// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The filter panel and what it may cost.
 *
 * Only `pageNo`, `pageSize`, `videoType`, `name`, `videoIds` and `scope` reach the server (contract §1.2 — any other
 * key is a 422). Classification, labels, the creation window and the sort therefore narrow **the page in hand**,
 * and every place that says so says "本页". Nothing here widens a page to fill a filter.
 */
import {LIST_QUERY_KEYS, type ScopeChoice, type VideoType, scopeParam} from './contract.ts';
import type {LocalKind} from './library.ts';
import type {MaterialCard} from './model.ts';

/**
 * The one catalogue the material centre reads: the cloud steward's. Local material is the drawer's 导入 tab, so there is
 * no `all` / `library` / `local` to switch to — the value is a constant, not a choice.
 */
export type MaterialSource = 'cloud';

export type SortOrder = 'newest' | 'downloads' | 'collected' | 'name';
export const SORT_ORDERS = Object.freeze([
  {value: 'newest', label: '最新发布'},
  {value: 'downloads', label: '下载最多'},
  {value: 'collected', label: '收藏最多'},
  {value: 'name', label: '标题升序'},
] as const);

/**
 * How long a material runs. The supplier has no duration parameter (contract §1.2), so this narrows **the page in
 * hand**, like the classification and the labels do; `any` is the default and costs nothing.
 */
export const DURATION_BANDS = Object.freeze(['any', 'under1m', 'oneTo5m', 'fiveTo20m', 'over20m'] as const);
export type DurationBand = (typeof DURATION_BANDS)[number];

export type MaterialFilters = {
  /** The centre is the cloud catalogue only; the field stays so the model keeps one shape, with one value. */
  readonly source: MaterialSource;
  readonly videoType: VideoType;
  readonly oneLevelId: number | null;
  readonly twoLevelId: number | null;
  readonly labelIds: readonly number[];
  /** The supplier's material status (the five the facets route lists); page-local, like the rest of these. */
  readonly stateId: number | null;
  readonly author: ScopeChoice;
  /** The local half's own dimensions: the open project, its `assets/<group>/` folder and the file kind. */
  readonly localProject: string | null;
  readonly localGroup: string | null;
  readonly localKind: LocalKind | null;
  /** The supplier two-level groups a drill-down is scoped to (sent as `twoLevelTypeIds`). */
  readonly groupIds: readonly number[];
  readonly createdFrom: string | null;
  readonly createdTo: string | null;
  /** The material's running time, page-local: the supplier has no parameter for it. */
  readonly duration: DurationBand;
  readonly search: string;
  readonly hideUnauthorized: boolean;
  readonly sort: SortOrder;
};

export const DEFAULT_FILTERS: MaterialFilters = Object.freeze({
  source: 'cloud',
  videoType: 1,
  oneLevelId: null,
  twoLevelId: null,
  labelIds: Object.freeze([]) as readonly number[],
  stateId: null,
  /* The product default: material is company-wide, so the first visit asks the company view. "Mine" is only ever asked
     for after the person picks it (and after their account is claimed), never by default and never after a claim. */
  author: 'company' as ScopeChoice,
  localProject: null,
  localGroup: null,
  localKind: null,
  groupIds: Object.freeze([]) as readonly number[],
  createdFrom: null,
  createdTo: null,
  duration: 'any' as DurationBand,
  search: '',
  hideUnauthorized: false,
  sort: 'newest' as SortOrder,
});

/** The keys the server accepts on `/api/materials/list`; `serverQuery` never returns another one. */
export type ServerQuery = {
  readonly pageNo: number;
  readonly pageSize: number;
  readonly videoType: VideoType;
  readonly name?: string;
  readonly videoIds?: string;
  readonly scope: string;
};

/** A category row the panel offers (one level or two), as the facets route gives it. */
export type CategoryOption = {readonly id: number; readonly name: string; readonly parentTypeId?: number};

/** Choosing a classification drops the narrower one: a two-level row of another parent cannot survive it. */
export function withOneLevel(filters: MaterialFilters, oneLevelId: number | null): MaterialFilters {
  if (oneLevelId === filters.oneLevelId) return filters;
  return {...filters, oneLevelId, twoLevelId: null};
}

/** Choosing a two-level category brings its parent (`parentTypeId`) along, so the two controls agree. */
export function withTwoLevel(filters: MaterialFilters, twoLevelId: number | null, twoLevel: readonly CategoryOption[]): MaterialFilters {
  if (twoLevelId === null) return {...filters, twoLevelId: null};
  const row = twoLevel.find(option => option.id === twoLevelId);
  if (!row) return filters;
  const parent = typeof row.parentTypeId === 'number' ? row.parentTypeId : filters.oneLevelId;
  return {...filters, oneLevelId: parent, twoLevelId};
}

/** The two-level rows that belong to the chosen one-level row (by `parentTypeId`), all of them when none is chosen. */
export function twoLevelOptions(filters: MaterialFilters, twoLevel: readonly CategoryOption[]): readonly CategoryOption[] {
  if (filters.oneLevelId === null) return twoLevel;
  return twoLevel.filter(option => option.parentTypeId === filters.oneLevelId);
}

