// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * The sentence model of the library's semantic search (multilingual-e5-small, int8), on its own: its tokenizer
 * (SentencePiece's unigram model, its vocabulary packed as vocab.bin) and the model run by onnxruntime-web
 * (WebAssembly, one thread), a text to its vector. It needs nothing but its files, so that the library's vectors
 * (scripts/library-vectors.mjs) and a search's query (OrangeFilm's service, `POST /v1/library/query`) are made by the
 * same code, and so are the same.
 */
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

/* ── the tokenizer: SentencePiece's unigram model, as the model's tokenizer.json has it ───────────────────────── */

/**
 * A text's token ids as the model was trained on them: NFKC, spaces as `▁` (one before the first word too), each word
 * cut into the pieces of the vocabulary whose scores add up highest (Viterbi); a character no piece has is `<unk>`.
 * Between `<s>` and `</s>`, at most 512.
 * @param {Vocabulary} vocab @param {string} text
 */
export function tokenize(vocab, text) {
  const ids = [0];
  const normal = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  for (const word of `▁${normal.replaceAll(' ', '▁')}`.split(/(?=▁)/)) {
    const chars = [...word];
    const n = chars.length;
    const best = new Float64Array(n + 1).fill(-Infinity);
    const from = new Int32Array(n + 1);
    const id = new Int32Array(n + 1);
    best[0] = 0;
    for (let i = 0; i < n; i++) {
      if (best[i] === -Infinity) continue;
      let piece = '';
      for (let j = i; j < Math.min(n, i + vocab.longest); j++) {
        piece += chars[j];
        const k = vocab.id(piece);
        /* the first four are <s>, <pad>, </s>, <unk>: never pieces of a text */
        if (k === undefined || k < 4) continue;
        const score = best[i] + vocab.scores[k];
        if (score > best[j + 1]) { best[j + 1] = score; from[j + 1] = i; id[j + 1] = k; }
      }
      if (best[i + 1] === -Infinity) { best[i + 1] = best[i] + vocab.unknown; from[i + 1] = i; id[i + 1] = 3; }
    }
    const out = [];
    for (let end = n; end > 0; end = from[end]) out.push(id[end]);
    ids.push(...out.reverse());
  }
  return [...ids.slice(0, 511), 2];
}

/**
 * A vocabulary as tokenize reads it: the id of a piece (undefined: none), each id's score, the longest piece (in
 * characters), and the score of a character no piece has.
 * @typedef {{ id: (piece: string) => number | undefined, scores: Float32Array, longest: number, unknown: number }} Vocabulary
 */

/** The vocabulary of a tokenizer.json. @param {string} file @returns {Vocabulary} */
export function readVocabulary(file) {
  /** @type {{ model: { vocab: [string, number][] } }} */
  const json = JSON.parse(readFileSync(file, 'utf8'));
  const pieces = new Map();
  let longest = 0;
  let lowest = 0;
  json.model.vocab.forEach(([piece, score], i) => { pieces.set(piece, i); longest = Math.max(longest, [...piece].length); lowest = Math.min(lowest, score); });
  return { id: (piece) => pieces.get(piece), scores: Float32Array.from(json.model.vocab, ([, s]) => s), longest, unknown: lowest - 10 };
}

/*
 * A vocabulary packed (vocab.bin, made from tokenizer.json when the library is published): read in a few
 * milliseconds where the JSON takes a hundred, a piece found by binary search over its UTF-8 bytes. Little-endian:
 *   u32 count, u32 longest, f32 unknown, then count × f32 score (by id), count × u32 id (in the order of the pieces'
 *   bytes), (count + 1) × u32 offset (by id, into the text), and the text: every piece's UTF-8, by id.
 */

/** tokenizer.json's vocabulary, packed. @param {string} file @returns {Buffer} */
export function packVocabulary(file) {
  /** @type {{ model: { vocab: [string, number][] } }} */
  const json = JSON.parse(readFileSync(file, 'utf8'));
  const { scores, longest, unknown } = readVocabulary(file);
  const bytes = json.model.vocab.map(([piece]) => Buffer.from(piece, 'utf8'));
  const n = bytes.length;
  const order = Uint32Array.from(bytes.keys()).sort((a, b) => Buffer.compare(bytes[a], bytes[b]));
  const offsets = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) offsets[i + 1] = offsets[i] + bytes[i].length;
  const head = Buffer.alloc(12);
  head.writeUInt32LE(n, 0);
  head.writeUInt32LE(longest, 4);
  head.writeFloatLE(unknown, 8);
  return Buffer.concat([head, Buffer.from(scores.buffer), Buffer.from(order.buffer), Buffer.from(offsets.buffer), ...bytes]);
}

