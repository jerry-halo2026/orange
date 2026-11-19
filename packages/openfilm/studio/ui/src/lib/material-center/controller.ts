// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

﻿/**
 * The material centre's interactions, kept out of React so they can be held to their rules without a DOM.
 *
 * The rule that matters most: **looking is not asking.** `hover` only records what the pointer is over. The one
 * place that may cost the supplier something is `use`, and it is reached only by the card's own use/download button.
 * The client it is given knows three read routes and nothing else, so no hover can become a file request.
 */
import type {Facets, MaterialPage, MaterialsFailure} from './contract.ts';
import {scopeParam} from './contract.ts';
import {DEFAULT_FILTERS, narrowCards, serverQuery, sortCards, type MaterialFilters} from './filters.ts';
import {cardsOf, type MaterialCard} from './model.ts';
import {emptyReason, filteredNotice, hasMorePages, providerTotalNote, screenOf, shortPageNote, type ScreenState} from './states.ts';
import type {MaterialsClient} from './client.ts';
import {useFailureKind, type UseFailureKind} from './use-material.ts';
import {deniedDownloads} from './denied.ts';

export const DEFAULT_PAGE_SIZE = 20;

/** What a use/download action costs, said before it can surprise anyone. */
export const USE_NOTICE = '已请求使用：会把文件真实下载一次到本地。';
export const USE_UNAVAILABLE_NOTICE = '当前还没有接上“使用/下载”的处理方，未发出任何请求。';

export type MaterialCenterView = 'cards' | 'list';

export type MaterialCenterState = {
  readonly status: ScreenState;
  readonly loading: boolean;
  readonly failure: MaterialsFailure | null;
  readonly page: MaterialPage | null;
  /** The page as shown: narrowed by the panel's page-local filters, then ordered. */
  readonly cards: readonly MaterialCard[];
  /** The page as returned, before the panel narrowed it. */
  readonly pageCards: readonly MaterialCard[];
  readonly facets: Facets | null;
  readonly facetsFailure: MaterialsFailure | null;
  readonly filters: MaterialFilters;
  readonly view: MaterialCenterView;
  readonly hovered: string | null;
  readonly selected: readonly string[];
  readonly usePending: string | null;
  readonly useNotice: string | null;
  /** Why the last use/download failed, classified (the page says which of the four it was) and retryable. */
  readonly useError: {readonly status: number; readonly code: string; readonly message: string; readonly kind: UseFailureKind} | null;
  /** The id the person last asked to use, so the retry button has something to repeat. */
  readonly lastUse: string | null;
  readonly filteredNotice: string | null;
  readonly emptyReason: string | null;
  readonly providerTotalNote: string | null;
  readonly shortPageNote: string | null;
  readonly hasMore: boolean;
  readonly pageNo: number;
  readonly pageSize: number;
  /** How many rows the authorization layer dropped on this page (contract §1.2 `filtered.dropped`). */
  readonly dropped: number;
};

export type MaterialCenterOptions = {
  readonly client: MaterialsClient;
  /** The host's use/download handler. Absent means the button says so and nothing is requested. */
  /**
   * The host's use/download handler. It may resolve with `{notice}` to say what happened in the library's own words
   * (a fresh download, or one the library already had); nothing resolved means the generic "requested" sentence.
   */
  readonly onUse?: (card: MaterialCard) => void | Promise<void | {notice?: string}>;
  readonly now?: () => number;
  readonly pageSize?: number;
  /** What the authorization layer lets this editor use, for the toolbar's "过滤无权限". `null` = unknown. */
  readonly permittedAccountKeys?: () => readonly string[] | null;
  readonly initialFilters?: Partial<MaterialFilters>;
};

export type MaterialCenterController = {
  getState(): MaterialCenterState;
  subscribe(listener: (state: MaterialCenterState) => void): () => void;
  hover(videoId: string | null): void;
  toggleSelect(videoId: string): void;
  select(videoId: string): void;
  selectOnPage(): void;
  clearSelection(): void;
  setView(view: MaterialCenterView): void;
  setFilters(patch: Partial<MaterialFilters>): void;
  clearFilters(): void;
  setPage(pageNo: number): void;
  refresh(signal?: AbortSignal): Promise<void>;
  /**
   * The "retry" button: reads the half that failed again — the list always, and the facets when their last read
   * failed. One press is one read of each (never a silent no-op), and a press while one is already out is ignored.
   */
  retry(): Promise<void>;
  loadFacets(signal?: AbortSignal): Promise<void>;
  use(videoId: string): Promise<void>;
  destroy(): void;
};

