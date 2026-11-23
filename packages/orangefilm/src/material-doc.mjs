// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * One material → the text that gets embedded, and the row `upsert_media_doc(p_row jsonb)` takes.
 *
 * This is the segment **before** the database: `docs/sql/012_media_doc.sql` already owns the table, the RPC and the
 * vector column, and the caller owns the embedding model. What 78 874 cloud materials still need is the one thing the
 * index rows do not carry — a *document*: a deterministic line of text whose every token is already in the name and the
 * supplier's own card metadata, so the same material written twice, by two processes, gives the same text and therefore
 * the same vector.
 *
 * # The template
 *
 * `<一级分类> <二级分类> <产品> <分组> <公共标签…> <时长> <作者> <名称去序号>` — fixed order, empty slots skipped, one
 * space between what is left. Product / group come from `parseMaterialName`
 * (`20261106-柠檬宝藏茶200g罐-外包装 (46)` → `柠檬宝藏茶200g罐` / `外包装`); the name keeps its sequence off the end
 * because `(46)` is a position in the supplier's album, not something anybody searches for, and 78k rows all ending in
 * a different `(n)` would put noise in every trigram.
 *
 * The two classification levels are the point of `card-meta-2`. Until they were here the text was 「批次 + 产品 + 分组 +
 * 名称」 and nothing else, so 「柠檬宝藏茶 外包装」 ranked a *different* product's `外包装` (0.9768: `外包装` is a shared
 * token and the category that says which tea this is never reached the vector). The batch date left the template when
 * the categories entered it: the date is still the `batch` column of `p_row` (012 keeps it, `media_search` filters on
 * it), and the name-without-sequence still opens with it (`20261106-柠檬宝藏茶200g罐-外包装`), so nothing searchable
 * was dropped — one token of duplication per row was.
 *
 * A name that does not follow that shape is not claimed: product/group stay empty, and the text degrades to the two
 * categories, the labels, the duration, the author and the name minus its sequence. It is still searchable — that is
 * the point of not dropping the row.
 *
 * # What is deliberately *not* here
 *
 *  - no embedding: `embedding` is the caller's (and 012 requires `embedding_ver` beside it — this module never invents
 *    one, so a vector cannot be lost to a guessed model name);
 *  - no `company_key`: the RPC reads the tenant from the session (012:169-170), a key in `p_row` would be a lie;
 *  - no `md5`, no `is_local`: where the bytes are is not a property of a document (012:16-21).
 *
 * # Two shapes the table forces on us
 *
 *  - `shot_index` is `0`, never `null`: `013_media_doc_shot_key.sql` makes the column `NOT NULL DEFAULT 0`, puts it in
 *    the primary key and rewrites the asset branch of `media_doc_gran_shape` to `shot_index = 0` (NULL in a unique index
 *    is mutually distinct, which would make the PK stop being a PK). On a 012-only database the value is inert — the RPC
 *    declares `v_shot integer;` with no default and only assigns it inside the `gran = 'shot'` branch, so an asset row
 *    still lands as `NULL` there. One value is correct under both DDLs.
 *  - `media_key` and `text` may not be empty (012:81-83). An entry with no `videoId` and no digest has no identity, so
 *    `mediaDocRow` raises here instead of letting PostgreSQL answer `22023` after 78 874 round trips.
 */
import { categoryName, md5Of, parseMaterialName } from './material-index.mjs';

/**
 * `text` ceiling, in characters (what PostgreSQL's `length()` counts, so code points — see `truncate`). Well under the
 * trigram index's comfort zone and far above any real card line: the longest name in the account is 60 characters, so a
 * row that reaches 2 000 is a caller passing a whole card body and the marker is the honest signal that it was cut.
 */
export const MEDIA_DOC_TEXT_MAX = 2000;
/** Appended *inside* the ceiling, so a truncated text is still ≤ `MEDIA_DOC_TEXT_MAX` and visibly cut. */
export const TRUNCATION_MARK = '…[截断]';
/**
 * The pipeline that produced this layer; a new prompt/extractor is a new version, per 012's `analyzer_ver` contract.
 *
 * `card-meta-2` is the template change: the two classification levels entered the text and the batch date left it. A
 * stored `card-meta-1` vector is therefore a vector of a *different* text — 012/013 supersede it on the first upsert of
 * the new version rather than mixing two templates in one index.
 */
export const DEFAULT_ANALYZER_VER = 'card-meta-2';
/** 012:73 — the two `source_kind` values the CHECK allows. */
export const SOURCE_KINDS = Object.freeze(['cloud', 'project']);

