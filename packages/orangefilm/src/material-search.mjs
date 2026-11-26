// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * One query, three routes to an answer: the vector RPC, its lexical half, and — when the database cannot be asked at all
 * — what the landed index still says.
 *
 * `docs/sql/012_media_doc.sql` owns `media_search(p_company_key, p_query, p_filters, p_embedding, p_limit)`: 78 874
 * asset documents with a 768-dimension vector each, three matching branches (vector / ILIKE / trigram) merged by
 * `media_key`. It deliberately answers **no local availability** — which byte is on which computer is not a database
 * fact. So this module answers the part the database can answer, and `studio/server/material-search-route.mjs` adds
 * the part this computer can (`content/<md5>` on disk).
 *
 * # The three degradations, each said out loud
 *
 * The answer carries `mode`, and `mode` is the whole story of how it was obtained — never a silent substitute:
 *
 *  1. `vector` — the embedder answered and the RPC was asked with `p_embedding`. The database decides the match
 *     (`match_kind` on every row says which branch found it).
 *  2. `lexical` — the embedder threw, timed out, or is not configured here: `p_embedding` is `null` and the RPC runs
 *     its two lexical branches only. **A lexical answer is not dressed up as a semantic one.**
 *  3. `index` — the RPC itself failed (no database, no such function, a broken session): the query is matched against
 *     the names in `material-index.mjs`'s landed index (`materialIds` scopes a collection, a name has to *contain* the
 *     words). Scores here are this module's own (`INDEX_SCORES`), not the database's.
 *
 * Nothing is ever invented: no match is `{ count: 0, items: [] }` with the mode the attempt reached, and the mode does
 * not change just because the answer is empty.
 *
 * # Why `embed` / `call` / `index` are injected
 *
 * The same function has to run in three places with three different transports (the Studio server's own process, the
 * MCP server's stdio process, and a test with no database at all). They are dependencies here and nothing else: a test
 * passes a function that returns a vector, another that returns rows, and one that throws — three lines, no database.
 * `createEmbedder` / `createMediaSearchCall` below are the real ones, written once so the server and the agent cannot
 * disagree about the endpoint, the model, the SQL or the parse.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultIndexDir, readMaterialIndex } from './material-index-build.mjs';
import { materialIds } from './material-index.mjs';
import { createPackSearch } from './material-pack.mjs';
import { sharedHome } from './locations.mjs';

/** The vector width the table declares (`vector(768)`, 012:563 asserts the typmod). Anything else is refused there. */
export const EMBED_DIMS = 768;
/** This machine's LM Studio: `:1235`, not the default `:1234` (`analyze-runner.mjs` says why). */
export const DEFAULT_EMBED_ENDPOINT = 'http://127.0.0.1:1235/v1/embeddings';
export const DEFAULT_EMBED_MODEL = 'text-embedding-nomic-embed-text-v1.5';
/** How long one embedding may take before the answer is lexical instead. */
export const DEFAULT_EMBED_TIMEOUT_MS = 20_000;

/**
 * 客户端自带的嵌入模型：bge-base-zh-v1.5，768 维 —— 与 `EMBED_DIMS` 正好同宽，不需要截断。
 *
 * 为什么是它（全量 67 156 条、200 题、同一份语料）：recall@20 **90.5%**、同组命中 **100.0%**、查询编码
 * p50 78 ms；bge-m3 是 83.0% / 98.0% / 407 ms（543 MB），bge-small-zh 是 76.5% / 100.0% / 11 ms（23 MB）。
 * 取向量方式是 **CLS**，分词是 **WordPiece**（`./wordpiece.mjs`）—— 用错不报错，只会静默换到另一个向量空间。
 */
export const LOCAL_EMBED_MODEL = 'bge-base-zh-v1.5';
/**
 * 向量包放在哪：<shared home>/materials/pack。装好客户端之后它就是这个位置 —— 不需要环境变量，
 * 也不需要用户配置；ORANGE_MATERIAL_PACK 只是给测试与非常规布局用的覆盖。
 * 包不在时 createPackSearch 仍然构造，但 eadPack 回 null、检索退到 RPC / 索引，不会出错。
 */
export const DEFAULT_PACK_DIR = () => join(sharedHome(), 'materials', 'pack');

/** The RPC this module asks, and the only one it knows how to ask. */
export const SEARCH_RPC = 'media_search';

/** The filters `media_search` honours — anything else a caller invents is dropped, as the SQL says (012:390). */
export const FILTER_KEYS = Object.freeze(['batch', 'product', 'gname', 'durationMaxMs', 'sourceKind']);

/** How many rows an answer may carry, and what a caller gets when it asks for no number. */
export const MATERIAL_SEARCH_CAPS = Object.freeze({ limit: 50, defaultLimit: 10 });

