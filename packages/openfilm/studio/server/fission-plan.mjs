// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * `plan.json` → Fission 的一批任务。
 *
 * # 为什么能对上
 *
 * Fission 的 job 是**批量**模型：`VideoDir` 里一堆片段、`AudioDir` 里一堆配音，它按 `PickRule` 与
 * `AlignStrategy` 把它们配起来。我们的计划是**有序**的（第 1 句配第 1 个镜头…），所以：
 *
 *   - 把计划里的素材按顺序**复制/硬链到一个 staging 目录**，文件名带序号（`01_S1.mp4`）；
 *   - 把每段的配音按同一序号放进 voice 目录（`01_S1.mp3`）；
 *   - `SplitMode = None`（不切）、`PickRule = Sequential`（按序）、`AlignStrategy = TrimLonger`（长的裁掉）；
 *
 * 这样 Fission 不需要理解"句子"，它只要按序配、按对齐策略裁 —— 而"每段多长"已经写在配音里了。
 * 这正是"时间以音频为准"在渲染端的落地：**画面被裁到声音的长度**。
 *
 * # 素材不在 assets/ 怎么办
 *
 * 如实进 `problems`（哪个 segmentId 缺哪条 mediaId），不猜、不用别的片段顶替。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

import { transitionNames } from './fission-engine-paths.mjs';

const pad = (/** @type {number} */ value) => String(value).padStart(2, '0');

/**
 * 在项目 `assets/` 里按 mediaId 找一条素材（文件名里含 id，扩展名是视频）。
 * @param {string} assetsRoot @param {string} mediaId
 */
export function findFootage(assetsRoot, mediaId) {
  if (!existsSync(assetsRoot)) return null;
  /** @type {string[]} */
  let names = [];
  try {
    names = readdirSync(assetsRoot, { recursive: true }).map(String);
  } catch {
    return null;
  }
  const hit = names.find((name) => name.includes(mediaId) && /\.(mp4|mov|m4v|webm|mkv)$/i.test(name));
  return hit ? join(assetsRoot, hit) : null;
}

/**
 * 把计划"摆"成 Fission 要读的目录。
 *
 * @param {any} plan
 * @param {{ project: string, assetsRoot: string, workRoot: string }} where
 * @returns {{ staged: { videoDir: string, audioDir: string, bgmDir: string | null, entries: { index: number,
 *   segmentId: string, mediaId: string, video?: string, audio?: string, shownSec: number }[] },
 *   problems: string[], notes: string[] }}
 */
export function stagePlanForFission(plan, { project, assetsRoot, workRoot }) {
  /* 这些目录会写进 job 的 VideoDir/AudioDir，而 Fission 的路径策略拒绝"符号链接祖先"
     （`Linked path ancestors are not accepted`）。macOS 上 /var 与 /tmp 都是链接，所以工程只要落在
     它们下面就必须先 realpath —— 否则同一份 job 在 Windows 上能跑、在 Mac 上直接被拒。 */
  const canonical = (/** @type {string} */ dir) => {
    mkdirSync(dir, { recursive: true });
    try {
      return realpathSync.native(dir);
    } catch {
      return dir;
    }
  };
  const root = join(workRoot, plan.id);
  rmSync(root, { recursive: true, force: true });
  const videoDir = canonical(join(root, 'video'));
  const audioDir = canonical(join(root, 'audio'));

  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const notes = [];
  /** @type {any[]} */
  const entries = [];

  let index = 0;
  for (const segment of plan.segments) {
    if (segment.kind !== 'speech') continue;
    index += 1;
    const shot = plan.shots.find((entry) => entry.segmentId === segment.id);
    /** @type {any} */
    const entry = { index, segmentId: segment.id, mediaId: shot?.mediaId ?? '', shownSec: shot?.shownSec ?? segment.audioSec };
    if (!shot) { problems.push(`${segment.id} 没有镜头`); entries.push(entry); continue; }
    const footage = findFootage(assetsRoot, shot.mediaId);
    if (!footage) {
      problems.push(`${segment.id} 的素材 ${shot.mediaId} 不在 assets/（先用 materials.take 取进来）`);
    } else {
      /* 顺序名 + 原扩展名：Fission 按目录序读，序号就是计划的顺序 */
      const extension = extname(footage) || '.mp4';
      const target = join(videoDir, `${pad(index)}_${segment.id}${extension}`);
      copyFileSync(footage, target);
      entry.video = target;
      /* 记下每个镜头在素材里的取用区间，交给 Fission 的裁剪策略（TrimLonger 会自己裁到音频长度） */
      entry.sourceStartSec = shot.startSec;
      entry.sourceEndSec = shot.endSec;
    }
    const voice = segment.voice?.file ?? '';
    if (voice && existsSync(voice)) {
      const extension = extname(voice) || '.mp3';
      const target = join(audioDir, `${pad(index)}_${segment.id}${extension}`);
      copyFileSync(voice, target);
      entry.audio = target;
    } else {
      problems.push(`${segment.id} 没有配音文件（先跑 measurePlanVoices）`);
    }
    entries.push(entry);
  }

  if (plan.bgm?.id) {
    const bgm = findFootage(assetsRoot, plan.bgm.id);
    if (bgm) {
      const bgmDir = join(root, 'bgm');
      mkdirSync(bgmDir, { recursive: true });
      copyFileSync(bgm, join(bgmDir, `${pad(1)}_bgm${extname(bgm) || '.mp3'}`));
      notes.push(`BGM 用 ${bgm}`);
      return { staged: { videoDir, audioDir, bgmDir, entries }, problems, notes };
    }
    notes.push(`BGM ${plan.bgm.id} 不在 assets/，这一版不带 BGM 出`);
  }
  return { staged: { videoDir, audioDir, bgmDir: null, entries }, problems, notes };
}

