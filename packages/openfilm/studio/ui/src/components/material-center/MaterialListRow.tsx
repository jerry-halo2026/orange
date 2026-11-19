// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import type {MaterialCopy} from '@/lib/material-center/copy';
import type {LibraryEntry} from '@/lib/material-center/library';
import {formatDuration, formatFileSize, relativeTime} from '@/lib/material-center/model';
import {LazyCover} from './LazyCover.tsx';
import type {MaterialCardViewProps} from './MaterialCard.tsx';

/** A row shows exactly what a card shows, so it takes exactly what a card takes. */
export type MaterialListRowProps = MaterialCardViewProps;

const kindWord = (copy: MaterialCopy, entry: LibraryEntry): string | null => {
  if (entry.localKind === 'video') return copy.kindVideo;
  if (entry.localKind === 'image') return copy.kindImage;
  if (entry.localKind === 'audio') return copy.kindAudio;
  if (entry.localKind === 'page') return copy.kindPage;
  if (entry.localKind === 'other') return copy.kindOther;
  return null;
};

/** The same material as a table row: same fields, same two actions, same "looking costs nothing" rule. */
export function MaterialListRow({entry, copy, now, selected, hovered, usePending, canSelect, canUse, useLabel, useTitle, onHover, onToggleSelect, onUse, onWiki, wikiOpen, onOpen}: MaterialListRowProps) {
  const type = entry.typeLabel ?? kindWord(copy, entry);
  return <tr
    data-material-row={entry.id}
    data-source={entry.source}
    data-hovered={hovered ? 'true' : 'false'}
    onPointerEnter={() => onHover(entry.id)}
    onPointerLeave={() => onHover(null)}
    onFocus={() => onHover(entry.id)}
    onBlur={() => onHover(null)}
    className={selected ? 'bg-[var(--bg-hover)]' : ''}
  >
    <td className="p-2">
      <button type="button" data-action="select" disabled={!canSelect} aria-pressed={selected} aria-label={copy.select} onClick={() => onToggleSelect(entry.id)} className="rounded border border-[var(--border)] px-2 py-0.5 text-[11px] disabled:opacity-40">{selected ? '✓' : copy.select}</button>
    </td>
    <td className="max-w-[520px] p-2">
      <div className="flex items-center gap-2">
        <LazyCover src={entry.cover} label={copy.noCover} className="h-8 w-14 shrink-0 overflow-hidden rounded" />
        <button type="button" data-action="open-detail" className="line-clamp-1 text-left text-[13px]" title={entry.name} onClick={() => onOpen?.(entry.id)}>{entry.name}</button>
      </div>
    </td>
    <td className="p-2 text-[12px] text-[var(--text-muted)]" data-field="source">{entry.source === 'cloud' ? copy.cloudNotDownloaded : entry.source === 'library' ? copy.sourceLibrary : copy.projectEntry}</td>
    <td className="p-2 text-[12px] text-[var(--text-muted)]" data-field="author">{entry.author ?? copy.authorUnknown}</td>
    <td className="p-2 text-[12px] text-[var(--text-muted)]" data-field="created">{relativeTime(entry.createdAtMs, now)}</td>
    <td className="p-2 text-[12px] text-[var(--text-muted)]" data-field="duration">{formatDuration(entry.durationSeconds)}</td>
    <td className="p-2 text-[12px] text-[var(--text-muted)]" data-field="size">{formatFileSize(entry.sizeBytes)}</td>
    <td className="p-2 text-[11px]">
      {type && <span data-badge="video-type" className="mr-1 rounded border border-[var(--border)] px-1.5 py-0.5">{type}</span>}
      {entry.badges.map((badge, index) => <span key={badge.kind + index} data-badge={badge.kind} className="mr-1 rounded border border-[var(--border)] px-1.5 py-0.5">{badge.text}</span>)}
      {entry.state && <span data-badge="state" className="rounded px-1.5 py-0.5" style={{color: entry.state.frontColor ?? 'var(--text)', backgroundColor: entry.state.backgroundColor ?? 'var(--bg-hover)'}}>{entry.state.name}</span>}
    </td>
    <td className="p-2 text-[12px]">
      {entry.source === 'cloud'
        ? <><span data-count="download">{entry.downloads ?? '—'}</span> / <span data-count="collect">{entry.collects ?? '—'}</span></>
        : <span data-count="local" className="text-[var(--text-muted)]">{entry.source === 'library' ? copy.sourceLibrary : copy.projectEntry}</span>}
    </td>
    <td className="p-2 text-right">
      {onWiki && entry.source === 'cloud' && entry.card && <button type="button" data-action="open-wiki" aria-pressed={wikiOpen === true} onClick={() => onWiki(entry.card!.videoId)} className="mr-1 rounded border border-[var(--border)] px-2 py-1 text-[12px] hover:bg-[var(--bg-hover)]">{copy.wiki}</button>}
      <button type="button" data-action="use" disabled={usePending || !canUse} title={useTitle} aria-busy={usePending} onClick={() => onUse(entry.id)} className="rounded border border-[var(--border)] px-2 py-1 text-[12px] disabled:opacity-40">{usePending ? copy.using : useLabel}</button>
    </td>
  </tr>;
}
