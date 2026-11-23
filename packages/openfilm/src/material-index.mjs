// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * Our own index of the cloud steward's materials.
 *
 * The supplier's collection id (`videoCollectionId`) is not in any OpenAPI this build can call, but every material's
 * name already says where it belongs: `20261106-柠檬宝藏茶200g罐-外包装 (46)` is batch `20261106`, product
 * `柠檬宝藏茶200g罐`, group `外包装`, sequence 46. Those three levels are what a person sees as 批次 / 合集 / 子合集,
 * and parsing the name is exact — unlike the category tree, whose names repeat (four two-level categories share one
 * name) and whose account differs from the collection's (`李雪妮` in the name, `郑淏月` in `accountName`).
 *
 * The index is what both the UI views and the agent tools read, so they cannot disagree about a count.
 *
 * # What a row keeps besides its place
 *
 * A parsed group's `entries` — and the flat `unclassified` list — carry the supplier's `rawMd5` as `md5` (`''` when the
 * row carried none, e.g. a material nobody ever downloaded). Nothing is derived from it here: it is carried so a later
 * step can ask "are these the same bytes?" without sweeping the supplier again.
 *
 * They also carry the six card fields the supplier sends with every row (`ENTRY_META_FIELDS`: `labels` from
 * `videoLabels`, `durationMs` from the supplier's seconds, `author` from `accountName`, `coverUrl`, `oneLevel` /
 * `twoLevel` from `oneLevelVideoType.name` / `twoLevelVideoType.name`). Harvesting used to drop them, which left the
 * document text made of 「批次 + 产品 + 分组 + 名称」 only — so `柠檬宝藏茶 外包装` ranked as `墨红玫瑰-外包装` (0.9768)
 * because the classification that says *which* tea was never in the text. An index written before these fields existed
 * still reads: `entryMetaOf` answers `[]` / `null` / `''` for what is not there.
 *
 * # Two layers, one of them derived
 *
 * Measured over the whole account (78 994 materials, `docs/execution/2026-11-16-auth-unify/material-index-run.md`): only
 * 390 names follow that pattern (0.49%). Losing the other 78 604 to one flat list would leave the 合集 view useless, so
 * what a name still says is read in a second, **derived** layer, kept apart from the parsed tree so nothing pretends a
 * material name is a batch id:
 *
 *  - `derived.batches` — the name opens with a numeric date or number (`12.13_…`, `20250422-4 …`, `12月18日 …`). Those
 *    are material *dates*, not batch numbers; they are pseudo-batches, marked `derived: true`, and never enter
 *    `batches`.
 *  - `derived.groups` — one 「未归档」 pseudo-collection, bucketed by the group word the name contains (`茶干`, `汤色`,
 *    `包装`, `规格`, `冲泡`…) or by a trailing `_n` sequence, which is all a name without a product still tells us.
 *  - `derived.unassigned` — a count only: capture names (`IMG_2525`), pure ASCII names and everything else that says
 *    nothing about a batch or a group. No group is invented for them, and no card wall is drawn from them.
 *
 * The three buckets add up to `totals.unclassified` — `derivedTotals` states it, and the tests pin it.
 */

/** `20261106-柠檬宝藏茶200g罐-外包装 (46)` → its parts; anything else is not claimed. */
const NAMED = /^(\d{8})-(.+?)-([^-/]+?)\s*\((\d+)\)$/;

/**
 * The three levels a name names, or null when it does not follow the pattern.
 * `product` may itself contain `-` (e.g. `20261106-2024头采新会柑普茶250g罐-包装 (33)`), so the product is everything
 * between the date and the last group segment.
 * @param {string} name
 */
import { productOf } from './material-product.mjs';

export function parseMaterialName(name) {
  const text = typeof name === 'string' ? name.trim() : '';
  const found = NAMED.exec(text);
  if (!found) return null;
  const [, date, middle, group, seq] = found;
  const cut = middle.lastIndexOf('-');
  const product = cut === -1 ? middle : middle.slice(0, cut);
  const productGroup = cut === -1 ? group : middle.slice(cut + 1);
  const parts = productGroup.split('-').filter(Boolean);
  return {
    date,
    product: product || productGroup,
    group: parts.length ? parts[parts.length - 1] : group,
    /** the group as written after the product, kept whole for display (`茶干料子-包装` stays one label) */
    groupLabel: productGroup,
    sequence: Number(seq),
    name: text,
  };
}