/**
 * The same two numbers under the contract's names (`docs/contracts/mcp-tools.schema.json`: `rows` / `defaultRows`), so
 * the schema and this file can be compared without a reader guessing which key is which.
 */
export const MATERIAL_SEARCH_CAPS_CONTRACT = Object.freeze({
  rows: MATERIAL_SEARCH_CAPS.limit, defaultRows: MATERIAL_SEARCH_CAPS.defaultLimit,
});

/** What `mode` may be, in the order the attempts are made. */
export const SEARCH_MODES = Object.freeze(['vector', 'lexical', 'index']);

/**
 * The index branch's scores. Not the database's numbers and not comparable with them: they only order *this* answer
 * (a name that opens with the words beats a name that merely contains them), and `matchKind` says `index`.
 */
export const INDEX_SCORES = Object.freeze({ prefix: 1, contains: 0.75, words: 0.5 });

/** The compose file the local database is reached through (`infra/docker-compose.yml`, this checkout's own). */
export const DEFAULT_COMPOSE_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'infra', 'docker-compose.yml');
export const DEFAULT_DB_SERVICE = 'db';
export const DEFAULT_DB_USER = 'postgres';
export const DEFAULT_DB_NAME = 'orange';
export const DEFAULT_PSQL_TIMEOUT_MS = 30_000;

/** An error with the code a caller branches on. @param {string} code @param {string} message @param {Record<string, unknown>} [extra] */
const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

/** A tenant this module will put in SQL: a company key is a token, never a sentence. @param {unknown} value */
export const isTenantKey = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.trim());

/** A row count a caller may ask for: 1..50, the default when it says nothing usable. @param {unknown} value */
export function limitOf(value) {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
  if (!Number.isInteger(number) || number < 1) return MATERIAL_SEARCH_CAPS.defaultLimit;
  return Math.min(number, MATERIAL_SEARCH_CAPS.limit);
}

/**
 * The filters as the RPC takes them: only the five keys it reads, numbers as numbers, empty strings dropped (an empty
 * `batch` is "no batch filter", not "batch = ''").
 * @param {Record<string, unknown> | null | undefined} filters
 */
export function normaliseFilters(filters) {
  /** @type {Record<string, string | number>} */
  const out = {};
  for (const key of FILTER_KEYS) {
    const value = filters?.[key];
    if (key === 'durationMaxMs') {
      const number = Number(value);
      if (Number.isFinite(number) && number >= 0) out.durationMaxMs = Math.trunc(number);
      continue;
    }
    if (typeof value === 'string' && value.trim()) out[key] = value.trim();
  }
  return out;
}

/** A 768-dimension vector of finite numbers, or it is not one. @param {unknown} value */
export const isEmbedding = (value) => Array.isArray(value)
  && value.length === EMBED_DIMS
  && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry));

/**
 * One RPC row → the row an agent reads. The database's names (`media_key`, `video_id`, `gname`…) become the tool's
 * (`mediaKey`, `videoId`, `gname`), and nothing else is added: this is the whole contract of an item.
 * @param {any} row
 */
export function itemOf(row) {
  if (!row || typeof row !== 'object') return null;
  const mediaKey = typeof row.media_key === 'string' && row.media_key ? row.media_key
    : typeof row.video_id === 'string' && row.video_id ? row.video_id : '';
  const videoId = typeof row.video_id === 'string' ? row.video_id : typeof row.videoId === 'string' ? row.videoId : '';
  if (!mediaKey && !videoId) return null;
  const text = (/** @type {unknown} */ value) => (typeof value === 'string' ? value : null);
  return {
    mediaKey: mediaKey || videoId,
    videoId,
    name: typeof row.name === 'string' ? row.name : '',
    batch: text(row.batch),
    product: text(row.product),
    gname: text(row.gname),
    durationMs: Number.isFinite(row.duration_ms) ? Number(row.duration_ms) : null,
    score: Number.isFinite(row.score) ? Number(row.score) : null,
    matchKind: typeof row.match_kind === 'string' ? row.match_kind : 'unknown',
  };
}

/** 落地索引的 `videoId → 那一行`，按文件戳缓存：每次检索重建 7.8 万行是不必要的。 */
let idCache = { stamp: '', rows: /** @type {Map<string, any> | null} */ (null) };
function indexRowsById(landed) {
  const stamp = JSON.stringify(landed?.builtAt ?? landed?.index?.builtAt ?? '') + ':' + (landed?.index ? 'tree' : 'plain');
  if (idCache.rows && idCache.stamp === stamp) return idCache.rows;
  const rows = new Map();
  for (const row of indexRows(landed)) rows.set(row.videoId, row);
  idCache = { stamp, rows };
  return rows;
}
/**
 * The landed index's rows, flat: every entry with the batch / collection / group it sits in, and the unclassified pool
 * at the end (it has no tree position, so those three fields are empty strings — not invented ids).
 * @param {any} landed the envelope `readMaterialIndex` returns, or the tree itself
 */
