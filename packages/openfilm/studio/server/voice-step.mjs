// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * 配音一步：把脚本里的每一条**完整口播**合成成一条音频，并按内容缓存。
 *
 * 单位是"一条完整口播"，不是句子：一条成片只吃一条配音（FissionEngine 的 `PickAudio`），所以脚本的一行 = 一条成片的配音。
 *
 * 这个模块只做三件事：
 *
 *   1. **按内容缓存**。键是 `sha256(provider|model|voice|normalize(text))`，产物落在
 *      `<project>/.film/tts-cache/<key>.<ext>`，旁边 `<key>.json` 记 provider/model/voice/text/src/createdAt。
 *      同一条文案 + 同一个音色 + 同一个模型，第二次不再花钱，也不再调服务。
 *   2. **一条失败不拖垮整批**。失败进 `failed`（`{ textIndex, reason }`），其它条照常合成：TTS 是外部调用，
 *      一条超时/限流不该让整批白跑。
 *   3. **限并发 2**。够快，又不至于把服务端限流打出来。
 *
 * 不做 ffprobe：真实时长由后续步骤（对齐/混音）负责，这里不猜。
 *
 * `run` 可注入（测试、或换一条链路），默认懒加载 `get.mjs` 的 `runGet`（`openfilm get tts`）。
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, isAbsolute, join } from 'node:path';

import { writeAtomic } from './atomic.mjs';

/** 缓存放哪儿：项目自己的 `.film/`（清掉只会重花一次钱，不丢作品）。 */
export const CACHE_DIR = join('.film', 'tts-cache');

/** 缓存目录的绝对路径。 */
export const cacheDirOf = (/** @type {string} */ project) => join(project, CACHE_DIR);

/**
 * 文本的规范形：去首尾空白，连续空白收成一个空格（换行在口播里只是停顿，不改变"说什么"）。
 * 只用于算键与去重：真正送去合成的仍是这一条口播自己的文字。
 * @param {unknown} text
 */
