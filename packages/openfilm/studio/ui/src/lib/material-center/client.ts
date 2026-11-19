// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The only module in the material centre that talks to a network, and it knows four routes: `/list`, `/facets`,
 * `/labels`, and `/index` (the index this computer landed). There is no method here that could ask for a file, a raw
 * source or a download — the backend has no such route (contract §0), and this client cannot invent one: every URL is
 * `baseUrl` + a frozen route + a checked query.
 *
 * The client is told nothing about a card until the caller asks for a page, so a hover, a render or a selection can
 * never produce a request.
 */
import {createRequestGate, type RequestGate} from './gate.ts';
import {
  FACETS_QUERY_KEYS, LABELS_QUERY_KEYS, LIST_QUERY_KEYS, MATERIAL_INDEX_ROUTE, MATERIAL_ROUTES, MAX_PAGE_SIZE, VIDEO_TYPES,
  isWireNumber, type Facets, type Labels, type MaterialPage, type MaterialsFailure, type MaterialRoute,
  type OneLevelCategory, type TwoLevelCategory, type WireItem, type WireNumber, type WireValue,
} from './contract.ts';

export type MaterialsClient = {
  /** The supplier routes this client can reach, in order. Anything else is not addressable from the editor. */
  readonly routes: readonly string[];
  list(query: Readonly<Record<string, string | number>>, signal?: AbortSignal): Promise<MaterialPage>;
  facets(query: Readonly<Record<string, string | number>>, signal?: AbortSignal): Promise<Facets>;
  labels(query: Readonly<Record<string, string | number>>, signal?: AbortSignal): Promise<Labels>;
  /**
   * The landed index, as the server sent it (`index-landed.ts` decodes it). No query: it is one file, read as it is.
   * A 404 `index-missing` rejects like any other failure, and the caller falls back to the page walk. Optional, so a
   * client stand-in without the route behaves like one this build does not serve.
   */
  index?(signal?: AbortSignal): Promise<unknown>;
};

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export type MaterialsClientOptions = {
  /** Where the read-only service is mounted; defaults to the same-origin path the contract mounts it on. */
  readonly baseUrl?: string;
  /** The bearer the service verifies; a getter keeps a rotated session in step. */
  readonly token?: string | (() => string | null) | null;
  /** Injected in tests; defaults to the platform's `fetch`. */
  readonly fetch?: Fetcher;
  readonly timeoutMs?: number;
  /** The one door every request goes through; defaults to one 6 QPS / 6 concurrent gate per client. */
  readonly gate?: RequestGate;
  /** The pause before the single retry a 429 gets; defaults to 400 ms. */
  readonly backoffMs?: number;
  /**
   * Called with `true` when a Studio-guard 401 is being retried, and with `false` when that request settles. The page
   * uses it to say "the session is not ready yet, retrying" instead of showing a failure mid-retry.
   */
  readonly onSessionRetry?: (retrying: boolean) => void;
  /** Extra attempts for a guard-shaped 401 (`{error}` and no `code`); defaults to 2. */
  readonly guardRetries?: number;
  /** The pause between those attempts; defaults to 300 ms. */
  readonly guardRetryDelayMs?: number;
};

/**
 * The Studio guard's own refusal: 401 with `{error: string}` and **no `code`** (server.mjs). It means "this page was not
 * opened with the Studio key / cookie Yet" — a port or host change leaves it behind — not "the supplier refused you".
 * Retried a couple of times, because a fresh Studio can be a moment away; a real `401 {code}` is not retried.
 */
function guardUnauthorized(status: number, body: unknown): boolean {
  return status === 401 && isRecord(body) && typeof body.error === 'string' && typeof body.code !== 'string';
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function failure(status: number, code: string, message: string): Error & MaterialsFailure {
  return Object.assign(new Error(message), {status, code, message});
}

const unconfirmed = () => failure(502, 'provider-response-unconfirmed', '供应商响应无法确认，本次结果不作数。');

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function numberWire(value: unknown): WireNumber | null {
  return isWireNumber(value) ? value : null;
}

function intOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) return Number(value);
  return null;
}

function authorizationOf(value: unknown): MaterialPage['authorization'] {
  if (!isRecord(value) || typeof value.reason !== 'string') throw unconfirmed();
  const layer = value.layer;
  if (layer !== null && layer !== 'public' && layer !== 'self' && layer !== 'granted') throw unconfirmed();
  return {layer, reason: value.reason};
}