export function indexRows(landed) {
  const tree = landed?.index ?? landed ?? {};
  /** @type {{videoId: string, name: string, batch: string, product: string, productName: string, gname: string}[]} */
  const rows = [];
  for (const batch of tree.batches ?? []) {
    for (const product of batch?.products ?? []) {
      for (const group of product?.groups ?? []) {
        const entries = Array.isArray(group?.entries)
          ? group.entries
          : (Array.isArray(group?.videoIds) ? group.videoIds : []).map((/** @type {any} */ id) => ({ videoId: id, name: '' }));
        for (const entry of entries) {
          const videoId = typeof entry?.videoId === 'string' ? entry.videoId : String(entry?.videoId ?? '');
          if (!videoId) continue;
          rows.push({
            videoId,
            name: typeof entry?.name === 'string' ? entry.name : '',
            batch: typeof batch?.id === 'string' ? batch.id : '',
            product: typeof product?.id === 'string' ? product.id : '',
            productName: typeof product?.name === 'string' ? product.name : '',
            gname: typeof group?.name === 'string' ? group.name : '',
          });
        }
      }
    }
  }
  for (const entry of tree.unclassified ?? []) {
    const videoId = typeof entry?.videoId === 'string' ? entry.videoId : String(entry?.videoId ?? '');
    if (!videoId) continue;
    rows.push({ videoId, name: typeof entry?.name === 'string' ? entry.name : '', batch: '', product: '', productName: '', gname: '' });
  }
  return rows;
}

/**
 * The index branch: names that contain the query. A query of several words is one filter — every word has to appear —
 * and the score says how they appear (see `INDEX_SCORES`). A collection named in `filters.product` is scoped through
 * `materialIds` first, so this branch and `material.items` agree about what a collection is.
 *
 * @param {{ landed: any, query: string, filters?: Record<string, unknown>, limit?: number }} request
 */
export function searchIndex({ landed, query, filters = {}, limit = MATERIAL_SEARCH_CAPS.defaultLimit }) {
  const text = typeof query === 'string' ? query.trim() : '';
  if (!text || !landed) return [];
  const where = normaliseFilters(filters);
  const words = text.split(/\s+/).filter(Boolean).map((word) => word.toLowerCase());
  const tree = landed?.index ?? landed;
  /* the collection the caller named, when the index knows it: `materialIds` is the one answer to "what is in it" */
  let scoped = null;
  if (typeof where.product === 'string' && where.product) {
    const ids = materialIds(tree, where.product, typeof where.gname === 'string' ? where.gname : undefined);
    scoped = new Set(ids);
    if (!scoped.size) return [];
  }

  /** @type {{item: any, score: number}[]} */
  const hits = [];
  for (const row of indexRows(tree)) {
    if (scoped && !scoped.has(row.videoId)) continue;
    if (where.batch && row.batch !== where.batch) continue;
    if (where.product && !scoped && row.product !== where.product && row.productName !== where.product) continue;
    if (where.gname && row.gname !== where.gname) continue;
    const name = row.name.toLowerCase();
    if (!name) continue;
    const score = name.startsWith(text.toLowerCase()) ? INDEX_SCORES.prefix
      : name.includes(text.toLowerCase()) ? INDEX_SCORES.contains
        : words.every((word) => name.includes(word)) ? INDEX_SCORES.words : 0;
    if (!score) continue;
    hits.push({
      item: {
        mediaKey: row.videoId,
        videoId: row.videoId,
        name: row.name,
        batch: row.batch || null,
        product: row.product || null,
        gname: row.gname || null,
        durationMs: null,
        score,
        matchKind: 'index',
      },
      score,
    });
  }
  hits.sort((a, b) => b.score - a.score
    || a.item.name.localeCompare(b.item.name)
    || a.item.videoId.localeCompare(b.item.videoId));
  return hits.slice(0, limitOf(limit)).map((hit) => hit.item);
}

/**
 * The answer: `{ mode, query, count, items }`, exactly. `mode` is how the rows were obtained, and an empty answer keeps
 * the mode it was attempted in (`vector` when a vector was used, `lexical` when the words were all there was, `index`
 * when the database could not be asked).
 *
 * @param {{ query?: unknown, filters?: Record<string, unknown>, limit?: unknown,
 *   embed?: ((query: string) => Promise<unknown>) | null,
 *   call?: ((rpc: string, params: Record<string, unknown>) => Promise<unknown>) | null,
 *   index?: (() => any) | null, packSearch?: ((query: string, request?: any) => Promise<any>) | null }} [request]
 * @returns {Promise<{mode: 'vector' | 'lexical' | 'index' | 'pack', query: string, count: number, items: any[]}>}
 */
