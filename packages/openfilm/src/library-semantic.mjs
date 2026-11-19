// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * Semantic search of the library, run **here**: what a thing is (`passageOf`) turned into a vector by the same model the
 * material search uses (bge-base-zh-v1.5, `./local-embedder.mjs`), compared by cosine against `library/vectors.i8`.
 *
 * 之前这一层是"服务端算"：`POST /v1/library/search` 在 openfilm.dev 上跑 e5，这台机器只保留目录。现在不这样了 ——
 *
 *   - 云端向量库已经删掉，没有理由为一个检索再养一个服务；
 *   - 客户端已经必须带 bge-base-zh（素材检索要它），元素库复用它＝**不多一次下载**；
 *   - 同一条查询向量能在两个空间里比（元素与素材），agent 拿到的是同一套语料的理解。
 *
 * 代价是一次性的：`scripts/library-vectors.mjs` 用 bge-base-zh 重算 `vectors.i8`（8 718 条，约 7 分钟）。
 *
 * 关掉这条路（Settings → Services: Library search = None，或 `libraryOff`）就只剩关键词检索，
 * 与以前一致；隔离配置（`isolationRequested()`）下**不读也不发**任何查询文本。
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { builtInRoot } from '../studio/server/library.mjs';
import { readSettings } from '../studio/server/keys.mjs';
import { isolationRequested } from './development-isolation.mjs';
import { LOCAL_EMBED_MODEL, createLocalEmbedder } from './local-embedder.mjs';

/** 一次检索最多等这么久（本机模型已经在内存里时是毫秒级；这里只是防呆）。 */
export const SEARCH_TIMEOUT_MS = 2500;

/** 进程内一个嵌入器：模型加载一次，查询向量自带 LRU。 */
let embedding = null;
/** The embedder this process uses (the vector builder imports it too, so both sides can never drift). */
export function embedder() {
  embedding ??= createLocalEmbedder();
  return embedding;
}

/**
 * The model's manifest — kept for the callers that ask "which model made these vectors": it is read from
 * `library/vectors.json`, which the vector builder writes beside `vectors.i8`.
 * @returns {{ model: string, dims: number } | null}
 */
export function manifest() {
  try {
    const parsed = JSON.parse(readFileSync(join(builtInRoot(), 'vectors.json'), 'utf8'));
    return { model: String(parsed.model ?? ''), dims: Number(parsed.dims ?? 0) };
  } catch {
    return null;
  }
}

/* ── the things' vectors ─────────────────────────────────────────────────────────────────────────────────────── */

/**
 * What a thing is, in the words its vector is made from: its category, names (English and Chinese), what it is about,
 * its group, its tags (English and Chinese), how lively it is and its tempo.
 * @param {{ cat: string, group: string, name: Record<string, string>, about?: string, tags?: string[], energy?: number, bpm?: number }} item
 * @param {{ byId: Map<string, { name: Record<string, string> }> }} vocab the tags (library-words.mjs vocabulary)
 * @param {{ name: Record<string, string> } | undefined} group
 */
export function passageOf(item, vocab, group) {
  const tags = (item.tags ?? []).map((t) => vocab.byId.get(t)?.name).filter(Boolean);
  const lively = ['', 'very calm', 'calm', 'moderate', 'lively', 'very energetic'][item.energy ?? 0] ?? '';
  return [`passage: ${item.cat}: ${item.name.en} (${item.name['zh-CN']}).`, item.about ?? '', group ? `${group.name.en}.` : '',
    tags.length ? `${tags.map((n) => n?.en).join(', ')}. ${tags.map((n) => n?.['zh-CN']).join('，')}.` : '',
    [lively, item.bpm ? `${item.bpm} bpm` : ''].filter(Boolean).join(', ')].filter(Boolean).join(' ');
}

/**
 * `vectors.i8` / `vectors.json` 读进内存：int8 值 × 每行 scale 就是原向量，行序与 `ids` 一致。
 * 按文件 mtime 缓存 —— 重算一次、下次读到的就是新的，不用重启。
 * @returns {{ dims: number, model: string, ids: string[], cats: string[], scales: number[], values: Int8Array,
 *   norms: Float32Array } | null}
 */
