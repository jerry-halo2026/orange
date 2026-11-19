// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * 把发布出来的向量包拉到本机，**只补变了的那几块**。
 *
 * 语料每天有几条新增；向量包 98.4 MB，整包重下就是每天 98 MB × 每个客户端。所以发布侧切成 8 MB 一块、
 * 清单里给出每块的 sha256（`scripts/material-pack-publish.mjs`），这一侧：
 *
 *   1. 取清单 `materials.json`（版本、维度、行数、每块的大小与哈希）；
 *   2. 本地已经是这个版本、每块都在且大小对 → 一次下载都不做；
 *   3. 否则逐块比 sha256：对得上的留在原地，只下变了的；
 *   4. 按序拼成 `vectors.f16`，核对整份 sha256 与 keys.txt，再写 `pack.json`。
 *
 * 拼装是必要的：排序那一侧（`src/material-pack.mjs`）读的就是一整份 `vectors.f16`，一次 98 MB 的顺序写
 * 比让读取侧处理分块便宜得多。
 *
 * 版本号来自内容（`scripts/material-vector-pack.mjs` 用行数 + 模型 + 向量哈希前 12 位算的），所以"版本相同"
 * 就是"内容相同"，不需要再比时间戳。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 清单的文件名（放在发布根上）。 */
export const MANIFEST_NAME = 'materials.json';

/** 包落在哪：`<dataDir>/materials/pack` —— 与 `material-search.mjs` 的默认包目录一致。 */
export const packDirectory = (/** @type {string} */ dataDir) => join(dataDir, 'materials', 'pack');

/** 本地现在是什么状态（诊断与"要不要更新"的判断）。 */
export function packState(/** @type {string} */ dataDir) {
  const dir = packDirectory(dataDir);
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'pack.json'), 'utf8'));
    return { dir, version: String(manifest.version ?? ''), ready: existsSync(join(dir, 'vectors.f16')), manifest };
  } catch {
    return { dir, version: '', ready: false, manifest: null };
  }
}

const digestOf = (/** @type {Buffer | string} */ data) => createHash('sha256').update(data).digest('hex');
const fileDigest = (/** @type {string} */ file) => digestOf(readFileSync(file));

/**
 * 确保向量包与发布的一致。
 *
 * @param {string} dataDir
 * @param {{ baseUrl: string, onProgress?: (progress: { phase: 'manifest' | 'chunk' | 'assemble', done: number, total: number, bytes: number, overall: number }) => void,
 *   fetch?: typeof fetch, signal?: AbortSignal, force?: boolean }} options
 * @returns {Promise<{ dir: string, version: string, downloaded: number[], reused: number, changed: boolean }>}
 */