function itemOf(value: unknown): WireItem {
  if (!isRecord(value)) throw unconfirmed();
  const id = value.videoId;
  if (!isRecord(id)) throw unconfirmed();
  const idValue = typeof id.value === 'string' ? id.value : null;
  const sourceType = id.sourceType;
  if (idValue === null || (sourceType !== 'string' && sourceType !== 'number')) throw unconfirmed();
  const source = typeof id.source === 'string' ? id.source : String(id.value);
  if (!isRecord(value.observation)) throw unconfirmed();
  return {videoId: {value: idValue, sourceType, source}, observation: value.observation as Record<string, WireValue>};
}

function pageOf(value: unknown): MaterialPage {
  if (!isRecord(value)) throw unconfirmed();
  if (value.totalIsProviderTotal !== true) throw unconfirmed();
  if (value.grants !== false) throw unconfirmed();
  if (!Array.isArray(value.items)) throw unconfirmed();
  const filtered = value.filtered;
  if (!isRecord(filtered)) throw unconfirmed();
  const inspected = intOf(filtered.inspected), dropped = intOf(filtered.dropped);
  if (inspected === null || dropped === null || dropped < 0 || dropped > inspected) throw unconfirmed();
  const pageNo = intOf(value.pageNo), pageSize = intOf(value.pageSize);
  if (pageNo === null || pageSize === null) throw unconfirmed();
  return {
    authorization: authorizationOf(value.authorization),
    providerScope: typeof value.providerScope === 'string' ? value.providerScope : '',
    pageNo, pageSize,
    items: value.items.map(itemOf),
    total: numberWire(value.total),
    providerTotal: intOf(value.providerTotal),
    totalIsProviderTotal: true,
    filtered: {inspected, dropped},
    grants: false,
  };
}

function twoLevelOf(value: unknown): TwoLevelCategory {
  if (!isRecord(value)) throw unconfirmed();
  const id = intOf(value.id), parentTypeId = intOf(value.parentTypeId);
  if (id === null || parentTypeId === null || typeof value.name !== 'string') throw unconfirmed();
  return {id, name: value.name, parentTypeId, level: 2};
}

function oneLevelOf(value: unknown): OneLevelCategory {
  if (!isRecord(value)) throw unconfirmed();
  const id = intOf(value.id);
  if (id === null || typeof value.name !== 'string' || !Array.isArray(value.children)) throw unconfirmed();
  return {id, name: value.name, level: 1, children: value.children.map(twoLevelOf)};
}

function facetsOf(value: unknown): Facets {
  if (!isRecord(value)) throw unconfirmed();
  if (!Array.isArray(value.oneLevel) || !Array.isArray(value.twoLevel) || !Array.isArray(value.states) || !Array.isArray(value.publicLabels)) throw unconfirmed();
  const oneLevel = value.oneLevel.map(oneLevelOf);
  const twoLevel = value.twoLevel.map(twoLevelOf);
  const flattened = oneLevel.reduce((count, row) => count + row.children.length, 0);
  /* a flattened list that disagrees with the children is a structure we do not understand — never "no subcategories" */
  if (flattened !== twoLevel.length) throw unconfirmed();
  return {
    authorization: authorizationOf(value.authorization),
    providerScope: typeof value.providerScope === 'string' ? value.providerScope : '',
    videoType: intOf(value.videoType) ?? 1,
    oneLevel,
    twoLevel,
    states: value.states.map(row => {
      if (!isRecord(row) || typeof row.name !== 'string') throw unconfirmed();
      return {
        id: intOf(row.id) ?? 0, name: row.name,
        frontColor: typeof row.frontColor === 'string' ? row.frontColor : '',
        backgroundColor: typeof row.backgroundColor === 'string' ? row.backgroundColor : '',
      };
    }),
    publicLabels: value.publicLabels.map(row => {
      if (!isRecord(row) || typeof row.name !== 'string') throw unconfirmed();
      return {id: intOf(row.id) ?? 0, name: row.name};
    }),
    labelTotal: numberWire(value.labelTotal),
  };
}

function labelsOf(value: unknown): Labels {
  if (!isRecord(value) || !Array.isArray(value.labels)) throw unconfirmed();
  return {
    authorization: authorizationOf(value.authorization),
    providerScope: typeof value.providerScope === 'string' ? value.providerScope : '',
    pageNo: intOf(value.pageNo) ?? 1,
    pageSize: intOf(value.pageSize) ?? 0,
    labels: value.labels.map(row => {
      if (!isRecord(row) || typeof row.name !== 'string') throw unconfirmed();
      return {id: intOf(row.id) ?? 0, name: row.name};
    }),
    total: numberWire(value.total),
  };
}

/** The query a route accepts, and whether it pages (the two rules the supplier refuses with a 422). */
type QueryRules = {readonly allowed: readonly string[]; readonly pageSized?: boolean};