/* ── the derived layer's rules, in one place ─────────────────────────────────────────────────────────────────────── */

/**
 * A numeric date at the very start of a name. A dotted / 月日 / 年月日 token is a date wherever it sits (`12.10吴非…` is
 * December 10th), so it needs no separator after it; a bare number does, or `2024头采…` (a product, not a batch) would
 * be read as batch `2024`.
 */
const DATE_DOTTED = /^(\d{1,2}[./-]\d{1,2}(?:[./-]\d{1,2})?)(?!\d)/;
const DATE_CN = /^(\d{1,2}月\d{1,2}日?)/;
const DATE_CN_YEAR = /^(\d{4}年\d{1,2}月(?:\d{1,2}日?)?)/;
const NUMBER_LEAD = /^(\d{2,8})(?=$|[\s\-_/.,，、()（）:：+＋~\u3000])/;

/**
 * The group words a name is bucketed by, longest first so `外包装` is not read as `包装` at the same position. This is a
 * vocabulary of the account's own naming (`material-index-run.md` §6), not a guess at a hierarchy.
 */
export const DERIVED_GROUP_WORDS = Object.freeze([
  '茶干料子', '茶汤汤色', '包装展示', '原料展示', '外包装', '加冰块',
  '茶干', '茶汤', '汤色', '包装', '规格', '冲泡', '原料', '标品', '展示', '细节', '成品',
]);

/** The bucket for a name whose only structure is a trailing `_n`: it is not a group word, and saying so is honest. */
export const SEQUENCE_BUCKET = '其他（只有序号）';
export const UNFILED_ID = 'derived:unfiled';
export const UNFILED_NAME = '未归档';

/** `…_3`, `…_12`: the sequence marker the supplier's own names carry. */
const SEQUENCE_TAIL = /_\d{1,4}$/;
/** A capture name says nothing about the business material: `IMG_2525`, `VID_…`, `mmexport…`, `微信图片_…`. */
const CAPTURE_PREFIX = /^(IMG|VID|DSC|DSCF|PXL|DJI|GOPR|mmexport|微信图片|Screenshot|WechatIMG)[_\-\s.]/i;
/** No CJK at all: a camera file name or an export, never a product. */
const ASCII_NAME = /^[\x00-\x7F]+$/;

/**
 * What a name the strict pattern did not claim still says. One function, so the buckets cannot disagree about a rule.
 *
 * @param {string} name
 * @returns {{kind: 'batch', token: string} | {kind: 'group', word: string} | {kind: 'sequence'} | {kind: 'none'}}
 */
export function classifyUnparsedName(name) {
  const text = typeof name === 'string' ? name.trim() : '';
  if (!text) return { kind: 'none' };
  /* A capture name is a file, not a material: no date, no group — even when it ends in `_2525`. */
  if (ASCII_NAME.test(text) || CAPTURE_PREFIX.test(text)) return { kind: 'none' };

  for (const pattern of [DATE_CN_YEAR, DATE_CN, DATE_DOTTED, NUMBER_LEAD]) {
    const found = pattern.exec(text);
    if (found) return { kind: 'batch', token: found[1] };
  }

  /* The group word: the earliest one the name carries; at the same position the longest (`外包装` beats `包装`). */
  let best = null;
  for (const word of DERIVED_GROUP_WORDS) {
    const at = text.indexOf(word);
    if (at < 0) continue;
    if (!best || at < best.at || (at === best.at && word.length > best.word.length)) best = { at, word };
  }
  if (best) return { kind: 'group', word: best.word };
  if (SEQUENCE_TAIL.test(text)) return { kind: 'sequence' };
  return { kind: 'none' };
}

/**
 * `md5` is the supplier's `rawMd5` when the row carried one (`''` when it did not — a material nobody downloaded has
 * `rawFileSize: 0` and may have no digest yet). It is additive: no count, order or id changes because of it.
 *
 * The six card fields are additive for the same reason (`ENTRY_META_FIELDS`): they are what `mediaDocText` needs to put
 * the supplier's own categories into a document (until they were carried here, `柠檬宝藏茶200g罐` was only ever a
 * product name and `茉莉花茶类` never reached the text at all). An older index without them reads back as empty —
 * `entryMetaOf` is the one place that decides that, so a missing field is `[]` / `null` / `''`, never a throw.
 * @typedef {{ videoId: string, name: string, md5: string, labels: string[], durationMs: number | null, author: string,
 *   coverUrl: string, oneLevel: string, twoLevel: string }} IndexEntry
 */