/** The sequence marker a supplier name ends with: ` (46)`. Not `_2` — that is the derived layer's tail, not this one. */
const SEQUENCE_TAIL = /\s*\(\d+\)$/;

const isSourceKind = (value) => SOURCE_KINDS.includes(value);

const str = (value) => (typeof value === 'string' ? value.trim() : '');

/** One line, no runs of whitespace: text is the input to a vector and to a trigram index, so layout is not information. */
const oneLine = (value) => value.replace(/\s+/gu, ' ').trim();

/** Code-point order — not `localeCompare`, whose result depends on the ICU the process happens to ship. */
const byCodepoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The name without its trailing ` (n)`.
 * @param {string} name
 */
export function stripSequence(name) {
  return oneLine(str(name).replace(SEQUENCE_TAIL, ''));
}

/**
 * Shared tags, deduplicated and put in code-point order.
 *
 * The order is sorted rather than preserved because a label *set* is what the supplier's card says: if the same three
 * tags arrive in a different order on a second read, the text (and therefore the vector) must not change. Positional
 * order is not part of the tag's meaning.
 * @param {unknown} labels
 * @returns {string[]}
 */
export function docLabels(labels) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(labels) ? labels : []) {
    const value = oneLine(str(raw));
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out.sort(byCodepoint);
}

/**
 * `23400` → `23.4s`, `60000` → `1m0s`. Whole seconds lose the `.0` (`12s`, not `12.0s`): the token sits in searchable
 * text, and `.0` is four characters of noise per row.
 *
 * Anything that is not a finite non-negative number is dropped (the column is nullable and `duration_ms >= 0`).
 * @param {unknown} durationMs
 */
export function formatDocDuration(durationMs) {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return '';
  const tenths = Math.round(durationMs / 100);
  if (tenths < 600) {
    const seconds = tenths / 10;
    return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
  }
  const totalSeconds = Math.round(durationMs / 1000);
  return `${Math.floor(totalSeconds / 60)}m${totalSeconds % 60}s`;
}

/** Cut at a code-point boundary so a surrogate pair is never split; the marker counts against the ceiling. */
function truncate(text) {
  const chars = Array.from(text);
  if (chars.length <= MEDIA_DOC_TEXT_MAX) return text;
  const keep = MEDIA_DOC_TEXT_MAX - Array.from(TRUNCATION_MARK).length;
  return chars.slice(0, keep).join('') + TRUNCATION_MARK;
}

/**
 * The stable identity of an asset document, for dedupe and logs.
 *
 * `videoId` first — it is what `media_key` becomes and the only id stable across syncs. A row without one falls back to
 * its digest (`md5:…`), then to its stripped name; `''` means the entry says nothing that could identify it, and the
 * caller must not write a document for it.
 * @param {{ videoId?: unknown, mediaKey?: unknown, name?: unknown, md5?: unknown, rawMd5?: unknown }} entry
 */
export function mediaDocId(entry) {
  const mediaKey = str(entry?.videoId) || str(entry?.mediaKey);
  if (mediaKey) return `asset:${mediaKey}`;
  const md5 = md5Of(entry);
  if (md5) return `asset:md5:${md5}`;
  const title = stripSequence(entry?.name);
  return title ? `asset:name:${title}` : '';
}

/**
 * The document text: one-level category, two-level category, product, group, shared tags, duration, author,
 * name-without-sequence.
 *
 * Deterministic by construction — no clock, no map iteration, no locale, no randomness: the same entry always gives the
 * same string, which is what makes a stored vector still valid on the next run.
 *
 * `oneLevel` / `twoLevel` / `labels` / `durationMs` / `author` are read off the entry when present, so `mediaDocRow` can
 * hand the same shape straight through (`mediaDocText(entry)` stays a one-argument call); the supplier's own field names
 * (`oneLevelVideoType` / `twoLevelVideoType`) are accepted too, so a raw row is not silently rendered without them.
 * @param {{ videoId?: unknown, mediaKey?: unknown, name?: unknown, md5?: unknown, labels?: unknown, durationMs?: unknown,
 *   author?: unknown, oneLevel?: unknown, twoLevel?: unknown, oneLevelVideoType?: unknown, twoLevelVideoType?: unknown }} entry
 */