/**
 * 由计划与 staging 目录生成 Fission 的 job（`FissionJob` 的 JSON 形状）。
 *
 * @param {any} plan
 * @param {{ videoDir: string, audioDir: string, bgmDir: string | null }} staged
 * @param {{ enginePaths: Record<string, string>, transitions?: string[] }} engine
 */
export function jobFromPlan(plan, staged, { enginePaths }) {
  const transitions = transitionNames(enginePaths);
  const totalSec = plan.shots.reduce((sum, shot) => sum + Number(shot.shownSec ?? 0), 0);
  /** @type {string[]} */
  const notes = [];
  if (!transitions.length) {
    notes.push('转场目录里没有 .glsl：Fission 会把转场全部按 xfade 降级（docs/transitions-ffmpeg9.md）');
  }
  if (plan.elements?.transitions?.length) {
    notes.push(`计划里点名了 ${plan.elements.transitions.length} 个转场，但 Fission 的转场名来自 TransitionsDir 的 glsl 文件名`);
  }
  return {
    job: {
      VideoDir: staged.videoDir,
      AudioDir: staged.audioDir,
      ...(staged.bgmDir ? { BgmDir: staged.bgmDir } : {}),
      /* 不写 OutDir：Fission 把它派生为 <workspace>/<task>/<attempt>/out，
         写死一个路径进来会被判 CFG_ARGS（实测）。 */
      Count: 1,
      Threads: 2,
      /* 不切、按序、把画面裁到声音长度 —— 这三条就是"音画对得上"在渲染端的全部 */
      SplitMode: 'None',
      /* FissionJob 的真名是 Pick / Align / Naming —— 写成 PickRule/AlignStrategy/NamingRule 会被
         反序列化静默忽略，job 退回默认值（实测：整批按随机选材、命名按音频名）。 */
      Pick: 'Sequential',
      Align: 'TrimLonger',
      TargetDurationSec: Number(totalSec.toFixed(3)),
      OutWidth: Number(plan.spec?.width ?? 1080),
      OutHeight: Number(plan.spec?.height ?? 1920),
      OutFps: Number(plan.spec?.fps ?? 30),
      VoiceVolume: 1.0,
      BgmVolume: Number(plan.bgm?.volume ?? 0.35),
      Naming: 'Sequence',
    },
    notes,
  };
}

/**
 * 一句人话：Fission 的退出码/事件 → 用户能懂的一句话。
 * @param {{ code?: number, stderr?: string, outDir?: string }} result
 */
export function explainFissionFailure({ code, stderr = '', outDir = '' }) {
  const text = String(stderr);
  if (/CFG_ENGINE_PATHS/.test(text)) return '渲染器缺少引擎路径配置（ffmpeg / 转场 / 素材根目录）—— 先跑一次 engine paths 生成';
  if (/FFmpeg.*not found|ffmpeg.*not recognized|The system cannot find/i.test(text)) return '找不到 ffmpeg：app 自带的那份没下下来';
  if (/No such file|does not exist/i.test(text)) return `有一个输入文件不存在（素材或配音没落盘）：${text.split('\n')[0].slice(0, 120)}`;
  if (/disk|space/i.test(text)) return '磁盘空间不足';
  if (code === 0) return `完成，产物在 ${outDir || '输出目录'}`;
  return `渲染失败（退出码 ${code ?? '?'}）：${text.split('\n').filter(Boolean)[0]?.slice(0, 160) ?? '没有更多信息'}`;
}