/** @typedef {{ pageable: number, sourceTotal: number, unreachable: number }} IndexReach */

const byCountThenName = (a, b) => b.count - a.count || a.name.localeCompare(b.name);

/**
 * The digest a row carries, whichever of the two names it uses (`rawMd5` is the supplier's own field, `md5` the short
 * one a caller may hand over). A `{sourceType, source}` wrapper is unwrapped; anything that is not a non-empty string is
 * `''`, so an entry never claims a digest it was not given.
 * @param {any} row
 */
export function md5Of(row) {
  const raw = row?.rawMd5 ?? row?.md5;
  const value = raw && typeof raw === 'object' ? raw.source ?? raw.value : raw;
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The six card fields an entry carries beside its place, in the order an entry writes them. Nothing is derived from
 * them here — `material-doc.mjs` decides what a field means in a document; this file only keeps what the supplier said.
 */
export const ENTRY_META_FIELDS = Object.freeze(['labels', 'durationMs', 'author', 'coverUrl', 'oneLevel', 'twoLevel']);

/** `{sourceType: 'number', source: '101'}` → `'101'`; a plain string/number as itself; anything else `null`. */
function scalarOf(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const raw = /** @type {any} */ (value).source ?? /** @type {any} */ (value).value;
    return typeof raw === 'string' || typeof raw === 'number' ? raw : null;
  }
  return typeof value === 'string' || typeof value === 'number' ? value : null;
}

/** A wire text as trimmed text; a number as its digits; nothing usable as `''` (never `String(undefined)`). */
function textAt(value) {
  const raw = scalarOf(value);
  if (typeof raw === 'string') return raw.trim();
  return typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : '';
}

/** A whole, non-negative number from a number, a digit string or a wire literal; anything else `null`. */
export function numberOf(value) {
  const raw = scalarOf(value);
  const number = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : null;
}

/**
 * The names of a supplier label list. The wire sends `videoLabels: [{id, name, level, …}]`; a caller that already
 * normalized them hands over strings. Order is kept as read (dedupe/sort is `docLabels`'s job, in the doc layer), and a
 * blank name is dropped rather than becoming an empty token.
 * @param {unknown} labels
 * @returns {string[]}
 */
export function labelNames(labels) {
  const out = [];
  for (const raw of Array.isArray(labels) ? labels : []) {
    const isRow = raw && typeof raw === 'object' && !Array.isArray(raw) && /** @type {any} */ (raw).sourceType === undefined;
    const value = textAt(isRow ? /** @type {any} */ (raw).name : raw);
    if (value) out.push(value);
  }
  return out;
}

/**
 * A category's own name: `{name: '茉莉花茶类', id: {…}}` → `茉莉花茶类`; a plain string as itself. The id is never part
 * of it — a number is not something anybody searches for, and the category tree repeats names across accounts anyway.
 * @param {unknown} value
 */
export function categoryName(value) {
  const isRow = value && typeof value === 'object' && !Array.isArray(value) && /** @type {any} */ (value).sourceType === undefined;
  return textAt(isRow ? /** @type {any} */ (value).name : value);
}

/**
 * The supplier's `duration` is **seconds** (`contract.ts` / `model.ts`: `durationSeconds`), the entry's is `durationMs`.
 * An entry that already carries `durationMs` is taken as is; `duration` / `durationSeconds` are multiplied once.
 * @param {any} row
 * @returns {number | null}
 */
export function durationMsOf(row) {
  const given = numberOf(row?.durationMs);
  if (given !== null) return given;
  for (const key of ['duration', 'durationSeconds']) {
    const seconds = numberOf(row?.[key]);
    if (seconds !== null) return seconds * 1000;
  }
  return null;
}

/**
 * The six fields of an entry, from a row in either shape: the normalized one (`{labels: ['茶'], durationMs, author,
 * coverUrl, oneLevel, twoLevel}`) or the supplier's own (`videoLabels` / `duration` / `accountName` /
 * `oneLevelVideoType` / `twoLevelVideoType`). Whatever the row does not say is empty — an old index has none of them,
 * and reading it must give empty fields, not a crash and not an invented value.
 * @param {any} row
 * @returns {{labels: string[], durationMs: number | null, author: string, coverUrl: string, oneLevel: string, twoLevel: string}}
 */
