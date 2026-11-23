// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * One material library, one catalogue: the supplier's rows, as the entries the page draws.
 *
 * **The material centre holds cloud material only.** The open project's `assets/` is the project's own body, not
 * material, and a file of the Saved library is where a download *lands* — neither is a source of this page, and this
 * module no longer builds an entry from either of them. That is the difference between "the page shows one source"
 * and "the source no longer produces the entries at all": there is no `localEntry` / `libraryEntry` left to call, so a
 * second caller cannot reintroduce them without writing the branch again on purpose.
 *
 * What a name has to be: material (`media.ts`). A video or a picture is material; a subtitle (`.vtt/.srt/.ass`) is a
 * 字幕轨's input and never a card here; any other text is not handled at all. A name with no extension is material —
 * the supplier's own names carry none, and their class is its `videoType`.
 *
 * The rules the model keeps:
 *  - a cloud entry says 云端未下载 until it has been downloaded; the download lands in Saved, which is the drawer's
 *    收藏 tab, and 用到工程 is a separate action taken there;
 *  - the material centre never falls back to another source: an unreachable cloud says so, it does not fill the page
 *    with the project's files.
 */
import {categoryBadges, videoTypeLabel, type MaterialCard} from './model.ts';
import {scopeParam, type ScopeChoice} from './contract.ts';
import type {MaterialFilters} from './filters.ts';
import {isMaterialName} from './media.ts';
import {cloudMaterialDraft, materialDraftKey, type MaterialDraftReference} from '../material-draft.ts';

/** The kinds a project file used to be given; kept as the model's own vocabulary, never produced here. */
export const LOCAL_KINDS = Object.freeze(['video', 'image', 'audio', 'page', 'other'] as const);
export type LocalKind = (typeof LOCAL_KINDS)[number];

/** A classification badge a supplier row carries; the two levels and its labels, in the supplier's own words. */
export type LibraryBadge = {readonly kind: 'one-level' | 'two-level' | 'label'; readonly text: string};

/** One thing a person can pick: always a supplier row, since the centre has no other source. */
export type LibraryEntry = {
  /** `cloud`: a supplier row. The union is kept for the card that draws it; nothing here makes the other two. */
  readonly source: 'local' | 'cloud' | 'library';
  /** Unique in the list: `cloud:<videoId>`. */
  readonly id: string;
  readonly name: string;
  /** The supplier's cover **as the server gave it** (already a loopback proxy url). */
  readonly cover: string | null;
  /** The supplier's class name. */
  readonly typeLabel: string | null;
  readonly badges: readonly LibraryBadge[];
  readonly state: {readonly name: string; readonly frontColor: string | null; readonly backgroundColor: string | null} | null;
  readonly author: string | null;
  readonly createdAtMs: number | null;
  readonly durationSeconds: number | null;
  readonly sizeBytes: number | null;
  readonly downloads: string | null;
  readonly collects: string | null;
  readonly localKind: LocalKind | null;
  /** Kept `null` always: no entry of this page comes from a project's `assets/`. */
  readonly localPath: string | null;
  /** Kept `null` always: the Saved library is the drawer's 收藏 tab, not a source of this page. */
  readonly savedPath: string | null;
  /** What selecting this entry adds to the batch draft; `null` when it cannot be part of a batch. */
  readonly draft: MaterialDraftReference | null;
  /** True for a cloud row: it is metadata and a cover until it has been downloaded. */
  readonly pendingDownload: boolean;
  /** The supplier row, for the one costed action (`use/download`). */
  readonly card: MaterialCard | null;
};

const aDate = (value: number | null): number | null => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null);

/** A supplier row as the same entry. Its cover is the server's url, untouched: the UI never builds a CDN address. */
export function cloudEntry(card: MaterialCard): LibraryEntry {
  const badges: LibraryBadge[] = categoryBadges(card).map((text, index) => ({kind: index === 0 ? 'one-level' as const : 'two-level' as const, text}));
  for (const label of card.videoLabels.slice(0, 2)) badges.push({kind: 'label', text: label.name});
  return {
    source: 'cloud',
    id: 'cloud:' + card.videoId,
    name: card.title,
    cover: card.coverUrl,
    typeLabel: videoTypeLabel(card.videoType),
    badges,
    state: card.videoState ? {name: card.videoState.name, frontColor: card.videoState.frontColor, backgroundColor: card.videoState.backgroundColor} : null,
    author: card.accountName,
    createdAtMs: aDate(card.createdAtMs),
    durationSeconds: card.durationSeconds,
    sizeBytes: card.fileSizeBytes,
    downloads: card.downloadCount,
    collects: card.collectCount,
    localKind: null,
    localPath: null,
    savedPath: null,
    draft: cloudMaterialDraft(card.videoId, card.title),
    pendingDownload: true,
    card,
  };
}