export async function searchMaterials({ query, filters = {}, limit, embed = null, call = null, index = null, packSearch = null } = {}) {
  const text = typeof query === 'string' ? query.trim() : '';
  const wanted = limitOf(limit);
  const where = normaliseFilters(filters);
  if (!text) return { mode: 'lexical', query: '', count: 0, items: [] };

  /** The index branch, for every reason the RPC cannot answer. */
  const fromIndex = () => {
    /** @type {any} */
    let landed = null;
    if (typeof index === 'function') {
      try { landed = index(); } catch { landed = null; }
    }
    const items = searchIndex({ landed, query: text, filters: where, limit: wanted });
    return { mode: /** @type {const} */ ('index'), query: text, count: items.length, items };
  };

  /** ① the embedder: unavailable, slow or wrong is a lexical answer, said as such. */
  let vector = null;
  if (typeof embed === 'function') {
    try {
      const answer = await embed(text);
      vector = isEmbedding(answer) ? answer : null;
    } catch {
      vector = null;
    }
  }
  const mode = /** @type {'vector' | 'lexical'} */ (vector ? 'vector' : 'lexical');

  /* ①′ 客户端那条：带在身边的向量包。没有数据库、没有服务时它是唯一的语义检索 —— 排在 RPC 之前，
     因为"装完就能用"的形态里 RPC 根本不存在（`packSearch` 为 null 时才往下走）。
     包里只有 media_key 与分数：目录细节由调用方（Studio 的落地索引）补，这里绝不编 videoId。 */
  if (typeof packSearch === 'function' && vector && typeof call !== 'function') {
    try {
      const packed = await packSearch(text, { limit: wanted });
      if (packed) {
        /* 包里只有 media_key 与分数。云管家那条链上 **media_key 就是 videoId**（67 156 行里全都相等），
           所以这里能如实给出 videoId；名字/批次/合集从落地索引补 —— 补不到就留空字符串，绝不编一个名字。 */
        const landed = typeof index === 'function' ? (() => { try { return index(); } catch { return null; } })() : null;
        const rows = landed ? indexRowsById(landed) : null;
        return {
          mode: /** @type {const} */ ('pack'),
          query: text,
          count: packed.items.length,
          items: packed.items.slice(0, wanted).map((hit) => {
            const row = rows?.get(hit.mediaKey);
            return {
              mediaKey: hit.mediaKey,
              videoId: hit.mediaKey,
              score: hit.score,
              /* 包里自带的名字优先（客户端没有索引也能说清是哪一条），索引只用来补 productName */
              name: hit.name || row?.name || '',
              batch: hit.batch || row?.batch || '',
              product: hit.product || row?.product || '',
              productName: row?.productName || '',
              gname: hit.gname || row?.gname || '',
            };
          }),
        };
      }
    } catch {
      /* 包坏了不该让检索整个失败：落到 RPC，再落到索引 */
    }
  }

  /* ② the RPC: a database that cannot answer at all is the index's turn, not an error for the person. */
  if (typeof call !== 'function') return fromIndex();
  /* the RPC answers either the rows themselves or `{ rows }`; both shapes are read below */
  /** @type {any} */
  let rows;
  try {
    rows = await call(SEARCH_RPC, { p_query: text, p_filters: where, p_embedding: vector, p_limit: wanted });
  } catch {
    return fromIndex();
  }
  const list = Array.isArray(rows) ? rows : Array.isArray(rows?.rows) ? rows.rows : [];
  /* ③ nothing found is nothing found: the mode that was attempted stays, and no row is made up to fill the answer. */
  const items = list.map(itemOf).filter(Boolean).slice(0, wanted);
  return { mode, query: text, count: items.length, items };
}

/**
 * The real embedder: one `POST /v1/embeddings`, one 768-dimension vector, or a throw the caller turns into `lexical`.
 * The response shape is OpenAI's (`data[0].embedding`), which is what LM Studio speaks.
 *
 * **查询向量按 `model + query` 缓存**（LRU，默认 256 条）。理由：一次 8B 嵌入 300–800 ms，而一次
 * 向量检索本身只要 8.5 ms —— 同一句话在 Studio 里被重复问（点两下、agent 重试、同一产品换参数）
 * 是常态，缓存直接把这部分从"每次"变成"第一次"。不同模型不共享缓存：换了模型就是另一个向量空间。
 *
 * @param {{ endpoint?: string, model?: string, fetchImpl?: typeof fetch, timeoutMs?: number, cacheSize?: number }} [options]
 * @returns {(query: string) => Promise<number[]>}
 */