export function entryMetaOf(row) {
  const source = row && typeof row === 'object' ? row : {};
  return {
    labels: labelNames(source.labels ?? source.videoLabels),
    durationMs: durationMsOf(source),
    author: textAt(source.author ?? source.accountName),
    coverUrl: textAt(source.coverUrl),
    oneLevel: categoryName(source.oneLevel ?? source.oneLevelVideoType),
    twoLevel: categoryName(source.twoLevel ?? source.twoLevelVideoType),
  };
}

/**
 * The whole tree: batches → products (合集) → groups (子合集) → video ids. Ordering is by count, then name, so a batch
 * with more material comes first and the order does not depend on the order rows arrived in.
 *
 * `reach` is the supplier's own arithmetic (`sourceTotal` claimed vs `pageable` actually served) when the caller knows
 * it; it is carried on the tree so a view can print the gap without a second source of truth.
 *
 * @param {IndexEntry[]} rows
 * @param {Date} [now]
 * @param {IndexReach | null} [reach]
 */
/** 这一期是哪天：优先 createTime（YYYY-MM-DD…），其次名字开头的 8 位日期；都没有就留空。 */
function materialDateOf(createTime, name) {
  const timestamp = typeof createTime === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(createTime) : null;
  if (timestamp) return `${timestamp[1]}${timestamp[2]}${timestamp[3]}`;
  const dated = typeof name === 'string' ? /^(\d{8})/.exec(name) : null;
  return dated ? dated[1] : '';
}