export function cloudEntries(cards: readonly MaterialCard[] | null | undefined): readonly LibraryEntry[] {
  return (cards ?? []).map(cloudEntry);
}

/** The folder of the Saved library a file sits in (`saved/云素材/a.mp4` → `云素材`; `saved/a.mp4` → `''`). */
export function libraryFolderOf(path: string | null): string {
  const parts = (path ?? '').split('/');
  return parts[0] === 'saved' && parts.length > 2 ? parts.slice(1, -1).join('/') : '';
}

export function entrySearchMatches(entry: LibraryEntry, search: string): boolean {
  const text = search.trim().toLocaleLowerCase();
  return !text || entry.name.toLocaleLowerCase().includes(text);
}

const number = (raw: string | null | undefined) => (raw === null || raw === undefined ? -1 : Number(raw));
const newer = (a: number | null, b: number | null) => (b ?? -1) - (a ?? -1);

/** The merged list, ordered by the panel's sort. Ties break on the id so a re-render cannot reorder the list. */
export function sortEntries(entries: readonly LibraryEntry[], sort: MaterialFilters['sort']): readonly LibraryEntry[] {
  const ordered = [...entries];
  ordered.sort((a, b) => {
    if (sort === 'newest') return newer(a.createdAtMs, b.createdAtMs) || a.id.localeCompare(b.id);
    if (sort === 'downloads') return number(b.downloads) - number(a.downloads) || a.id.localeCompare(b.id);
    if (sort === 'collected') return number(b.collects) - number(a.collects) || a.id.localeCompare(b.id);
    return a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id);
  });
  return ordered;
}

/** Why the cloud half says nothing, in the page's own terms. */
export type CloudReason = 'service' | 'provider' | 'auth' | 'fault';

export function cloudReasonOf(failure: {readonly status: number; readonly code?: string} | null): CloudReason | null {
  if (!failure) return null;
  const code = failure.code ?? '';
  if (failure.status === 501 || code === 'material-service-unavailable') return 'service';
  /* A 401 is the session, not the material: the same "auth" tier as a 403, so the page can say "sign in". */
  if (failure.status === 401 || failure.status === 403 || code === 'authentication-required' || code === 'authorization-denied') return 'auth';
  if (code.startsWith('provider-')) return 'provider';
  return 'fault';
}

/** What the controller knows that the merged view needs (the page passes its state through unchanged). */
export type LibraryState = {
  readonly filters: MaterialFilters;
  readonly cards: readonly MaterialCard[];
  readonly loading: boolean;
  readonly failure: {readonly status: number; readonly code?: string} | null;
  readonly hasMore: boolean;
  readonly pageNo: number;
  /** The page as the supplier answered it (for the "empty because the authorization layer dropped rows" case). */
  readonly page?: {readonly items: readonly unknown[]; readonly filtered: {readonly inspected: number; readonly dropped: number}} | null;
};

/** A page that answered 200 with no rows because the authorization layer dropped every one of them. */
export type FilteredEmpty = {readonly inspected: number; readonly dropped: number};

/**
 * The authorization layer emptied this page: the supplier sent rows and every one was dropped. It is not an outage and
 * not a refused request — the person may simply be looking at a scope that sees none of them (`own` before a claim).
 */
export function filteredEmptyOf(state: LibraryState): FilteredEmpty | null {
  const page = state.page;
  if (!page || page.items.length > 0 || page.filtered.dropped <= 0) return null;
  return {inspected: page.filtered.inspected, dropped: page.filtered.dropped};
}

export type LibraryView = {
  /** The cloud page, card by card: the one list the material centre draws. */
  readonly entries: readonly LibraryEntry[];
  /** The project's files and the Saved files are not part of this list, so their counts are always zero. */
  readonly localCount: number;
  readonly cloudCount: number;
  readonly libraryCount: number;
  readonly cloud: {readonly state: 'ok' | 'loading' | 'unavailable'; readonly reason: CloudReason | null};
  readonly empty: 'none' | 'no-cloud' | 'cloud-unavailable';
  /** 200, no rows, and every row dropped by the authorization layer — say "filtered", never "sign in". */
  readonly filteredEmpty: FilteredEmpty | null;
  /** The supplier pager is the supplier's: it stays on screen with the catalogue it pages. */
  readonly pager: boolean;
};

