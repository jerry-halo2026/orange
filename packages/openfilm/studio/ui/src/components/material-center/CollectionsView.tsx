// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The 合集 view: 批次 (a foldable heading) → 合集 cards → 子合集 cards → that group's materials.
 *
 * Every level is drawn as the drawer's **folder card** (`FolderCover`): a 2 × 2 collage of the set's first four covers,
 * the count in a badge on the cover's foot and the name under it, in the same `minmax(104px, 1fr)` grid the video cards
 * use. A collection, a 子合集, a 派生批次 and a 「未归档」 bucket are all sets of material, so they are all drawn the
 * same way — a column of 28px text rows said "these are labels", which is not what they are.
 *
 * It reads the index and nothing else for its structure — a name that does not parse is *not* grouped by hand. What such
 * a name still says is drawn in the two stages under the real batches, and the three stages are the whole of it:
 *
 *  1. 真实批次 — the parsed tree (`20261106-…-外包装 (46)`). Only 390 of 78 994 names get here.
 *  2. 派生批次 / 未归档 — the derived layer: pseudo-batches from a date or number the name opens with, then the
 *     「未归档」 buckets (a group word, or a bare `_n`). Marked derived, never drawn as a batch — but drawn as cards,
 *     because they are sets of material like any other.
 *  3. 未归类 N 条 — a collapsed line. No group, no cards: a name that says nothing about a batch is not given a fake one.
 *
 * The tree does not explain itself at the top. Where the index came from (`landed` / `probing`), how much of it the
 * supplier would page and how many rows it claims are the reader's own facts, not the person's task: those three lines
 * were read past, never read. A landed index past its own `staleAfterMs` is still said (`index-stale`) — that one can be
 * acted on — and so is 共 N 个派生批次 (a list cut short) and 未归类 (a count that is not a card).
 *
 * Covers are not in the index, so a card's collage is read one way: the covers of the rows already on this page when they
 * are the set's, and otherwise one `/list?name=<prefix>` page of four (`collection-covers.ts`) — asked for when the card
 * is in view, kept in memory for the rest of the visit, and never asked for twice.
 *
 * The materials inside a step are the group's own: a group is read from `/list` by the name prefix its materials share
 * (`group-page.ts`, `GroupMaterials`), page by page, so the wall is that group's material and not a filter over the page
 * the list happened to have. The note above it says the supplier's total and how many rows are loaded; the button under
 * it takes one more page until the total is reached.
 */
import React from 'react';
import type {MaterialCopy} from '@/lib/material-center/copy';
import {
  INDEX_ROOT, collectionOf, collectionsStages, crumbsOf, selectionAtCrumb, selectionOf,
  type IndexCollection, type IndexDerivedBatch, type IndexDerivedGroup, type IndexSelection, type MaterialIndexState,
} from '@/lib/material-center/index-tree';
import type {GroupPageReader} from '@/lib/material-center/group-page';
import {groupPrefixOf} from '@/lib/material-center/group-page';
import type {LibraryEntry} from '@/lib/material-center/library';
import {collageUrls, type CollectionCoverStore} from '@/lib/material-center/collection-covers';
import {FolderCover} from './FolderCover.tsx';
import {GroupMaterials} from './GroupMaterials.tsx';

/** How many derived batches the stage lists before it says how many there are: 1 726 pseudo-batches is a scroll, not a list. */
export const DERIVED_BATCH_ROWS = 40;

export type CollectionsViewProps = {
  readonly copy: MaterialCopy;
  /** The index as the reader has it: built, still being built, or not buildable. */
  readonly index: MaterialIndexState;
  /** The materials loaded on this page: a cover for a card whose rows are already here. */
  readonly entries: readonly LibraryEntry[];
  /** The group's own read (`/list` by name prefix): a group is not a filter over this page's list. */
  readonly page: GroupPageReader;
  /** The one card wall, built by the page (so a card's actions are the page's, in both views). */
  readonly renderEntries: (entries: readonly LibraryEntry[]) => React.ReactNode;
  /** The four covers a card's collage is made of: one request per set for the visit. */
  readonly covers: CollectionCoverStore;
};

