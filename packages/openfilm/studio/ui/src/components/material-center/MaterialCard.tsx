// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import type {DragEvent} from 'react';
import type {MaterialCopy} from '@/lib/material-center/copy';
import type {LibraryEntry} from '@/lib/material-center/library';
import {formatDuration, formatFileSize, relativeTime} from '@/lib/material-center/model';
import {clearResourceDrag, dragPicture, setResourceDragData} from '@/lib/resource-drag';
import {LazyCover} from './LazyCover.tsx';

export type MaterialCardViewProps = {
  readonly entry: LibraryEntry;
  readonly copy: MaterialCopy;
  /** Injected so a card's words do not depend on the machine's clock at render time (and tests can fix it). */
  readonly now: number;
  /** In the batch draft already (one selection model for both sources). */
  readonly selected: boolean;
  readonly hovered: boolean;
  readonly usePending: boolean;
  /** Whether selecting it can be recorded (the draft bridge may be unavailable, and some files cannot be batched). */
  readonly canSelect: boolean;
  /** Whether the one costed action is offered (a cloud use handler, or a local insert handler). */
  readonly canUse: boolean;
  /** What the one action is called for this source: 下载 / 加到当前工程 / 加入时间线. */
  readonly useLabel: string;
  /** Why the action is greyed out, when it is (the reason a person can read). */
  readonly useTitle?: string;
  /**
   * The material-center's small card (the drawer's tile grid): a cover, one status dot and a one-line name; the actions
   * wait under the pointer. Every `data-*` the full card carries is still here - the words that were a row are kept in
   * the card and not drawn.
   */
  readonly dense?: boolean;
  /** Looking only. It records what the pointer is over; it cannot reach a network. */
  readonly onHover: (id: string | null) => void;
  readonly onToggleSelect: (id: string) => void;
  /** The one costed action: one call per click, on the button alone. For a local entry: put it on the timeline. */
  readonly onUse: (id: string) => void;
  /** The wiki's entry: asks the page to open this material's notes (the page reads them, lazily). */
  readonly onWiki?: (videoId: string) => void;
  readonly wikiOpen?: boolean;
  /** Opening the material itself (the detail sheet). Looking closer is not the costed action, so it is its own press. */
  readonly onOpen?: (id: string) => void;
};

const kindWord = (copy: MaterialCopy, entry: LibraryEntry): string | null => {
  if (entry.localKind === 'video') return copy.kindVideo;
  if (entry.localKind === 'image') return copy.kindImage;
  if (entry.localKind === 'audio') return copy.kindAudio;
  if (entry.localKind === 'page') return copy.kindPage;
  if (entry.localKind === 'other') return copy.kindOther;
  return null;
};

/**
 * A cloud card is the one thing here that can be dragged onto a track. Its file is not in the project, so the drop is a
 * download first and a clip after (`lib/clip-download`, ProjectView's drop): the drag carries the id to download and the
 * cover already on screen, and a stand-in path (named after the id) so the timeline can draw where it will land. A card
 * with no supplier row behind it has nothing to download and is not draggable.
 */
const dragProps = (entry: LibraryEntry) => {
  /* the supplier row the entry already carries (as the wiki button reads it), never a row of the card's own */
  if (entry.source !== 'cloud' || !entry.card) return {} as const;
  return {
    draggable: true,
    onDragStart: (event: DragEvent<HTMLElement>) => {
      event.dataTransfer.effectAllowed = 'copy';
      setResourceDragData(event.dataTransfer, {
        path: 'assets/materials/' + entry.card!.videoId + '.mp4',
        name: entry.name,
        kind: 'video',
        ...(entry.durationSeconds ? {durationMs: Math.round(entry.durationSeconds * 1000)} : {}),
        material: {
          videoId: entry.card!.videoId,
          ...(typeof entry.card!.videoType === 'number' ? {videoType: entry.card!.videoType} : {}),
          ...(entry.cover ? {cover: entry.cover} : {}),
        },
      });
      dragPicture(event);
    },
    onDragEnd: () => clearResourceDrag(),
  };
};