/**
 * The cloud page for the current filters: the supplier's rows and nothing else.
 *
 * Two narrowings happen here, both about what may be *material* at all:
 *  1. the cloud rows are already narrowed by the controller (the page-local filters it can reach);
 *  2. a row whose name is a subtitle (`.vtt/.srt/.ass`) or another text file is dropped — `media.ts` — because a subtitle
 *     is a 字幕轨's input, not a card among the pictures, and the centre holds material only.
 *
 * Nothing here adds the project's files or the Saved library: those are the drawer's 导入 / 收藏 tabs, and the builders
 * that made entries of them are gone (`localEntry` / `libraryEntry` no longer exist).
 */
export function libraryView(state: LibraryState): LibraryView {
  const clouds = state.cards.filter(card => isMaterialName(card.title)).map(cloudEntry);
  const reason = cloudReasonOf(state.failure);
  const cloud = {state: reason ? 'unavailable' as const : state.loading ? 'loading' as const : 'ok' as const, reason};
  const entries = sortEntries(clouds, state.filters.sort);
  const empty: LibraryView['empty'] = entries.length > 0 ? 'none' : reason ? 'cloud-unavailable' : 'no-cloud';
  return {
    entries,
    localCount: 0,
    cloudCount: clouds.length,
    libraryCount: 0,
    cloud,
    empty,
    filteredEmpty: filteredEmptyOf(state),
    pager: true,
  };
}

/** Whether the entry is in the batch draft already (the one selection model both sources share). */
export function draftSelected(draft: readonly MaterialDraftReference[] | null | undefined, entry: LibraryEntry): boolean {
  if (!entry.draft) return false;
  const key = materialDraftKey(entry.draft);
  return (draft ?? []).some(item => materialDraftKey(item) === key);
}

/** The filter that the panel's single "author" control writes: a supplier scope or a local project, never both. */
export type AuthorChoice = {readonly kind: 'cloud'; readonly scope: ScopeChoice} | {readonly kind: 'local'; readonly projectId: string};

export function authorValue(filters: MaterialFilters): string {
  return filters.localProject !== null ? 'local:' + filters.localProject : 'cloud:' + scopeParam(filters.author);
}

export function authorFrom(value: string): Partial<MaterialFilters> {
  if (value.startsWith('local:')) return {localProject: value.slice('local:'.length)};
  const scope = value.slice('cloud:'.length);
  const author: ScopeChoice = scope === 'own' || scope === 'company' ? scope : {accountKey: scope.startsWith('account:') ? scope.slice('account:'.length) : scope};
  return {author, localProject: null};
}

/**
 * What a download costs and what it changes; the host's download handler is the only action here.
 * `result` is whatever the handler resolved with (`{landed, reused, …}`, contract §9), so the page can say whether a
 * material was newly downloaded or was already in the library.
 */
export type TakeResult = {readonly status: 'used' | 'unavailable'; readonly relisted: boolean; readonly result?: unknown};

/**
 * The chain a download runs: the host fetches the material into Saved, and the Saved listing is read again so the
 * drawer's 收藏 tab (and the project, through the take route) shows what actually landed. No other channel exists.
 *
 * A failed download **rejects with the handler's own error**: the library has to say which failure it was (not
 * connected, not allowed, timed out, too large or the wrong type, anything else), so it is not turned into a boolean
 * here. The listing is only read again after a download that actually landed something.
 */
export async function takeMaterial(card: MaterialCard, options: {
  readonly use?: ((card: MaterialCard) => unknown) | null;
  readonly relist?: (() => void | Promise<void>) | null;
}): Promise<TakeResult> {
  const use = options.use;
  if (!use) return {status: 'unavailable', relisted: false};
  const result = await use(card);
  if (!options.relist) return {status: 'used', relisted: false, result};
  try {
    await options.relist();
    return {status: 'used', relisted: true, result};
  } catch {
    return {status: 'used', relisted: false, result};
  }
}

/** Why "add to the current project" cannot be pressed, in the page's own words. */
export type ProjectGateReason = 'no-project' | 'signed-out' | 'service';
export type ProjectGate = {readonly enabled: boolean; readonly reason: ProjectGateReason | null};

/**
 * Whether the one project action is available. A download needs no project (it lands in Saved, contract §9); this
 * action does — and a library listing that came back 403 or 5xx is a second, honest reason to grey it out.
 */
