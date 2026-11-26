// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * Filling the material index from the supplier's pages, once, and landing it whole.
 *
 * `material-index.mjs` decides what a name means. This file asks for the supplier's rows — every page of every material
 * class (`videoType` 0..4) — and hands them to `buildMaterialIndex`. A row is not only its name: the same page carries
 * the card's labels, duration, author, cover and two classification levels, and `rowOf` keeps all six so the document
 * text can say *which* material a card is (dropping them made every 「外包装」 material look alike). The page reader is
 * injected — the CLI gives it the Studio's `/api/materials/list`, a test gives it a stub — so pagination is testable
 * without a network.
 *
 * Four facts about that feed shape every guard here:
 *
 *  - `total` is the supplier's own count and is **not** a promise: it is read page by page and may move (a material
 *    added while the sweep runs), so the last value wins and every change is said out loud.
 *  - a page can come back empty (an account with fewer rows than `pageNo * pageSize`, a filter the supplier applied),
 *    and an empty page is the end of that class, never a reason to keep asking 500 times.
 *  - a page can repeat the one before it (the supplier clamps a too-large `pageNo`), which reads as "nothing new":
 *    that is the end too, not a loop.
 *  - the same `videoId` can appear twice — in one page or in two — and `buildMaterialIndex` keeps it once. So
 *    `sourceTotal` (the supplier's own sum) and `parsed + unclassified` (what we actually hold) can disagree, and the
 *    difference is a warning with the number in it, never a silent tidy-up.
 *  - a class can claim far more than it will ever serve. `videoType 1` says 179 831 and clamps at page 289 (28 900 rows,
 *    the rest repeating the page before it). That is not a failure and not a duplicate: those rows are simply
 *    unreachable. So the build states **two** totals — `sourceTotal` (claimed) and `pageable` (served) — and their
 *    difference as `unreachable`, instead of folding "the supplier will not page it" into one confusing gap.
 *
 * A sweep is paced: `throttleMs` (500 by default) between page requests, and a 429 is backed off exponentially and the
 * same page asked again — measured on this account, ~144 requests/minute is where the supplier starts answering 429
 * (`docs/execution/2026-11-16-auth-unify/material-index-run.md` §1).
 *
 * The file is written as `<dir>/index.json.tmp` and renamed over `<dir>/index.json` (directory 0700, file 0600), so a
 * reader sees the previous index or the new one and never half of either. A reader goes to that file first
 * (`loadMaterialIndex`): `generatedAt` + `staleAfterMs` (24 h) decide whether it is still good, and only a missing or
 * stale index is swept again.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { buildMaterialIndex, derivedTotals, entryMetaOf, md5Of, numberOf } from './material-index.mjs';

/** The five material classes the supplier's `videoType` names (`contract.ts` VIDEO_TYPES). */
export const MATERIAL_VIDEO_TYPES = Object.freeze([0, 1, 2, 3, 4]);

/** The supplier's own upper bound for one page (`contract.ts` MAX_PAGE_SIZE): a larger ask is refused upstream. */
export const PAGE_SIZE = 100;

/** Far past any real sweep (a 448-material account needs 5 pages per class), and a hard stop if the feed misbehaves. */
export const MAX_PAGES_PER_TYPE = 500;

export const INDEX_SCHEMA = 'orange/material-index-build/1';
export const INDEX_FILE = 'index.json';

/** How long a landed index stays good for reading (`staleAfterMs` in the file; a reader may pass its own). */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * The pause between two page requests. 500 ms is what kept this account under the supplier's limit (≈108 requests per
 * minute against the ≈144 that earned a 429); it is a parameter because a test must not wait for it.
 */
export const DEFAULT_THROTTLE_MS = 500;

/** A 429's backoff: `RATE_LIMIT_BASE_MS * 2 ** attempt`, held under `RATE_LIMIT_MAX_MS`, this many times per page. */
export const RATE_LIMIT_RETRIES = 4;
export const RATE_LIMIT_BASE_MS = 1000;
export const RATE_LIMIT_MAX_MS = 16_000;

/** The pause the backoff asks for, given a 1-based attempt. */
export const backoffMs = (attempt) => Math.min(RATE_LIMIT_MAX_MS, RATE_LIMIT_BASE_MS * 2 ** Math.max(0, attempt - 1));

