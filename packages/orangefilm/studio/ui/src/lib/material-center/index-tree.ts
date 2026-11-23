// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The 批次 → 合集 → 子合集 tree, read from the names the cloud steward already gives its material.
 *
 * The data layer is `packages/orangefilm/src/material-index.mjs` (one parser, one builder, one id lookup); this module
 * only types that answer for the UI and adds what a view needs on top of it — the crumb trail, the count invariant, the
 * tag path of one material, the derived layer the view draws under the real batches, and a reader that can be handed
 * rows instead of a network so a test can build a whole index without a request.
 *
 * Nothing here is fuzzy: a name that does not carry `日期-产品-分组 (序号)` is not in `batches`. What such a name still
 * says (a material date, a group word, a `_n` sequence, or nothing) is the data layer's `derived` layer, drawn as its own
 * stage — never mixed into the parsed tree.
 */
import {buildMaterialIndex, entryMetaOf, materialIds, parseMaterialName} from '../../../../../src/material-index.mjs';
import {isMaterialName} from './media.ts';

/** One row the index is built from: the supplier id, the name it was given, and its digest when the row carried one. */
export type MaterialIndexRow = {readonly videoId: string; readonly name: string; readonly md5?: string};

/** 子合集: the group segment of the name (`外包装`, `茶干料子`…). */
export type IndexGroup = {readonly id: string; readonly name: string; readonly count: number; readonly videoIds: readonly string[]};

/** 合集: one date and one product (`20261106-柠檬宝藏茶200g罐`). */
export type IndexCollection = {readonly id: string; readonly name: string; readonly count: number; readonly groups: readonly IndexGroup[]};

/** 批次: one date (`20261106`). */
export type IndexBatch = {readonly id: string; readonly name: string; readonly count: number; readonly products: readonly IndexCollection[]};

/**
 * 派生批次: a date or number the name opens with (`12.13`, `20250422`, `12月18日`). A material *date*, not a batch id —
 * that is what `derived: true` says, and why it never appears in `batches`.
 */
export type IndexDerivedBatch = {
  readonly id: string;
  readonly name: string;
  readonly count: number;
  readonly videoIds: readonly string[];
  readonly derived: true;
};

/** One bucket of 「未归档」: a group word the name carries, or the bare `_n` sequence. */
export type IndexDerivedGroup = IndexGroup & {readonly derived?: true};

/** 「未归档」: one pseudo-collection for everything that has a group but no batch. */
export type IndexUnfiled = {
  readonly id: string;
  readonly name: string;
  readonly count: number;
  readonly derived: true;
  readonly groups: readonly IndexDerivedGroup[];
};

/** The second layer, as the data layer builds it. `count` is the sum of the three buckets. */
export type IndexDerived = {
  readonly count: number;
  readonly batches: readonly IndexDerivedBatch[];
  readonly groups: IndexUnfiled;
  readonly unassigned: number;
};

/** What the supplier claims and what it will actually serve (`sourceTotal` − `pageable` = `unreachable`). */
export type MaterialIndexReach = {readonly pageable: number; readonly sourceTotal: number; readonly unreachable: number};

export type MaterialIndexTotals = {readonly videos: number; readonly parsed: number; readonly unclassified: number};

/** 产品：日期 + 供应商二级分类（产品），子分组是视频标签（规格/配料/包装…）。 */
export type IndexMaterialEntry = {readonly videoId: string; readonly videoType: number};
export type IndexProductLabel = {readonly name: string; readonly count: number; readonly videoIds: readonly string[]; readonly entries?: readonly IndexMaterialEntry[]};
export type IndexProductDate = {readonly date: string; readonly count: number};
export type IndexProduct = {
  readonly id: string;
  readonly oneLevel: string;
  readonly name: string;
  readonly count: number;
  readonly videoIds: readonly string[];
  readonly entries?: readonly IndexMaterialEntry[];
  readonly dates: readonly IndexProductDate[];
  readonly labels: readonly IndexProductLabel[];
};

export type MaterialIndexTree = {
  readonly schema: string;
  readonly generatedAt: string;
  readonly totals: MaterialIndexTotals;
  readonly batches: readonly IndexBatch[];
  readonly unclassified: readonly MaterialIndexRow[];
  readonly derived?: IndexDerived;
  readonly products?: readonly IndexProduct[];
  readonly reach?: MaterialIndexReach;
};

const NO_DERIVED: IndexDerived = {
  count: 0, batches: [], unassigned: 0,
  groups: {id: 'derived:unfiled', name: '未归档', count: 0, derived: true, groups: []},
};

