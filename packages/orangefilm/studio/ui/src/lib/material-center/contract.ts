// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The read-only material routes (apps/api, see .dev/zhishang/api-contract.md) as the editor consumes them.
 *
 * Three routes and no more: `list` is the only one that returns material rows, and **none of them returns a
 * playable file**. `isInner` is not a parameter (the supplier request always asks for the public url), passing it
 * is a 422 on the server, so it never leaves this module either.
 */

/** The frozen route table. A caller cannot ask for a route that is not here (no raw, no download, no query). */
export const MATERIAL_ROUTES = Object.freeze({list: '/list', facets: '/facets', labels: '/labels'} as const);
export type MaterialRoute = keyof typeof MATERIAL_ROUTES;

/**
 * The one route of ours beside the supplier's three: the 批次/合集 index `material-index-build.mjs` landed on this
 * computer. It is a file read on the Studio server, not a supplier call, so it is not in `MATERIAL_ROUTES` (that table
 * is the supplier's and the client's `routes` is held to it) and it takes no query at all.
 */
export const MATERIAL_INDEX_ROUTE = '/index';

/** `GET /api/materials/list` accepts exactly these query keys; anything else is `422 invalid-query` (contract §1.2). */
export const LIST_QUERY_KEYS = Object.freeze(['pageNo', 'pageSize', 'videoType', 'name', 'videoIds', 'scope', 'twoLevelTypeIds'] as const);
/** `GET /api/materials/facets` accepts no paging at all (contract §1.3). */
export const FACETS_QUERY_KEYS = Object.freeze(['videoType', 'scope'] as const);
/** `GET /api/materials/labels` (contract §1.4). */
export const LABELS_QUERY_KEYS = Object.freeze(['pageNo', 'pageSize', 'videoType', 'scope'] as const);

/** The supplier's material page size ceiling; the server rejects 101 with 422 and so do we, before any request. */
export const MAX_PAGE_SIZE = 100;

/** Who the rows are asked for. `own` and `company` are the two named views; anything else names one account. */
export type ScopeChoice = 'own' | 'company' | {readonly accountKey: string};

/** The wire form of a scope: `own`, `company`, `account:<accountKey>` (bytes kept as given, never trimmed). */
export function scopeParam(scope: ScopeChoice): string {
  if (scope === 'own' || scope === 'company') return scope;
  return 'account:' + scope.accountKey;
}

/** The inverse of {@link scopeParam}; `null` for a value the server would refuse (contract §2 `scope-invalid`). */
export function parseScopeParam(raw: string): ScopeChoice | null {
  if (raw === 'own' || raw === 'company') return raw;
  if (!raw.startsWith('account:')) return null;
  const accountKey = raw.slice('account:'.length);
  if (!accountKey || accountKey.length > 512 || /\s/.test(accountKey)) return null;
  return {accountKey};
}

/** A number the server kept as its supplier literal (`{sourceType:'number',source}`), never a rounded JS number. */
export type WireNumber = {readonly sourceType: 'number'; readonly source: string};
export type WireValue = string | number | boolean | null | WireNumber | readonly WireValue[] | {readonly [key: string]: WireValue};

export function isWireNumber(value: unknown): value is WireNumber {
  return !!value && typeof value === 'object' && (value as {sourceType?: unknown}).sourceType === 'number'
    && typeof (value as {source?: unknown}).source === 'string';
}

/** A text field of a supplier row, or `null` when the supplier sent nothing usable. */
export function wireText(value: WireValue | undefined): string | null {
  if (typeof value === 'string') return value;
  return null;
}

/** A field the supplier sent as an integer, as a number; `null` for anything else (`1.5`, text, missing). */
export function wireInt(value: WireValue | undefined): number | null {
  if (isWireNumber(value)) return /^-?(?:0|[1-9]\d*)$/.test(value.source) ? Number(value.source) : null;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  return null;
}

/** The supplier's own literal for a number, unrounded (`"1234.50"` stays `"1234.50"`), or `null`. */
export function wireNumberLiteral(value: WireValue | undefined): string | null {
  if (isWireNumber(value)) return value.source;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

export type Authorization = {readonly layer: 'public' | 'self' | 'granted' | null; readonly reason: string};

/** One row of `GET /api/materials/list`: the supplier id, and the row itself with its numbers kept as literals. */
export type WireItem = {
  readonly videoId: {readonly value: string; readonly sourceType: 'string' | 'number'; readonly source: string};
  readonly observation: Readonly<Record<string, WireValue>>;
};

export type MaterialPage = {
  readonly authorization: Authorization;
  readonly providerScope: string;
  readonly pageNo: number;
  readonly pageSize: number;
  readonly items: readonly WireItem[];
  readonly total: WireNumber | null;
  readonly providerTotal: number | null;
  /** Always true: `total`/`providerTotal` are the **supplier's company-wide** total, not this account's count. */
  readonly totalIsProviderTotal: true;
  readonly filtered: {readonly inspected: number; readonly dropped: number};
  /** Always false: reading a material is not a permission to use it. */
  readonly grants: false;
};

export type TwoLevelCategory = {readonly id: number; readonly name: string; readonly parentTypeId: number; readonly level: 2};
export type OneLevelCategory = {
  readonly id: number;
  readonly name: string;
  readonly level: 1;
  readonly children: readonly TwoLevelCategory[];
};

export type Facets = {
  readonly authorization: Authorization;
  readonly providerScope: string;
  readonly videoType: number;
  readonly oneLevel: readonly OneLevelCategory[];
  /** Flattened `children` of `oneLevel`, `parentTypeId` kept (contract §1.3). */
  readonly twoLevel: readonly TwoLevelCategory[];
  readonly states: readonly {readonly id: number; readonly name: string; readonly frontColor: string; readonly backgroundColor: string}[];
  readonly publicLabels: readonly {readonly id: number; readonly name: string}[];
  readonly labelTotal: WireNumber | null;
};

export type Labels = {
  readonly authorization: Authorization;
  readonly providerScope: string;
  readonly pageNo: number;
  readonly pageSize: number;
  readonly labels: readonly {readonly id: number; readonly name: string}[];
  readonly total: WireNumber | null;
};

/** The failure the server's fixed body describes (`{code,message}`), with the HTTP status kept. */
export type MaterialsFailure = {readonly status: number; readonly code: string; readonly message: string};

export function isMaterialsFailure(value: unknown): value is MaterialsFailure {
  if (!value || typeof value !== 'object') return false;
  const {status, code, message} = value as Partial<MaterialsFailure>;
  return typeof status === 'number' && typeof code === 'string' && typeof message === 'string';
}

/** The five supplier material classes the UI's main category offers (`videoType` 0..4). */
export const VIDEO_TYPES = Object.freeze([
  {value: 0, label: '成片'},
  {value: 1, label: '素材'},
  {value: 2, label: '第三方'},
  {value: 3, label: '图片'},
  {value: 4, label: '文案'},
] as const);
export type VideoType = (typeof VIDEO_TYPES)[number]['value'];