/**
 * Whether a failed page is the supplier rate-limiting us rather than a real failure. Only this is retried: a 502 or a
 * malformed answer would be asked again with no reason to expect a different answer.
 * @param {unknown} error
 */
export function isRateLimited(error) {
  const at = /** @type {any} */ (error);
  const status = Number(at?.status ?? at?.httpStatus ?? at?.response?.status ?? NaN);
  if (status === 429) return true;
  if (String(at?.code ?? '') === 'provider-rate-limited') return true;
  return /\b429\b|provider-rate-limited|rate.?limit|限流/i.test(String(at?.message ?? ''));
}

/** The `.orangefilm-dev` home a dev Studio and the desktop app share. */
export function orangefilmDevHome(home) {
  const given = process.env.ORANGE_DEV_HOME;
  if (typeof given === 'string' && given.trim()) return given.trim();
  return join(home || homedir(), '.orangefilm-dev');
}

/** Where the index lands unless `--dir` says otherwise: `~/.orangefilm-dev/material-index`.
 *  @param {{ home?: string }} [options] */
export function defaultIndexDir({ home } = {}) {
  const given = process.env.ORANGE_MATERIAL_INDEX_DIR;
  if (typeof given === 'string' && given.trim()) return given.trim();
  return join(orangefilmDevHome(home), 'material-index');
}

/** `index.json` in `dir`. */
export const materialIndexPath = (dir) => join(dir, INDEX_FILE);

/**
 * A whole number the wire may send as a number, as digits, or as its own `{sourceType: 'number', source: '448'}`
 * wrapper; anything else is "not said".
 */
function wholeNumber(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? /** @type {any} */ (value).source : value;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return Math.trunc(raw);
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) return Number(raw.trim());
  return null;
}

/**
 * One wire row as the fields the index keeps. Accepts the shape this module documents (`{videoId, name, labels,
 * durationMs, …}`) and the Studio's own (`{videoId: {value}, observation: {name, rawMd5, accountName, duration,
 * videoLabels, oneLevelVideoType, twoLevelVideoType, coverUrl}}`), so a CLI page can be handed over as it arrived.
 *
 * `md5` is the supplier's `rawMd5` (unwrapped from a `{sourceType, source}` literal if it comes as one) or `''`; it is
 * carried, not computed — the digest of the bytes is the supplier's word, and nothing here hashes a file.
 *
 * The six card fields are read off the same row (`entryMetaOf`, one decision point for both shapes): the supplier's
 * `duration` is seconds and becomes `durationMs` there, its `videoLabels` become `labels`, its `accountName` becomes
 * `author`, and the two category objects give `oneLevel` / `twoLevel`. A row that carries none of them still becomes an
 * entry — with empty fields — because the name is still worth keeping.
 * @param {unknown} item
 * @returns {{videoId: string, name: string, md5: string, labels: string[], durationMs: number | null, author: string,
 *   coverUrl: string, oneLevel: string, twoLevel: string, videoType?: number, createTime?: string | null} | null}
 */
export function rowOf(item) {
  if (!item || typeof item !== 'object') return null;
  const raw = /** @type {any} */ (item).videoId;
  const videoId = typeof raw === 'string' ? raw.trim() : typeof raw?.value === 'string' ? raw.value.trim() : '';
  if (!videoId) return null;
  const given = /** @type {any} */ (item);
  const observation = given.observation;
  const name = typeof given.name === 'string'
    ? given.name
    : typeof observation?.name === 'string' ? observation.name : '';
  const md5 = md5Of({
    rawMd5: observation?.rawMd5 ?? given.rawMd5,
    md5: observation?.md5 ?? given.md5,
  });
  const meta = entryMetaOf({
    labels: observation?.videoLabels ?? given.videoLabels ?? given.labels,
    duration: observation?.duration ?? given.duration,
    durationMs: given.durationMs,
    author: observation?.accountName ?? given.author ?? given.accountName,
    coverUrl: observation?.coverUrl ?? given.coverUrl,
    oneLevel: observation?.oneLevelVideoType ?? given.oneLevel ?? given.oneLevelVideoType,
    twoLevel: observation?.twoLevelVideoType ?? given.twoLevel ?? given.twoLevelVideoType,
  });
  const videoType = numberOf(observation?.videoType ?? given.videoType) ?? 0;
  return { videoId, name, md5, ...meta, videoType, createTime: observation?.createTime ?? given.createTime ?? given.uploadTime ?? null };
}

