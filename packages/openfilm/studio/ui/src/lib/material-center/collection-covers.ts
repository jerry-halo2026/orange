// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The four covers a 合集 card's collage is made of.
 *
 * The index keeps names and ids, not covers (`material-index.mjs` carries `md5`), so a collection's covers can only come
 * from rows: the rows already loaded on this page (a `LibraryEntry` per row, `library.ts`), and — when those do not cover
 * the collection — **one** page of four rows for it, read with `name=` set to the collection's own name prefix (the
 * `/list` route's prefix filter, the same one a 子合集 is read with in `group-page.ts`).
 *
 * One request per prefix, ever: a card that comes back into view, a re-render, and a second card of the same collection
 * all read the answered four from memory. A failed read is remembered as `failed` and draws no cover — never an error,
 * never a retry loop, and never a second request for the same prefix.
 *
 * It never renders and has no React: the view subscribes (`subscribe`/`version`) and asks (`ensure`) only when the card
 * is actually in view, which is what keeps a card below the fold from asking for covers nobody sees (contract §8.4).
 */
import {groupPageQuery, type GroupPageClient, type GroupPageContext} from './group-page.ts';
import {cardsOf} from './model.ts';

/** The cells of the 2 × 2 collage: at most four covers, and a collection with fewer draws fewer. */
export const COLLAGE_CELLS = 4;

/** The rows a page already has, as the only thing the collage needs from them: which id, and its cover. */
export type CoveredEntry = {readonly id: string; readonly cover: string | null};

export type CollectionCovers = {
  /** `idle` (nothing asked yet) · `loading` · `ready` · `failed` (asked, refused: no cover, no sentence). */
  readonly state: 'idle' | 'loading' | 'ready' | 'failed';
  /** The supplier's cover urls, as the server gave them (`coverRequestUrl` turns one into the request). */
  readonly urls: readonly string[];
};

export const NO_COVERS: CollectionCovers = {state: 'idle', urls: []};

const cellCount = (asked: number | undefined): number =>
  Math.max(1, Math.min(COLLAGE_CELLS, Math.trunc(asked ?? COLLAGE_CELLS)));

/**
 * The covers of one card, `cells` at most: the rows read for this collection first (they are the collection's first
 * rows), then whatever the page already had of its material — deduped by url, so one material is one cell.
 *
 * The entries are only a stand-in: they are matched by id (`cloud:<videoId>`, the id a `LibraryEntry` carries) so a row
 * of another collection can never lend its cover to this card.
 */
export function collageUrls(input: {
  /** The ids the index gives this collection (or one of its groups); `[]` when it gave none. */
  readonly ids?: readonly string[];
  /** The rows already on this page. */
  readonly entries?: readonly CoveredEntry[];
  /** The rows read for this prefix (`/list?name=`), in the supplier's own order. */
  readonly fetched?: readonly string[];
  readonly cells?: number;
}): readonly string[] {
  const limit = cellCount(input.cells);
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (url: string | null) => {
    const text = typeof url === 'string' ? url.trim() : '';
    if (!text || seen.has(text) || out.length >= limit) return;
    seen.add(text);
    out.push(text);
  };
  for (const url of input.fetched ?? []) push(url);
  const own = new Set((input.ids ?? []).map(id => 'cloud:' + id));
  for (const entry of input.entries ?? []) if (own.has(entry.id)) push(entry.cover);
  return out;
}

export type CollectionCoverStore = {
  /** What is known about this prefix now; `NO_COVERS` while nothing has been asked. */
  coversOf(prefix: string): CollectionCovers;
  /** Ask for this prefix's four rows — once per prefix per store, from a card that is in view. */
  ensure(prefix: string): void;
  /** A number that changes when an answer lands (the snapshot a view subscribes to). */
  version(): number;
  subscribe(listener: () => void): () => void;
  destroy(): void;
};

/** The prefix a collection's own rows share: the collection id is exactly `<日期>-<产品>` (`material-index.mjs`). */
const prefixOf = (raw: string | null | undefined): string => (typeof raw === 'string' ? raw.trim() : '');

/**
 * One store per page, built from the page's own `/list` (never a second client) and the filters read at request time —
 * the same class and scope a 子合集 is opened with, so a collage can never quietly read another catalogue.
 */
export function createCollectionCoverStore(options: {
  readonly list: GroupPageClient['list'];
  readonly context: () => GroupPageContext;
  readonly cells?: number;
}): CollectionCoverStore {
  const cells = cellCount(options.cells);
  const known = new Map<string, CollectionCovers>();
  const asked = new Set<string>();
  const listeners = new Set<() => void>();
  let revision = 0;
  let live = true;

  const publish = (prefix: string, next: CollectionCovers) => {
    if (!live) return;
    known.set(prefix, next);
    revision += 1;
    for (const listener of listeners) listener();
  };

  return {
    coversOf(prefix) {
      return known.get(prefixOf(prefix)) ?? NO_COVERS;
    },
    ensure(raw) {
      const prefix = prefixOf(raw);
      if (!prefix || asked.has(prefix) || !live) return;
      asked.add(prefix);
      const context = options.context();
      publish(prefix, {state: 'loading', urls: []});
      /* One page of four: the collage's own cells, so the answer is exactly what the card draws. */
      Promise.resolve()
        .then(() => options.list(groupPageQuery(prefix, {videoType: context.videoType, scope: context.scope, pageNo: 1, pageSize: cells})))
        .then(page => {
          const urls = cardsOf(page).map(card => card.coverUrl).filter((url): url is string => typeof url === 'string' && url.trim() !== '');
          publish(prefix, {state: 'ready', urls: urls.slice(0, cells)});
        })
        .catch(() => publish(prefix, {state: 'failed', urls: []}));
    },
    version: () => revision,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      live = false;
      listeners.clear();
    },
  };
}
