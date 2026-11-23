// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import React from 'react';
import {CornerDownLeft, Search, User} from 'lucide-react';
import {failureCopy, useFailureCopy, type MaterialCopy} from '@/lib/material-center/copy';
import type {MaterialCenterController, MaterialCenterState} from '@/lib/material-center/controller';
import {authorFrom, authorValue, cloudEntries, draftSelected, libraryView, type LibraryEntry, type LibraryView} from '@/lib/material-center/library';
import {createGroupPageReader, type GroupPageClient} from '@/lib/material-center/group-page';
import {createCollectionCoverStore} from '@/lib/material-center/collection-covers';
import {deniedDownloads} from '@/lib/material-center/denied';
import {ownScopeAvailable, type MaterialBinding} from '@/lib/material-center/binding';
import {tagPathOf, type MaterialIndexState} from '@/lib/material-center/index-tree';
import {MATERIAL_VIEW_MODES, useMaterialViewMode, writeViewMode} from '@/lib/material-center/view-pref';
import {materialDraftKey, type MaterialDraftOperation, type MaterialDraftReference} from '@/lib/material-draft';
import {MaterialCardView} from './MaterialCard.tsx';
import {MaterialDetail} from './MaterialDetail.tsx';
import {CollectionsView} from './CollectionsView.tsx';
import {ProductFolders} from './ProductFolders.tsx';
import {MaterialSubNav} from './MaterialSubNav.tsx';
import {WikiPanel} from './WikiPanel.tsx';
import type {WikiCache} from '@/lib/material-center/wiki';
import type {WikiCopy} from '@/lib/material-center/wiki-copy';
import {wikiCopyFor} from '@/lib/material-center/wiki-copy';
import {MaterialListRow} from './MaterialListRow.tsx';

export type MaterialCenterPageProps = {
  readonly controller: MaterialCenterController;
  readonly copy: MaterialCopy;
  /** The Studio sidebar's presentation of the same page: one column, the same data, the same rules. */
  readonly compact?: boolean;
  /**
   * The cloud tab's presentation: cloud entries are the drawer's small tiles (one cover, one name, its actions under the
   * pointer) in the same auto-fill grid MediaPool draws, so a page of the supplier's material reads as a grid, not as
   * one full-width card per row.
   */
  readonly dense?: boolean;
  /** The clock the relative times are read against; defaults to now at render. */
  readonly now?: () => number;
  readonly title?: string;
  /** A drill-down hides the filter bar: the group is the filter. */
  readonly showFilters?: boolean;
  /** A drill-down answers its group's total (`providerTotal`), so the group card behind it can say it. */
  readonly onGroupCount?: (total: number | null) => void;
  /** The wiki's session memory; without it no notes entry is offered. */
  readonly wiki?: WikiCache;
  readonly wikiCopy?: WikiCopy;
  readonly studioRetrying?: boolean;
  /** The claimed cloud-steward account "my materials" is scoped to; `null` until one is claimed (in Settings). */
  readonly binding: MaterialBinding | null;
  /** Whether the claim has been read yet (nothing about "mine" is claimed or refused before that). */
  readonly rail?: boolean;
  readonly hideToggle?: boolean;
  readonly bindingKnown: boolean;
  /** The batch draft, the one selection model the sources share. */
  readonly draft: readonly MaterialDraftReference[];
  readonly draftReady: boolean;
  readonly onDraftOperation: (operation: MaterialDraftOperation) => Promise<boolean>;
  /**
   * The 批次 → 合集 → 子合集 tree the collections view reads. Handed in (never fetched here): an index that is still
   * being built says so, and a failed one says it failed — neither is ever filled in with a fuzzy grouping.
   */
  readonly index?: MaterialIndexState;
  /**
   * The `list` route as this page's client has it: the 合集 view reads one 子合集 by its name prefix with it
   * (`group-page.ts`), so a group is its own pages and not a filter over whatever page the list happened to load.
   */
  readonly list: GroupPageClient['list'];
};

const useCenter = (controller: MaterialCenterController): MaterialCenterState => {
  const subscribe = React.useCallback((listener: () => void) => controller.subscribe(listener), [controller]);
  return React.useSyncExternalStore(subscribe, controller.getState, controller.getState);
};