/**
 * The derived layer, with the empty one standing in for an index built before the layer existed — an older `index.json`
 * is read, not reinterpreted.
 */
export function derivedOf(index: MaterialIndexTree): IndexDerived {
  return index.derived ?? NO_DERIVED;
}

/** The whole tree from rows: the data layer's builder, typed. Ordering is the builder's (count, then name). */
export function indexTree(
  rows: readonly MaterialIndexRow[],
  now: Date = new Date(),
  reach: MaterialIndexReach | null = null,
): MaterialIndexTree {
  /* A subtitle track's input (`.vtt/.srt/.ass`) and a text file are not material: they never enter a batch or a 合集.
     A name with no extension — the supplier's own `20261106-…-外包装 (46)` — is material, so an empty tree cannot be
     the result of this filter alone (`media.ts` says why). */
  const material = rows.filter(row => isMaterialName(row.name));
  /* The builder's entry carries the supplier's digest (`''` when the row had none); a row read before the field existed
     is handed the empty string rather than an invented one. */
  /* `entryMetaOf` 是唯一决定"元数据缺了算什么"的地方（缺 → []/null/''，不抛）。
     直接只给 videoId/name/md5 会让 IndexEntry 少六个字段 —— 那正是 tsc 一直报的那条。 */
  return buildMaterialIndex(material.map(row => ({videoId: row.videoId, name: row.name, md5: row.md5 ?? '', ...entryMetaOf(row)})), now, reach as never) as unknown as MaterialIndexTree;
}

/** The derived layer's three buckets, summed: `total` must equal `totals.unclassified`, or a row was lost. */
export function derivedCounts(index: MaterialIndexTree): {batches: number; grouped: number; unassigned: number; total: number} {
  const derived = derivedOf(index);
  const batches = derived.batches.reduce((total, batch) => total + batch.count, 0);
  const grouped = derived.groups?.count ?? 0;
  const unassigned = derived.unassigned;
  return {batches, grouped, unassigned, total: batches + grouped + unassigned};
}

/** A collection's material ids, optionally narrowed to one 子合集. */
export function videoIdsOf(index: MaterialIndexTree, collectionId: string, groupId?: string): readonly string[] {
  return materialIds(index, collectionId, groupId) as readonly string[];
}

/** The sum of a collection's groups: what the 合集 card must equal, and what the 子合集 list must add up to. */
export function groupsSum(collection: IndexCollection): number {
  return collection.groups.reduce((total, group) => total + group.count, 0);
}

/** Whether a collection's count and its groups agree (they are built in one pass, so they have to). */
export function countsAgree(collection: IndexCollection): boolean {
  return groupsSum(collection) === collection.count;
}

/** What the collections view is looking at: none, a batch, a collection, or one of its groups. */
export type IndexSelection = {
  readonly batchId: string | null;
  readonly collectionId: string | null;
  readonly groupId: string | null;
};

export const INDEX_ROOT: IndexSelection = {batchId: null, collectionId: null, groupId: null};

export function selectionOf(batchId: string | null, collectionId: string | null = null, groupId: string | null = null): IndexSelection {
  return {batchId, collectionId, groupId};
}

/** One crumb: a level and the id it goes back to (`null` for 全部). */
export type IndexCrumb = {
  readonly level: 'root' | 'batch' | 'collection' | 'group';
  readonly id: string | null;
  readonly name: string;
};

export function batchOf(index: MaterialIndexTree, batchId: string | null): IndexBatch | null {
  if (!batchId) return null;
  return index.batches.find(batch => batch.id === batchId) ?? null;
}

/** A collection anywhere in the tree (the ids carry the batch, the search does not rely on it). */
export function collectionOf(index: MaterialIndexTree, collectionId: string | null): IndexCollection | null {
  if (!collectionId) return null;
  for (const batch of index.batches) {
    const found = batch.products.find(collection => collection.id === collectionId);
    if (found) return found;
  }
  return null;
}

/** The collection a group belongs to. */
export function groupOf(index: MaterialIndexTree, groupId: string | null): IndexGroup | null {
  if (!groupId) return null;
  for (const batch of index.batches) {
    for (const collection of batch.products) {
      const found = collection.groups.find(group => group.id === groupId || group.name === groupId);
      if (found) return found;
    }
  }
  return null;
}

/**
 * The trail for a selection, deepest level last: `全部 / 20261106 / 柠檬宝藏茶200g罐 / 外包装`.
 * A level whose id is not in the tree is left out, so the trail never names something that is not there.
 */