/** The card wall of every level: the video cards' own density (104px), so a set and a material are the same size. */
const wallStyle: React.CSSProperties = {gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))', gap: '8px 8px'};
/** One set of material: the drawer's folder tile, and nothing around it (the collage is the card). */
const cardClass = 'group flex min-w-0 cursor-pointer flex-col gap-1 rounded-md p-0.5 text-left transition hover:bg-[var(--bg-hover)] focus-visible:ring-1 focus-visible:ring-[var(--accent)] focus-visible:outline-none';
const nameClass = 'min-w-0 truncate px-0.5 text-[12px] font-medium text-[var(--text)]';
/** A foldable stage heading: the fold is the first thing a person meets at this level. */
const stageHeading = 'cursor-pointer px-1 py-1 text-[12px] font-semibold text-[var(--text-muted)]';
const heading = 'px-1 py-1 text-[12px] font-semibold';

export function CollectionsView({copy, index, entries, page, renderEntries, covers}: CollectionsViewProps) {
  const [selection, setSelection] = React.useState<IndexSelection>(INDEX_ROOT);
  /* A cover answer is a re-render: the store counts its own changes (one per landed page). */
  const coversRevision = React.useSyncExternalStore(covers.subscribe, covers.version, covers.version);
  /* One reveal per prefix, the same function on every render of that card: an observer is not rebuilt per frame. */
  const revealers = React.useMemo(() => new Map<string, () => void>(), [covers]);
  const revealFor = (prefix: string) => {
    let reveal = revealers.get(prefix);
    if (!reveal) {
      reveal = () => covers.ensure(prefix);
      revealers.set(prefix, reveal);
    }
    return reveal;
  };

  if (index.state === 'pending') {
    return <p role="status" data-state="index-pending" className="text-[12px] text-[var(--text-muted)]">{copy.indexPending}</p>;
  }
  if (index.state === 'failed') {
    return <p role="alert" data-state="index-failed" className="rounded border border-[var(--border)] bg-[var(--bg-panel)] px-2 py-1 text-[12px]">{copy.indexFailed}</p>;
  }

  const tree = index.index;
  const stages = collectionsStages(tree);
  const derivedShown = stages.derived.slice(0, DERIVED_BATCH_ROWS);
  const derivedHidden = stages.derived.length - derivedShown.length;
  const crumbs = crumbsOf(tree, selection, copy.allBatches);
  const collection = collectionOf(tree, selection.collectionId);
  const group = collection && selection.groupId
    ? collection.groups.find(row => row.id === selection.groupId || row.name === selection.groupId) ?? null
    : null;

  /**
   * What every card has: the collage and the name under it. `prefix` is the name prefix its rows share — the collection
   * id for a 合集, `<日期>-<产品>-<分组>` for a 子合集, the date a 派生批次 opens with. An empty prefix means the set has
   * no prefix the supplier could be asked for (a 「未归档」 bucket is a word inside the names), so its collage shows only
   * the covers this page already has.
   */
  const face = (input: {readonly name: string; readonly count: number; readonly ids: readonly string[]; readonly prefix: string}) => {
    const answered = input.prefix ? covers.coversOf(input.prefix) : null;
    const urls = collageUrls({ids: input.ids, entries, fetched: answered?.urls ?? []});
    return <>
      <FolderCover urls={urls} count={input.count} {...(input.prefix ? {onReveal: revealFor(input.prefix)} : {})} />
      <span data-collection-name="" className={nameClass} title={input.name}>{input.name}</span>
    </>;
  };
  /** Which of `none / pending / loading / ready / failed` the four covers of this card are in (a run reads it, not a trace). */
  const coverState = (prefix: string) => (prefix ? covers.coversOf(prefix).state : 'none');

  const collectionCard = (batchId: string, row: IndexCollection) => <button key={row.id} type="button"
    data-collection-card={row.id} data-collection-count={row.count} data-collection-count-text={row.count}
    data-cover-state={coverState(row.id)} title={row.name} aria-label={row.name + '，' + copy.collectionCount(row.count)}
    onClick={() => setSelection(selectionOf(batchId, row.id))} className={cardClass}>
    {face({name: row.name, count: row.count, ids: row.groups.flatMap(entry => entry.videoIds), prefix: row.id})}
  </button>;

  /* A pseudo-batch is a set of material like any other: the token its names open with is a prefix the supplier can be
     asked for, so it is drawn as a card — marked derived, never drawn as a batch (there is no level behind it). */
  const derivedCard = (row: IndexDerivedBatch) => <button key={row.id} type="button"
    data-derived-batch={row.id} data-derived-count={row.count} data-derived-count-text={row.count}
    data-cover-state={coverState(row.name)} title={row.name} aria-label={row.name + '，' + copy.collectionCount(row.count)}
    className={cardClass + ' cursor-default'}>
    {face({name: row.name, count: row.count, ids: row.videoIds, prefix: row.name})}
  </button>;

  /* A 「未归档」 bucket is a group word (`茶干`) or a bare `_n`: it is inside the names, not their prefix, so its card
     draws the covers this page already has and asks for nothing. */
  const unfiledCard = (row: IndexDerivedGroup) => <button key={row.id} type="button"
    data-derived-group={row.id} data-derived-group-count={row.count} data-derived-group-count-text={row.count}
    data-cover-state="none" title={row.name} aria-label={row.name + '，' + copy.collectionCount(row.count)}
    className={cardClass + ' cursor-default'}>
    {face({name: row.name, count: row.count, ids: row.videoIds, prefix: ''})}
  </button>;

  return <section data-collections="" aria-label={copy.viewCollections} data-covers-revision={coversRevision}
    className="flex min-h-0 flex-col gap-2">
    <nav data-material-crumb="" aria-label={copy.viewCollections} className="flex flex-wrap items-center gap-1 text-[11px] text-[var(--text-muted)]">
      {crumbs.map((crumb, at) => <React.Fragment key={crumb.level + (crumb.id ?? '')}>
        {at > 0 && <span aria-hidden>/</span>}
        {at === crumbs.length - 1
          ? <span data-crumb={crumb.level} className="min-w-0 truncate px-1 text-[var(--text)]">{crumb.name}</span>
          : <button type="button" data-crumb={crumb.level} onClick={() => setSelection(selectionAtCrumb(selection, crumb.level, crumb.id))}
            className="min-w-0 truncate rounded px-1 hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">{crumb.name}</button>}
      </React.Fragment>)}
    </nav>

    {/* A landed index past its own window is drawn, then said (it can be rebuilt): the one line about the read that a
        person can act on. Which index it was, and the supplier's pageable/claimed arithmetic, are not drawn. */}
    {index.stale && <p role="status" data-note="index-stale" className="rounded border border-[var(--border)] bg-[var(--bg-panel)] px-2 py-1 text-[12px]">
      {copy.indexStale}
    </p>}

    {!collection && stages.real.length === 0 && <p role="status" data-state="index-empty" className="text-[12px] text-[var(--text-muted)]">{copy.indexEmpty}</p>}

    {/* 1. 批次 → 合集 cards. The batch heading folds its wall away, the way a folder does. The heading is the batch's
        *name* and nothing else: the wall under it is what says how much is in it, and a "108 条" beside the date read
        as a second title. A card's own count stays on its collage's foot (`FolderCover`). */}
    {!collection && <div data-stage="batches" className="flex flex-col gap-2">
      {stages.real.map(batch => <details key={batch.id} data-batch={batch.id} open className="flex flex-col gap-2">
        <summary className={stageHeading}>{batch.name}</summary>
        <div className="grid" style={wallStyle}>
          {batch.products.map(row => collectionCard(batch.id, row))}
        </div>
      </details>)}
    </div>}

    {/* 2a. 派生批次: the date / number a name opens with. Marked derived — a material date is not a batch id. */}
    {!collection && derivedShown.length > 0 && <details data-stage="derived" open className="flex flex-col gap-1">
      <summary className={stageHeading}>{copy.derivedStage}</summary>
      <div className="grid" style={wallStyle}>
        {derivedShown.map(derivedCard)}
      </div>
      {derivedHidden > 0 && <p data-note="derived-more" data-derived-total={stages.derived.length} data-derived-shown={derivedShown.length}
        className="px-1 text-[11px] text-[var(--text-muted)]">{copy.derivedMore(stages.derived.length, derivedShown.length)}</p>}
    </details>}

    {/* 2b. 未归档: one pseudo-collection, bucketed by the group word or by a bare `_n`. */}
    {!collection && stages.unfiled && <details data-stage="unfiled" data-unfiled-count={stages.unfiled.count} open className="flex flex-col gap-1">
      <summary className={stageHeading}>
        {copy.unfiledStage}
        <span data-unfiled-name="" className="ml-2 font-normal text-[11px] text-[var(--text-muted)]">{stages.unfiled.name}</span>
      </summary>
      <div className="grid" style={wallStyle}>
        {stages.unfiled.groups.map(unfiledCard)}
      </div>
    </details>}

    {/* 3. 未归类: a collapsed count. No group, no cards — a name that says nothing is not given a fake structure. */}
    {!collection && stages.unassigned > 0 && <details data-stage="unassigned" data-unassigned={stages.unassigned} className="rounded border border-[var(--border)] bg-[var(--bg-panel)] px-2 py-1 text-[12px]">
      <summary data-unassigned-summary="" className="cursor-pointer text-[var(--text-muted)]">{copy.unassignedCount(stages.unassigned)}</summary>
      <p className="mt-1 text-[11px] text-[var(--text-muted)]">{copy.unassignedHint}</p>
    </details>}

    {/* 子合集: the groups of one collection, each a card with its own count (their sum is the collection's count). */}
    {collection && !group && <section data-groups="" aria-label={collection.name} className="flex flex-col gap-2">
      <h3 className={heading}>
        {collection.name}
        <span data-collection-count={collection.count} className="ml-2 font-normal text-[11px] text-[var(--text-muted)]">{copy.collectionCount(collection.count)}</span>
      </h3>
      <div className="grid" style={wallStyle}>
        {collection.groups.map(row => <button key={row.id} type="button"
          data-group-card={row.id} data-group-count={row.count} data-group-count-text={row.count}
          data-cover-state={coverState(groupPrefixOf(collection.id, row))} title={row.name}
          aria-label={row.name + '，' + copy.collectionCount(row.count)}
          onClick={() => setSelection(selectionOf(selection.batchId, collection.id, row.id))} className={cardClass}>
          {face({name: row.name, count: row.count, ids: row.videoIds, prefix: groupPrefixOf(collection.id, row)})}
        </button>)}
      </div>
    </section>}

    {/* 子合集内的素材: the group is read from `/list` by its name prefix — its own pages, its own covers, its own total. */}
    {collection && group && <section data-groups="" aria-label={group.name} className="flex min-h-0 flex-col gap-2">
      <h3 className={heading}>
        {collection.name}
        <span aria-hidden className="px-1 text-[var(--text-muted)]">/</span>
        {group.name}
        <span data-group-count={group.count} className="ml-2 font-normal text-[11px] text-[var(--text-muted)]">{copy.collectionCount(group.count)}</span>
      </h3>
      <GroupMaterials copy={copy} prefix={groupPrefixOf(collection.id, group)} page={page} renderEntries={renderEntries} />
    </section>}
  </section>;
}
