// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * Where the index's rows come from: the read-only material list, walked page by page.
 *
 * This is the one function the page hands to the index reader, and it is read-only by construction — it takes a
 * `list` that can only be `MaterialsClient['list']`, asks for company material of one class, and stops at a page budget
 * so a provider with 179 000 rows cannot be walked by opening a tab. A page budget that runs out is **not** declared
 * as "the whole catalogue": the caller keeps the count it actually read (`rows.length`).
 *
 * `readIndexWalk` additionally carries what the last page said the class holds (`providerTotal`). That is the only way a
 * view can print "可翻页 N / 声称 M" honestly: N is what this walk could page, M is the supplier's own claim, and the
 * difference is material no page number will reach.
 */
import type {MaterialPage, VideoType} from './contract.ts';
import {cardsOf} from './model.ts';
import type {IndexWalk, MaterialIndexRow} from './index-tree.ts';

/** The supplier's ceiling per page (`MAX_PAGE_SIZE`); the index walk uses it so few requests cover a batch. */
export const INDEX_PAGE_SIZE = 100;
/** How many pages one build may read: 8 × 100 rows. Enough for a few batches, bounded on purpose. */
export const INDEX_MAX_PAGES = 8;

/** The one call this module makes: a page of the read-only list, injected by the caller (or by a test). */
export type IndexPageList = (pageNo: number, pageSize: number) => Promise<MaterialPage>;

export type IndexRowsOptions = {
  readonly maxPages?: number;
  readonly pageSize?: number;
  readonly videoType?: VideoType;
};

/** The total a page reports, whichever of the two fields the server filled in (a number, or nothing). */
function claimOf(page: MaterialPage): number | null {
  const raw = (page as {providerTotal?: unknown; total?: unknown}).providerTotal ?? (page as {total?: unknown}).total;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

/**
 * Read the rows the index is built from, and say what the supplier claims for them. A page that is shorter than asked
 * for ends the walk (the supplier has no more), and a repeated id is kept once so two pages that overlap cannot double
 * a count.
 */
export async function readIndexWalk(list: IndexPageList, options: IndexRowsOptions = {}): Promise<IndexWalk> {
  const maxPages = Math.max(1, Math.floor(options.maxPages ?? INDEX_MAX_PAGES));
  const pageSize = Math.min(INDEX_PAGE_SIZE, Math.max(1, Math.floor(options.pageSize ?? INDEX_PAGE_SIZE)));
  const rows: MaterialIndexRow[] = [];
  const seen = new Set<string>();
  let sourceTotal: number | null = null;
  for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
    const page = await list(pageNo, pageSize);
    const claimed = claimOf(page);
    if (claimed !== null) sourceTotal = claimed;
    const cards = cardsOf(page);
    for (const card of cards) {
      if (seen.has(card.videoId)) continue;
      seen.add(card.videoId);
      rows.push({videoId: card.videoId, name: card.title});
    }
    if (cards.length < pageSize) break;
  }
  return {rows, reach: {pageable: rows.length, sourceTotal}};
}

/** The rows alone (what the previous reader asked for); `readIndexWalk` is the same walk with the claim beside them. */
export async function readIndexRows(list: IndexPageList, options: IndexRowsOptions = {}): Promise<readonly MaterialIndexRow[]> {
  return (await readIndexWalk(list, options)).rows;
}
