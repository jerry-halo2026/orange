// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * 一个「混剪配方」（recipe）→ Fission 能读的 staging 目录 + job。
 *
 * 配方是画布节点与 agent 共用的唯一真相（`.film/fission/recipe.json`），引擎只认目录与 job，
 * 所以这一层负责三件事，每一件都对着实测过的引擎语义（docs/execution/2026-11-19-mix-engine-spike.md）：
 *
 *   1. 组：`groups[].name` **逐字**成为 `video/` 下的一级子目录名，并原样成为 `SceneGroups[].Name`
 *      （引擎按整名匹配；配置非空时，目录里没列出的组不参与）。
 *   2. 配音：一条成片只吃一条配音（`PickAudio = audios[cursor % n]`），所以每个音频文件是一整条口播；
 *      字幕文本写在 `audio` 的**父目录** `meta.json`（`{items:[{file,text}]}`），且 `items` 必须始终存在。
 *   3. job：字段名用引擎真名（`Pick / Align / Naming`），写错会被 `UnmappedMemberHandling.Disallow` 拒绝。
 *
 * 这里不做的事：不探测时长、不合成配音、不下载云端素材（`resolveRef` 由调用方注入），不启动进程。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join } from 'node:path';

import { canonicalPath } from './fission-runner.mjs';

/** 与 `FissionJob` 的属性逐字对应；写错一个就在这里报，而不是等引擎静默忽略。 */
export const JOB_FIELDS = new Set([
  'VideoDir', 'SceneGroups', 'ImageDurMinSec', 'ImageDurMaxSec', 'AudioDir', 'BgmDir', 'IntroDir', 'OutroDir',
  'OutDir', 'Count', 'Threads', 'TargetDurationSec', 'GeneratedAudioCount', 'GeneratedAudioDurationSec', 'AudioUses',
  'OutWidth', 'OutHeight', 'OutFps', 'VoiceVolume', 'BgmVolume', 'SplitMode', 'SceneThreshold', 'AvgPieces',
  'BySeconds', 'RandomMinSec', 'RandomMaxSec', 'Align', 'Pick', 'AllowVideoReuse', 'RandomHFlip', 'TransitionSec',
  'TransitionName', 'SubtitleEnabled', 'SubtitleStyle', 'SubtitlePos', 'SubtitlePosPct', 'SubtitleFontSize', 'SubtitleFontFamily', 'PreviewMode', 'BgmMode',
  'CoverAtSec', 'Naming', 'UseNvenc', 'NvencGate',
]);