export function loadVectors({ root = builtInRoot() } = {}) {
  const index = join(root, 'vectors.json');
  const binary = join(root, 'vectors.i8');
  /** @type {{ dims: number, model: string, ids: string[], cats: string[], scales: number[], values: Int8Array, norms: Float32Array } | null} */
  let cached = ready.stamp === `${statSync(index).mtimeMs}:${statSync(binary).mtimeMs}` ? ready.vectors : null;
  if (cached) return cached;
  try {
    const parsed = JSON.parse(readFileSync(index, 'utf8'));
    const dims = Number(parsed?.dims);
    const ids = Array.isArray(parsed?.ids) ? parsed.ids.map(String) : [];
    const cats = Array.isArray(parsed?.cats) ? parsed.cats.map(String) : [];
    const scales = Array.isArray(parsed?.scales) ? parsed.scales.map(Number) : [];
    const values = new Int8Array(readFileSync(binary));
    if (!Number.isInteger(dims) || dims <= 0) return null;
    if (values.length !== ids.length * dims || cats.length !== ids.length || scales.length !== ids.length) return null;
    const norms = new Float32Array(ids.length);
    for (let row = 0; row < ids.length; row += 1) {
      let sum = 0;
      const base = row * dims;
      for (let k = 0; k < dims; k += 1) {
        const value = values[base + k] * scales[row];
        sum += value * value;
      }
      norms[row] = Math.sqrt(sum) || 1;
    }
    cached = { dims, model: String(parsed.model ?? ''), ids, cats, scales, values, norms };
    ready.stamp = `${statSync(index).mtimeMs}:${statSync(binary).mtimeMs}`;
    ready.vectors = cached;
    return cached;
  } catch {
    return null;
  }
}

/** The vectors last read, and the file stamp they were read at. */
const ready = { stamp: '', vectors: /** @type {ReturnType<typeof loadVectors>} */ (null) };

/**
 * 最接近 `query` 的那些东西：本机算，`[id, cosine]`，余弦降序，最多 `limit` 条；`cat` 只在该类别里挑。
 * 模型没有 / 目录没有 / 关掉了 → null（调用方退到关键词检索）。
 *
 * @param {string} query @param {string} cat @param {number} [limit]
 * @returns {Promise<[string, number][] | null>}
 */
export async function nearest(query, cat, limit = 50) {
  /* 隔离配置下不读设置、不算向量：宁可只有关键词，也不让查询文本多走一步 */
  if (isolationRequested()) return null;
  if ((await readSettings()).libraryOff) return null;
  const text = String(query ?? '').trim();
  if (!text) return null;
  const vectors = loadVectors();
  if (!vectors) return null;
  if (vectors.model && vectors.model !== LOCAL_EMBED_MODEL) {
    /* 向量是用别的模型算的：比出来的名次没有意义，老实退回关键词 */
    return null;
  }
  /** @type {number[]} */
  let vector;
  try {
    vector = await embedder()(text);
  } catch {
    return null;
  }
  if (vector.length !== vectors.dims) return null;

  /** @type {{ id: string, score: number }[]} */
  const best = [];
  for (let row = 0; row < vectors.ids.length; row += 1) {
    if (vectors.cats[row] !== cat) continue;
    const base = row * vectors.dims;
    const scale = vectors.scales[row];
    let dot = 0;
    for (let k = 0; k < vectors.dims; k += 1) dot += vectors.values[base + k] * scale * vector[k];
    const score = dot / vectors.norms[row];
    if (best.length < limit || score > best[best.length - 1].score) {
      let at = best.length;
      while (at > 0 && best[at - 1].score < score) at -= 1;
      best.splice(at, 0, { id: vectors.ids[row], score });
      if (best.length > limit) best.pop();
    }
  }
  return best.map((hit) => [hit.id, hit.score]);
}