/* the drawer's own tile action (MediaPool's grid sets the column; this is the button on it) */
const SMALL_ACTION = 'flex h-5 w-5 items-center justify-center rounded bg-[var(--bg-panel)]/85 text-[11px] leading-none text-[var(--text)] ring-1 ring-[var(--border)] hover:bg-[var(--bg-hover)] disabled:opacity-40';

/** One material, from either source: cover, its badges, title, author, time, length, size, its two actions. */
export function MaterialCardView({entry, copy, now, selected, hovered, usePending, canSelect, canUse, useLabel, useTitle, dense = false, onHover, onToggleSelect, onUse, onWiki, wikiOpen, onOpen}: MaterialCardViewProps) {
  const type = entry.typeLabel ?? kindWord(copy, entry);
  const sourceWord = entry.source === 'cloud' ? copy.cloudNotDownloaded : entry.source === 'library' ? copy.sourceLibrary : copy.projectEntry;
  /* the one costed action: one button, one call site, drawn by both cards */
  const useButton = (className: string, text: string) => <button
    type="button"
    data-action="use"
    disabled={usePending || !canUse}
    title={useTitle ?? useLabel}
    aria-busy={usePending}
    onClick={() => onUse(entry.id)}
    className={className}
  >{usePending ? copy.using : text}</button>;

  if (dense) return <article
    data-material-card={entry.id}
    data-source={entry.source}
    data-hovered={hovered ? 'true' : 'false'}
    data-dense="true"
    {...dragProps(entry)}
    onPointerEnter={() => onHover(entry.id)}
    onPointerLeave={() => onHover(null)}
    onFocus={() => onHover(entry.id)}
    onBlur={() => onHover(null)}
    className={'group flex min-w-0 flex-col gap-1'}
  >
    <div className={'relative aspect-video overflow-hidden rounded-md bg-[var(--bg-hover)] ring-1 transition ' + (selected ? 'ring-[var(--text)]' : 'ring-[var(--border)] group-hover:ring-[var(--border-strong)]')}>
      <LazyCover src={entry.cover} label={copy.noCover} className="h-full w-full" />
      <button
        type="button"
        data-action="select"
        disabled={!canSelect}
        aria-pressed={selected}
        aria-label={copy.select}
        title={copy.select}
        onClick={() => onToggleSelect(entry.id)}
        className={SMALL_ACTION + ' absolute left-1 top-1 ' + (selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100')}
      >{selected ? '✓' : '+'}</button>
      {entry.state && <span
        data-badge="state"
        title={entry.state.name}
        aria-label={entry.state.name}
        className="pointer-events-none absolute right-1.5 top-1.5 h-2 w-2 rounded-full ring-1 ring-black/40"
        style={{backgroundColor: entry.state.backgroundColor ?? entry.state.frontColor ?? 'var(--text)'}}
      />}
      <div className="absolute inset-x-1 bottom-1 flex items-center justify-end gap-1 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
        {onWiki && entry.source === 'cloud' && entry.card && <button type="button" data-action="open-wiki" aria-pressed={wikiOpen === true} title={copy.wiki} aria-label={copy.wiki} onClick={() => onWiki(entry.card!.videoId)} className={SMALL_ACTION}>✎</button>}
        {useButton(SMALL_ACTION, '↓')}
      </div>
    </div>
    <span className="min-w-0 truncate text-[12px] font-medium">
      <button type="button" data-action="open-detail" title={entry.name + ' · ' + sourceWord} onClick={() => onOpen?.(entry.id)} className="max-w-full truncate text-left">{entry.name}</button>
    </span>
    {/* the words the full card draws as a row: kept in the card, not drawn */}
    <p className="sr-only">
      <span data-badge="source">{sourceWord}</span>
      {type && <span data-badge="video-type">{type}</span>}
      {entry.badges.map((badge, index) => <span key={badge.kind + index} data-badge={badge.kind}>{badge.text}</span>)}
      <span data-field="author">{entry.author ?? copy.authorUnknown}</span>
      <span data-field="created">{relativeTime(entry.createdAtMs, now)}</span>
      <span data-field="duration">{formatDuration(entry.durationSeconds)}</span>
      <span data-field="size">{formatFileSize(entry.sizeBytes)}</span>
      {entry.source === 'cloud' && <><span data-count="download">{copy.downloads} {entry.downloads ?? '—'}</span><span data-count="collect">{copy.collects} {entry.collects ?? '—'}</span></>}
    </p>
  </article>;

  return <article
    data-material-card={entry.id}
    data-source={entry.source}
    data-hovered={hovered ? 'true' : 'false'}
    {...dragProps(entry)}
    onPointerEnter={() => onHover(entry.id)}
    onPointerLeave={() => onHover(null)}
    onFocus={() => onHover(entry.id)}
    onBlur={() => onHover(null)}
    className={'flex flex-col overflow-hidden rounded-xl border bg-[var(--bg-panel)] ' + (selected ? 'border-[var(--text)]' : 'border-[var(--border)]')}
  >
    <div className="relative aspect-video">
      <LazyCover src={entry.cover} label={copy.noCover} className="h-full w-full" />
      <button
        type="button"
        data-action="select"
        disabled={!canSelect}
        aria-pressed={selected}
        aria-label={copy.select}
        onClick={() => onToggleSelect(entry.id)}
        className="absolute left-2 top-2 rounded bg-[var(--bg-panel)]/90 px-2 py-1 text-[11px] disabled:opacity-40"
      >{selected ? '✓' : copy.select}</button>
      {entry.state && <span
        data-badge="state"
        className="absolute right-2 top-2 rounded px-2 py-1 text-[11px]"
        style={{color: entry.state.frontColor ?? 'var(--text)', backgroundColor: entry.state.backgroundColor ?? 'var(--bg-hover)'}}
      >{entry.state.name}</span>}
    </div>
    <div className="flex flex-1 flex-col gap-2 p-3">
      <h3 className="line-clamp-2 text-[13px] font-medium">
        <button type="button" data-action="open-detail" title={entry.name} onClick={() => onOpen?.(entry.id)} className="text-left">{entry.name}</button>
      </h3>
      <div className="flex flex-wrap gap-1 text-[11px] text-[var(--text-muted)]">
        <span data-badge="source" className={'rounded border px-1.5 py-0.5 ' + (entry.source === 'cloud' ? 'border-[var(--border)]' : 'border-dashed border-[var(--border)]')}>{sourceWord}</span>
        {type && <span data-badge="video-type" className="rounded border border-[var(--border)] px-1.5 py-0.5">{type}</span>}
        {entry.badges.map((badge, index) => <span key={badge.kind + index} data-badge={badge.kind} className="rounded border border-[var(--border)] px-1.5 py-0.5">{badge.text}</span>)}
      </div>
      <p className="text-[12px] text-[var(--text-muted)]">
        <span data-field="author">{entry.author ?? copy.authorUnknown}</span>
        {' · '}
        <span data-field="created">{relativeTime(entry.createdAtMs, now)}</span>
        {' · '}
        <span data-field="duration">{formatDuration(entry.durationSeconds)}</span>
        {' · '}
        <span data-field="size">{formatFileSize(entry.sizeBytes)}</span>
      </p>
      <div className="mt-auto flex items-center gap-3 text-[12px]">
        {entry.source === 'cloud'
          ? <>
            <span data-count="download">{copy.downloads} {entry.downloads ?? '—'}</span>
            <span data-count="collect">{copy.collects} {entry.collects ?? '—'}</span>
          </>
          : <span data-count="local" className="text-[var(--text-muted)]">{entry.source === 'library' ? copy.sourceLibrary : copy.projectEntry}</span>}
        {onWiki && entry.source === 'cloud' && entry.card && <button type="button" data-action="open-wiki" aria-pressed={wikiOpen === true} onClick={() => onWiki(entry.card!.videoId)} className="rounded border border-[var(--border)] px-2 py-1 text-[12px] hover:bg-[var(--bg-hover)]">{copy.wiki}</button>}
        {useButton('ml-auto rounded border border-[var(--border)] px-2 py-1 text-[12px] hover:bg-[var(--bg-hover)] disabled:opacity-40', useLabel)}
      </div>
    </div>
  </article>;
}
