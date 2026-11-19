// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * The embedding model the material search runs on this computer: bge-base-zh-v1.5 (768 维), 以及它需要的
 * onnxruntime-web。装机后第一次用到时下载，之后一直用本地的。
 *
 * 为什么照 ffmpeg-runtime 的形状写：那套已经证明过——pin 住 url + sha256、下到 `<dataDir>/runtime/`、
 * 有进度、有 stall 检测、有重试、已经在就跳过。模型比 ffmpeg 简单：**不需要按平台分**，一个文件
 * 在 Windows x64 与 macOS arm64 上是同一份（wasm 运行时 + 纯数据模型），所以这里没有 BUILDS 表。
 *
 * 为什么模型不在安装包里：模型 98 MB、向量包 103 MB，塞进安装包会让每个用户为一个可能用不上的功能付下载；
 * 而 ffmpeg 是"打开就要用"，模型是"用到素材检索才要"。所以它是首次运行时取。
 *
 * `verified` 是这条路的正确性保证：sha256 不符就不落盘、不覆盖，宁可再下一次 —— 一个被截断的 onnx
 * 会在运行时抛"invalid model"而不是"下载失败"，那种错最难查。
 */
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 模型：id、维度、取向量方式、分词器类型，以及每个文件的 url 与 sha256。 */
export const MATERIAL_MODEL = Object.freeze({
  id: 'bge-base-zh-v1.5',
  dims: 768,
  /** BERT 系取第一个 token（`<s>`/CLS）。用 e5 的 mean 不报错，只会静默换个向量空间（余弦 0.749）。 */
  pooling: 'cls',
  /** WordPiece（`src/wordpiece.mjs`），不是 SentencePiece unigram —— 读错词表直接抛。 */
  tokenizer: 'wordpiece',
  files: Object.freeze([
    {
      path: 'model_quantized.onnx',
      bytes: 102_868_746,
      sha256: 'b665f3bba56c3119bc76ba131ebcc544d720a7408cb11581bdf354aaa0198d43',
      url: 'https://huggingface.co/Xenova/bge-base-zh-v1.5/resolve/main/onnx/model_quantized.onnx',
    },
    {
      path: 'tokenizer.json',
      bytes: 439_124,
      sha256: '7dfbf1966ebf99d471c3796e9b457329d2b2182b817e144f1e904b957745c839',
      url: 'https://huggingface.co/Xenova/bge-base-zh-v1.5/resolve/main/tokenizer.json',
    },
    {
      path: 'runtime/ort.wasm.min.mjs',
      bytes: 53_725,
      sha256: 'c21d9c326d453a4a61398270c804d5979e118540597cb0c07f7b3d64e6098234',
      url: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/ort.wasm.min.mjs',
    },
    {
      path: 'runtime/ort-wasm-simd-threaded.mjs',
      bytes: 24_738,
      sha256: '30ed0b5cd1182ede931fea448afb567d4dc705ec957af09f108a2be5f770dac3',
      url: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/ort-wasm-simd-threaded.mjs',
    },
    {
      path: 'runtime/ort-wasm-simd-threaded.wasm',
      bytes: 14_848_852,
      sha256: '4b884c203b0fa48d057be3332c65513ff85aa3c5bddd6946acc0fab7ecda001d',
      url: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/ort-wasm-simd-threaded.wasm',
    },
  ]),
});

/** 下载多久没有新字节就算卡住。 */
const STALL_MS = 30_000;
const TRIES = 3;

/** 模型落在哪个目录（不分平台：同一份文件在 Windows 与 macOS 上都能用）。 */
export const embedModelDir = (/** @type {string} */ dataDir) => join(dataDir, 'runtime', 'models', MATERIAL_MODEL.id);

/** 目录里是否已经有完整的模型（文件存在且大小对得上；哈希校验在下一次下载时才做，免得每次启动都读 98 MB）。 */
export const embedModelIn = (/** @type {string} */ dir) => MATERIAL_MODEL.files
  .every((file) => {
    try { return statSync(join(dir, file.path)).size === file.bytes; } catch { return false; }
  });

/** 还缺哪些文件（给进度条与日志用）。 */
export const missingModelFiles = (/** @type {string} */ dir) => MATERIAL_MODEL.files
  .filter((file) => {
    try { return statSync(join(dir, file.path)).size !== file.bytes; } catch { return true; }
  });