export function createEmbedder({
  endpoint = DEFAULT_EMBED_ENDPOINT, model = DEFAULT_EMBED_MODEL, fetchImpl, timeoutMs = DEFAULT_EMBED_TIMEOUT_MS,
  cacheSize = 256,
} = {}) {
  const url = String(endpoint ?? '').trim();
  const name = String(model ?? '').trim();
  /** @type {Map<string, number[]>} 插入序即最近使用序（命中时删了再塞回去，所以最早的永远在最前）。 */
  const cache = new Map();
  const limit = Number.isInteger(cacheSize) && cacheSize > 0 ? cacheSize : 0;

  return async (query) => {
    const key = `${name}\u0000${query}`;
    if (limit > 0) {
      const hit = cache.get(key);
      if (hit) {
        cache.delete(key);
        cache.set(key, hit);
        return hit;
      }
    }
    const fetcher = fetchImpl ?? globalThis.fetch;
    if (typeof fetcher !== 'function') throw fail('embed-unavailable', 'no fetch to send the embedding with');
    let target;
    try { target = new URL(url); } catch { throw fail('embed-unavailable', `the embedding endpoint is not a url: ${url}`); }
    const response = await fetcher(target.href, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: name, input: query }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response?.ok) throw fail('embed-failed', `the embedding endpoint answered ${response?.status ?? 'nothing'}`);
    /** @type {any} */
    const body = await response.json().catch(() => null);
    const vector = body?.data?.[0]?.embedding;
    if (!isEmbedding(vector)) throw fail('embed-invalid', `the embedding endpoint returned no ${EMBED_DIMS}-dimension vector`);
    if (limit > 0) {
      cache.set(key, vector);
      if (cache.size > limit) {
        /* `keys().next().value` is typed `string | undefined`; the cache is non-empty here, so the key exists. */
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
    }
    return vector;
  };
}

/** 随应用分发的运行时候选（`library/models/` 下，`library-models.mjs` 的清单与此一致）。 */
export const LOCAL_EMBED_RUNTIME = 'models/onnxruntime-web-1.31.1/ort.wasm.min.mjs';
/** 模型在 `library/` 下的目录。 */
export const LOCAL_EMBED_DIR = 'models/bge-base-zh-onnx';

/**
 * 本地嵌入器：ONNX（onnxruntime-web，wasm）跑 `library/models/bge-base-zh-onnx/`，不需要网络、不需要 LM Studio。
 *
 * 与 `createEmbedder` 的区别只有一个 —— 向量在**本进程**算出来：客户端装完就自带模型，检索才谈得上离线可用；
 * HTTP 那条留给开发期（LM Studio）和回退（`ORANGE_EMBED_MODE=service`）。
 *
 * 三件容易错、错了又不报错的事都显式写在这里：
 *   - **池化**：BERT 系取第一个 token（`<s>`/CLS），不是 e5 的平均（用错余弦只有 0.749）；
 *   - **分词**：bge-*-zh 是 WordPiece，不是 SentencePack unigram（读错词表在 readVocabulary 就抛）；
 *   - **维度**：768 与 `vector(768)` 同宽，不做截断（bge-base-zh 不是 MRL 模型）。
 *
 * 模型加载一次、进程内复用；查询向量按 `model + query` 缓存（与 HTTP 那条同样的理由：同一句话会被反复问）。
 * 文件不在、ONNX 起不来 → 抛 `embed-unavailable` / `embed-failed`，`searchMaterials` 会退到词法与索引。
 *
 * @param {{ modelDir?: string, runtime?: string, cacheSize?: number }} [options]
 * @returns {(query: string) => Promise<number[]>}
 */