/** The rows of one page, in the order the page returned them (a row without an id is dropped, not invented). */
export function rowsFromPage(items) {
  const rows = [];
  for (const item of Array.isArray(items) ? items : []) {
    const row = rowOf(item);
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * Read every page of every class.
 *
 * Returns the rows in the order they arrived plus what the sweep saw, and never throws for a page that fails: that
 * class stops, the warning names the page, and the classes after it are still read. What cannot be a warning is a
 * missing `fetchPage` — that is a caller's bug.
 *
 * Two numbers come out of the walk, and they answer two different questions: `sourceTotal` is what the supplier claims
 * (the `total`s added up), `pageable` is what it actually served (each class's rows held under its own claim). On this
 * account the difference is 150 931 rows of `videoType 1` that no page number can reach.
 *
 * @param {{
 *   fetchPage: (ask: {videoType: number, pageNo: number, pageSize: number}) => Promise<{items?: unknown[], total?: unknown}>,
 *   pageSize?: number,
 *   videoTypes?: readonly number[],
 *   maxPagesPerType?: number,
 *   throttleMs?: number,
 *   maxRetries?: number,
 *   sleep?: (ms: number) => Promise<unknown>,
 *   onPage?: ((read: {videoType: number, pageNo: number, rows: number, fresh: number, total: number | null}) => void) | null,
 * }} options
 */
export async function collectMaterialRows({
  fetchPage,
  pageSize = PAGE_SIZE,
  videoTypes = MATERIAL_VIDEO_TYPES,
  maxPagesPerType = MAX_PAGES_PER_TYPE,
  throttleMs = DEFAULT_THROTTLE_MS,
  maxRetries = RATE_LIMIT_RETRIES,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  onPage = null,
} = /** @type {any} */ ({})) {
  if (typeof fetchPage !== 'function') throw new TypeError('collectMaterialRows needs a fetchPage function');
  const size = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : PAGE_SIZE;
  const cap = Number.isInteger(maxPagesPerType) && maxPagesPerType > 0 ? maxPagesPerType : MAX_PAGES_PER_TYPE;
  const pause = Number.isFinite(throttleMs) && throttleMs > 0 ? throttleMs : 0;
  const retries = Number.isInteger(maxRetries) && maxRetries >= 0 ? maxRetries : RATE_LIMIT_RETRIES;

  /** @type {{videoId: string, name: string, md5: string, labels: string[], durationMs: number | null, author: string,
   *   coverUrl: string, oneLevel: string, twoLevel: string}[]} */
  const rows = [];
  /** @type {{videoType: number, pages: number, rows: number, total: number | null, pageable: number, stopped: string}[]} */
  const types = [];
  /** @type {{code: string, videoType?: number, pageNo?: number, message: string, [key: string]: unknown}[]} */
  const warnings = [];
  let sourceTotal = 0;
  let pageable = 0;
  let fetched = 0;
  let backedOff = 0;

  for (const videoType of videoTypes) {
    const seen = new Set();
    /** @type {number | null} */
    let expected = null;
    let pages = 0;
    let rowCount = 0;
    let stopped = 'complete';

    for (let pageNo = 1; ; pageNo++) {
      if (pageNo > cap) {
        stopped = 'page-cap';
        warnings.push({
          code: 'page-cap', videoType, pageNo: pageNo - 1, maxPages: cap,
          message: `videoType ${videoType}: ${cap} 页仍未读完（已收 ${seen.size} 条），停止该类型`,
        });
        break;
      }

      /* the retry loop can leave without assigning (it gives up): `undefined` is a page that was not read */
      /** @type {{items?: unknown[], total?: unknown} | undefined} */
      let page;
      let attempt = 0;
      let gaveUp = false;
      for (;;) {
        /* Pace the sweep: the supplier answers 429 at ≈144 requests/minute, and a 108/minute walk is the one measured
           not to. The first page of the whole walk is not paced — there is nothing before it to pace against — and a
           retry is paced by its own backoff, not by both. */
        if (pause > 0 && fetched > 0 && attempt === 0) await sleep(pause);
        try {
          page = await fetchPage({ videoType, pageNo, pageSize: size });
          break;
        } catch (error) {
          /* A rate limit is a "wait and ask again", never a page that does not exist. Everything else stops the class. */
          if (!isRateLimited(error) || attempt >= retries) {
            gaveUp = true;
            stopped = 'page-failed';
            warnings.push({
              code: 'page-failed', videoType, pageNo, attempts: attempt + 1,
              detail: String(/** @type {any} */ (error)?.message ?? error),
              message: `videoType ${videoType} 第 ${pageNo} 页读取失败，该类型在此停止（已收 ${seen.size} 条）`,
            });
            break;
          }
          attempt += 1;
          backedOff += 1;
          const wait = backoffMs(attempt);
          warnings.push({
            code: 'rate-limited', videoType, pageNo, attempt, waitMs: wait,
            message: `videoType ${videoType} 第 ${pageNo} 页被供应商限流，退避 ${wait}ms 后重试（第 ${attempt} 次）`,
          });
          await sleep(wait);
        }
      }
      if (gaveUp) break;
      pages += 1;
      fetched += 1;

      const reported = wholeNumber(page?.total);
      if (reported !== null) {
        if (expected !== null && reported !== expected) {
          warnings.push({
            code: 'total-changed', videoType, pageNo, previous: expected, total: reported,
            message: `videoType ${videoType} 第 ${pageNo} 页的 total 从 ${expected} 变为 ${reported}`,
          });
        }
        expected = reported;
      }

      const pageRows = rowsFromPage(page?.items);
      if (pageRows.length === 0) {
        stopped = 'empty-page';
        /* a class with nothing in it (total 0, nothing collected) is a fact, not a warning; an empty page the total
           said would have rows is */
        if (expected === null || expected > seen.size) {
          warnings.push({
            code: 'empty-page', videoType, pageNo, collected: seen.size, total: expected,
            message: `videoType ${videoType} 第 ${pageNo} 页为空（已收 ${seen.size} 条${expected === null ? '' : `，total 说 ${expected}`}），按结束处理`,
          });
        }
        break;
      }

      let fresh = 0;
      for (const row of pageRows) {
        if (seen.has(row.videoId)) continue;
        seen.add(row.videoId);
        rows.push(row);
        fresh += 1;
      }
      rowCount += pageRows.length;
      if (onPage) onPage({ videoType, pageNo, rows: pageRows.length, fresh, total: expected });

      if (fresh === 0) {
        stopped = 'repeat-page';
        warnings.push({
          code: 'repeat-page', videoType, pageNo, repeated: pageRows.length,
          message: `videoType ${videoType} 第 ${pageNo} 页与前页重复（${pageRows.length} 条全是已收的），按结束处理`,
        });
        break;
      }
      if (pageRows.length < size) { stopped = 'short-page'; break; }
      if (expected !== null && seen.size >= expected) { stopped = 'reached-total'; break; }
    }

    if (expected === null) {
      warnings.push({
        code: 'total-missing', videoType,
        message: `videoType ${videoType} 没有报 total，sourceTotal 只累加报了的类型`,
      });
    }
    sourceTotal += expected ?? 0;
    /* What this class could be paged: its own rows, never more than it claimed (a repeat page can serve more rows than
       the claim, and that surplus is a duplicate, not extra material). */
    const reachable = Math.min(rowCount, expected ?? rowCount);
    pageable += reachable;
    types.push({ videoType, pages, rows: rowCount, total: expected, pageable: reachable, stopped });
  }

  return { rows, sourceTotal, pageable, fetched, backedOff, pageSize: size, types, warnings };
}

/**
 * The whole build: every page, the index over the rows, and the counts said once.
 *
 * Three totals, three questions: `sourceTotal` is what the supplier claims, `pageable` is what it will actually serve,
 * `unreachable` is the difference (`videoType 1`'s 150 931 rows). `parsed + unclassified` is what we hold, and
 * `duplicates = pageable - videos` is the overlap the supplier served twice. So every gap is named:
 *
 *   sourceTotal = parsed + unclassified + duplicates + unreachable
 *
 * `staleAfterMs` travels with the file so a reader knows when this index stops being good enough to read.
 */
export async function buildMaterialIndexFromApi(options = /** @type {any} */ ({})) {
  const collected = await collectMaterialRows(options);
  const pageable = collected.pageable;
  const unreachable = Math.max(0, collected.sourceTotal - pageable);
  const index = buildMaterialIndex(collected.rows, options.now ?? new Date(), {
    sourceTotal: collected.sourceTotal, pageable, unreachable,
  });
  const { videos, parsed, unclassified } = index.totals;
  const staleAfterMs = Number.isFinite(options.staleAfterMs) && options.staleAfterMs > 0 ? options.staleAfterMs : STALE_AFTER_MS;
  const warnings = [...collected.warnings];

  const difference = collected.sourceTotal - (parsed + unclassified);
  if (difference !== 0) {
    warnings.push({
      code: 'source-total-mismatch', difference, sourceTotal: collected.sourceTotal, counted: parsed + unclassified,
      message: `sourceTotal ${collected.sourceTotal} 与 parsed+unclassified ${parsed + unclassified} 相差 ${difference}`,
    });
  }
  if (unreachable > 0) {
    warnings.push({
      code: 'unreachable', sourceTotal: collected.sourceTotal, pageable, unreachable,
      message: `供应商声称 ${collected.sourceTotal} 条，实际只能翻到 ${pageable} 条：${unreachable} 条不可达`,
    });
  }
  if (unclassified > 0) {
    const derived = derivedTotals(index);
    warnings.push({
      code: 'unclassified', count: unclassified,
      derived: { batches: derived.batches, grouped: derived.grouped, unassigned: derived.unassigned },
      message: `${unclassified} 条名称不符合「批次-产品-分组 (序号)」，未归入任何批次/合集；分层后：派生批次 ${derived.batches} / 未归档 ${derived.grouped} / 未归类 ${derived.unassigned}`,
    });
  }

  return {
    schema: INDEX_SCHEMA,
    generatedAt: index.generatedAt,
    staleAfterMs,
    sourceTotal: collected.sourceTotal,
    pageable,
    unreachable,
    duplicates: Math.max(0, pageable - videos),
    videos,
    parsed,
    unclassified,
    pageSize: collected.pageSize,
    pages: { fetched: collected.fetched, backedOff: collected.backedOff, perType: collected.types },
    warnings,
    index,
  };
}

const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** Rename over the target, trying again while Windows says the file is busy (Defender, the indexer, OneDrive). */
async function replaceFile(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { return await rename(from, to); }
    catch (error) {
      const code = String(/** @type {any} */ (error)?.code ?? '');
      if (process.platform !== 'win32' || !BUSY.has(code) || attempt >= 8) throw error;
      await new Promise((done) => setTimeout(done, 20 * 2 ** attempt));
    }
  }
}

/**
 * Land the build as `<dir>/index.json`: bytes to `index.json.tmp`, **read back and parsed**, and only then renamed over.
 *
 * Three rules, each because it already went wrong once (`docs/execution/2026-11-16-auth-unify/material-index-encoding.md`):
 *
 *  1. **UTF-8 is written here, explicitly** (`writeFileSync(tmp, text, 'utf8')`), by this process. The file never passes
 *     through a shell: a `Set-Content` / `Out-File` round trip takes the console codepage (GBK here) and turns 「标品」
 *     into 「鏍囧搧」, which is not reversible and still looks like JSON.
 *  2. **The tmp file is read back and `JSON.parse`d before the rename.** Bytes that do not come back identical, or do not
 *     parse, are a failed build — not an index.
 *  3. **A failed build deletes its tmp and throws**: the previous `index.json` is never touched, and no half file is left
 *     behind for a reader to pick up.
 *
 * The directory is made 0700 when it does not exist; on Windows only the file attribute that exists there is set, the
 * mode is a POSIX promise.
 * @param {string} dir
 * @param {object} result what {@link buildMaterialIndexFromApi} returned
 * @param {{dirMode?: number, fileMode?: number}} [options]
 */
export async function writeMaterialIndex(dir, result, { dirMode = 0o700, fileMode = 0o600 } = {}) {
  if (typeof dir !== 'string' || !dir.trim()) throw new TypeError('writeMaterialIndex needs a directory');
  await mkdir(dir, { recursive: true, mode: dirMode });
  try { await chmod(dir, dirMode); } catch { /* Windows: the mode is not a filesystem fact there */ }
  try { chmodSync(dir, dirMode); } catch { /* same */ }

  const file = materialIndexPath(dir);
  const tmp = `${file}.tmp`;
  const text = `${JSON.stringify(result, null, 2)}\n`;
  const built = /** @type {any} */ (result);
  try {
    /* rule 1: explicit encoding, no shell, no locale */
    writeFileSync(tmp, text, 'utf8');
    try { chmodSync(tmp, fileMode); } catch { /* same */ }
    /* rule 2: what landed is what is verified — a mojibake or truncated write fails here, not on a reader's screen */
    verifyLandedIndex(tmp, text, built);
    await replaceFile(tmp, file);
  } catch (error) {
    /* rule 3: the tmp goes, the old index stays, the caller hears why */
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
  return {
    directory: dir,
    file,
    bytes: Buffer.byteLength(text, 'utf8'),
    md5s: countMd5s(built?.index),
    metadata: countMetadata(built?.index),
    generatedAt: built?.generatedAt ?? null,
    videos: built?.videos ?? null,
    parsed: built?.parsed ?? null,
    unclassified: built?.unclassified ?? null,
    sourceTotal: built?.sourceTotal ?? null,
    pageable: built?.pageable ?? null,
    unreachable: built?.unreachable ?? null,
  };
}

/**
 * How many entries carry a digest, and how many there are: the number a person checks the `md5` field with.
 * @param {any} index
 */
export function countMd5s(index) {
  let entries = 0;
  let withMd5 = 0;
  const count = (list) => {
    for (const entry of Array.isArray(list) ? list : []) {
      entries += 1;
      if (typeof entry?.md5 === 'string' && entry.md5) withMd5 += 1;
    }
  };
  for (const batch of index?.batches ?? []) {
    for (const product of batch?.products ?? []) for (const group of product?.groups ?? []) count(group?.entries);
  }
  count(index?.unclassified);
  return { entries, withMd5, missing: entries - withMd5 };
}

/**
 * How many entries carry each card field, over the whole index (`batches[].products[].groups[].entries[]` plus
 * `unclassified[]`): the number a person checks the harvest with, and the one that says a field silently stopped being
 * read — "0 with labels" looks exactly like an account whose labels are all empty until it is printed beside 78 874.
 *
 * `category` counts an entry with *either* level, because that is what the document text needs; `oneLevel` /
 * `twoLevel` are kept apart so a tree that only fills one level is visible.
 * @param {any} index
 */
export function countMetadata(index) {
  const counts = { entries: 0, labels: 0, duration: 0, author: 0, coverUrl: 0, oneLevel: 0, twoLevel: 0, category: 0 };
  const count = (list) => {
    for (const entry of Array.isArray(list) ? list : []) {
      counts.entries += 1;
      if (Array.isArray(entry?.labels) && entry.labels.length) counts.labels += 1;
      if (typeof entry?.durationMs === 'number' && Number.isFinite(entry.durationMs) && entry.durationMs >= 0) counts.duration += 1;
      if (typeof entry?.author === 'string' && entry.author) counts.author += 1;
      if (typeof entry?.coverUrl === 'string' && entry.coverUrl) counts.coverUrl += 1;
      if (entry?.oneLevel) counts.oneLevel += 1;
      if (entry?.twoLevel) counts.twoLevel += 1;
      if (entry?.oneLevel || entry?.twoLevel) counts.category += 1;
    }
  };
  for (const batch of index?.batches ?? []) {
    for (const product of batch?.products ?? []) for (const group of product?.groups ?? []) count(group?.entries);
  }
  count(index?.unclassified);
  return counts;
}

/**
 * Read the tmp file back and prove it is the index that was meant: identical text, parses as JSON, same schema, same
 * `videos` count. Anything else throws `index-verify-failed` (the caller deletes the tmp).
 * @param {string} tmp
 * @param {string} text
 * @param {any} built
 */
function verifyLandedIndex(tmp, text, built) {
  const fail = (message) => Object.assign(new Error(`素材索引自校验失败（${tmp}）：${message}；已删除临时文件，旧 index.json 未改动`), {
    code: 'index-verify-failed', file: tmp,
  });
  const back = readFileSync(tmp, 'utf8');
  if (back !== text) {
    throw fail(`读回的 ${back.length} 字符与写入的 ${text.length} 字符不一致（编码被改写）`);
  }
  let reparsed;
  try { reparsed = JSON.parse(back); }
  catch (error) { throw fail(`读回的内容不是合法 JSON：${String(/** @type {any} */ (error)?.message ?? error)}`); }
  if (!reparsed || typeof reparsed !== 'object' || Array.isArray(reparsed)) throw fail('读回的 JSON 不是对象');
  if ((built?.schema ?? null) !== (reparsed.schema ?? null)) throw fail(`schema 读回为 ${String(reparsed.schema)}`);
  if ((built?.videos ?? null) !== (reparsed.videos ?? null)) throw fail(`videos 读回为 ${String(reparsed.videos)}`);
}

/**
 * The index as it was written, or `null` when there is none (or it does not parse). A reader that finds nothing says
 * so; nothing here invents an empty index.
 * @param {string} dir
 * @param {{read?: (path: string, encoding: 'utf8') => string}} [options]
 */
export function readMaterialIndex(dir, { read = readFileSync } = /** @type {any} */ ({})) {
  try {
    const text = read(materialIndexPath(dir), 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && Array.isArray(parsed.index?.batches) ? parsed : null;
  } catch {
    return null;
  }
}

/** How long ago a landed index was built; `null` when it does not say (an older file, or a hand-written one). */
export function indexAgeMs(result, now = new Date()) {
  const at = Date.parse(String(/** @type {any} */ (result)?.generatedAt ?? ''));
  if (!Number.isFinite(at)) return null;
  return Math.max(0, now.getTime() - at);
}

/**
 * Whether a landed index is past its freshness window. The window is the caller's, else the file's own `staleAfterMs`,
 * else 24 h. An index that cannot say when it was built is treated as stale: reading it would be a guess.
 * @param {any} result what {@link readMaterialIndex} returned
 * @param {{now?: Date, staleAfterMs?: number}} [options]
 */
export function isIndexStale(result, { now = new Date(), staleAfterMs } = {}) {
  const own = Number(/** @type {any} */ (result)?.staleAfterMs);
  /* the caller's window is optional, so it is narrowed to a number before `Number.isFinite` sees it */
  const asked = typeof staleAfterMs === 'number' ? staleAfterMs : NaN;
  const window = Number.isFinite(asked) && asked >= 0 ? asked : (Number.isFinite(own) && own > 0 ? own : STALE_AFTER_MS);
  const age = indexAgeMs(result, now);
  if (age === null) return true;
  return age >= window;
}

/**
 * The index a reader should use: **the file first**, and a sweep only when there is nothing to read or what is there is
 * stale (`generatedAt` + `staleAfterMs`, 24 h by default). `force` is the one way past that — a person asking for a new
 * index is not a cache miss.
 *
 * Returns the result together with where it came from, so a caller can say "read" instead of pretending it built one:
 * `reason` is `fresh` | `stale` | `missing` | `unreadable` | `forced`.
 *
 * @param {string} dir
 * @param {{
 *   now?: Date,
 *   staleAfterMs?: number,
 *   force?: boolean,
 *   build?: () => Promise<any>,
 *   read?: (dir: string, options?: any) => any,
 *   write?: (dir: string, result: any) => Promise<any>,
 * }} [options]
 */
export async function loadMaterialIndex(dir, {
  now = new Date(), staleAfterMs, force = false, build, read = readMaterialIndex, write = writeMaterialIndex,
} = {}) {
  const landed = read(dir);
  const ageMs = landed ? indexAgeMs(landed, now) : null;
  if (!force && landed && !isIndexStale(landed, { now, staleAfterMs })) {
    return { result: landed, fromCache: true, reason: 'fresh', ageMs, written: null };
  }
  if (typeof build !== 'function') {
    throw Object.assign(new TypeError('loadMaterialIndex needs a build function when the index is missing or stale'), {
      code: landed ? 'index-stale' : 'index-missing', dir, ageMs,
    });
  }
  const reason = force ? 'forced' : landed ? 'stale' : 'missing';
  const result = await build();
  const written = await write(dir, result);
  return { result, fromCache: false, reason, ageMs, written };
}