export function projectTakeGate(input: {
  readonly projectId: string | null | undefined;
  readonly signedOut?: boolean;
  readonly serviceDown?: boolean;
}): ProjectGate {
  if (!input.projectId) return {enabled: false, reason: 'no-project'};
  if (input.signedOut) return {enabled: false, reason: 'signed-out'};
  if (input.serviceDown) return {enabled: false, reason: 'service'};
  return {enabled: true, reason: null};
}

export type ProjectTakeResult = {readonly status: 'taken' | 'refused' | 'unavailable'; readonly reason?: ProjectGateReason};

/**
 * Where a download's second hop left the material: the project path it landed on, or why it did not take that hop.
 * `no-landing` is a download whose answer named no `saved/…` path (an older server); `take-failed` is the native route
 * refusing this one file — the download itself still counts, so it is a fallback and never a second failure sentence.
 */
export type DownloadLanding = {
  readonly status: 'taken' | 'refused' | 'unavailable' | 'failed';
  /** The `assets/…` path the take answered with, when it named one; `null` when it did not. */
  readonly path: string | null;
  readonly reason?: ProjectGateReason | 'no-landing' | 'take-failed' | 'claim';
};

/** The `assets/…` place a take answered with (the native `saved/take` route answers `{path}` for a file). */
const projectPathOf = (answer: unknown): string | null => {
  const path = (answer as {path?: unknown} | null)?.path;
  return typeof path === 'string' && path.startsWith('assets/') ? path : null;
};

/**
 * The hop that was missing between a download and the drawer's 导入 list.
 *
 * A download lands in Saved (contract §9) and the 导入 tab lists only the open project's `assets/`, so the file a
 * person just downloaded was nowhere they could use it from: the library entry needed a second, separate press of
 * "加到当前工程" that nothing pointed at. This takes the file the download just landed into the open project by that
 * same native route, so the 导入 list shows it — and it is a fallback in the strict sense: no project means no
 * request, a refused or failed take leaves the download's own result standing, and the Saved copy is never touched.
 */
export async function landDownloadInProject(landed: string | null | undefined, options: {
  readonly projectId: string | null | undefined;
  /** Injected in tests; the host's own gate (a library that refused, a signed-out session) instead of the bare one. */
  readonly gate?: ProjectGate;
  /** The native take: one Saved path in, its `assets/…` place (or anything) out. */
  readonly take?: ((path: string) => unknown) | null;
  /** Add this account to a library another account claimed; resolves false when the person says no. */
  readonly claim?: (() => Promise<boolean>) | null;
  /** The project listing read again, so the merged list shows the new file without a reload. */
  readonly relist?: (() => void | Promise<void>) | null;
}): Promise<DownloadLanding> {
  if (typeof landed !== 'string' || !landed.startsWith('saved/') || landed.split('/').some(part => part === '' || part === '.' || part === '..')) {
    return {status: 'unavailable', path: null, reason: 'no-landing'};
  }
  const gate = options.gate ?? projectTakeGate({projectId: options.projectId});
  if (!gate.enabled) return {status: 'refused', path: null, ...(gate.reason ? {reason: gate.reason} : {})};
  const take = options.take;
  if (!take) return {status: 'unavailable', path: null};
  let answer: unknown;
  try {
    answer = await take(landed);
  } catch (error) {
    const code = (error as {code?: unknown} | null)?.code;
    if ((code === 'saved-access-denied' || code === 'saved-claim-takeover-required') && options.claim) {
      if (!await options.claim()) return {status: 'refused', path: null, reason: 'claim'};
      try { answer = await take(landed); }
      catch { return {status: 'failed', path: null, reason: 'take-failed'}; }
    } else {
      return {status: 'failed', path: null, reason: code === 'saved-access-denied' ? 'claim' : 'take-failed'};
    }
  }
  if (options.relist) {
    try {
      await options.relist();
    } catch {
      /* The file is in `assets/`; the 导入 view reads its own listing again on the folder's event. */
    }
  }
  return {status: 'taken', path: projectPathOf(answer)};
}

/**
 * Take one Saved file into the open project by the native `takeSaved` path (the route imports the file; this never
 * writes a file itself). A refused gate means the call is not made at all — the button being disabled and the handler
 * being called anyway must not become a request.
 */
export async function takeSavedIntoProject(path: string | null, options: {
  readonly gate: ProjectGate;
  readonly take?: ((path: string) => unknown) | null;
}): Promise<ProjectTakeResult> {
  if (!options.gate.enabled) return {status: 'refused', reason: options.gate.reason ?? undefined};
  if (!path || !options.take) return {status: 'unavailable'};
  await options.take(path);
  return {status: 'taken'};
}