export function createLocalEmbedder({ modelDir, runtime, cacheSize = 256 } = {}) {
  /** @type {Promise<(text: string) => Promise<Float32Array>> | null} */
  let loading = null;
  /** @type {Map<string, number[]>} */
  const cache = new Map();
  const limit = Number.isInteger(cacheSize) && cacheSize > 0 ? cacheSize : 0;
  const dir = typeof modelDir === 'string' && modelDir.trim() ? modelDir.trim() : '';
  const runtimeFile = typeof runtime === 'string' && runtime.trim() ? runtime.trim() : '';

  const load = () => {
    if (!loading) {
      loading = (async () => {
        /** @type {string} */
        let root = '';
        try {
          const { builtInRoot } = await import('../studio/server/library.mjs');
          root = builtInRoot();
        } catch { root = ''; }
        const at = (/** @type {string} */ rel) => (root ? join(root, rel) : rel);
        /* 三处候选，按"客户端装好之后"的顺序：
           1. 显式给的目录（测试、非常规布局）；
           2. `<shared home>/runtime/models/bge-base-zh-v1.5` —— `ensureEmbedModel` 下到这里，客户端就是这一条；
           3. 包里带的那份（开发检出、或安装包自带）。
           之前只认第 3 条：下载器把模型放到了第 2 条的位置，客户端会"下载成功却加载不到"。 */
        const downloaded = join(sharedHome(), 'runtime', 'models', 'bge-base-zh-v1.5');
        const usable = (/** @type {string} */ candidate) => { try { return existsSync(join(candidate, 'tokenizer.json')); } catch { return false; } };
        /* 显式给的目录**不回落**：配置写错了要立刻看出来，而不是悄悄用别的模型跑出另一套向量。 */
        const folder = dir ? dir : (usable(downloaded) ? downloaded : at(LOCAL_EMBED_DIR));
        const runtimeCandidate = runtimeFile || (existsSync(join(folder, 'runtime', 'ort.wasm.min.mjs'))
          ? join(folder, 'runtime', 'ort.wasm.min.mjs')
          : at(LOCAL_EMBED_RUNTIME));
        const { loadEmbedder } = await import('./sentence-model.mjs');
        const { readWordPiece, tokenizeWordPiece } = await import('./wordpiece.mjs');
        const vocab = readWordPiece(join(folder, 'tokenizer.json'));
        return loadEmbedder({
          runtime: runtimeCandidate,
          onnx: join(folder, 'model_quantized.onnx'),
          pooling: 'cls',
          tokenize: (/** @type {string} */ text) => tokenizeWordPiece(vocab, text),
        });
      })().catch((error) => {
        loading = null;
        throw fail('embed-unavailable', `the local model did not load: ${String(error?.message ?? error)}`);
      });
    }
    return loading;
  };

  return async (query) => {
    const key = `${LOCAL_EMBED_MODEL}\u0000${query}`;
    if (limit > 0) {
      const hit = cache.get(key);
      if (hit) {
        cache.delete(key);
        cache.set(key, hit);
        return hit;
      }
    }
    const embed = await load();
    /** @type {Float32Array} */
    let vector;
    try { vector = await embed(query); } catch (error) {
      throw fail('embed-failed', `the local model did not answer: ${String(error?.message ?? error)}`);
    }
    const numbers = Array.from(vector);
    if (!isEmbedding(numbers)) throw fail('embed-invalid', `the local model returned no ${EMBED_DIMS}-dimension vector`);
    if (limit > 0) {
      cache.set(key, numbers);
      if (cache.size > limit) {
        /* `keys().next().value` is typed `string | undefined`; the cache is non-empty here, so the key exists. */
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
    }
    return numbers;
  };
}
/** A tag for dollar quoting that the text does not contain. @param {string} text @param {string} [base] */
export function dollarTag(text, base = 'q') {
  for (let index = 0; ; index += 1) {
    const tag = index === 0 ? base : `${base}${index}`;
    if (!text.includes(`$${tag}$`)) return tag;
  }
}

/**
 * The SQL one search is: the session's tenant (`app.company_key`, 010's trusted-GUC rule), then the function, then the
 * rows as one JSON array — one `psql -qAt` invocation, one line back.
 *
 * Every value is dollar-quoted with a tag the value does not contain, so a material name with a quote in it is data.
 * @param {{ tenant: string, query?: string | null, filters?: Record<string, unknown>, embedding?: number[] | null, limit?: unknown }} request
 */
export function mediaSearchScript({ tenant, query = null, filters = {}, embedding = null, limit }) {
  if (!isTenantKey(tenant)) throw fail('tenant-invalid', 'a tenant key is a token, not a sentence');
  const literal = (/** @type {string} */ value) => {
    const tag = dollarTag(value);
    return `$${tag}$${value}$${tag}$`;
  };
  const text = typeof query === 'string' && query.trim() ? query.trim() : null;
  const vector = isEmbedding(embedding) ? embedding : null;
  const args = [
    literal(tenant.trim()),
    text === null ? 'null' : literal(text),
    `${literal(JSON.stringify(normaliseFilters(filters)))}::jsonb`,
    vector === null ? 'null' : `${literal(`[${vector.map((entry) => Number(entry.toFixed(7))).join(',')}]`)}::vector(${EMBED_DIMS})`,
    String(limitOf(limit)),
  ];
  return [
    `set app.company_key = ${literal(tenant.trim())};`,
    'select coalesce(json_agg(row_to_json(t)), \'[]\'::json)::text',
    `  from (select * from public.${SEARCH_RPC}(${args.join(', ')})) t;`,
    '',
  ].join('\n');
}

/** The first `ERROR:`/`错误:` line of a psql stderr, short enough for a log. @param {string} stderr */
export function firstPsqlError(stderr) {
  const line = String(stderr ?? '').split(/\r?\n/).find((entry) => /ERROR:|错误:/.test(entry));
  return (line ?? String(stderr ?? '').trim().split(/\r?\n/)[0] ?? '').replace(/^docker\s*:\s*/i, '').slice(0, 300);
}

/**
 * `psql -qAt` stdout → the rows of one search. The script's only output line is the JSON array (`-q` swallows the
 * `SET` tag); anything else — an empty answer, a psql that printed nothing — is a named failure, never `[]`.
 * @param {string} stdout
 */
export function parseMediaSearchOutput(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const json = [...lines].reverse().find((line) => line.startsWith('[') || line.startsWith('{'));
  if (json === undefined) throw fail('media-search-empty-answer', 'psql answered nothing for media_search');
  /* `JSON.parse` returns any: the shape is checked below, so the parse result is read as any */
  /** @type {any} */
  let parsed;
  try { parsed = JSON.parse(json); } catch { throw fail('media-search-unreadable', 'the media_search answer is not JSON'); }
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.rows)) return parsed.rows;
  throw fail('media-search-unreadable', 'the media_search answer is not a list of rows');
}