export async function ensureVectorPack(dataDir, {
  baseUrl, onProgress = () => {}, fetch: fetchImpl = fetch, signal, force = false,
}) {
  const root = String(baseUrl ?? '').replace(/\/+$/, '');
  /* 发布时既可以写绝对地址（CDN），也可以写相对路径（把 dist/materials 整个放到根上）——这里两种都认 */
  const absolute = (/** @type {string} */ url) => (/^https?:/i.test(url) ? url : `${root}/${String(url).replace(/^\/+/, '')}`);
  if (!root) throw new Error('ensureVectorPack needs the address the pack is published at');
  const dir = packDirectory(dataDir);
  mkdirSync(join(dir, 'chunks'), { recursive: true });

  /* ① 清单 */
  const manifestResponse = await fetchImpl(`${root}/${MANIFEST_NAME}`, { signal });
  if (!manifestResponse.ok) throw new Error(`${root}/${MANIFEST_NAME} answered ${manifestResponse.status}`);
  /** @type {any} */
  const remote = await manifestResponse.json();
  if (!remote?.version || !Array.isArray(remote?.chunks) || !Number.isInteger(remote?.dims)) {
    throw new Error(`${MANIFEST_NAME} is not a pack manifest`);
  }
  onProgress({ phase: 'manifest', done: 1, total: 1, bytes: 0, overall: 0 });

  const local = packState(dataDir);
  const sameVersion = !force && local.version === remote.version && local.ready;
  const totalChunks = remote.chunks.length;
  const totalBytes = remote.chunks.reduce((/** @type {number} */ sum, /** @type {any} */ chunk) => sum + chunk.bytes, 0);

  /* ② 已经是最新、且每块都在 —— 一次都不下 */
  if (sameVersion) {
    const intact = remote.chunks.every((/** @type {any} */ chunk) => {
      try { return statSync(join(dir, 'chunks', chunkName(chunk.index))).size === chunk.bytes; } catch { return false; }
    });
    if (intact) return { dir, version: remote.version, downloaded: [], reused: totalChunks, changed: false };
  }

  /* ③ 逐块比哈希，只下变了的 */
  /** @type {number[]} */
  const downloaded = [];
  let reused = 0;
  let doneBytes = 0;
  for (const chunk of remote.chunks) {
    const file = join(dir, 'chunks', chunkName(chunk.index));
    let reusedHere = false;
    try {
      if (statSync(file).size === chunk.bytes && fileDigest(file) === chunk.sha256) reusedHere = true;
    } catch { reusedHere = false; }
    if (reusedHere) {
      reused += 1;
      doneBytes += chunk.bytes;
      onProgress({ phase: 'chunk', done: chunk.index + 1, total: totalChunks, bytes: chunk.bytes, overall: doneBytes / totalBytes });
      continue;
    }
    const response = await fetchImpl(absolute(chunk.url ?? `pack/${remote.version}/chunks/${chunkName(chunk.index)}`), { signal });
    if (!response.ok) throw new Error(`chunk ${chunk.index} answered ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length !== chunk.bytes) throw new Error(`chunk ${chunk.index}: ${body.length} bytes, expected ${chunk.bytes}`);
    if (digestOf(body) !== chunk.sha256) throw new Error(`chunk ${chunk.index}: sha256 mismatch`);
    const partial = `${file}.part`;
    writeFileSync(partial, body);
    renameSync(partial, file);
    downloaded.push(chunk.index);
    doneBytes += chunk.bytes;
    onProgress({ phase: 'chunk', done: chunk.index + 1, total: totalChunks, bytes: chunk.bytes, overall: doneBytes / totalBytes });
  }

  /* ④ 拼装 + 整份核对 */
  onProgress({ phase: 'assemble', done: 0, total: 1, bytes: 0, overall: 1 });
  const vectors = Buffer.alloc(remote.vectors?.bytes ?? totalBytes);
  let at = 0;
  for (const chunk of remote.chunks) {
    const piece = readFileSync(join(dir, 'chunks', chunkName(chunk.index)));
    piece.copy(vectors, at);
    at += piece.length;
  }
  if (remote.vectors?.sha256 && digestOf(vectors) !== remote.vectors.sha256) {
    /* 拼出来的整份对不上：清掉块，下一次从头来（免得一直在错的块上打转） */
    rmSync(join(dir, 'chunks'), { recursive: true, force: true });
    throw new Error('the assembled vectors do not match the manifest sha256');
  }
  if (remote.keys?.url) {
    const keysResponse = await fetchImpl(absolute(remote.keys.url), { signal });
    if (!keysResponse.ok) throw new Error(`keys.txt answered ${keysResponse.status}`);
    const keys = Buffer.from(await keysResponse.arrayBuffer());
    if (digestOf(keys) !== remote.keys.sha256) throw new Error('keys.txt sha256 mismatch');
    writeFileSync(join(dir, 'keys.txt'), keys);
  } else if (remote.keys?.bytes) {
    throw new Error('the manifest names keys.txt without a url');
  }
  const partialVectors = join(dir, 'vectors.f16.part');
  writeFileSync(partialVectors, vectors);
  renameSync(partialVectors, join(dir, 'vectors.f16'));
  writeFileSync(join(dir, 'pack.json'), `${JSON.stringify({
    version: remote.version, model: remote.model, dims: remote.dims, rows: remote.rows,
    quantization: remote.quantization, byteOrder: remote.byteOrder, analyzerVer: remote.analyzerVer,
    column: remote.column, builtAt: remote.builtAt, publishedAt: remote.publishedAt,
    files: [
      { path: 'vectors.f16', bytes: vectors.length, sha256: remote.vectors?.sha256 ?? digestOf(vectors) },
      { path: 'keys.txt', bytes: readFileSync(join(dir, 'keys.txt')).length, sha256: remote.keys?.sha256 ?? '' },
    ],
  }, null, 1)}\n`);
  onProgress({ phase: 'assemble', done: 1, total: 1, bytes: 0, overall: 1 });
  return { dir, version: remote.version, downloaded, reused, changed: true };
}

/** 块的文件名（补零：目录里按名字排序就是按序）。 @param {number} index */
const chunkName = (index) => `${String(index).padStart(3, '0')}.bin`;

/** 本机已经下了哪些块（诊断用）。 @param {string} dataDir */
export function localChunks(/** @type {string} */ dataDir) {
  try {
    return readdirSync(join(packDirectory(dataDir), 'chunks')).filter((name) => name.endsWith('.bin')).sort();
  } catch {
    return [];
  }
}