/** A packed vocabulary (packVocabulary). @param {Buffer} buf @returns {Vocabulary} */
export function readPacked(buf) {
  const data = new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  const view = new DataView(data.buffer);
  const n = view.getUint32(0, true);
  const scores = new Float32Array(data.buffer, 12, n);
  const order = new Uint32Array(data.buffer, 12 + 4 * n, n);
  const offsets = new Uint32Array(data.buffer, 12 + 8 * n, n + 1);
  const text = data.subarray(12 + 12 * n + 4);
  const encoder = new TextEncoder();
  /** the piece of id `k` against `want`, as Buffer.compare: by bytes */
  const compare = (/** @type {number} */ k, /** @type {Uint8Array} */ want) => {
    const from = offsets[k];
    const length = offsets[k + 1] - from;
    for (let i = 0; i < Math.min(length, want.length); i++) if (text[from + i] !== want[i]) return text[from + i] - want[i];
    return length - want.length;
  };
  return {
    id: (piece) => {
      const want = encoder.encode(piece);
      let lo = 0;
      let hi = n - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const c = compare(order[mid], want);
        if (c === 0) return order[mid];
        if (c < 0) lo = mid + 1; else hi = mid - 1;
      }
      return undefined;
    },
    scores, longest: view.getUint32(4, true), unknown: view.getFloat32(8, true),
  };
}

/* ── the model ───────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * The model, loaded from its files: a text (with its `query: ` or `passage: `, as the model was trained) to its
 * vector, the mean of its tokens' last states, of length 1.
 * `pooling`: how the vector is taken from the model's last states. e5 averages its tokens (`mean`); the BERT-family
 * retrieval models (bge, gte, XLM-R) use their first token — the `[CLS]`/`<s>` one (`cls`). Getting this wrong does not
 * fail: it silently returns a vector in a different space (measured on bge-m3: cosine 0.75 against the reference).
 * packed (vocab.bin), or as the model's maker publishes it (tokenizer.json)
 * @returns {Promise<(text: string) => Promise<Float32Array>>}
 */
export async function loadEmbedder(files) {
  const ort = await import(pathToFileURL(files.runtime).href);
  /* 线程数：浏览器里 >1 需要 SharedArrayBuffer（要 COOP/COEP 头），Node 里没有这个限制。threads: 1 是安全默认。 */
  ort.env.wasm.numThreads = Number.isInteger(files.threads) && files.threads > 0 ? files.threads : 1;
  ort.env.wasm.wasmPaths = pathToFileURL(`${dirname(files.runtime)}/`).href;
  ort.env.logLevel = 'error';
  /* 分词器可以注进来：WordPiece（bge-small-zh 这类 BERT 模型）不是 unigram，读不到同一个词表结构，
     由调用方给一个 	okenize(text) => ids（src/wordpiece.mjs）。 */
  const tokenizeText = typeof files.tokenize === 'function'
    ? files.tokenize
    : (() => {
      const vocab = files.tokenizer.endsWith('.json') ? readVocabulary(files.tokenizer) : readPacked(readFileSync(files.tokenizer));
      return (/** @type {string} */ text) => tokenize(vocab, text);
    })();
  const session = await ort.InferenceSession.create(readFileSync(files.onnx));
  const int64 = (/** @type {number[]} */ v) => new ort.Tensor('int64', BigInt64Array.from(v, BigInt), [1, v.length]);
  /* 只喂模型声明要的输入：XLM-R 系（bge-m3）没有 `token_type_ids`，多给一个就 `invalid input`
     —— 这不是模型的错，是调用方假设了 BERT-base 的三件套。 */
  const wanted = new Set(Array.isArray(session.inputNames) ? session.inputNames : ['input_ids', 'attention_mask', 'token_type_ids']);
  const cls = files.pooling === 'cls';
  return async (/** @type {string} */ text) => {
    const ids = tokenizeText(text);
    /** @type {Record<string, any>} */
    const feed = { input_ids: int64(ids), attention_mask: int64(ids.map(() => 1)) };
    if (wanted.has('token_type_ids')) feed.token_type_ids = int64(ids.map(() => 0));
    const out = (await session.run(feed))[session.outputNames[0]];
    const dims = out.dims[2];
    const v = new Float32Array(dims);
    /* cls：取第一个 token（XLM-R 的 <s>）的状态；mean：所有 token 平均（e5 的口径） */
    if (cls) for (let k = 0; k < dims; k++) v[k] = out.data[k];
    else for (let i = 0; i < ids.length; i++) for (let k = 0; k < dims; k++) v[k] += out.data[i * dims + k];
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  };
}
