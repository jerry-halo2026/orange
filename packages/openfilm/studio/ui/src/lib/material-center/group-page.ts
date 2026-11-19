// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * One 子合集's materials, read **by the name prefix the supplier already gives them**.
 *
 * A group's names are `20261109-油弃乌龙茶-茶干 (12)`: `<日期>-<产品>-<分组>` then the sequence. The index knows the group
 * (`id` is exactly that prefix) and the supplier's `/list` takes `name=` as a prefix filter, so the group's own page is
 * one query per page instead of a filter over whatever page the list happened to have loaded — which is what made a
 * group look empty (`索引 23 条，本页已加载 0 条`): the ids were in the index, but on pages nobody had read.
 *
 * What this module decides, with no React and no network of its own:
 *
 *  - the prefix (`groupPrefixOf`), and the query (`groupPageQuery`: `pageNo`, `pageSize` 100, `videoType`, `name`,
 *    `scope` — the five keys the contract lists, nothing else);
 *  - how one answered page joins the ones already in hand (`appendGroupPage`): appended, deduped by `videoId`, with the
 *    supplier's **own total** kept (`providerTotal`, else `total`), and `exhausted` true once the loaded rows reach it
 *    or the page came back short — the two facts the view's "加载更多" and "已全部加载 N 条" are made of;
 *  - the reader (`createGroupPageReader`): one request per page, one page at a time, and a second open of the group that
 *    is already on screen is no request at all.
 *
 * Covers are not in the index (`material-index.mjs` keeps `md5`, not `coverUrl`), so a group's covers can only come from
 * its rows: they are here, on `MaterialCard.coverUrl`, as the server gave them.
 */
import {MAX_PAGE_SIZE, scopeParam, type MaterialPage, type MaterialsFailure, type ScopeChoice, type VideoType} from './contract.ts';
import {cardsOf, type MaterialCard} from './model.ts';

/** The page size a group is read in: the supplier's ceiling (`MAX_PAGE_SIZE`), so one press is one page. */
export const GROUP_PAGE_SIZE = MAX_PAGE_SIZE;

/**
 * The name prefix a group's materials share: `<日期>-<产品>-<分组>`, **without** the ` (n)` sequence.
 *
 * A group's id already is that prefix (`material-index.mjs` builds it as `${date}-${product}-${groupLabel}`) and is used
 * as given; only an id that does not sit under this collection falls back to the collection id and the group's name —
 * so a prefix is never invented from a name that did not parse.
 */
export function groupPrefixOf(collectionId: string, group: {readonly id: string; readonly name: string}): string {
  const id = typeof group?.id === 'string' ? group.id.trim() : '';
  if (id && id.startsWith(collectionId + '-')) return id;
  return collectionId + '-' + (group?.name ?? '').trim();
}

/** The query one page of a group is asked with. Keys outside the contract's whitelist never appear here. */
export type GroupPageQuery = {
  readonly pageNo: number;
  readonly pageSize: number;
  readonly videoType: VideoType;
  readonly name: string;
  readonly scope: string;
};

export function groupPageQuery(prefix: string, options: {
  readonly videoType: VideoType;
  readonly scope: ScopeChoice;
  readonly pageNo: number;
  readonly pageSize?: number;
}): GroupPageQuery {
  const pageNo = Number.isInteger(options.pageNo) && options.pageNo >= 1 ? options.pageNo : 1;
  const asked = options.pageSize ?? GROUP_PAGE_SIZE;
  const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(asked)));
  return {pageNo, pageSize, videoType: options.videoType, name: prefix, scope: scopeParam(options.scope)};
}

/** The supplier's total for this query: `providerTotal` when it sent one, else the wire `total`; `null` if neither. */
export function groupTotalOf(page: MaterialPage | null | undefined): number | null {
  if (!page) return null;
  const raw = page.providerTotal ?? page.total;
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? raw : null;
  const source = raw && typeof raw === 'object' ? (raw as {source?: unknown}).source : null;
  if (typeof source !== 'string' || !/^\d+$/.test(source)) return null;
  return Number(source);
}

/** A group's materials as the view draws them: the cards loaded so far, the supplier's total, and whether it is all. */
export type GroupPageState = {
  /** The prefix these rows were asked for (`null` before a group is opened). */
  readonly prefix: string | null;
  readonly cards: readonly MaterialCard[];
  /** What the supplier claims for this prefix (`null` when the page claimed nothing). */
  readonly total: number | null;
  /** How many rows are loaded (`cards.length`, kept as its own field so the view prints one number). */
  readonly loaded: number;
  /** The last page that answered, for the next one. */
  readonly pageNo: number;
  readonly loading: boolean;
  /** Nothing more to take: the loaded rows reached the total, or the supplier's last page came back short. */
  readonly exhausted: boolean;
  /** Why the last read failed, with its status and code kept (`null` when it did not). */
  readonly failure: MaterialsFailure | null;
};

export function emptyGroupPage(prefix: string | null = null): GroupPageState {
  return {prefix, cards: [], total: null, loaded: 0, pageNo: 0, loading: false, exhausted: false, failure: null};
}

/**
 * One answered page, joined to the ones already in hand.
 *
 * Appended in the supplier's own order, deduped by `videoId` (a row the supplier serves twice is one card), with the
 * total learned from the page and `exhausted` decided here rather than by the view: a short page means the supplier has
 * no more rows for this prefix, and a full page that reaches the claimed total is complete as well. A page that carried
 * no total claims nothing — then only the short page decides.
 */