export function crumbsOf(index: MaterialIndexTree, selection: IndexSelection, allWord: string): readonly IndexCrumb[] {
  const crumbs: IndexCrumb[] = [{level: 'root', id: null, name: allWord}];
  const batch = batchOf(index, selection.batchId);
  if (batch) crumbs.push({level: 'batch', id: batch.id, name: batch.name});
  const collection = collectionOf(index, selection.collectionId);
  if (collection) crumbs.push({level: 'collection', id: collection.id, name: collection.name});
  const group = collection && selection.groupId
    ? collection.groups.find(entry => entry.id === selection.groupId || entry.name === selection.groupId) ?? null
    : null;
  if (group) crumbs.push({level: 'group', id: group.id, name: group.name});
  return crumbs;
}

/** What a crumb press selects: going up one level drops what was under it. */
export function selectionAtCrumb(selection: IndexSelection, level: IndexCrumb['level'], id: string | null): IndexSelection {
  if (level === 'root') return INDEX_ROOT;
  if (level === 'batch') return selectionOf(id);
  if (level === 'collection') return selectionOf(selection.batchId, id);
  return selection;
}

/** The ids the current step shows: a group's material, a collection's, a batch's, or none at all. */
export function selectedVideoIds(index: MaterialIndexTree, selection: IndexSelection): readonly string[] {
  if (selection.groupId && selection.collectionId) return videoIdsOf(index, selection.collectionId, selection.groupId);
  if (selection.collectionId) return videoIdsOf(index, selection.collectionId);
  const batch = batchOf(index, selection.batchId);
  return batch ? batch.products.flatMap(collection => videoIdsOf(index, collection.id)) : [];
}

/** The three levels a material's name names — the tag path the detail sheet shows — or `null` when it has none. */
export function tagPathOf(name: string): readonly string[] | null {
  const parsed = parseMaterialName(name) as {date: string; product: string; groupLabel: string} | null;
  if (!parsed) return null;
  return [parsed.date, parsed.product, parsed.groupLabel].filter((part, index) => part !== '' && (index === 0 || part.trim() !== ''));
}

/**
 * What the 合集 view draws, in the order it draws it: the real batches, then the derived layer (pseudo-batches and the
 * 「未归档」 buckets), then the bare count of names that said nothing. One model, so the three stages, their counts and
 * the invariant (`stageTotal === totals.unclassified`) cannot drift from what is on screen.
 */
export type CollectionsStages = {
  readonly real: readonly IndexBatch[];
  readonly derived: readonly IndexDerivedBatch[];
  readonly unfiled: IndexUnfiled | null;
  readonly unassigned: number;
};

export function collectionsStages(index: MaterialIndexTree): CollectionsStages {
  const derived = derivedOf(index);
  const unfiled = derived.groups && derived.groups.count > 0 ? derived.groups : null;
  return {real: index.batches, derived: derived.batches, unfiled, unassigned: derived.unassigned};
}

/** Every number a stage draws, in one place: what a test asserts and what the view prints are the same count. */
export type StageCounts = {
  readonly realBatches: number;
  readonly realCollections: number;
  readonly derivedBatches: number;
  readonly unfiledGroups: number;
  readonly unassigned: number;
  readonly total: number;
};

export function stageCounts(stages: CollectionsStages): StageCounts {
  const realCollections = stages.real.reduce((total, batch) => total + batch.products.length, 0);
  const unfiledGroups = stages.unfiled?.groups.length ?? 0;
  return {
    realBatches: stages.real.length,
    realCollections,
    derivedBatches: stages.derived.length,
    unfiledGroups,
    unassigned: stages.unassigned,
    total: stages.real.reduce((total, batch) => total + batch.count, 0)
      + stages.derived.reduce((total, batch) => total + batch.count, 0)
      + (stages.unfiled?.count ?? 0)
      + stages.unassigned,
  };
}

/** What the reader knows: the tree is still being built, it was built, or it could not be built. */
export type MaterialIndexState =
  | {readonly state: 'pending'}
  | {
    readonly state: 'ready';
    readonly index: MaterialIndexTree;
    /**
     * Where the tree came from. `landed` is the index `material-index-build.mjs` wrote on this computer
     * (`GET /api/materials/index`, 78 874 rows); `probing` is the budgeted page walk (8 × 100) used only when that
     * file is absent or unusable. The view says which at the top — it never quietly draws one as the other.
     */
    readonly source: 'landed' | 'probing';
    /** When the landed index was built (`null` for a walk, which was built just now). */
    readonly generatedAt: string | null;
    /** Past the file's own `staleAfterMs`: the data is still drawn, and the view says it can be rebuilt. */
    readonly stale: boolean;
    /** How many materials the tree holds (`totals.videos`). */
    readonly rows: number;
  }
  | {readonly state: 'failed'; readonly code: string};

