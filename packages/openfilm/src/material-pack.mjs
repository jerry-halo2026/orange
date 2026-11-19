// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * 客户端自己的排序：包里带着每条素材的向量，检索时在这里做余弦扫描 —— 没有数据库、没有服务、没有网络。
 *
 * # 包里有什么（`scripts/material-vector-pack.mjs` 打的）
 *
 *   vectors.f16   行序 = keys.txt 的行序，fp16 小端
 *   keys.txt      每行一个 media_key
 *   pack.json     版本、维度、行数、两个文件的 sha256
 *
 * # 为什么是暴力扫描
 *
 * 67 156 × 768 的精确余弦在本机 JavaScript 里是 **41–59 ms**（实测，Float32Array 顺序访问），而 HNSW 那套索引
 * 要多带一份图结构、要处理召回损失、还要随向量增量重建。客户端一秒钟查几次的量级上，精确扫描既简单又更准。
 *
 * # 内存
 *
 * 解成 Float32 是 197 MB（67 156 × 768 × 4），一次性、进程内常驻；也可以不解码、在 fp16 上现算（省一半内存、
 * 慢一倍）。默认解码 —— 卡顿在第一次查询比在每次查询更难被注意到，而 197 MB 在桌面客户端是可接受的。
 *
 * 包不在（还没下载完）、版本对不上、文件被截断 → `readPack` 返回 null，调用方退到词法/索引，不抛给用户。
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * fp16（小端）→ Float32Array。手写在 `material-vector-pack.mjs` 里编码、这里解码，两边都由
 * `material-vector-pack.test.mjs` 的往返测试守着。
 * @param {Buffer} buffer @param {number} rows @param {number} dims
 */
export function decodeFloat16(buffer, rows, dims) {
  const out = new Float32Array(rows * dims);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  for (let i = 0; i < out.length; i += 1) {
    const bits = view.getUint16(i * 2, true);
    const sign = bits & 0x8000 ? -1 : 1;
    const exponent = (bits >>> 10) & 0x1f;
    const mantissa = bits & 0x3ff;
    out[i] = exponent === 0
      ? sign * mantissa * 2 ** -24
      : exponent === 0x1f
        ? (mantissa ? NaN : sign * Infinity)
        : sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
  }
  return out;
}

/**
 * 读一个包；缺文件、字节数不符、维度不认识 → null（调用方降级，不抛给用户）。
 * @param {string} dir
 * @returns {{ version: string, model: string, dims: number, rows: number, keys: string[],
 *   names: (string[][] | null), vectors: Float32Array } | null}
 * `names` is one row per `names.tsv` line (`media_key / name / batch / product / gname`), so string[][].
 */
export function readPack(dir) {
  if (!dir) return null;
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'pack.json'), 'utf8'));
    const dims = Number(manifest?.dims);
    const rows = Number(manifest?.rows);
    if (!Number.isInteger(dims) || !Number.isInteger(rows) || dims <= 0 || rows <= 0) return null;
    const vectorFile = manifest?.files?.find((/** @type {any} */ file) => file?.path === 'vectors.f16');
    const keyFile = manifest?.files?.find((/** @type {any} */ file) => file?.path === 'keys.txt');
    if (!vectorFile || !keyFile) return null;
    if (statSync(join(dir, 'vectors.f16')).size !== vectorFile.bytes) return null;
    if (statSync(join(dir, 'keys.txt')).size !== keyFile.bytes) return null;
    const keys = readFileSync(join(dir, 'keys.txt'), 'utf8').split('\n').filter(Boolean);
    if (keys.length !== rows) return null;
    const vectors = decodeFloat16(readFileSync(join(dir, 'vectors.f16')), rows, dims);
    /* names.tsv 可选：media_key / name / batch / product / gname，与 keys 同序。老包没有它就是 null。 */
    let names = null;
    try {
      const lines = readFileSync(join(dir, 'names.tsv'), 'utf8').split('\n').filter(Boolean);
      if (lines.length === rows) names = lines.map((line) => line.split('\t'));
    } catch { names = null; }
    return {
      version: String(manifest.version ?? ''),
      model: String(manifest.model ?? ''),
      dims, rows, keys, names, vectors,
    };
  } catch {
    return null;
  }
}

/**
 * 前 `count` 名（不排全表：67k 的排序里我们只要头 20，用一次插入选择就够了）。
 * @param {Float32Array} scores @param {number} count @param {number[] | null} allowed 允许的下标（结构化过滤后的候选）；null 不限
 * @returns {{ index: number, score: number }[]}
 */
export function topScores(scores, count, allowed = null) {
  /** @type {{ index: number, score: number }[]} */
  const best = [];
  const consider = (/** @type {number} */ index) => {
    const score = scores[index];
    if (Number.isNaN(score)) return;
    if (best.length === count && score <= best[best.length - 1].score) return;
    let at = best.length;
    while (at > 0 && best[at - 1].score < score) at -= 1;
    best.splice(at, 0, { index, score });
    if (best.length > count) best.pop();
  };
  if (allowed) for (const index of allowed) consider(index);
  else for (let index = 0; index < scores.length; index += 1) consider(index);
  return best;
}