/**
 * 确保模型就位：缺什么下什么，每个文件下完先核 sha256，对得上才改名成正式文件。
 *
 * `onProgress({ file, done, total, bytes, overall })`：`overall` 是整包的完成比例（0–1），界面直接乘。
 * 已有且大小正确的文件不再下载 —— 断网重来一遍只补缺的那些。
 *
 * @param {string} dataDir
 * @param {{ onProgress?: (progress: { file: string, bytes: number, total: number, overall: number }) => void,
 *   fetch?: typeof fetch, stallMs?: number, tries?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<{ dir: string, downloaded: string[], present: string[] }>}
 */
export async function ensureEmbedModel(dataDir, {
  onProgress = () => {}, fetch: fetchImpl = fetch, stallMs = STALL_MS, tries = TRIES, signal,
} = {}) {
  const dir = embedModelDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const whole = MATERIAL_MODEL.files.reduce((sum, file) => sum + file.bytes, 0);
  /** @type {string[]} */ const downloaded = [];
  /** @type {string[]} */ const present = [];
  let alreadyDone = 0;
  for (const file of MATERIAL_MODEL.files) {
    const target = join(dir, file.path);
    const there = (() => { try { return statSync(target).size === file.bytes; } catch { return false; } })();
    if (there) {
      present.push(file.path);
      alreadyDone += file.bytes;
      onProgress({ file: file.path, bytes: file.bytes, total: file.bytes, overall: alreadyDone / whole });
      continue;
    }
    mkdirSync(join(target, '..'), { recursive: true });
    const partial = `${target}.part`;
    let lastError = null;
    for (let attempt = 1; attempt <= tries; attempt += 1) {
      try {
        await downloadOne(file, partial, { fetchImpl, stallMs, onProgress: (bytes) => onProgress({
          file: file.path, bytes, total: file.bytes, overall: (alreadyDone + Math.min(bytes, file.bytes)) / whole,
        }), signal });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        rmSync(partial, { force: true });
      }
    }
    if (lastError) throw lastError;
    renameSync(partial, target);
    downloaded.push(file.path);
    alreadyDone += file.bytes;
    onProgress({ file: file.path, bytes: file.bytes, total: file.bytes, overall: alreadyDone / whole });
  }
  return { dir, downloaded, present };
}

/**
 * 一个文件：下到 `.part`，边下边数，sha256 对得上才算成功。
 * @param {{ path: string, url: string, sha256: string, bytes: number }} file @param {string} partial
 * @param {{ fetchImpl: typeof fetch, stallMs: number, signal?: AbortSignal, onProgress: (bytes: number) => void }} options
 */
async function downloadOne(file, partial, { fetchImpl, stallMs, onProgress, signal }) {
  const response = await fetchImpl(file.url, { signal });
  if (!response.ok || !response.body) throw new Error(`${file.url} answered ${response.status}`);
  const hash = createHash('sha256');
  const sink = createWriteStream(partial);
  let bytes = 0;
  /** @type {NodeJS.Timeout | null} */
  let stall = null;
  const arm = () => {
    if (stall) clearTimeout(stall);
    stall = setTimeout(() => {
      try { sink.destroy(new Error(`no bytes for ${Math.round(stallMs / 1000)} s`)); } catch { /* already gone */ }
    }, stallMs);
  };
  arm();
  try {
    for await (const chunk of /** @type {any} */ (response.body)) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      hash.update(buffer);
      if (!sink.write(buffer)) await new Promise((done) => sink.once('drain', done));
      onProgress(bytes);
      arm();
    }
  } finally {
    if (stall) clearTimeout(stall);
    await new Promise((done) => sink.end(done));
  }
  if (bytes !== file.bytes) throw new Error(`${file.path}: got ${bytes} bytes, expected ${file.bytes}`);
  const digest = hash.digest('hex');
  if (digest !== file.sha256) throw new Error(`${file.path}: sha256 ${digest} != ${file.sha256}`);
}

/** 一个文件的 sha256（测试与打包脚本用）。 @param {string} file */
export async function sha256Of(file) {
  const digest = createHash('sha256');
  digest.update(await readFile(file));
  return digest.digest('hex');
}

/** 目录里现在有什么（诊断）：每个文件在不在、多大。 */
export function modelState(dataDir) {
  const dir = embedModelDir(dataDir);
  return {
    dir,
    ready: existsSync(dir) && embedModelIn(dir),
    files: MATERIAL_MODEL.files.map((file) => {
      try { return { path: file.path, bytes: statSync(join(dir, file.path)).size, ok: statSync(join(dir, file.path)).size === file.bytes }; } catch { return { path: file.path, bytes: 0, ok: false }; }
    }),
  };
}