/** What a use/download says afterwards: the host's own sentence when it gave one, else the generic request notice. */
const noticeOf = (outcome: unknown): string => {
  const notice = (outcome as {notice?: unknown} | null)?.notice;
  return typeof notice === 'string' && notice ? notice : USE_NOTICE;
};

/**
 * A failure as the screen reads it, with **status and code kept independently**.
 *
 * The old shape was all-or-nothing: unless the error carried a numeric `status` *and* a string `code`, both were
 * replaced by `{500, 'internal-error'}` — so a 403 `authorization-denied` that arrived through a hop which kept only
 * the code (or only the status) became the generic failure, and the page said "读取失败" about a permission refusal.
 * The code is now never dropped, and a known code names its status when the status itself did not arrive.
 */
const failureOf = (error: unknown): MaterialsFailure => {
  const at = (error ?? null) as {
    status?: unknown; code?: unknown; message?: unknown;
    body?: {code?: unknown}; response?: {status?: unknown};
  } | null;
  const fromBody = at?.body && typeof at.body === 'object' ? at.body.code : undefined;
  const code = typeof at?.code === 'string' ? at.code : typeof fromBody === 'string' ? fromBody : 'internal-error';
  const status = typeof at?.status === 'number' ? at.status
    : typeof at?.response?.status === 'number' ? at.response.status
      : code === 'authorization-denied' || code === 'origin-rejected' ? 403
        : code === 'authentication-required' ? 401
          : 500;
  return {status, code, message: typeof at?.message === 'string' ? at.message : code};
};

