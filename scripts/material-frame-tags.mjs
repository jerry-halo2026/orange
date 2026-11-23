// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * 给静音素材打画面标签：抽三帧 → 视觉模型 → 落库（`visual_tags` / `visual_ver`）。
 *
 * # 为什么值得跑
 *
 * 67 156 条素材里 59 248 条的名字是"展示小青柑1""片段3"，而这些素材**没有声音** ——
 * 转写拿不到任何东西，"能从名字认出镜头类型的只有 12%"就是这么来的。
 * 打标之后，"有没有人的镜头""晒场空镜""手部倒茶"这些查询才有得可答。
 *
 * # 做法
 *
 * 1. 按 `visual_ver` 挑待办（`--limit` 先小批量看准确率）；
 * 2. ffmpeg 抽三帧到临时目录（10%/50%/90%）；
 * 3. 调视觉模型（`--vision` 指向一个可执行脚本，或设 `OPENFILM_VISION_CMD`）：
 *    它收到 `{ images: [三个文件], prompt }`，输出 JSON；
 * 4. 合并三帧 → `visual_tags` + `visual_ver`；同时把 `tagText()` 的文本写进 `text` 的检索段。
 *
 * # 没配视觉模型也要能跑
 *
 * `--dry-run` 只抽帧、不调用、不写库：先确认"三帧抽得对不对、抽取耗时多少"。
 * 这比接不上 key 就整条流程停住有用。
 */
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { frameTimes, mergeFrameTags, parseTagAnswer, tagText, taggingPrompt, tagsDigest, VISUAL_VER } from '../packages/orangefilm/src/visual-tags.mjs';

const run = promisify(execFile);

/**
 * 抽三帧。
 * @param {{ ffmpeg: string, input: string, durationSec: number, dir: string, id: string }} options
 * @returns {Promise<{ files: string[], at: number[] }>}
 */
export async function extractFrames({ ffmpeg, input, durationSec, dir, id }) {
  const times = frameTimes(durationSec);
  /** @type {string[]} */
  const files = [];
  for (const [index, entry] of times.entries()) {
    const file = join(dir, `${id}-${index}.jpg`);
    await run(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', String(entry.at), '-i', input,
      '-frames:v', '1', '-vf', 'scale=512:-2', '-q:v', '3', file,
    ], { windowsHide: true, timeout: 30_000 });
    files.push(file);
  }
  return { files, at: times.map((entry) => entry.at) };
}

/**
 * 调视觉模型（注入式：脚本收到 JSON，输出 JSON）。
 * @param {{ cmd: string, images: string[], prompt: string, timeoutMs?: number }} options
 */
export function askVision({ cmd, args = [], images, prompt, timeoutMs = 60_000 }) {
  /* execFile 不收 stdin（那是 spawn 的事）—— 用 spawn 把 payload 写进去再收 stdout。 */
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('视觉模型超时')); }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`视觉模型退出码 ${code}：${String(stderr).split(String.fromCharCode(10))[0]?.slice(0, 120) ?? ''}`));
    });
    child.stdin.end(JSON.stringify({ images, prompt }));
  });
}

/**
 * 主流程（DB 与 ffmpeg 都是注入的，单测不需要它们）。
 *
 * @param {{ rows: { media_key: string, name?: string, duration_ms?: number, entry: string }[],
 *   ffmpeg: string, visionCmd?: string, limit?: number, dryRun?: boolean,
 *   workDir?: string, ask?: typeof askVision, write?: (row: any, tags: any, text: string) => Promise<void>,
 *   onEvent?: (event: { mediaKey: string, ok: boolean, note: string }) => void }} options
 */
export async function tagMaterials({ rows, ffmpeg, visionCmd, limit = 200, dryRun = false, workDir,
  ask = askVision, extract = extractFrames, write, onEvent = () => {} }) {
  const dir = workDir ?? mkdtempSync(join(tmpdir(), 'frame-tags-'));
  /* 指定了 workDir 也要建出来：ffmpeg 不会替你建目录，只会失败 */
  mkdirSync(dir, { recursive: true });
  const own = !workDir;
  const selected = rows.slice(0, Math.max(0, limit));
  /** @type {{ mediaKey: string, ok: boolean, at?: number[], tags?: any, note: string }[]} */
  const results = [];
  try {
    for (const row of selected) {
      const mediaKey = String(row.media_key);
      const durationSec = Number(row.duration_ms ?? 0) / 1000;
      if (!(durationSec > 0)) {
        results.push({ mediaKey, ok: false, note: '没有时长，跳过' });
        onEvent({ mediaKey, ok: false, note: '没有时长' });
        continue;
      }
      let frames;
      try {
        frames = await extract({ ffmpeg, input: row.entry, durationSec, dir, id: mediaKey });
      } catch (error) {
        results.push({ mediaKey, ok: false, note: `抽帧失败：${String(error?.message ?? error).split('\n')[0].slice(0, 120)}` });
        onEvent({ mediaKey, ok: false, note: '抽帧失败' });
        continue;
      }
      /* 注入了 ask 就等于有视觉模型：单测与自定义 provider 都不必再传 visionCmd */
      if (dryRun || (!visionCmd && ask === askVision)) {
        results.push({ mediaKey, ok: true, at: frames.at, note: dryRun ? '只抽帧（dry-run）' : '没有视觉模型，只抽帧' });
        onEvent({ mediaKey, ok: true, note: '抽帧完成' });
        continue;
      }
      try {
        const answer = await ask({ cmd: visionCmd, images: frames.files, prompt: taggingPrompt() });
        const parsed = parseTagAnswer(answer);
        if (!parsed) {
          results.push({ mediaKey, ok: false, note: '模型回答不是 JSON' });
          onEvent({ mediaKey, ok: false, note: '回答不合格式' });
          continue;
        }
        const tags = { ...parsed, digest: tagsDigest(parsed), ver: VISUAL_VER };
        const text = tagText(parsed, { name: row.name ?? '' });
        if (write) await write(row, tags, text);
        results.push({ mediaKey, ok: true, at: frames.at, tags: parsed, note: text });
        onEvent({ mediaKey, ok: true, note: text });
      } catch (error) {
        results.push({ mediaKey, ok: false, note: `视觉模型失败：${String(error?.message ?? error).split('\n')[0].slice(0, 120)}` });
        onEvent({ mediaKey, ok: false, note: '视觉模型失败' });
      }
    }
  } finally {
    if (own) rmSync(dir, { recursive: true, force: true });
  }
  return { results, ok: results.filter((entry) => entry.ok).length, failed: results.filter((entry) => !entry.ok).length };
}

/* ── CLI ─────────────────────────────────────────────────────────────────────────── */
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const args = new Map();
  for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
  const limit = Number(args.get('--limit') ?? 20);
  const dryRun = args.has('--dry-run');
  const ffmpeg = args.get('--ffmpeg') ?? process.env.FFMPEG ?? 'ffmpeg';
  const visionCmd = args.get('--vision') ?? process.env.OPENFILM_VISION_CMD ?? '';
  console.log(`frame-tags: limit=${limit} dryRun=${dryRun} vision=${visionCmd || '(未配置，只抽帧)'}`);
  console.log('提示：抽帧走 ffmpeg；DB 取行与写回由调用方注入（见 scripts/material-frame-tags.mjs 的用法）。');
  void extractFrames;
  void tagMaterials;
  void mergeFrameTags;
}