const SPLIT = /** @type {const} */ ({ scene: 'Scene', pieces: 'AveragePieces', seconds: 'BySeconds', range: 'RandomRange', none: 'None' });
const PICK = /** @type {const} */ ({ sceneOrder: 'SceneOrderRandomWithin', random: 'Random', sequential: 'Sequential' });
const NAMING = /** @type {const} */ ({ audioFileName: 'AudioFileName', sequence: 'Sequence', randomTitle: 'RandomTitle' });
const ASPECT = /** @type {const} */ ({ '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1080, 1080] });

/** 文件名里不能出现的字符（与引擎的路径策略同一套禁忌，外加 Windows 文件名禁忌）。 */
const BAD_NAME = /[\\/:*?"<>|\u0000-\u001f]/;
/** 组的目录名：允许中文与空格，不允许路径分隔符、尾随点/空格（引擎会拒）。 */
const groupNameOk = (/** @type {string} */ name) =>
  Boolean(name) && name.length <= 60 && !BAD_NAME.test(name) && !/[. ]$/.test(name) && name !== '.' && name !== '..';

/** 一个渲染前的配方错误：带字段路径，便于面板逐项标红。 */
export class RecipeError extends Error {
  /** @param {string} at @param {string} why */
  constructor(at, why) {
    super(`${at}: ${why}`);
    this.name = 'RecipeError';
    this.at = at;
  }
}

/**
 * 把用户/agent 给的配方收敛成一份可用的：缺省值补齐，非法值逐项报错（一次尽量报全）。
 * @param {any} input
 * @returns {{ recipe: any, problems: string[] }}
 */
export function normalizeRecipe(input) {
  /** @type {string[]} */
  const problems = [];
  const bad = (/** @type {string} */ at, /** @type {string} */ why) => problems.push(`${at}: ${why}`);
  if (!input || typeof input !== 'object') return { recipe: null, problems: ['recipe: 不是一个对象'] };
  if (input.schema !== undefined && input.schema !== 'orange/mix-recipe/1') bad('schema', '只认识 orange/mix-recipe/1');

  const groupsIn = Array.isArray(input.groups) ? input.groups : [];
  if (!groupsIn.length) bad('groups', '至少要有一个场景组');
  /**
   * 引擎的组名字典是 **OrdinalIgnoreCase**（`Open` 与 `open` 是同一个组），
   * 而 macOS 盘上的文件名是 NFD、用户从访达复制的路径也是 NFD —— 同一串名字可能是不同码点。
   * 所以这里先统一 NFC，再按小写去重：两处都收敛，目录名与 `SceneGroups[].Name` 才是同一串字节。
   */
  const seen = new Set();
  const groups = groupsIn.map((/** @type {any} */ g, /** @type {number} */ i) => {
    const at = `groups[${i}]`;
    const name = typeof g?.name === 'string' ? g.name.trim().normalize('NFC') : '';
    if (!groupNameOk(name)) bad(`${at}.name`, '组名要非空、不含路径字符、不以点或空格结尾');
    const key = name.toLowerCase();
    if (name && seen.has(key)) bad(`${at}.name`, `组名 ${name} 与前面的组重名（引擎按大小写不敏感认组）`);
    if (name) seen.add(key);
    const refsIn = Array.isArray(g?.refs) ? g.refs : [];
    if (!refsIn.length) bad(`${at}.refs`, '这一组没有素材');
    const refs = refsIn.map((/** @type {any} */ r, /** @type {number} */ k) => {
      if (!r || typeof r !== 'object') { bad(`${at}.refs[${k}]`, '不是对象'); return r; }
      if (!['asset', 'dir', 'saved', 'cloud'].includes(r.kind)) bad(`${at}.refs[${k}].kind`, 'kind 是 asset/dir/saved/cloud');
      if (r.kind === 'cloud' ? typeof r.videoId !== 'string' || !r.videoId : typeof r.path !== 'string' || !r.path) {
        bad(`${at}.refs[${k}]`, r.kind === 'cloud' ? 'cloud 素材要 videoId' : '要 path');
      }
      /* path 也统一 NFC：盘上的 NFD 文件名与输入里的 NFC 写法要指向同一个文件 */
      return typeof r.path === 'string' ? { ...r, path: r.path.normalize('NFC') } : r;
    });
    const rule = g?.rule === 'sequential' ? 'sequential' : 'random';
    const take = Number.isInteger(g?.takePerOutput) && g.takePerOutput > 0 ? g.takePerOutput : 0;
    const speed = typeof g?.speed === 'number' ? g.speed : 1;
    if (speed < 0.5 || speed > 4) bad(`${at}.speed`, '变速在 0.5–4');
    return {
      name, refs, enabled: g?.enabled !== false, rule, takePerOutput: take, speed,
      useThenDelete: g?.useThenDelete === true, allowReuse: g?.allowReuse === true,
    };
  });

  const script = input.script ?? {};
  const uploads = Array.isArray(input.voiceFiles) && input.voiceFiles.some((row) => row && typeof row.path === 'string' && row.path.trim());
  const lines = (Array.isArray(script.lines) ? script.lines : []).map((/** @type {any} */ line) => String(line ?? '').trim()).filter(Boolean);
  if (!lines.length && !uploads) bad('script.lines', '至少要有一条完整口播（一行 = 一条成片的配音）');
  lines.forEach((/** @type {string} */ line, /** @type {number} */ i) => {
    if (line.length > 5000) bad(`script.lines[${i}]`, '一条口播不要超过 5000 字');
  });
  if (!uploads && (typeof script.provider !== 'string' || !script.provider)) bad('script.provider', '要指定配音厂商');
  if (!uploads && (typeof script.voice !== 'string' || !script.voice)) bad('script.voice', '要指定音色');

  const p = input.params ?? {};
  const count = Number.isInteger(p.count) && p.count >= 0 ? p.count : 0;
  const audioUses = Number.isInteger(p.audioUses) && p.audioUses >= 0 ? p.audioUses : 1;
  const threads = Number.isInteger(p.threads) ? Math.min(64, Math.max(1, p.threads)) : 4;
  const aspect = typeof p.aspect === 'string' && p.aspect in ASPECT ? p.aspect : '9:16';
  const split = typeof p.split === 'string' && p.split in SPLIT ? p.split : 'scene';
  const align = Number.isInteger(p.align) && p.align >= 1 && p.align <= 8 ? p.align : 1;
  const transitionSec = typeof p.transitionSec === 'number' ? p.transitionSec : 0;
  if (transitionSec < 0 || transitionSec > 2) bad('params.transitionSec', '转场时长 0–2 秒');
  const naming = typeof p.naming === 'string' && p.naming in NAMING ? p.naming : 'audioFileName';
  const pick = typeof p.pick === 'string' && p.pick in PICK ? p.pick : 'sceneOrder';
  const targetSec = typeof p.targetSec === 'number' && p.targetSec > 0 ? p.targetSec : null;

  const recipe = {
    schema: 'orange/mix-recipe/1',
    groups,
    script: { provider: script.provider, voice: script.voice, lines },
    params: {
      count, audioUses, threads, aspect, split,
      sceneThreshold: typeof p.sceneThreshold === 'number' ? p.sceneThreshold : 0.3,
      avgPieces: Number.isInteger(p.avgPieces) && p.avgPieces > 0 ? p.avgPieces : 4,
      bySeconds: typeof p.bySeconds === 'number' && p.bySeconds > 0 ? p.bySeconds : 3,
      randomMinSec: typeof p.randomMinSec === 'number' ? p.randomMinSec : 2,
      randomMaxSec: typeof p.randomMaxSec === 'number' ? p.randomMaxSec : 4,
      align, pick, naming, targetSec,
      transition: typeof p.transition === 'string' && p.transition ? p.transition : '',
      transitionSec,
      subtitle: p.subtitle === true,
      preview: p.preview === true,
      subtitleStyle: typeof p.subtitleStyle === 'string' ? p.subtitleStyle : 'white-outline',
      subtitlePos: typeof p.subtitlePos === 'string' ? p.subtitlePos : 'bottom',
      subtitlePosPct: Number.isFinite(p.subtitlePosPct) ? Math.min(100, Math.max(0, Number(p.subtitlePosPct))) : null,
      subtitleFontSize: Number.isInteger(p.subtitleFontSize) ? p.subtitleFontSize : 64,
      /* ASS 字体族：空 = 引擎缺省（Windows 兼容的 Microsoft YaHei）；macOS 随包 Noto Sans SC 时必须显式给 */
      subtitleFontFamily: typeof p.subtitleFontFamily === 'string' && p.subtitleFontFamily.trim() ? p.subtitleFontFamily.trim() : null,
      hflip: p.hflip !== false,
      allowVideoReuse: p.allowVideoReuse === true,
      bgmVolume: typeof p.bgmVolume === 'number' ? Math.max(0, Math.min(2, p.bgmVolume)) : 0.35,
      bgmMode: p.bgmMode === 'sequence' ? 'sequence' : p.bgmMode === 'fixed' ? 'fixed' : 'random',
    },
    voiceFiles: Array.isArray(input.voiceFiles)
      ? input.voiceFiles.filter((row) => row && typeof row.path === 'string' && row.path.trim()).slice(0, 200)
        .map((row) => ({ path: String(row.path), text: String(row.text ?? '').slice(0, 4000), cues: Array.isArray(row.cues) ? row.cues.slice(0, 2000).filter((cue) => cue && Number.isFinite(cue.startSec) && Number.isFinite(cue.endSec) && String(cue.text ?? '').trim()).map((cue) => ({ startSec: Number(cue.startSec), endSec: Number(cue.endSec), text: String(cue.text).slice(0, 500) })) : [], subtitleMode: row.subtitleMode === 'srt' ? 'srt' : row.subtitleMode === 'none' ? 'none' : 'recognize' }))
      : [],
    bgm: Array.isArray(input.bgm) ? input.bgm : [],
    intro: Array.isArray(input.intro) ? input.intro : [],
    outro: Array.isArray(input.outro) ? input.outro : [],
  };
  return { recipe, problems };
}

/**
 * 把配方摆成引擎要读的目录：`<workRoot>/<batchId>/{video/<组名>/, audio/, bgm/, intro/, outro/}`。
 *
 * `voices` 是已经合成好的整条口播（`voice-step` 的产物）：`[{ file, text }]`，顺序与 `script.lines` 一致。
 * `resolveRef(ref) → 绝对路径 | null` 由调用方提供（asset/dir 在本地解析，cloud/saved 需要下载层）。
 *
 * @param {{ recipe: any, project: string, workRoot: string, batchId: string, voices: { file: string, text: string }[],
 *   resolveRef?: (ref: any) => string | null }} options
 */
export function stageRecipe({ recipe, project, workRoot, batchId, voices, resolveRef = defaultResolveRef(canonicalPath(project)) }) {
  /** @type {string[]} */
  const problems = [];
  if (!/^[a-z0-9-]{1,40}$/.test(batchId)) throw new RecipeError('batchId', '只能是小写字母、数字与连字符');
  /* 规范路径：macOS 上 `/var/...` 与 `/private/var/...` 是同一处，写进 job 的必须是解析后的那个 */
  const root = join(canonicalPath(workRoot), batchId);
  /* 批次级目录：同一批次重跑会重建；不同批次互不影响（旧实现按 plan 复用同一根，重试会删掉在跑的输入）。 */
  rmSync(root, { recursive: true, force: true });
  const videoDir = join(root, 'video');
  const audioDir = join(root, 'audio');
  mkdirSync(videoDir, { recursive: true });
  mkdirSync(audioDir, { recursive: true });

  /** @type {Record<string, { name: string, count: number }>} */
  const staged = {};
  const MEDIA_FILE = /\.(mp4|mov|m4v|mkv|avi|webm|flv|wmv|jpe?g|png|webp|gif|bmp)$/i;
  /** 一个 ref 可能指向目录（场景组）：展开成其中的视频/图片文件。 */
  const filesOf = (resolved) => {
    if (!resolved || !existsSync(resolved)) return [];
    const info = statSync(resolved);
    if (!info.isDirectory()) return info.isFile() ? [resolved] : [];
    return readdirSync(resolved)
      .filter((name) => MEDIA_FILE.test(name))
      .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }))
      .map((name) => join(resolved, name));
  };
  for (const group of recipe.groups) {
    /* 目录名就在这里再收敛一次 NFC：手写的 recipe 也可能没过 normalizeRecipe，而 job 的 Name 必须与目录同名 */
    const name = String(group?.name ?? '').normalize('NFC');
    const dir = join(videoDir, name);
    mkdirSync(dir, { recursive: true });
    let count = 0;
    for (const ref of group.refs) {
      const resolved = resolveRef(ref);
      const files = filesOf(resolved);
      if (!files.length) {
        problems.push(`${name}: 素材 ${ref.path ?? ref.videoId ?? '?'} 找不到`);
        continue;
      }
      for (const file of files) {
        const target = join(dir, `${String(++count).padStart(3, '0')}${extname(file) || '.mp4'}`);
        copyFileSync(file, target);
      }
    }
    if (!count) problems.push(`${name}: 一个素材都没落下`);
    staged[name] = { name, count };
  }

  /** @type {{ file: string, text: string }[]} */
  const items = [];
  let index = 0;
  for (const voice of voices) {
    if (!voice?.file || !existsSync(voice.file)) { problems.push(`配音 ${index + 1} 没有文件`); index += 1; continue; }
    index += 1;
    const name = `${String(index).padStart(2, '0')}${extname(voice.file) || '.mp3'}`;
    copyFileSync(voice.file, join(audioDir, name));
    items.push({ file: name, text: String(voice.text ?? ''), ...(Array.isArray(voice.cues) && voice.cues.length ? { cues: voice.cues } : {}) });
  }
  if (!items.length) problems.push('没有任何配音：先跑 voice-step');

  /* 字幕文本：引擎从 AudioDir 的父目录读 meta.json，且 `items` 缺失会让整次运行抛 KeyNotFoundException。 */
  const meta = { version: 1, batchId, items };
  mkdirSync(root, { recursive: true });
  writeJson(join(root, 'meta.json'), meta);

  const sideDir = (/** @type {string} */ role, /** @type {any[]} */ refs) => {
    if (!refs.length) return null;
    const dir = join(root, role);
    mkdirSync(dir, { recursive: true });
    let n = 0;
    for (const ref of refs) {
      const file = resolveRef(ref);
      if (!file || !existsSync(file)) { problems.push(`${role}: 素材 ${ref?.path ?? ref?.videoId ?? '?'} 找不到`); continue; }
      copyFileSync(file, join(dir, `${String(++n).padStart(2, '0')}${extname(file) || '.mp3'}`));
    }
    return n ? dir : null;
  };
  const bgmDir = sideDir('bgm', recipe.bgm);
  const introDir = sideDir('intro', recipe.intro);
  const outroDir = sideDir('outro', recipe.outro);

  return { root, videoDir, audioDir, bgmDir, introDir, outroDir, groups: staged, items, problems };
}

