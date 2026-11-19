// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The index `GET /api/materials/index` serves: the tree our own builder landed on this computer, decoded for the view.
 *
 * Why this module exists at all: the 合集 view used to be built from an 8 × 100 page walk, so it drew at most 800 of
 * 78 874 materials and looked empty. The landed file already holds the whole account — 7 real batches, 1 726 derived
 * ones — so the reader takes *that* tree instead of rebuilding a smaller one.
 *
 * What is dropped, and only this: the flattened `unclassified` rows (78 484 of them, ~8 MB). The view never draws a
 * card for them; it draws `totals.unclassified` and the derived layer, and both are kept.
 *
 * A body that is not this index is refused (`index-unreadable`): the reader then falls back to the page walk, which
 * says so at the top of the view. Nothing here invents an empty tree.
 */
import type {IndexBatch, IndexDerived, LandedIndexTree, MaterialIndexTree} from './index-tree.ts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const whole = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0);

const unusable = (why: string) => Object.assign(new Error('素材索引不可用：' + why), {code: 'index-unreadable'});

/**
 * The route's answer as the tree the 合集 view draws.
 *
 * Accepts the body the server sends — the landed file's own fields plus `claimed` / `totals` / `batches` / `derived` /
 * `stale` (see `material-index-route.mjs`) — and refuses anything that cannot be that tree, so a half answer never
 * becomes a half view.
 */
export function landedIndexOf(body: unknown): LandedIndexTree {
  if (!isRecord(body)) throw unusable('响应不是对象');
  const batches = body.batches;
  const totals = body.totals;
  if (!Array.isArray(batches)) throw unusable('没有 batches');
  if (!isRecord(totals)) throw unusable('没有 totals');
  const derived = isRecord(body.derived) ? body.derived : null;
  const reach = isRecord(body.index) && isRecord((body.index as Record<string, unknown>).reach)
    ? (body.index as Record<string, unknown>).reach as Record<string, unknown>
    : null;
  const pageable = typeof body.pageable === 'number' ? body.pageable : typeof reach?.pageable === 'number' ? reach.pageable : null;
  const claimed = typeof body.claimed === 'number' ? body.claimed : typeof reach?.sourceTotal === 'number' ? reach.sourceTotal : null;
  const generatedAt = typeof body.generatedAt === 'string' && body.generatedAt ? body.generatedAt : null;
  const tree: MaterialIndexTree = {
    schema: typeof body.schema === 'string' ? body.schema : 'orange/material-index-build/1',
    generatedAt: generatedAt ?? '',
    totals: {
      videos: whole(totals.videos),
      parsed: whole(totals.parsed),
      unclassified: whole(totals.unclassified),
    },
    batches: batches as readonly IndexBatch[],
    /* The flattened rows are not drawn, and 78 484 of them are not worth holding: the counts above are the truth. */
    unclassified: [],
    ...(derived ? {derived: derived as unknown as IndexDerived} : {}),
    ...(pageable !== null && claimed !== null
      ? {reach: {pageable, sourceTotal: claimed, unreachable: Math.max(0, claimed - pageable)}}
      : {}),
  };
  return {
    tree,
    generatedAt,
    stale: body.stale === true,
    rows: tree.totals.videos,
  };
}