/**
 * The database, as this checkout reaches it: `docker compose exec -T db psql` — the same connection `infra/migrate.mjs`
 * and `scripts/material-doc-index.mjs` use (there is no PostgREST on this installation, and no driver dependency in the
 * package either).
 * @param {{ composeFile?: string, service?: string, user?: string, database?: string, timeoutMs?: number }} [options]
 * @returns {(script: string) => Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function makePsql({
  composeFile = DEFAULT_COMPOSE_FILE, service = DEFAULT_DB_SERVICE, user = DEFAULT_DB_USER,
  database = DEFAULT_DB_NAME, timeoutMs = DEFAULT_PSQL_TIMEOUT_MS,
} = {}) {
  const args = ['compose', '-f', composeFile, 'exec', '-T', service, 'psql', '-U', user, '-d', database, '-qAt'];
  return (script) => new Promise((resolve, reject) => {
    /** @type {import('node:child_process').ChildProcess} */
    const child = execFile('docker', args, { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && typeof error.code === 'string') {
          /* docker itself could not run (not installed, not on PATH): a named failure, not a psql exit code */
          reject(fail('psql-unavailable', `the local database could not be reached: ${String(error.message ?? error)}`, {
            detail: firstPsqlError(stderr),
          }));
          return;
        }
        resolve({ code: error ? Number(error.code ?? 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      });
    /* the script goes in on stdin: it is a query, not an argument anyone can read off a process list */
    child.stdin?.end(script, 'utf8');
  });
}

/**
 * The real `call(rpc, params)`: one search, one psql session.
 * @param {{ tenant: string, composeFile?: string, psql?: (script: string) => Promise<{code: number, stdout: string, stderr: string}>, timeoutMs?: number }} options
 * @returns {(rpc: string, params: Record<string, unknown>) => Promise<any[]>}
 */
export function createMediaSearchCall({ tenant, composeFile = DEFAULT_COMPOSE_FILE, psql, timeoutMs = DEFAULT_PSQL_TIMEOUT_MS } = /** @type {any} */ ({})) {
  const run = typeof psql === 'function' ? psql : makePsql({ composeFile, timeoutMs });
  return async (rpc, params = {}) => {
    if (rpc !== SEARCH_RPC) throw fail('unknown-rpc', `material search asks ${SEARCH_RPC}, not ${String(rpc)}`);
    const script = mediaSearchScript({
      tenant,
      query: /** @type {any} */ (params.p_query),
      filters: /** @type {any} */ (params.p_filters),
      embedding: /** @type {any} */ (params.p_embedding),
      limit: params.p_limit,
    });
    const result = await run(script);
    if (Number(result?.code ?? 1) !== 0) {
      throw fail('media-search-failed', firstPsqlError(result?.stderr) || `psql exited ${String(result?.code)}`, {
        detail: firstPsqlError(result?.stderr),
      });
    }
    return parseMediaSearchOutput(result?.stdout ?? '');
  };
}

/**
 * The landed index as the fallback reads it: `~/.orangefilm-dev/material-index/index.json` (or `dir`), re-read only when
 * the question is actually asked — a machine with no index answers `[]` there, and the RPC's answer is what it was.
 * @param {{ dir?: string }} [options]
 */
