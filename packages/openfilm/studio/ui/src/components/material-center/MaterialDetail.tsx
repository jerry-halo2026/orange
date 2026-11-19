// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * One material, large: the preview, the title, the tag path its name carries, who made it, when, how long, how big —
 * and the same three actions the card offers (download / select / notes), so the detail is a place to look *and* to act.
 *
 * It is a sheet over the page, not a second page: Esc, the back button and a press outside it all close it, and nothing
 * here reads or fetches anything — every value comes from the entry the card already showed.
 */
import React from 'react';
import type {MaterialCopy} from '@/lib/material-center/copy';
import type {LibraryEntry} from '@/lib/material-center/library';
import {formatDuration, formatFileSize, relativeTime} from '@/lib/material-center/model';
import {LazyCover} from './LazyCover.tsx';

export type MaterialDetailProps = {
  readonly entry: LibraryEntry;
  readonly copy: MaterialCopy;
  /** The clock the relative time is read against (the page's, so the card and the sheet agree). */
  readonly now: number;
  readonly selected: boolean;
  readonly canSelect: boolean;
  readonly canUse: boolean;
  readonly useLabel: string;
  readonly usePending: boolean;
  /** `批次 / 合集 / 子合集` as the name spells them; `null` when the name does not follow the pattern. */
  readonly tagPath: readonly string[] | null;
  readonly onClose: () => void;
  readonly onToggleSelect: (id: string) => void;
  readonly onUse: (id: string) => void;
  readonly onWiki?: ((videoId: string) => void) | undefined;
  readonly wikiOpen?: boolean;
};

const button = 'rounded border border-[var(--border)] px-2 py-1 text-[12px] transition hover:bg-[var(--bg-hover)] disabled:opacity-40';

/** The date as the supplier wrote it, or a relative time when it did not: the sheet never invents a date. */
function dateOf(entry: LibraryEntry, now: number): string {
  const written = entry.card?.createTime;
  return written && written.trim() ? written : relativeTime(entry.createdAtMs, now);
}
export function MaterialDetail({
  entry, copy, now, selected, canSelect, canUse, useLabel, usePending, tagPath, onClose, onToggleSelect, onUse, onWiki, wikiOpen,
}: MaterialDetailProps) {
  const close = React.useRef(onClose);
  close.current = onClose;
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return <div data-material-detail={entry.id} role="dialog" aria-modal="true" aria-label={entry.name}
    className="fixed inset-0 z-[10040] grid place-items-center p-6" style={{background: 'rgba(0,0,0,0.55)'}}
    onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <article className="flex max-h-full w-full max-w-[880px] flex-col overflow-hidden rounded-[14px] border border-[var(--border)] bg-[var(--bg-panel)] shadow-[0_24px_64px_-12px_rgba(0,0,0,0.5)]">
      <header className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
        <button type="button" data-action="close-detail" onClick={onClose} className={button}>{copy.detailBack}</button>
        <h2 data-field="detail-title" className="min-w-0 flex-1 truncate text-[13px] font-semibold" title={entry.name}>{entry.name}</h2>
        {onWiki && entry.source === 'cloud' && entry.card && <button type="button" data-action="open-wiki" aria-pressed={wikiOpen === true}
          onClick={() => onWiki(entry.card!.videoId)} className={button}>{copy.wiki}</button>}
        <button type="button" data-action="select" disabled={!canSelect} aria-pressed={selected}
          onClick={() => onToggleSelect(entry.id)} className={button}>{selected ? '✓' : copy.select}</button>
        <button type="button" data-action="use" disabled={usePending || !canUse} aria-busy={usePending}
          onClick={() => onUse(entry.id)} className={button}>{usePending ? copy.using : useLabel}</button>
      </header>
      <div className="relative min-h-0 flex-1 overflow-hidden bg-[var(--bg-hover)]" style={{aspectRatio: '16 / 9'}}>
        <LazyCover src={entry.cover} label={copy.noCover} className="h-full w-full" />
      </div>
      <div className="flex flex-wrap items-start gap-x-6 gap-y-1 px-3 py-2 text-[12px] text-[var(--text-muted)]">
        <span data-field="detail-tag-path" className="min-w-0"><span className="text-[var(--text-faint)]">{copy.detailTagPath}: </span>
          {tagPath && tagPath.length > 0 ? tagPath.join(' / ') : copy.detailNoTagPath}</span>
        <span data-field="detail-author"><span className="text-[var(--text-faint)]">{copy.author}: </span>{entry.author ?? copy.authorUnknown}</span>
        <span data-field="detail-created"><span className="text-[var(--text-faint)]">{copy.created}: </span>{dateOf(entry, now)}</span>
        <span data-field="detail-duration"><span className="text-[var(--text-faint)]">{copy.duration}: </span>{formatDuration(entry.durationSeconds)}</span>
        <span data-field="detail-size"><span className="text-[var(--text-faint)]">{copy.size}: </span>{formatFileSize(entry.sizeBytes)}</span>
      </div>
    </article>
  </div>;
}
