// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * WordPiece：BERT 系中文模型（bge-small-zh、gte-zh、m3e…）的分词器。
 *
 * 为什么需要它：仓库原来的 `sentence-model.mjs` 只认 SentencePiece 的 **unigram**（e5、bge-m3 那种
 * `model.vocab` 是 `[[piece, score], …]`）。bge-small-zh 的 `tokenizer.json` 是 `model.type = "WordPiece"`、
 * `vocab` 是一个 `{piece: id}` 对象 —— 直接喂进去会在 `readVocabulary` 就抛错（这是好事，至少没有静默出错）。
 *
 * 这里按 BERT 的原文实现三步：清洗（去控制字符、CJK 单字切开）→ 预分词（空白与标点各自成词）→
 * 贪心最长匹配（后继片段带 `##` 前缀）。词表与特殊标记全部从 `tokenizer.json` 里读，不写死。
 *
 * 与 HF tokenizers 的差异只在极端情况（超长词、组合字符的 NFKC 细节）：对我们的用途（中文素材名 + 短查询），
 * 差别落在 `[UNK]` 的个数上，而向量差异可以用余弦量出来（`bench-onnx-drift.mjs`）。
 */
import { readFileSync } from 'node:fs';

/** CJK 与全角标点的范围（与 BERT 的 `_is_chinese_char` 一致，加上常用中文标点）。 */
const CJK = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/;
/** 会被单独切开的标点：ASCII 标点 + 中文标点。 */
const PUNCT = /[\u0021-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E\u3000-\u303F\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65]/;

/**
 * 一个 WordPiece 词表 + 它的分词函数。
 * @typedef {{ id: Map<string, number>, unk: number, cls: number, sep: number, maxChars: number,
 *   lower: boolean }} WordPieceVocab
 */

/**
 * 从 HF 的 `tokenizer.json` 读 WordPiece 词表。
 * @param {string} file
 * @returns {WordPieceVocab}
 */
export function readWordPiece(file) {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  const model = json?.model ?? {};
  if (model.type !== 'WordPiece') throw new Error(`${file} is not a WordPiece tokenizer (model.type = ${model.type})`);
  /** @type {Map<string, number>} */
  const id = new Map();
  for (const [piece, index] of Object.entries(model.vocab ?? {})) id.set(piece, Number(index));
  /* the fallback is a token id (a number), which is what the function returns when the token is absent */
  const special = (/** @type {string} */ name, /** @type {number} */ fallback) => {
    const value = json?.added_tokens?.find((/** @type {any} */ token) => token?.content === name)?.id ?? id.get(name);
    return typeof value === 'number' ? value : fallback;
  };
  const longest = [...id.keys()].reduce((max, piece) => Math.max(max, piece.replace(/^##/, '').length), 1);
  return {
    id,
    unk: special(model.unk_token ?? '[UNK]', 100),
    cls: special('[CLS]', 101),
    sep: special('[SEP]', 102),
    maxChars: Math.min(200, Math.max(1, longest)),
    lower: json?.normalizer?.lowercase === true,
  };
}

/**
 * 文本 → 词 id（含首尾的 `[CLS]` / `[SEP]`）。
 * @param {WordPieceVocab} vocab @param {string} text @param {number} [maxTokens]
 * @returns {number[]}
 */
export function tokenizeWordPiece(vocab, text, maxTokens = 512) {
  const clean = String(text ?? '')
    .normalize('NFKC')
    /* eslint-disable-next-line no-control-regex -- 控制字符正是要去掉的东西 */
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const lowered = vocab.lower ? clean.toLowerCase() : clean;

  /* CJK 每个字单独成词（BERT 的 handle_chinese_chars） */
  const spaced = [...lowered].map((ch) => (CJK.test(ch) ? ` ${ch} ` : ch)).join('');

  /** @type {string[]} */
  const words = [];
  for (const chunk of spaced.split(/\s+/)) {
    if (!chunk) continue;
    let buffer = '';
    const flush = () => { if (buffer) { words.push(buffer); buffer = ''; } };
    for (const ch of chunk) {
      if (PUNCT.test(ch)) { flush(); words.push(ch); } else buffer += ch;
    }
    flush();
  }

  /** @type {number[]} */
  const ids = [vocab.cls];
  for (const word of words) {
    const chars = [...word];
    let start = 0;
    /** @type {string[]} */
    const pieces = [];
    let bad = false;
    while (start < chars.length) {
      let end = chars.length;
      let found = -1;
      while (start < end) {
        const piece = (start > 0 ? '##' : '') + chars.slice(start, end).join('');
        const at = vocab.id.get(piece);
        if (at !== undefined) { found = at; break; }
        end -= 1;
      }
      if (found < 0) { bad = true; break; }
      pieces.push(String(found));
      start = end;
    }
    if (bad) ids.push(vocab.unk); else ids.push(...pieces.map(Number));
    if (ids.length >= maxTokens - 1) break;
  }
  ids.push(vocab.sep);
  return ids.slice(0, maxTokens);
}