/**
 * 默认的本地解析：工程内相对路径（asset）与绝对目录 + 相对路径（dir）。
 * cloud / saved 需要下载与 Saved 索引，这里明确报"还没接"，不猜路径。
 * @param {string} project
 */
export function defaultResolveRef(project) {
  return (/** @type {any} */ ref) => {
    if (ref?.kind === 'asset' && typeof ref.path === 'string') {
      const file = join(project, ...String(ref.path).split('/'));
      return existsSync(file) ? file : null;
    }
    if (ref?.kind === 'dir' && typeof ref.path === 'string') {
      if (typeof ref.dir === 'string') {
        const file = join(ref.dir, ref.path);
        return existsSync(file) ? file : null;
      }
      /* 面板旧写法：path 本身是绝对目录（场景组根或子目录）。 */
      return isAbsolute(ref.path) && existsSync(ref.path) ? ref.path : null;
    }
    return null;
  };
}

const writeJson = (/** @type {string} */ file, /** @type {unknown} */ value) =>
  writeFileSync(file, `${JSON.stringify(value, null, 1)}\n`, 'utf8');

/**
 * 配方 + staging → Fission job。字段名与取值范围对着 `FissionJob` 与实测语义：
 * - `TargetDurationSec` 留空 = 跟随配音（不要拿镜头时长求和，会裁掉最后一句）；
 * - `Count / AudioUses` 共同决定条数：`min(Count, 配音数 × max(AudioUses,1))`。
 *
 * @param {{ recipe: any, staged: any }} options
 */
