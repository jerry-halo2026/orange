// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The two words a clip says while its file is not here yet, and the ring that says it is still coming.
 *
 * Drawn by the timeline over the clip's picture band (see `lib/clip-download`): a material dropped on a track shows the
 * cover it already had, a turning ring and 「正在下载」; when the file lands the clip's own first frame / thumbnails are
 * behind it, and a check marks the moment (the badge leaves on its own shortly after); a failure keeps a red line with the
 * reason, so a clip can never turn forever.
 *
 * The state is on the element (`data-state`) as well as on the clip around it, so a run can read the transition from the
 * badge alone: `downloading → ready`, or `downloading → failed`.
 */
import * as React from 'react';
import {downloadsOf, subscribeDownloads, type ClipDownload} from '@/lib/clip-download';
import {useT} from '@/i18n';

/** Every clip's state, one subscription for a whole timeline (the store object is stable between changes). */
export function useClipDownloads(): ReadonlyMap<string, ClipDownload> {
  return React.useSyncExternalStore(subscribeDownloads, downloadsOf, downloadsOf);
}

export type ClipDownloadBadgeProps = {
  /** What that clip is doing, if anything. `undefined` draws nothing at all (an ordinary clip). */
  readonly download: ClipDownload | undefined;
  /** A clip wide enough for a sentence; a narrow one keeps the ring (or the failure mark) only. */
  readonly wide?: boolean;
  /** Where the picture band starts, so the badge covers the pictures and not the clip's name. */
  readonly top?: number;
};

export function ClipDownloadBadge({download, wide = true, top = 0}: ClipDownloadBadgeProps) {
  const t = useT();
  if (!download) return null;
  const state = download.state;
  return <span
    data-clip-download=""
    data-state={state}
    {...(state === 'failed' ? {role: 'alert'} : {role: 'status'})}
    className="pointer-events-none absolute inset-x-0 bottom-0 z-[3] flex items-center justify-center gap-1.5 overflow-hidden"
    style={{top}}
  >
    {/* the picture already known for it: a supplier cover (a material has one before its file does) */}
    {download.cover ? <img data-clip-cover="" src={download.cover} alt="" draggable={false}
      className="absolute inset-0 h-full w-full object-cover opacity-55" /> : null}
    {state === 'downloading' ? (
      <>
        <span data-clip-spinner="" aria-hidden
          className="relative h-2.5 w-2.5 shrink-0 animate-spin rounded-full border border-white/70 border-t-transparent" />
        {wide ? <span className="relative truncate px-1 text-[11px] font-medium text-white/90">{t('timeline.downloading')}</span> : null}
      </>
    ) : state === 'failed' ? (
      <>
        <span data-clip-failed-mark="" aria-hidden className="relative shrink-0 text-[11px] leading-none text-[#ffb4b4]">!</span>
        <span className="relative truncate px-1 text-[11px] font-medium text-[#ffd7d7]">
          {t('timeline.downloadFailed')}{download.reason ? ' · ' + download.reason : ''}
        </span>
      </>
    ) : (
      <span data-clip-ready="" aria-hidden className="relative text-[11px] leading-none text-white/85">✓</span>
    )}
  </span>;
}