export function defaultIndexLoader({ dir = defaultIndexDir() } = {}) {
  return () => readMaterialIndex(dir)?.index ?? null;
}

/**
 * The whole thing, wired for one installation: null when this machine has no tenant to search (nothing is guessed), and
 * the JSON-RPC env keys are the only configuration.
 *
 * @param {{ env?: Record<string, string | undefined>, fetchImpl?: typeof fetch, psql?: (script: string) => Promise<any>,
 *   index?: (() => any) | null, indexDir?: string | null, tenant?: string, endpoint?: string, model?: string,
 *   composeFile?: string, timeoutMs?: number,
 *   embedder?: 'local' | 'service', modelDir?: string, packDir?: string }} [options]
 * @returns {{ tenant: string | null, local: boolean, embed: (query: string) => Promise<number[]>,
 *   call: ((rpc: string, params: Record<string, unknown>) => Promise<any[]>) | null,
 *   packSearch: ((query: string, request?: { limit?: number }) => Promise<any>) | null,
 *   search: (request: { query?: unknown, filters?: Record<string, unknown>, limit?: unknown }) =>
 *     Promise<{ mode: 'vector' | 'lexical' | 'index' | 'pack', query: string, count: number, items: any[] }> } | null}
 */
export function createMaterialSearchService({
  env = process.env, fetchImpl, psql, index = null, indexDir = null,
  tenant = env?.ORANGE_MEDIA_TENANT ?? env?.ORANGE_MEDIA_TENANT,
  endpoint = env?.ORANGE_EMBED_ENDPOINT ?? env?.ORANGE_EMBED_ENDPOINT,
  model = env?.ORANGE_EMBED_MODEL ?? env?.ORANGE_EMBED_MODEL,
  composeFile = env?.ORANGE_MEDIA_COMPOSE ?? env?.ORANGE_MEDIA_COMPOSE, timeoutMs,
  /* `local` 用随应用分发的 ONNX 模型（离线可用）；`service` 是 LM Studio 那类 HTTP 端点（开发期/回退）。 */
  embedder = (env?.ORANGE_EMBED_MODE ?? env?.ORANGE_EMBED_MODE) === 'service' ? 'service' : 'local',
  modelDir = env?.ORANGE_EMBED_MODEL_DIR ?? env?.ORANGE_EMBED_MODEL_DIR,
  packDir = env?.ORANGE_MATERIAL_PACK ?? env?.ORANGE_MATERIAL_PACK ?? DEFAULT_PACK_DIR(),
} = {}) {
  const key = typeof tenant === 'string' ? tenant.trim() : '';
  const named = typeof indexDir === 'string' && indexDir ? indexDir : null;
  const packDirNamed = typeof packDir === 'string' && packDir.trim() ? packDir.trim() : '';
  /* 无 tenant 时仍可本地检索：向量包/落地索引不需要数据库；两者都没有才真的没有搜索。 */
  const localOnly = !isTenantKey(key);
  if (localOnly && !packDirNamed && !named && typeof index !== 'function') return null;
  const embed = embedder === 'local'
    ? createLocalEmbedder({ ...(typeof modelDir === 'string' && modelDir ? { modelDir } : {}) })
    : createEmbedder({
      endpoint: typeof endpoint === 'string' && endpoint.trim() ? endpoint.trim() : DEFAULT_EMBED_ENDPOINT,
      model: typeof model === 'string' && model.trim() ? model.trim() : DEFAULT_EMBED_MODEL,
      ...(fetchImpl ? { fetchImpl } : {}),
      ...(Number.isFinite(timeoutMs) ? { timeoutMs: Number(timeoutMs) } : {}),
    });
  const call = localOnly ? null : createMediaSearchCall({
    tenant: key,
    composeFile: typeof composeFile === 'string' && composeFile.trim() ? composeFile.trim() : DEFAULT_COMPOSE_FILE,
    ...(typeof psql === 'function' ? { psql } : {}),
    ...(Number.isFinite(timeoutMs) ? { timeoutMs: Number(timeoutMs) } : {}),
  });
  const landed = typeof index === 'function' ? index : defaultIndexLoader(named ? { dir: named } : {});
  /* 向量包：客户端装好之后它就是语义检索的全部（没有数据库可问）。没有包 → null，走 RPC 与索引。 */
  const packSearch = packDirNamed ? createPackSearch({ dir: packDirNamed, embed }) : null;
  return {
    tenant: key || null,
    local: localOnly,
    embed,
    call,
    packSearch,
    search: (request = {}) => searchMaterials({
      query: request.query,
      filters: request.filters,
      limit: request.limit,
      embed,
      call,
      index: landed,
      packSearch,
    }),
  };
}