/** Labels are a multi-selection; the order is the click order and a repeat click removes. */
export function toggleLabel(filters: MaterialFilters, labelId: number): MaterialFilters {
  const has = filters.labelIds.includes(labelId);
  return {...filters, labelIds: has ? filters.labelIds.filter(id => id !== labelId) : [...filters.labelIds, labelId]};
}

/** The query the server is asked for. Keys outside the contract's whitelist never appear here. */
export function serverQuery(filters: MaterialFilters, pageNo: number, pageSize: number): ServerQuery {
  if (!Number.isInteger(pageNo) || pageNo < 1 || pageNo > 1_000_000) throw Object.assign(new Error('页码超出范围'), {code: 'invalid-query'});
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw Object.assign(new Error('每页条数超出范围'), {code: 'invalid-query'});
  const search = filters.search.trim();
  const query: {pageNo: number; pageSize: number; videoType: VideoType; name?: string; videoIds?: string; scope: string; twoLevelTypeIds?: string} = {
    pageNo, pageSize, videoType: filters.videoType, scope: scopeParam(filters.author),
  };
  if (search) query.name = search.slice(0, 128);
  if (filters.groupIds.length) query.twoLevelTypeIds = filters.groupIds.join(',');
  return query;
}

/** The keys of a query, for tests and for the "only these six" claim in the contract. */
export function queryKeys(query: ServerQuery): readonly string[] {
  return Object.keys(query).filter(key => (LIST_QUERY_KEYS as readonly string[]).includes(key));
}

/** Whether a query holds nothing the server would refuse. */
export function queryIsAllowed(query: ServerQuery): boolean {
  return Object.keys(query).every(key => (LIST_QUERY_KEYS as readonly string[]).includes(key));
}

function withinWindow(card: MaterialCard, from: string | null, to: string | null): boolean {
  if (!from && !to) return true;
  if (card.createdAtMs === null) return false;
  const at = new Date(card.createdAtMs);
  const day = at.getFullYear() + '-' + String(at.getMonth() + 1).padStart(2, '0') + '-' + String(at.getDate()).padStart(2, '0');
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

/** Whether a running time falls in the chosen band; `any` takes everything, and an unknown length is not the band. */
function withinBand(seconds: number | null, band: DurationBand): boolean {
  if (band === 'any') return true;
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return false;
  if (band === 'under1m') return seconds < 60;
  if (band === 'oneTo5m') return seconds >= 60 && seconds < 300;
  if (band === 'fiveTo20m') return seconds >= 300 && seconds < 1200;
  return seconds >= 1200;
}

/**
 * The page in hand, narrowed by everything that is not a server parameter.
 * `permittedAccountKeys` is what the authorization layer lets this editor use; when the toolbar's
 * "过滤无权限" is on, a row outside it is hidden instead of shown as unusable.
 */
export function narrowCards(
  cards: readonly MaterialCard[],
  filters: MaterialFilters,
  permittedAccountKeys: readonly string[] | null,
): readonly MaterialCard[] {
  return cards.filter(card => {
    if (filters.oneLevelId !== null && card.oneLevelVideoType?.id !== filters.oneLevelId) return false;
    if (filters.twoLevelId !== null && card.twoLevelVideoType?.id !== filters.twoLevelId) return false;
    if (filters.labelIds.length) {
      const ids = card.videoLabels.map(label => label.id);
      if (!filters.labelIds.some(id => ids.includes(id))) return false;
    }
    if (filters.stateId !== null && card.videoState?.id !== filters.stateId) return false;
    if (!withinBand(card.durationSeconds, filters.duration)) return false;
    if (!withinWindow(card, filters.createdFrom, filters.createdTo)) return false;
    if (filters.hideUnauthorized) {
      if (!permittedAccountKeys) return false;
      const key = card.accountKey;
      if (!key || !permittedAccountKeys.includes(key)) return false;
    }
    return true;
  });
}

const number = (raw: string | null) => (raw === null ? -1 : Number(raw));

/** The page in hand, ordered. The supplier's `orderByType` is not a route parameter, so this is page-local too. */
export function sortCards(cards: readonly MaterialCard[], sort: SortOrder): readonly MaterialCard[] {
  const ordered = [...cards];
  if (sort === 'newest') ordered.sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0));
  else if (sort === 'downloads') ordered.sort((a, b) => number(b.downloadCount) - number(a.downloadCount));
  else if (sort === 'collected') ordered.sort((a, b) => number(b.collectCount) - number(a.collectCount));
  else ordered.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
  return ordered;
}

/** Whether any narrowing is on, so the panel can offer "clear" and the toolbar can say "本页内筛选". */
export function hasPageLocalFilters(filters: MaterialFilters): boolean {
  return filters.oneLevelId !== null || filters.twoLevelId !== null || filters.labelIds.length > 0 || filters.stateId !== null
    || filters.duration !== 'any'
    || filters.localGroup !== null || filters.localKind !== null
    || filters.createdFrom !== null || filters.createdTo !== null || filters.sort !== 'newest' || filters.hideUnauthorized;
}