/** One landed tree, as the reader records it: the tree, when it was built, whether it is past its own window. */
export type LandedIndexTree = {
  readonly tree: MaterialIndexTree;
  readonly generatedAt: string | null;
  readonly stale: boolean;
  /** How many materials the landed index holds (`totals.videos`): the number the view prints beside `landed`. */
  readonly rows: number;
};

/**
 * One read of the rows, and — when the source knows them — the supplier's own numbers for them. A source that is a
 * plain array of rows claims nothing about `sourceTotal`, and the view then says how much it read instead.
 */
export type IndexWalk = {
  readonly rows: readonly MaterialIndexRow[];
  readonly reach?: {readonly pageable: number; readonly sourceTotal: number | null} | null;
};

/** Where the rows come from. Injected: a test hands an array, the page hands a read-only page walk. */
export type IndexRowsSource = () => Promise<readonly MaterialIndexRow[] | IndexWalk>;

/**
 * Where the landed index comes from: the read-only route, as a tree (`index-landed.ts`). Resolves `null` when there is
 * nothing landed to read; anything it throws is the same thing — the reader then walks the pages instead.
 */
export type IndexLandedSource = () => Promise<LandedIndexTree | null>;

export type MaterialIndexReader = {
  getState(): MaterialIndexState;
  subscribe(listener: (state: MaterialIndexState) => void): () => void;
  /** One read of the rows and one build; a second call while one is out shares it. */
  load(): Promise<void>;
  destroy(): void;
};

/** The claim and the served rows as the reach a view prints; a walk that cannot say the claim is not a reach. */
export function reachOf(walk: IndexWalk | null | undefined): MaterialIndexReach | null {
  const claimed = walk?.reach?.sourceTotal;
  if (typeof claimed !== 'number' || !Number.isFinite(claimed)) return null;
  const pageable = Math.max(0, walk?.reach?.pageable ?? 0);
  return {pageable, sourceTotal: claimed, unreachable: Math.max(0, claimed - pageable)};
}

/**
 * The index reader: a read-only function over two injected sources, in this order.
 *
 *  1. **the landed index** (`landed`, `GET /api/materials/index`): the whole account, 78 874 rows, already built. This
 *     is the normal path, and the reason the 合集 view is not nearly empty any more;
 *  2. **the page walk** (`rows`, 8 × 100): only when there is nothing landed — a 404 `index-missing`, an unusable file,
 *     a route this build does not serve. The state says `probing` and the view says so, so the smaller number is never
 *     presented as the account.
 *
 * It never fetches anything itself (the sources do), it never caches across a page, and it never falls back to a fuzzy
 * grouping — a walk that fails leaves the state `failed` and the view says the index is not there.
 */
export function createMaterialIndexReader(options: {
  readonly rows: IndexRowsSource;
  readonly landed?: IndexLandedSource | null;
  readonly now?: () => Date;
}): MaterialIndexReader {
  const listeners = new Set<(state: MaterialIndexState) => void>();
  let state: MaterialIndexState = {state: 'pending'};
  let inflight: Promise<void> | null = null;
  let live = true;
  const setState = (next: MaterialIndexState) => {
    if (!live) return;
    state = next;
    for (const listener of listeners) listener(state);
  };
  /** The landed tree, or `null` when there is none to read: a 404, an unusable file, or a source that is not wired. */
  const landedTree = async (): Promise<LandedIndexTree | null> => {
    if (!options.landed) return null;
    try {
      return await options.landed();
    } catch {
      /* `index-missing` / `index-unreadable` / an unwired route: the walk below is the fallback, and the view says so. */
      return null;
    }
  };
  const load = (): Promise<void> => {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const landed = await landedTree();
        if (landed) {
          setState({state: 'ready', index: landed.tree, source: 'landed', generatedAt: landed.generatedAt, stale: landed.stale, rows: landed.rows});
          return;
        }
        const answer = await options.rows();
        const walk: IndexWalk = Array.isArray(answer) ? {rows: answer} : (answer as IndexWalk);
        const at = options.now ? options.now() : new Date();
        const index = indexTree(walk.rows, at, reachOf(walk));
        setState({state: 'ready', index, source: 'probing', generatedAt: null, stale: false, rows: index.totals.videos});
      } catch (error) {
        const code = (error as {code?: unknown} | null)?.code;
        setState({state: 'failed', code: typeof code === 'string' ? code : 'index-unavailable'});
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load,
    destroy() {
      live = false;
      listeners.clear();
    },
  };
}