const QUERY_RULES: Readonly<Record<MaterialRoute, QueryRules>> = Object.freeze({
  list: {allowed: LIST_QUERY_KEYS, pageSized: true},
  facets: {allowed: FACETS_QUERY_KEYS},
  labels: {allowed: LABELS_QUERY_KEYS, pageSized: true},
});

/** A query key the contract does not list would be a 422; refuse it here, before a socket is opened. */
function checkQuery(rules: QueryRules, query: Readonly<Record<string, string | number>>): void {
  for (const [key, raw] of Object.entries(query)) {
    if (!rules.allowed.includes(key)) throw failure(422, 'invalid-query', '不支持的参数：' + key);
    if (typeof raw === 'number' && !Number.isInteger(raw)) throw failure(422, 'invalid-query', '参数必须是整数：' + key);
  }
  if (rules.pageSized) {
    const size = query.pageSize;
    if (typeof size === 'number' && (size < 1 || size > MAX_PAGE_SIZE)) throw failure(422, 'invalid-query', '每页条数超出生效范围 1-' + MAX_PAGE_SIZE);
  }
  const type = query.videoType;
  if (typeof type === 'number' && !VIDEO_TYPES.some(entry => entry.value === type)) throw failure(422, 'invalid-query', '素材大类超出 0-4');
}

const search = (query: Readonly<Record<string, string | number>>) =>
  Object.keys(query).sort().map(key => encodeURIComponent(key) + '=' + encodeURIComponent(String(query[key]))).join('&');

export function createMaterialsClient(options: MaterialsClientOptions = {}): MaterialsClient {
  const base = (options.baseUrl ?? '/api/materials').replace(/\/+$/, '');
  const fetcher: Fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 15_000;
  const tokenOf = () => (typeof options.token === 'function' ? options.token() : options.token ?? null);
  const gate: RequestGate = options.gate ?? createRequestGate({qps: 6, concurrency: 6});
  const backoffMs = options.backoffMs ?? 400;

  async function request<T>(route: MaterialRoute | null, query: Readonly<Record<string, string | number>>, signal: AbortSignal | undefined, decode: (body: unknown) => T): Promise<T> {
    const rules: QueryRules = route ? QUERY_RULES[route] : {allowed: []};
    checkQuery(rules, query);
    const qs = search(query);
    const url = base + (route ? MATERIAL_ROUTES[route] : MATERIAL_INDEX_ROUTE) + (qs ? '?' + qs : '');
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', onAbort, {once: true});
    }
    const timer = setTimeout(() => controller.abort(failure(504, 'provider-timeout', '供应商超时，本次结果不作数。')), timeoutMs);
    const token = tokenOf();
    const guardRetries = Math.max(0, Math.min(5, options.guardRetries ?? 2));
    try {
      let response: Response | null = null;
      let body: unknown = null;
      let retried = false;
      let throttled = 0;
      for (let attempt = 0; ; attempt += 1) {
        response = await gate.run(() => fetcher(url, {
          method: 'GET',
          cache: 'no-store',
          redirect: 'error',
          /* The Studio guard reads the session cookie (or the launch key header); a same-origin page must send it.
             `omit` made every cloud read 401 "open Studio from the address …". */
          credentials: 'same-origin',
          signal: controller.signal,
          headers: {accept: 'application/json', ...(token ? {authorization: 'Bearer ' + token} : {})},
        }));
        body = await response.json().catch(() => null);
        /* The supplier counts requests: one pause-and-retry, then the person decides when to try again. */
        if (response.status === 429 && throttled < 1) {
          throttled += 1;
          await pause(backoffMs * throttled);
          continue;
        }
        if (!guardUnauthorized(response.status, body) || attempt >= guardRetries) break;
        if (!retried) {
          retried = true;
          options.onSessionRetry?.(true);
        }
        if (controller.signal.aborted) break;
        await pause(Math.max(0, options.guardRetryDelayMs ?? 300));
        if (controller.signal.aborted) break;
      }
      if (retried) options.onSessionRetry?.(false);
      if (!response) throw failure(500, 'internal-error', '未收到响应。');
      if (!response.ok) {
        const code = isRecord(body) && typeof body.code === 'string' ? body.code : 'internal-error';
        const message = isRecord(body) && typeof body.message === 'string' ? body.message : '接口返回 ' + response.status;
        throw failure(response.status, code, message);
      }
      return decode(body);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  return Object.freeze({
    routes: Object.freeze(Object.values(MATERIAL_ROUTES)),
    list: (query, signal) => request('list', query, signal, pageOf),
    facets: (query, signal) => request('facets', query, signal, facetsOf),
    labels: (query, signal) => request('labels', query, signal, labelsOf),
    /* No query and no decoder: the index is one file the server hands over as it is, and `index-landed.ts` is what
       decides whether its answer is that tree. */
    index: signal => request(null, {}, signal, body => body),
  });
}