export function appendGroupPage(state: GroupPageState, page: MaterialPage, pageSize: number = GROUP_PAGE_SIZE): GroupPageState {
  const seen = new Set(state.cards.map(card => card.videoId));
  const added: MaterialCard[] = [];
  for (const card of cardsOf(page)) {
    if (seen.has(card.videoId)) continue;
    seen.add(card.videoId);
    added.push(card);
  }
  const cards = added.length ? [...state.cards, ...added] : state.cards;
  const rows = page.items.length;
  /* A page past the end answers `total: 0` (measured: page 4 of a 221-row prefix says 0), so a total is only taken from
     a page that carried rows — the total learned from a real page is never overwritten by an empty one. */
  const claimed = groupTotalOf(page);
  const total = claimed !== null && (rows > 0 || state.total === null) ? claimed : state.total;
  const asked = page.pageSize > 0 ? page.pageSize : pageSize;
  const short = rows < asked;
  const reached = total !== null && cards.length >= total;
  return {
    prefix: state.prefix,
    cards,
    total,
    loaded: cards.length,
    pageNo: page.pageNo > 0 ? page.pageNo : state.pageNo,
    loading: false,
    exhausted: rows === 0 || short || reached,
    failure: null,
  };
}

/** The failure the last read met, classified the way the page names failures (status and code kept apart). */
export function groupFailureOf(error: unknown): MaterialsFailure {
  const at = (error ?? null) as {status?: unknown; code?: unknown; message?: unknown; body?: {code?: unknown}} | null;
  const fromBody = at?.body && typeof at.body === 'object' ? at.body.code : undefined;
  const code = typeof at?.code === 'string' ? at.code : typeof fromBody === 'string' ? fromBody : 'internal-error';
  const status = typeof at?.status === 'number' ? at.status
    : code === 'authorization-denied' || code === 'origin-rejected' ? 403
      : code === 'authentication-required' ? 401
        : 500;
  return {status, code, message: typeof at?.message === 'string' ? at.message : code};
}

/**
 * Whether the view draws the "加载更多" button: a group is open, rows are loaded, nothing is in flight, and the loaded
 * rows have not reached the total. A failed read draws its own sentence and retry instead.
 */
export function groupLoadMore(state: GroupPageState): boolean {
  return state.prefix !== null && !state.loading && state.failure === null && state.loaded > 0 && !state.exhausted;
}

export type GroupPageClient = {
  list(query: Readonly<Record<string, string | number>>, signal?: AbortSignal): Promise<MaterialPage>;
};

export type GroupPageContext = {readonly videoType: VideoType; readonly scope: ScopeChoice};

export type GroupPageReaderOptions = {
  /** The list route, as the page's client has it. One request per page asked for. */
  readonly list: GroupPageClient['list'];
  /** The view's own class and scope, read at request time (a filter change is the next request's, not this one's). */
  readonly context: () => GroupPageContext;
  /** Overridable for a test; defaults to the contract's ceiling, 100. */
  readonly pageSize?: number;
};

export type GroupPageReader = {
  getState(): GroupPageState;
  subscribe(listener: (state: GroupPageState) => void): () => void;
  /** Show this group: page 1, unless this exact group is already in hand (then no request is made). */
  open(prefix: string): Promise<void>;
  /** The next page, appended. Nothing is asked for once the loaded rows reached the total. */
  more(): Promise<void>;
  /** After a failure: the page that failed again (page 1 when the first one failed). */
  retry(): Promise<void>;
  destroy(): void;
};

export function createGroupPageReader(options: GroupPageReaderOptions): GroupPageReader {
  const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(options.pageSize ?? GROUP_PAGE_SIZE)));
  const listeners = new Set<(state: GroupPageState) => void>();
  let state: GroupPageState = emptyGroupPage();
  let inflight: AbortController | null = null;
  let asked: string | null = null;
  let live = true;

  const publish = (next: GroupPageState) => {
    if (!live) return;
    state = next;
    for (const listener of listeners) listener(state);
  };

  async function read(prefix: string, pageNo: number): Promise<void> {
    inflight?.abort();
    const control = new AbortController();
    inflight = control;
    publish({...state, prefix, loading: true, failure: null});
    try {
      const context = options.context();
      const page = await options.list(groupPageQuery(prefix, {
        videoType: context.videoType, scope: context.scope, pageNo, pageSize,
      }), control.signal);
      if (control.signal.aborted || !live) return;
      publish(appendGroupPage(state, page, pageSize));
    } catch (error) {
      if (control.signal.aborted || !live) return;
      publish({...state, prefix, loading: false, failure: groupFailureOf(error)});
    } finally {
      if (inflight === control) inflight = null;
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    open(prefix) {
      const wanted = typeof prefix === 'string' ? prefix.trim() : '';
      if (!wanted) return Promise.resolve();
      /* The same group, already read (or being read, or known to be empty): a second open is not a second request. */
      if (asked === wanted && state.prefix === wanted && state.failure === null) return Promise.resolve();
      asked = wanted;
      publish({...emptyGroupPage(wanted), loading: true});
      return read(wanted, 1);
    },
    more() {
      if (!state.prefix || state.loading || state.exhausted || state.failure) return Promise.resolve();
      return read(state.prefix, state.pageNo + 1);
    },
    retry() {
      if (!state.prefix || state.loading) return Promise.resolve();
      return read(state.prefix, state.loaded > 0 ? state.pageNo + 1 : 1);
    },
    destroy() {
      live = false;
      inflight?.abort();
      inflight = null;
      listeners.clear();
    },
  };
}