/**
 * 一个包的检索器：`embed(query)` → 768 个数 → 与每行点积（向量都归一化过，点积即余弦）→ 前 N 行。
 *
 * @param {{ dir: string, embed: (query: string) => Promise<number[]>, cacheSize?: number }} options
 * @returns {(query: string, request?: { limit?: number, allowed?: string[] | null }) =>
 *   Promise<{ mode: 'pack', query: string, count: number, items: { mediaKey: string, score: number }[] } | null>}
 */
export function createPackSearch({ dir, embed, cacheSize = 64 }) {
  /** @type {ReturnType<typeof readPack> | undefined} */
  let pack;
  const limit = Number.isInteger(cacheSize) && cacheSize > 0 ? cacheSize : 0;
  /** @type {Map<string, number[]>} */
  const cache = new Map();

  const loaded = () => {
    if (pack === undefined) pack = readPack(dir);
    return pack;
  };

  return async (query, request = {}) => {
    /* destructured default keeps `asked` a number: `limit` is optional on the request object */
    const { limit: asked = 0 } = request;
    const wanted = Number.isInteger(asked) && asked > 0 ? Math.min(asked, 200) : 20;
    const text = String(query ?? '').trim();
    const loadedPack = loaded();
    if (!loadedPack) return null;
    if (!text) return null;

    /** @type {number[]} */
    let vector;
    const key = `${loadedPack.version}\u0000${text}`;
    const hit = limit > 0 ? cache.get(key) : null;
    if (hit) {
      cache.delete(key);
      cache.set(key, hit);
      vector = hit;
    } else {
      vector = await embed(text);
      if (limit > 0) {
        cache.set(key, vector);
        if (cache.size > limit) {
          /* `keys().next().value` is typed `string | undefined`; the cache is non-empty here, so the key exists. */
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
      }
    }
    if (vector.length !== loadedPack.dims) {
      throw Object.assign(new Error(`this pack is ${loadedPack.dims} dimensions, the query is ${vector.length}`), { code: 'pack-dims' });
    }

    /* 结构化过滤：调用方给一批允许的 media_key，只在这些行里挑（包本身不带分类信息） */
    let allowed = null;
    if (Array.isArray(request.allowed)) {
      const indexOf = new Map(loadedPack.keys.map((mediaKey, index) => [mediaKey, index]));
      allowed = request.allowed.map((mediaKey) => indexOf.get(mediaKey)).filter((index) => typeof index === 'number');
      if (!allowed.length) return { mode: 'pack', query: text, count: 0, items: [] };
    }

    const scores = new Float32Array(loadedPack.rows);
    for (let row = 0; row < loadedPack.rows; row += 1) {
      let sum = 0;
      const base = row * loadedPack.dims;
      for (let k = 0; k < loadedPack.dims; k += 1) sum += loadedPack.vectors[base + k] * vector[k];
      scores[row] = sum;
    }
    const best = topScores(scores, wanted, allowed);
    return {
      mode: 'pack',
      query: text,
      count: best.length,
      items: best.map(({ index, score }) => ({
        mediaKey: loadedPack.keys[index],
        score,
        /* 包里带名字时一并给出（没有就是空串，绝不编） */
        name: loadedPack.names?.[index]?.[1] ?? '',
        batch: loadedPack.names?.[index]?.[2] ?? '',
        product: loadedPack.names?.[index]?.[3] ?? '',
        gname: loadedPack.names?.[index]?.[4] ?? '',
      })),
    };
  };
}

/**
 * 向量包里的名字：`media_key → 云管家给的那名字`，按 `names.tsv` 的 mtime 缓存。
 *
 * 为什么下载命名要用它：素材落地时文件名取"这一条叫什么"，而这个信息在包里（`names.tsv`）就有。
 * 之前读的是落地索引（`material-index/index.json`）—— 那份索引一旦被清空或与语料不是同一快照，
 * 名字就查不到，文件只好退回 `<videoId>.mp4`，用户看到的就是一墙数字。
 *
 * 没有 `names.tsv`（老包）时 `nameOf` 一律 null，调用方自己回退，不编名字。
 *
 * @param {string} dir
 * @returns {{ file: string, nameOf: (mediaKey: string) => string | null, size: () => number }}
 */
export function createPackNames(dir) {
  const file = join(dir, 'names.tsv');
  /** @type {Map<string, string> | null} */
  let table = null;
  let stamp = '';
  const read = () => {
    let current = '';
    try { const info = statSync(file); current = `${info.mtimeMs}:${info.size}`; } catch { current = ''; }
    if (!current) { table = null; stamp = ''; return null; }
    if (!table || stamp !== current) {
      const map = new Map();
      try {
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          if (!line) continue;
          const at = line.indexOf('\t');
          if (at <= 0) continue;
          const name = line.slice(at + 1).split('\t')[0].trim();
          if (name) map.set(line.slice(0, at), name);
        }
        table = map;
        stamp = current;
      } catch { table = null; stamp = ''; return null; }
    }
    return table;
  };
  return {
    file,
    /** 这一条叫什么；不知道就是 null。 @param {string} mediaKey */
    nameOf(mediaKey) {
      if (typeof mediaKey !== 'string' || !mediaKey) return null;
      const map = read();
      return map?.get(mediaKey) ?? null;
    },
    /** 包里有多少条名字（0 表示没有 names.tsv）。 */
    size() { return read()?.size ?? 0; },
  };
}