export function buildMaterialIndex(rows, now = new Date(), reach = null) {
  const batches = new Map();
  const derivedBatches = new Map();
  const unfiled = new Map();
  const unclassified = [];
  const seen = new Set();
  const productGroups = new Map();
  let unassigned = 0;

  for (const row of Array.isArray(rows) ? rows : []) {
    const videoId = typeof row?.videoId === 'string' ? row.videoId : String(row?.videoId ?? '');
    const name = typeof row?.name === 'string' ? row.name : '';
    if (!videoId || seen.has(videoId)) continue;
    seen.add(videoId);
    const md5 = md5Of(row);
    const meta = entryMetaOf(row);
    const productName = meta.twoLevel || productOf(name) || '';
    if (productName) {
      const oneLevel = meta.oneLevel || '';
      const key = `${oneLevel}|${productName}`;
      let group = productGroups.get(key);
      if (!group) { group = { id: `product:${key}`, oneLevel, name: productName, count: 0, videoIds: [], entries: [], dates: new Map(), labelGroups: new Map() }; productGroups.set(key, group); }
      group.count += 1;
      group.videoIds.push(videoId);
      group.entries.push({ videoId, videoType: Number(row?.videoType) || 0 });
      const date = materialDateOf(typeof row?.createTime === 'string' ? row.createTime : '', name);
      const dateGroup = group.dates.get(date) ?? { date, count: 0 };
      dateGroup.count += 1;
      group.dates.set(date, dateGroup);
      for (const label of meta.labels ?? []) {
        let labelGroup = group.labelGroups.get(label);
        if (!labelGroup) { labelGroup = { name: label, count: 0, videoIds: [], entries: [] }; group.labelGroups.set(label, labelGroup); }
        labelGroup.count += 1;
        labelGroup.videoIds.push(videoId);
        labelGroup.entries.push({ videoId, videoType: Number(row?.videoType) || 0 });
      }
    }
    const parsed = parseMaterialName(name);
    if (!parsed) {
      unclassified.push({ videoId, name, md5, ...meta });
      const derived = classifyUnparsedName(name);
      if (derived.kind === 'batch') {
        const id = `derived:${derived.token}`;
        let batch = derivedBatches.get(id);
        if (!batch) { batch = { id, name: derived.token, count: 0, videoIds: [], derived: true }; derivedBatches.set(id, batch); }
        batch.count += 1;
        batch.videoIds.push(videoId);
      } else if (derived.kind === 'group' || derived.kind === 'sequence') {
        const label = derived.kind === 'group' ? derived.word : SEQUENCE_BUCKET;
        let group = unfiled.get(label);
        if (!group) { group = { id: `${UNFILED_ID}:${label}`, name: label, count: 0, videoIds: [], derived: true }; unfiled.set(label, group); }
        group.count += 1;
        group.videoIds.push(videoId);
      } else {
        unassigned += 1;
      }
      continue;
    }

    const batchId = parsed.date;
    const productId = `${parsed.date}-${parsed.product}`;
    let batch = batches.get(batchId);
    if (!batch) { batch = { id: batchId, name: batchId, count: 0, products: new Map() }; batches.set(batchId, batch); }
    let product = batch.products.get(productId);
    if (!product) { product = { id: productId, name: parsed.product, count: 0, groups: new Map() }; batch.products.set(productId, product); }
    const groupId = `${productId}-${parsed.groupLabel}`;
    let group = product.groups.get(groupId);
    if (!group) { group = { id: groupId, name: parsed.groupLabel, count: 0, videoIds: [], entries: [] }; product.groups.set(groupId, group); }

    for (const target of [batch, product, group]) target.count += 1;
    /* `videoIds` stays the ids alone (materialIds returns them), and `entries` carries the name beside each id: the
       agent tools (`material.items`) answer with a name, and nothing else in the index keeps one. Additive only —
       totals, ordering and `videoIds` are what they were. `md5` is additive too: `''` when the row had no digest, and
       the six card fields (`ENTRY_META_FIELDS`) are how the supplier's labels / duration / author / categories reach
       the document text instead of being dropped at harvest time. */
    group.videoIds.push(videoId);
    group.entries.push({ videoId, name, md5, ...meta });
  }

  const unfiledGroups = [...unfiled.values()].sort(byCountThenName);
  const unfiledCount = unfiledGroups.reduce((total, group) => total + group.count, 0);
  return {
    schema: 'orange/material-index/1',
    generatedAt: now.toISOString(),
    totals: {
      videos: seen.size,
      parsed: seen.size - unclassified.length,
      unclassified: unclassified.length,
    },
    batches: [...batches.values()].sort(byCountThenName).map((batch) => ({
      id: batch.id,
      name: batch.name,
      count: batch.count,
      products: [...batch.products.values()].sort(byCountThenName).map((product) => ({
        id: product.id,
        name: product.name,
        count: product.count,
        groups: [...product.groups.values()].sort(byCountThenName),
      })),
    })),
    unclassified,
    /* 产品层：跨日期按「日期 + 供应商二级分类（产品）」聚合，子分组用视频标签（规格/配料/包装…）。 */
    products: [...productGroups.values()].sort(byCountThenName).slice(0, 2000).map((group) => ({
      id: group.id,
      oneLevel: group.oneLevel,
      name: group.name,
      count: group.count,
      videoIds: group.videoIds,
      entries: group.entries,
      dates: [...group.dates.values()].sort((a, b) => b.date.localeCompare(a.date)),
      labels: [...group.labelGroups.values()].sort(byCountThenName).map((label) => ({ name: label.name, count: label.count, videoIds: label.videoIds, entries: label.entries })),
    })),
    /* The second layer: what the names still said, with `count` as the sum of the three buckets (see `derivedTotals`). */
    derived: {
      count: unclassified.length,
      batches: [...derivedBatches.values()].sort(byCountThenName),
      groups: { id: UNFILED_ID, name: UNFILED_NAME, count: unfiledCount, derived: true, groups: unfiledGroups },
      unassigned,
    },
    ...(reach ? { reach } : {}),
  };
}

/**
 * The derived layer's three buckets, summed. `total` always equals `totals.unclassified`: the layering may not lose a
 * row, and a caller that prints the three numbers beside the flat count is printing one number twice.
 * @param {any} index
 */
export function derivedTotals(index) {
  const derived = index?.derived ?? {};
  const batches = (derived.batches ?? []).reduce((total, batch) => total + (Number(batch?.count) || 0), 0);
  const grouped = Number(derived.groups?.count) || 0;
  const unassigned = Number(derived.unassigned) || 0;
  return { batches, grouped, unassigned, total: batches + grouped + unassigned };
}

/** A collection's video ids, optionally narrowed to one group. @param {object} index @param {string} productId @param {string} [groupId] */
export function materialIds(index, productId, groupId) {
  for (const batch of index?.batches ?? []) {
    for (const product of batch.products) {
      if (product.id !== productId) continue;
      if (!groupId) return product.groups.flatMap((group) => group.videoIds);
      return product.groups.find((group) => group.id === groupId || group.name === groupId)?.videoIds ?? [];
    }
  }
  return [];
}