export function jobFromRecipe({ recipe, staged }) {
  const p = recipe.params;
  const [width, height] = ASPECT[p.aspect] ?? ASPECT['9:16'];
  /** @type {Record<string, any>} */
  const job = {
    VideoDir: staged.videoDir,
    AudioDir: staged.audioDir,
    ...(staged.bgmDir ? { BgmDir: staged.bgmDir } : {}),
    ...(staged.introDir ? { IntroDir: staged.introDir } : {}),
    ...(staged.outroDir ? { OutroDir: staged.outroDir } : {}),
    SceneGroups: recipe.groups.map((/** @type {any} */ g) => ({
      Name: String(g?.name ?? '').normalize('NFC'), Enabled: g.enabled, TakePerOutput: g.takePerOutput,
      Rule: g.rule === 'sequential' ? 'Sequential' : 'Random', Speed: g.speed,
      UseThenDelete: g.useThenDelete, AllowReuse: g.allowReuse,
    })),
    Count: p.count,
    AudioUses: p.audioUses,
    Threads: p.threads,
    SplitMode: SPLIT[p.split] ?? 'Scene',
    SceneThreshold: p.sceneThreshold,
    AvgPieces: p.avgPieces,
    BySeconds: p.bySeconds,
    RandomMinSec: p.randomMinSec,
    RandomMaxSec: p.randomMaxSec,
    Align: p.align,
    Pick: PICK[p.pick] ?? 'SceneOrderRandomWithin',
    AllowVideoReuse: p.allowVideoReuse,
    RandomHFlip: p.hflip,
    TransitionName: p.transition || 'fade',
    TransitionSec: p.transition ? p.transitionSec : 0,
    OutWidth: width,
    OutHeight: height,
    OutFps: 30,
    VoiceVolume: 1,
    BgmVolume: staged.bgmDir ? p.bgmVolume : 0,
    BgmMode: p.bgmMode,
    Naming: NAMING[p.naming] ?? 'AudioFileName',
    UseNvenc: true,
    ...(p.preview ? { PreviewMode: true } : {}),
    ...(p.subtitle ? {
      SubtitleEnabled: true, SubtitleStyle: p.subtitleStyle, SubtitlePos: p.subtitlePos, SubtitleFontSize: p.subtitleFontSize,
      ...(p.subtitlePosPct === null || p.subtitlePosPct === undefined ? {} : { SubtitlePosPct: p.subtitlePosPct }),
      /* 只在显式给了字体族时写：缺省交给引擎（Windows 用 Microsoft YaHei），不替它编一个 */
      ...(p.subtitleFontFamily ? { SubtitleFontFamily: p.subtitleFontFamily } : {}),
    } : {}),
    ...(p.targetSec ? { TargetDurationSec: p.targetSec } : {}),
  };
  for (const key of Object.keys(job)) {
    if (!JOB_FIELDS.has(key)) throw new RecipeError(key, '不是 FissionJob 的字段（引擎会拒）');
  }
  /** @type {string[]} */
  const notes = [];
  if (!staged.bgmDir && recipe.bgm.length) notes.push('BGM 未落下，这一批不带 BGM');
  if (p.subtitle && p.aspect !== '9:16') notes.push('字幕画布固定 1080×1920，非 9:16 会错位：这一批不开字幕');
  if (p.subtitle && p.aspect !== '9:16') { delete job.SubtitleEnabled; delete job.SubtitleFontFamily; }
  return { job, notes };
}

/** 一次性把配方变成「可跑的输入」：校验 → staging → job。
 * @param {{ recipe: any, project: string, workRoot: string, batchId: string, voices: { file: string, text: string }[],
 *   resolveRef?: (ref: any) => string | null }} options
 */
export function prepareRecipeRun({ recipe, project, workRoot, batchId, voices, resolveRef }) {
  const staged = stageRecipe({ recipe, project, workRoot, batchId, voices, ...(resolveRef ? { resolveRef } : {}) });
  const { job, notes } = jobFromRecipe({ recipe, staged });
  return { staged, job, problems: staged.problems, notes };
}

/** 批次目录里现在有几个视频文件（面板/日志用）。 */
export function countStaged(dir) {
  try { return readdirSync(dir, { recursive: true }).filter((n) => /\.(mp4|mov|mkv|m4v)$/i.test(String(n))).length; }
  catch { return 0; }
}

/** 把一条配音文件的 basename 拿去和 meta 对（测试与失败诊断用）。 */
export const voiceName = (/** @type {string} */ file) => basename(file);