export function mediaDocText(entry) {
  const name = str(entry?.name);
  const parsed = parseMaterialName(name);
  const parts = [
    categoryName(entry?.oneLevel ?? entry?.oneLevelVideoType),
    categoryName(entry?.twoLevel ?? entry?.twoLevelVideoType),
    parsed ? parsed.product : '',
    parsed ? parsed.group : '',
    ...docLabels(entry?.labels),
    formatDocDuration(entry?.durationMs),
    oneLine(str(entry?.author)),
    stripSequence(name),
  ];
  const text = parts.map(oneLine).filter(Boolean).join(' ');
  /* A card with no name and no metadata still needs a non-empty `text` (012:83). The identity is the last thing that is
     true about it; an empty string would be rejected by the table, which is worse than a searchable id token. */
  return truncate(text || mediaDocId(entry));
}

/**
 * The `p_row` JSON that `upsert_media_doc(p_row jsonb)` takes — one asset document, without the vector.
 *
 * Keys are the ones 012 actually reads off `p_row` (`media_key`, `gran`, `analyzer_ver`, `video_id`, `shot_index`,
 * `name`, `batch`, `product`, `gname`, `labels`, `duration_ms`, `author`, `source_kind`, `text`); `embedding` and
 * `embedding_ver` are the caller's, because they belong to the embedding model and not to this template.
 *
 * `batch` / `product` / `gname` are `null` when the name does not follow the pattern: 012 runs them through
 * `nullif(btrim(...))` anyway, so `null` and `''` are the same row, and `null` states "not claimed" rather than
 * "claimed as empty".
 *
 * @param {{ videoId?: unknown, mediaKey?: unknown, name?: unknown, md5?: unknown, rawMd5?: unknown }} entry
 * @param {{ analyzerVer?: string, labels?: string[], durationMs?: number | null, author?: string | null, sourceKind?: 'cloud' | 'project' }} [options]
 */
export function mediaDocRow(entry, options = {}) {
  const {
    analyzerVer = DEFAULT_ANALYZER_VER,
    labels = [],
    durationMs = null,
    author = null,
    sourceKind = 'cloud',
  } = options ?? {};

  const mediaKey = str(entry?.videoId) || str(entry?.mediaKey);
  if (!mediaKey) {
    throw new TypeError('mediaDocRow: entry has no videoId — media_key may not be empty (012:81)');
  }
  const version = str(analyzerVer) || DEFAULT_ANALYZER_VER;
  if (!isSourceKind(sourceKind)) {
    throw new TypeError(`mediaDocRow: source_kind must be one of ${SOURCE_KINDS.join('|')} (got ${String(sourceKind)})`);
  }

  /* Options win, but an option that was not given falls back to the same field on the entry: this keeps
     `mediaDocRow(entry).text === mediaDocText(entry)` true, so a caller cannot get two different documents for one
     material depending on which function it reached for. */
  const resolvedDuration = durationMs ?? (typeof entry?.durationMs === 'number' ? entry.durationMs : null);
  const resolvedAuthor = author ?? (str(entry?.author) || null);
  const resolvedLabels = Array.isArray(labels) && labels.length
    ? labels
    : (Array.isArray(entry?.labels) ? entry.labels : labels);

  if (resolvedDuration !== null
      && (typeof resolvedDuration !== 'number' || !Number.isFinite(resolvedDuration) || resolvedDuration < 0)) {
    throw new TypeError(`mediaDocRow: duration_ms must be null or a non-negative number (got ${String(resolvedDuration)})`);
  }

  const name = str(entry?.name);
  const parsed = parseMaterialName(name);
  const tags = docLabels(resolvedLabels);
  const text = mediaDocText({ ...entry, labels: tags, durationMs: resolvedDuration, author: resolvedAuthor });

  return {
    media_key: mediaKey,
    gran: 'asset',
    analyzer_ver: version,
    /* Same value as media_key: 012 keeps the column because `media_search` returns it and the client needs the
       supplier id to fetch bytes. */
    video_id: mediaKey,
    /* An asset document is the whole material, and 013 says that is shot `0` (`asset ⇒ shot_index = 0`) rather than a
       NULL. It also has to be `0` because the column is part of the primary key: a NULL there would be "distinct" from
       every other NULL and the key would stop keying. */
    shot_index: 0,
    name: name || null,
    batch: parsed ? parsed.date : null,
    product: parsed ? parsed.product : null,
    gname: parsed ? parsed.group : null,
    labels: tags,
    duration_ms: resolvedDuration === null ? null : Math.round(resolvedDuration),
    author: resolvedAuthor,
    source_kind: sourceKind,
    text,
  };
}