/** One row of the author menu: the two scopes, and nothing else. */
const authorOption = 'flex h-7 w-full items-center gap-1.5 px-2 text-left text-[12px] text-[var(--text)] hover:bg-[var(--bg-hover)] disabled:opacity-40 [&[aria-checked=true]]:text-[var(--accent)]';

const emptyWord = (copy: MaterialCopy, empty: LibraryView['empty']): string => empty === 'no-cloud' ? copy.emptyCloud
  : empty === 'cloud-unavailable' ? copy.emptyCloudOffline : copy.emptyAll;

/**
 * The material centre: one filter bar (a search and whose material — it reads the cloud catalogue and nothing else), one
 * list, and two views of the same cloud material: the dense wall of every video, and the 批次 → 合集 → 子合集 tree. The
 * toggle is the only difference; both views draw the same card with the same actions, and one material opens the same
 * detail sheet from either.
 *
 * The project's own files and the Saved library are not part of this list: they are the drawer's 导入 and 收藏 tabs, so
 * there is no source switch here and nothing local to fall back on.
 */
export function MaterialCenterPage({
  controller, copy, compact = false, dense = false, now = Date.now, title,
  studioRetrying = false, showFilters = true, onGroupCount, wiki, wikiCopy: wikiWords,
  binding, bindingKnown, draft, draftReady, onDraftOperation, index = {state: 'pending'}, list, rail = false, hideToggle = false,
}: MaterialCenterPageProps) {
  const state = useCenter(controller);
  const viewMode = useMaterialViewMode();
  const [search, setSearch] = React.useState(state.filters.search);
  /* The session's refusals: a video the supplier already said no to is not asked for again. */
  const deniedVersion = React.useSyncExternalStore(deniedDownloads.subscribe, () => deniedDownloads.version);
  const deniedNow = React.useMemo(() => new Set(deniedDownloads.ids()), [deniedVersion]);
  const [hovered, setHovered] = React.useState<string | null>(null);
  const [detailFor, setDetailFor] = React.useState<string | null>(null);
  const [pendingDraft, setPendingDraft] = React.useState<Set<string>>(new Set());
  const pendingRef = React.useRef(new Set<string>());
  const at = now();
  /* The group card behind a drill-down learns its total from the page it just read. The callback may be a new arrow
     each render, so it is held in a ref and the effect follows only the value (a request-free write-back). */
  const countRef = React.useRef(onGroupCount);
  countRef.current = onGroupCount;
  const pageTotal = state.page?.providerTotal ?? null;
  React.useEffect(() => {
    if (pageTotal === null) return;
    const total = typeof pageTotal === 'number' ? pageTotal : Number(pageTotal);
    if (Number.isFinite(total)) countRef.current?.(total);
  }, [pageTotal]);

  /** "My materials" exists only once an account is claimed (Settings → 云管家); before that the page uses the company view. */
  const ownAvailable = ownScopeAvailable(binding);
  const cloudBound = Boolean(binding);
  /* The wiki: one material's notes open at a time (read when opened, kept for the session). */
  const wikiCopy = wikiWords ?? wikiCopyFor('en');
  const [wikiFor, setWikiFor] = React.useState<string | null>(null);
  /* The first read waits for the claim: "mine" is never asked for before we know one exists (and no request at all
     is made from a render — this is the page's ordinary list load). */
  const started = React.useRef(false);
  React.useEffect(() => {
    if (!bindingKnown || started.current) return;
    started.current = true;
    if (!ownAvailable && state.filters.author === 'own') {
      controller.setFilters({author: 'company'});
      return;
    }
    void controller.refresh();
    void controller.loadFacets();
  }, [bindingKnown, ownAvailable, controller, state.filters.author]);

  const filters = state.filters;
  /** The scope the author button stands for, in the library's own words (its menu is the same two choices). */
  const authorName = authorValue(filters) === 'cloud:own' ? copy.authorOwn : copy.authorCompany;
  /* The author menu: a press on the button opens it, a press anywhere else (or Escape) closes it. */
  const [authorOpen, setAuthorOpen] = React.useState(false);
  const authorBox = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!authorOpen) return undefined;
    const outside = (event: MouseEvent) => {
      if (!authorBox.current?.contains(event.target as Node)) setAuthorOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAuthorOpen(false);
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [authorOpen]);
  /* The page's list: the cloud catalogue (no local half is merged in anywhere). */
  const view: LibraryView = libraryView(state);

  /* The 合集 view's group read: one `/list` per page with `name=` set to the group's prefix. The class and the scope are
     read at request time, so a filter change is the next request's and never a re-read of the group on screen. */
  const groupReader = React.useMemo(() => createGroupPageReader({
    list,
    context: () => ({videoType: controller.getState().filters.videoType, scope: controller.getState().filters.author}),
  }), [list, controller]);
  React.useEffect(() => () => groupReader.destroy(), [groupReader]);
  const groupPage = React.useSyncExternalStore(groupReader.subscribe, groupReader.getState, groupReader.getState);
  const groupEntries = React.useMemo(() => cloudEntries(groupPage.cards), [groupPage.cards]);

  /* The four covers of a 合集 / 子合集 card: one `/list?name=<prefix>` page of four per set, asked for from a card that is
     in view and kept in memory for the visit (`collection-covers.ts`). Same client, same class and scope as the group
     read — a second route client would be a second catalogue. */
  const coverStore = React.useMemo(() => createCollectionCoverStore({
    list,
    context: () => ({videoType: controller.getState().filters.videoType, scope: controller.getState().filters.author}),
  }), [list, controller]);
  React.useEffect(() => () => coverStore.destroy(), [coverStore]);

  /* Both walls' entries: the loaded page's, and the open group's own rows (so a group card's download, selection and
     detail are the page's own actions, not a second set). */
  const byId = React.useMemo(() => new Map([...view.entries, ...groupEntries].map(entry => [entry.id, entry])),
    [view.entries, groupEntries]);
  const focused = hovered ? byId.get(hovered) ?? null : null;
  const detail = detailFor ? byId.get(detailFor) ?? null : null;

  /** Looking: the page's own highlight, and the controller's (a state setter; it cannot reach a request). */
  const look = (id: string | null) => {
    setHovered(id);
    controller.hover(id ? byId.get(id)?.card?.videoId ?? null : null);
  };
  const useEntry = (id: string) => {
    const entry = byId.get(id);
    if (entry?.source === 'cloud' && entry.card) void controller.use(entry.card.videoId);
  };
  const toggle = (id: string) => {
    const entry = byId.get(id);
    if (!entry?.draft || !draftReady || pendingRef.current.has(id)) return;
    pendingRef.current.add(id);
    setPendingDraft(new Set(pendingRef.current));
    const operation: MaterialDraftOperation = draftSelected(draft, entry)
      ? {type: 'remove', key: materialDraftKey(entry.draft)}
      : {type: 'add', item: entry.draft};
    void onDraftOperation(operation).catch(() => false).finally(() => {
      pendingRef.current.delete(id);
      setPendingDraft(new Set(pendingRef.current));
    });
  };

  const cardProps = (entry: LibraryEntry) => ({
    entry,
    copy,
    now: at,
    selected: draftSelected(draft, entry),
    hovered: hovered === entry.id,
    usePending: entry.source === 'cloud' ? state.usePending === entry.card?.videoId : false,
    canSelect: draftReady && entry.draft !== null && !pendingDraft.has(entry.id),
    canUse: entry.source === 'cloud' ? cloudBound && entry.card !== null && !deniedNow.has(entry.card.videoId) : false,
    useLabel: entry.source === 'cloud'
      ? (!cloudBound ? copy.bindToDownload : entry.card && deniedNow.has(entry.card.videoId) ? useFailureCopy(copy, 'forbidden', deniedDownloads.codeOf(entry.card.videoId) ?? undefined) : copy.download)
      : copy.download,
    onHover: look,
    onToggleSelect: toggle,
    onUse: useEntry,
    onOpen: (id: string) => setDetailFor(current => (current === id ? null : id)),
    ...(wiki && entry.source === 'cloud' && entry.card ? {onWiki: (videoId: string) => setWikiFor(current => (current === videoId ? null : videoId)), wikiOpen: wikiFor === entry.card.videoId} : {}),
  });

  /** One wall for whichever list is handed in: the dense cloud grid, and a group's own materials, are the same cards. */
  const wall = (rows: readonly LibraryEntry[]) => rows.length === 0 ? null : <div data-view-pane="cards"
    className={'grid ' + (dense ? '' : 'gap-3 ' + (compact ? 'grid-cols-1' : 'sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5'))}
    style={dense ? {gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))', gap: '8px 8px'} : undefined}>
    {rows.map(entry => <MaterialCardView key={entry.id} {...cardProps(entry)} dense={dense && entry.source === 'cloud'} />)}
  </div>;

  /** A group's materials: that group's own rows (read by its name prefix), drawn by the same card wall and actions. */
  const renderGroupEntries = (rows: readonly LibraryEntry[]) => wall(rows);

  return <section data-material-center="" className={(rail ? 'flex min-h-0 flex-row gap-3 ' : 'flex min-h-0 flex-col gap-3 ') + (compact ? 'h-full overflow-y-auto p-3' : '')} aria-label={title ?? copy.title}>
    {rail && <MaterialSubNav copy={copy} active={viewMode} onChange={writeViewMode} />}
    <div className="flex min-w-0 flex-1 flex-col gap-3">
    <div className="flex flex-wrap items-center gap-2">
      {!rail && !hideToggle && <div role="group" data-view-toggle={viewMode} aria-label={copy.viewToggle} className="flex overflow-hidden rounded border border-[var(--border)] text-[11px]">
        {MATERIAL_VIEW_MODES.map(mode => <button key={mode} type="button" data-view-mode={mode} aria-pressed={viewMode === mode}
          title={mode === 'videos' ? copy.viewVideos : mode === 'collections' ? copy.viewCollections : '产品'} aria-label={mode === 'videos' ? copy.viewVideos : mode === 'collections' ? copy.viewCollections : '产品'}
          onClick={() => writeViewMode(mode)}
          className={(viewMode === mode ? 'bg-[var(--bg-hover)] text-[var(--text)] ' : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] ')
            + 'px-2 py-1 first:border-r first:border-[var(--border)]'}>{mode === 'videos' ? '▦' : '▤'}</button>)}
      </div>}
    </div>

    {/* One compact bar for one catalogue, in the drawer's own shape: a single `h-7` line whose search box takes every
        pixel the icon buttons do not, and those buttons carry the two capabilities this page has — apply the search and
        choose whose material. No source switch: the cloud is the page's only source, and a drill-down hides the bar
        because the group is the filter. The line never wraps: at 268px the search field keeps a width (min-w-0 flex-1)
        and a button is 28px, never a label pushed under its own control. */}
    {showFilters && <div data-filter-bar="" role="group" aria-label={copy.filters} className="flex h-7 min-w-0 items-center gap-1">
      <form onSubmit={event => {event.preventDefault(); controller.setFilters({search}); if (viewMode !== 'videos') writeViewMode('videos');}}
        className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md bg-[var(--bg-field)] px-2 text-[var(--text-faint)] focus-within:ring-1 focus-within:ring-[var(--accent)]">
        <Search size={13} aria-hidden className="shrink-0" />
        <input data-filter="search" value={search} maxLength={128} aria-label={copy.search} placeholder={copy.searchHint}
          onChange={event => setSearch(event.target.value)}
          className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--text)] outline-none placeholder:text-[var(--text-faint)]" />
        <button type="submit" aria-label={copy.apply} title={copy.apply}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--text-faint)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
          <CornerDownLeft size={12} />
        </button>
      </form>
      {/* Whose material: the one scope this page has, as an icon button and a two-item menu — a full-width select was
          the control that ate the row in the drawer's column. */}
      <div data-author="" ref={authorBox} className="relative shrink-0">
        <button type="button" data-filter="author" data-action="author-menu" data-author-value={authorValue(filters)}
          aria-haspopup="menu" aria-expanded={authorOpen} aria-label={copy.author + '：' + authorName}
          title={copy.author + '：' + authorName} onClick={() => setAuthorOpen(open => !open)}
          className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
          <User size={14} />
        </button>
        {authorOpen && <div role="menu" data-author-menu="" className="absolute right-0 top-8 z-20 w-48 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-panel)] py-1 text-[12px] shadow-lg">
          <button type="button" role="menuitemradio" data-author-option="cloud:own" aria-checked={authorValue(filters) === 'cloud:own'}
            value="cloud:own" disabled={!ownAvailable} title={ownAvailable ? undefined : copy.ownNeedsBinding}
            onClick={() => { controller.setFilters(authorFrom('cloud:own')); setAuthorOpen(false); }}
            className={authorOption}>{copy.authorOwn}</button>
          <button type="button" role="menuitemradio" data-author-option="cloud:company" aria-checked={authorValue(filters) === 'cloud:company'}
            value="cloud:company"
            onClick={() => { controller.setFilters(authorFrom('cloud:company')); setAuthorOpen(false); }}
            className={authorOption}>{copy.authorCompany}</button>
        </div>}
      </div>
    </div>}

    {focused && <p data-note="hover" className="text-[11px] text-[var(--text-muted)]">{focused.name}</p>}
    {studioRetrying && <p role="status" data-note="studio-retrying" className="rounded border border-[var(--border)] bg-[var(--bg-panel)] px-2 py-1 text-[12px]">{copy.studioSessionRetrying}</p>}
    {view.cloud.state === 'unavailable' && !studioRetrying && <p role="status" data-note="cloud" className="rounded border border-[var(--border)] bg-[var(--bg-panel)] px-2 py-1 text-[12px]">
      {failureCopy(copy, state.failure)}
      <button type="button" data-action="retry-cloud" onClick={() => void controller.retry()} className="ml-2 underline">{copy.retry}</button>
    </p>}
    {state.useNotice && <p role="status" data-note="use" className="rounded border border-[var(--border)] bg-[var(--bg-panel)] px-2 py-1 text-[12px]">{state.useNotice}</p>}
    {state.useError && <p role="alert" data-note="use-error" className="flex flex-wrap items-center gap-2 rounded border border-[var(--border)] bg-[var(--bg-panel)] px-2 py-1 text-[12px]">
      <span data-use-error={state.useError.code}>{useFailureCopy(copy, state.useError.kind, state.useError.code)}</span>
      {state.useError.kind !== 'unsupported' && state.useError.kind !== 'forbidden' && state.lastUse && <button type="button" data-action="retry-use" onClick={() => void controller.use(state.lastUse!)} className="rounded border border-[var(--border)] px-2 py-0.5 text-[11px] hover:bg-[var(--bg-hover)]">{copy.retryUse}</button>}
    </p>}
    {/* A 200 whose rows were all dropped is a filtered page: the way to the company view must be there whoever else is
        still listed, so the notice does not wait for an empty list. */}
    {view.filteredEmpty
      ? <p role="status" data-state="empty" data-note="filtered-empty" className="flex flex-wrap items-center gap-2 rounded border border-[var(--border)] bg-[var(--bg-panel)] px-2 py-1 text-[12px]">
        <span>{state.filteredNotice ?? copy.filteredEmpty(view.filteredEmpty.dropped)}</span>
        <button type="button" data-action="switch-company" onClick={() => controller.setFilters({author: 'company'})} className="rounded border border-[var(--border)] px-2 py-0.5 text-[11px] hover:bg-[var(--bg-hover)]">{copy.switchToCompany}</button>
      </p>
      : <>
        {state.filteredNotice && <p role="status" data-note="filtered" className="rounded border border-[var(--border)] bg-[var(--bg-panel)] px-2 py-1 text-[12px]">{state.filteredNotice}</p>}
        {view.empty !== 'none' && view.cloud.state !== 'loading' && <p role="status" data-state="empty" className="text-[13px]">{emptyWord(copy, view.empty)} {state.shortPageNote ?? ''}</p>}
      </>}
    {state.status === 'unauthorized' && <p role="alert" data-state="unauthorized" className="rounded border border-[var(--border)] px-3 py-2 text-[13px]">{copy.unauthorized}</p>}
    {view.cloud.state === 'loading' && view.entries.length === 0 && <p role="status" data-state="loading" className="text-[13px]">{copy.loading}</p>}

    {/* The notes of one material: read when opened (the cache answers a second open), never on render. */}
    {wiki && wikiFor && <WikiPanel cache={wiki} videoId={wikiFor} copy={wikiCopy}
      onClose={() => setWikiFor(null)}
      onUseClip={() => { void controller.use(wikiFor); }} />}

    {(viewMode === 'products')
      ? (index.state === 'ready' ? <ProductFolders copy={copy} tree={index.index} renderEntries={renderGroupEntries} list={list} /> : <p className="text-[12px] text-[var(--text-muted)]">{copy.indexEmpty}</p>)
      : (viewMode === 'collections')
      ? <CollectionsView copy={copy} index={index} entries={view.entries} page={groupReader} renderEntries={renderGroupEntries} covers={coverStore} />
      : (state.view === 'cards' ? wall(view.entries) : view.entries.length === 0 ? null : <div data-view-pane="list" className="overflow-x-auto rounded-xl border border-[var(--border)]">
        <table className="w-full text-left">
          <thead className="text-[11px] text-[var(--text-muted)]">
            <tr><th className="p-2">{copy.select}</th><th className="p-2">{copy.title}</th><th className="p-2">{copy.source}</th><th className="p-2">{copy.author}</th><th className="p-2">{copy.created}</th><th className="p-2">{copy.duration}</th><th className="p-2">{copy.size}</th><th className="p-2">{copy.labels}</th><th className="p-2">{copy.downloads}/{copy.collects}</th><th className="p-2" /></tr>
          </thead>
          <tbody>
            {view.entries.map(entry => <MaterialListRow key={entry.id} {...cardProps(entry)} />)}
          </tbody>
        </table>
      </div>)}

    {/* The supplier's pager belongs to the video wall and sits at its foot, on a row of its own under a hairline: 合集 is
        the whole index read as one tree, so it has no page of its own and no pager at all. A line that says only where the
        page is — the internal note about short pages is not the person's business. */}
    {viewMode === 'videos' && view.pager && <div data-page-block="" role="group" aria-label={copy.page(state.pageNo)}
      className="flex flex-wrap items-center justify-center gap-2 border-t border-[var(--border)] pt-2 text-[12px]">
      <button type="button" data-action="previous" disabled={state.pageNo <= 1} onClick={() => controller.setPage(state.pageNo - 1)} className="rounded border border-[var(--border)] px-2 py-1 disabled:opacity-40">{copy.previous}</button>
      <span data-field="pageNo" className="tabular-nums text-[var(--text-muted)]">{copy.page(state.pageNo)}</span>
      <button type="button" data-action="next" disabled={!state.hasMore} onClick={() => controller.setPage(state.pageNo + 1)} className="rounded border border-[var(--border)] px-2 py-1 disabled:opacity-40">{copy.next}</button>
      {state.hasMore && <span data-note="more" className="text-[var(--text-muted)]">{copy.more}</span>}
    </div>}

    {detail && <MaterialDetail entry={detail} copy={copy} now={at}
      selected={draftSelected(draft, detail)}
      canSelect={draftReady && detail.draft !== null && !pendingDraft.has(detail.id)}
      canUse={detail.card !== null && !deniedNow.has(detail.card.videoId)}
      useLabel={detail.card && deniedNow.has(detail.card.videoId) ? useFailureCopy(copy, 'forbidden', deniedDownloads.codeOf(detail.card.videoId) ?? undefined) : copy.download}
      usePending={state.usePending === detail.card?.videoId}
      tagPath={tagPathOf(detail.name)}
      onClose={() => setDetailFor(null)}
      onToggleSelect={toggle}
      onUse={useEntry}
      {...(wiki && detail.source === 'cloud' && detail.card ? {onWiki: (videoId: string) => setWikiFor(current => (current === videoId ? null : videoId)), wikiOpen: wikiFor === detail.card.videoId} : {})} />}
    </div>
  </section>;
}