export function createMaterialCenterController(options: MaterialCenterOptions): MaterialCenterController {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const listeners = new Set<(state: MaterialCenterState) => void>();
  let live = true;
  let inflight: AbortController | null = null;

  let state: MaterialCenterState = {
    status: 'loading', loading: true, failure: null, page: null, cards: [], pageCards: [], facets: null,
    facetsFailure: null, filters: {...DEFAULT_FILTERS, ...options.initialFilters}, view: 'cards', hovered: null,
    selected: [], usePending: null, useNotice: null, useError: null, lastUse: null, filteredNotice: null, emptyReason: null,
    providerTotalNote: null, shortPageNote: null, hasMore: false, pageNo: 1, pageSize, dropped: 0,
  };

  const getState = () => state;
  const notify = () => {
    for (const listener of listeners) listener(state);
  };
  const setState = (patch: Partial<MaterialCenterState>) => {
    if (!live) return;
    state = {...state, ...patch};
    notify();
  };

  /** The cards as the screen shows them: page-local narrowing and ordering, no fetching. */
  const present = (page: MaterialPage | null, filters: MaterialFilters, permitted: readonly string[] | null): readonly MaterialCard[] => {
    const decoded = cardsOf(page);
    return sortCards(narrowCards(decoded, filters, permitted), filters.sort);
  };

  function applyPage(page: MaterialPage, filters: MaterialFilters) {
    const permitted = options.permittedAccountKeys?.() ?? null;
    const cards = present(page, filters, permitted);
    setState({
      page, pageCards: cardsOf(page), cards,
      status: screenOf({loading: false, failure: null, page, visibleCount: cards.length}),
      loading: false, failure: null,
      filteredNotice: filteredNotice(page), emptyReason: cards.length === 0 ? emptyReason(page) : null,
      providerTotalNote: providerTotalNote(page), shortPageNote: cards.length === 0 ? shortPageNote(page) : null,
      hasMore: hasMorePages(page, pageSize), dropped: page.filtered.dropped,
    });
  }

  /** Re-derive the visible cards from the page in hand (a filter changed, nothing was fetched). */
  function represent(filters: MaterialFilters) {
    const permitted = options.permittedAccountKeys?.() ?? null;
    const cards = present(state.page, filters, permitted);
    setState({
      cards,
      status: screenOf({loading: false, failure: null, page: state.page, visibleCount: cards.length}),
      emptyReason: state.page && cards.length === 0 ? emptyReason(state.page) : null,
      shortPageNote: state.page && cards.length === 0 ? shortPageNote(state.page) : null,
    });
  }

  async function refresh(signal?: AbortSignal): Promise<void> {
    inflight?.abort();
    const controller = new AbortController();
    inflight = controller;
    if (signal) signal.addEventListener('abort', () => controller.abort(), {once: true});
    setState({loading: true, status: 'loading', failure: null});
    try {
      const page = await options.client.list(serverQuery(state.filters, state.pageNo, pageSize), controller.signal);
      if (controller.signal.aborted) return;
      applyPage(page, state.filters);
    } catch (error) {
      if (controller.signal.aborted) return;
      const failure = failureOf(error);
      const status = screenOf({loading: false, failure, page: null, visibleCount: 0});
      setState({loading: false, status, failure, cards: [], pageCards: [], page: null, filteredNotice: null, emptyReason: null, providerTotalNote: null, shortPageNote: null, hasMore: false, dropped: 0});
    } finally {
      if (inflight === controller) inflight = null;
    }
  }

  async function loadFacets(signal?: AbortSignal): Promise<void> {
    try {
      const facets = await options.client.facets({videoType: state.filters.videoType, scope: serverQuery(state.filters, 1, pageSize).scope}, signal);
      setState({facets, facetsFailure: null});
    } catch (error) {
      if (signal?.aborted) return;
      setState({facetsFailure: failureOf(error)});
    }
  }

  /**
   * The "retry" button: one read of the list, plus the facets when their last read failed — so a press after a failed
   * load really sends requests again (the old button could re-read a list that was never the thing that failed). A
   * press while a retry is still out is ignored; two presses after it settled are two retries.
   */
  let retrying: Promise<void> | null = null;
  function retry(): Promise<void> {
    if (retrying) return retrying;
    const facetsFailed = state.facetsFailure !== null;
    retrying = (async () => {
      try {
        await Promise.all([refresh(), ...(facetsFailed ? [loadFacets()] : [])]);
      } finally {
        retrying = null;
      }
    })();
    return retrying;
  }

  return {
    getState,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Looking. No client call, no request, ever. */
    hover(videoId) {
      if (state.hovered === videoId) return;
      setState({hovered: videoId});
    },
    select(videoId) {
      if (state.selected.includes(videoId)) return;
      setState({selected: [...state.selected, videoId]});
    },
    toggleSelect(videoId) {
      setState({selected: state.selected.includes(videoId) ? state.selected.filter(id => id !== videoId) : [...state.selected, videoId]});
    },
    selectOnPage() {
      const onPage = state.cards.map(card => card.videoId);
      const merged = [...state.selected];
      for (const id of onPage) if (!merged.includes(id)) merged.push(id);
      setState({selected: merged});
    },
    clearSelection() {
      setState({selected: []});
    },
    setView(view) {
      if (state.view === view) return;
      setState({view});
    },
    setFilters(patch) {
      const filters: MaterialFilters = {...state.filters, ...patch};
      /** Only these three reach the server; the rest narrow the page in hand and cost nothing. */
      const serverChanged = filters.videoType !== state.filters.videoType
        || filters.search !== state.filters.search
        || scopeParam(filters.author) !== scopeParam(state.filters.author);
      const pageNo = serverChanged ? 1 : state.pageNo;
      setState({filters, pageNo});
      represent(filters);
      if (serverChanged) {
        void refresh();
        void loadFacets();
      }
    },
    clearFilters() {
      const filters: MaterialFilters = {...DEFAULT_FILTERS};
      setState({filters, pageNo: 1});
      represent(filters);
      void refresh();
    },
    setPage(pageNo) {
      if (!Number.isInteger(pageNo) || pageNo < 1) return;
      setState({pageNo});
      void refresh();
    },
    refresh,
    retry,
    loadFacets,
    /**
     * The one action with a cost. Called once per click by the card's use/download button — never by a hover.
     * A second click while the first is unanswered does nothing.
     */
    async use(videoId) {
      if (state.usePending) return;
      /* Already refused for this identity: no request, not even from a retry. */
      if (deniedDownloads.has(videoId)) { setState({useError: {status: 403, code: 'authorization-denied', message: '', kind: 'forbidden'}, useNotice: null, lastUse: videoId}); return; }
      const card = state.cards.find(row => row.videoId === videoId) ?? state.pageCards.find(row => row.videoId === videoId);
      if (!card) return;
      if (!options.onUse) {
        setState({useNotice: USE_UNAVAILABLE_NOTICE, useError: null});
        return;
      }
      setState({usePending: videoId, useNotice: null, useError: null, lastUse: videoId});
      try {
        const outcome = await options.onUse(card);
        if (live) setState({usePending: null, useNotice: noticeOf(outcome)});
      } catch (error) {
        if (live) setState({usePending: null, useNotice: null, useError: {...failureOf(error), kind: useFailureKind(error)}});
      }
    },
    destroy() {
      live = false;
      inflight?.abort();
      listeners.clear();
    },
  };
}