export const normalizeText = (text) => String(text ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();

/**
 * 缓存键：同一句文案、同一个音色、同一个模型才复用。
 * @param {{ provider: string, model?: string | null, voice: string, text: unknown }} one
 */
export function cacheKey({ provider, model, voice, text }) {
  return createHash('sha256').update(`${provider}|${model ?? ''}|${voice}|${normalizeText(text)}`).digest('hex');
}

/** `assets/audio/vo/x.mp3` 或绝对路径 → 绝对路径。 */
const atProject = (/** @type {string} */ project, /** @type {string} */ path) => (isAbsolute(path) ? path : join(project, path));

/**
 * 一次 `run` 的产物：provider 直接把字节给出来（`files[].bytes`），或只给落盘后的路径（`assets/audio/vo/…`）。
 * 两条路都要走通：MiniMax/Qwen 走前者，别家（ElevenLabs、Google…）走后者。
 * @param {string} project
 * @param {any} result
 * @returns {Promise<{ bytes: Uint8Array, src: string, ext: string }>}
 */
async function produced(project, result) {
  const first = Array.isArray(result?.files) ? result.files[0] : null;
  const src = /** @type {string} */ ([
    first?.path,
    result?.index?.[0]?.src,
    result?.receipt?.src,
    result?.file,
    result?.src,
  ].find((value) => typeof value === 'string' && value.trim()) ?? '');
  let bytes = first?.bytes ? new Uint8Array(first.bytes) : null;
  if (!bytes && src) bytes = new Uint8Array(await readFile(atProject(project, src)));
  if (!bytes || !bytes.length) throw new Error('这次合成没有拿到音频字节');
  const ext = extname(src).toLowerCase() || '.mp3';
  return { bytes, src, ext };
}

/**
 * 已经合成过的那一条（`<key>.json` + `<key>.<ext>` 都在才算），否则 null。
 * @param {string} dir 缓存目录
 * @param {string} key
 */
async function fromCache(dir, key) {
  /** @type {any} */
  let record;
  try { record = JSON.parse(await readFile(join(dir, `${key}.json`), 'utf8')); }
  catch { return null; }
  if (!record || typeof record !== 'object') return null;
  const ext = extname(String(record.src ?? '')).toLowerCase() || '.mp3';
  const file = join(dir, `${key}${ext}`);
  if (!existsSync(file)) return null;
  return { file, text: typeof record.text === 'string' ? record.text : '', src: String(record.src ?? '') };
}

/**
 * 合成脚本的每一条口播。
 *
 * @param {{
 *   project: string, lines: unknown[], provider: string, voice: string, model?: string | null,
 *   run?: (ask: { text: string, out: string }) => Promise<any>, concurrency?: number,
 * }} options
 * @returns {Promise<{
 *   voices: { file: string, text: string, cached: boolean, key: string, src: string }[],
 *   failed: { textIndex: number, reason: string }[],
 * }>} `file` 是缓存里的绝对路径，`src` 是这次落盘的项目内路径（`assets/audio/vo/…`）。
 */
export async function synthesizeVoices({ project, lines, provider, voice, model, run, concurrency = 2 }) {
  if (typeof project !== 'string' || !project.trim()) throw new Error('synthesizeVoices 需要项目目录（project）');
  if (typeof provider !== 'string' || !provider.trim()) throw new Error('synthesizeVoices 需要 provider');
  if (typeof voice !== 'string' || !voice.trim()) throw new Error('synthesizeVoices 需要音色（voice）');
  const list = Array.isArray(lines) ? lines : [];
  const dir = cacheDirOf(project);
  await mkdir(dir, { recursive: true });

  /* 默认走 `openfilm get tts`；懒加载，注入 run 时完全不碰 get.mjs */
  const speak = run ?? (async ({ text, out }) => {
    const { runGet } = await import('./get.mjs');
    return runGet(project, 'tts', { out, text, voice, via: provider }, { ...(model ? { model } : {}) });
  });

  /** 同一批里出现同一句文案时共用一次调用（键相同即内容相同）。 @type {Map<string, Promise<any>>} */
  const inFlight = new Map();

  /**
   * 一条口播：命中缓存直接返回，否则调 `run` 并把字节写进缓存。
   * `out` 是纯名（landing 只收纯名），取键的前 12 位：同一句话永远落到同一个名字上。
   * @param {unknown} line @param {number} textIndex
   */
  const make = async (line, textIndex) => {
    const said = String(line ?? '').trim();
    if (!said) throw new Error(`第 ${textIndex + 1} 条是空的，没有可念的文案`);
    const key = cacheKey({ provider, model, voice, text: said });
    const hit = await fromCache(dir, key);
    if (hit) return { file: hit.file, text: hit.text || said, cached: true, key, src: hit.src };
    const out = `vo-${key.slice(0, 12)}`;
    const made = await produced(project, await speak({ text: said, out }));
    const file = join(dir, `${key}${made.ext}`);
    await writeAtomic(file, made.bytes);
    const record = { provider, model: model ?? '', voice, text: said, src: made.src, createdAt: new Date().toISOString() };
    await writeAtomic(join(dir, `${key}.json`), `${JSON.stringify(record, null, 1)}\n`);
    return { file, text: said, cached: false, key, src: made.src };
  };

  /** @type {({ file: string, text: string, cached: boolean, key: string, src: string } | undefined)[]} */
  const voices = new Array(list.length);
  /** @type {{ textIndex: number, reason: string }[]} */
  const failed = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      const textIndex = next++;
      if (textIndex >= list.length) return;
      try {
        const key = cacheKey({ provider, model, voice, text: list[textIndex] });
        if (!inFlight.has(key)) inFlight.set(key, make(list[textIndex], textIndex));
        voices[textIndex] = await inFlight.get(key);
      } catch (e) {
        failed.push({ textIndex, reason: String(/** @type {any} */ (e)?.message ?? e) });
      }
    }
  };
  const width = Math.max(1, Math.min(Number(concurrency) || 1, list.length || 1));
  await Promise.all(Array.from({ length: width }, worker));

  /* 成功的按脚本顺序收拢（失败的位置留空，不占位） */
  /** @type {{ file: string, text: string, cached: boolean, key: string, src: string }[]} */
  const done = [];
  for (const one of voices) if (one) done.push(one);

  return {
    voices: done,
    failed: failed.sort((a, b) => a.textIndex - b.textIndex),
  };
}
