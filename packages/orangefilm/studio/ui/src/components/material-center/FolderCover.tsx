// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * A 合集 (or one of its 子合集) drawn as the drawer's folder card: a 2 × 2 collage of its first four covers, the count in
 * a badge on the cover's foot, and the name under it — the same shape `MediaPool`'s `FolderTile` gives a folder, so a
 * collection reads as a set at a glance instead of as a line of text.
 *
 * The four cells are asked for by a card that is **in view** (`onReveal`), never at render: a card below the fold, a
 * card filtered out and a page nobody scrolls send nothing. Each cell reads the cover route once and draws what its
 * **status** says (`readCover`), so `data-cover` reports it without a network trace:
 *
 *  - `none` — this cell has no cover: fewer than four materials, a row without one, or a **204** from the route (a
 *    supplier host that cannot be reached at all has no image, and that is not a failure);
 *  - `pending` — the card is not in view yet, or the route was asked and has not answered: nothing drawn yet;
 *  - `shown` — the image is in the document, from the bytes this origin's cover route (`/api/materials/cover?url=`)
 *    answered;
 *  - `failed` — the route refused (another host, a url that is not one): the ground stays, and nothing is reported.
 */
import React from 'react';
import {Folder} from 'lucide-react';
import {coverRequestUrl, readCover} from '@/lib/material-center/cover';

export type FolderCoverProps = {
  /** The supplier's cover urls for this card, at most four; the rest of the grid is empty ground. */
  readonly urls: readonly string[];
  /** The count the badge prints (`46`), not a sentence: the card's own line says the rest. */
  readonly count: number;
  /** Asked once, when the card first comes into view (the four rows a collage needs). */
  readonly onReveal?: () => void;
};

/** The cells of every collage: 2 × 2, so a collection with one material and one with four share the same box. */
const CELLS = 4;

const GROUND = 'bg-[var(--bg-hover)]';

function Cell({url, seen}: {url: string | null; seen: boolean}) {
  const [answer, setAnswer] = React.useState<{state: 'idle' | 'none' | 'shown' | 'failed'; href: string | null}>({state: 'idle', href: null});
  /* Another url is another image: what the last one answered says nothing about this one. */
  React.useEffect(() => { setAnswer({state: 'idle', href: null}); }, [url]);
  /* In view: one read of the route; its status is what this cell is (`none` for a 204, never "failed"). */
  const made = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!url || !seen) return undefined;
    const control = new AbortController();
    void readCover(coverRequestUrl(url), {signal: control.signal}).then(
      next => {
        if (control.signal.aborted) { if (next.state === 'shown') URL.revokeObjectURL(next.href); return; }
        if (next.state === 'shown') made.current = next.href;
        setAnswer({state: next.state, href: next.state === 'shown' ? next.href : null});
      },
      () => { if (!control.signal.aborted) setAnswer({state: 'failed', href: null}); },
    );
    return () => {
      control.abort();
      if (made.current) { URL.revokeObjectURL(made.current); made.current = null; }
    };
  }, [url, seen]);

  if (!url) return <span data-cover="none" className={GROUND} />;
  if (!seen) return <span data-cover="pending" data-cover-url={url} className={GROUND} />;
  /* A 204: this url has no image (a host the server cannot reach), which is the placeholder, not a failure. */
  if (answer.state === 'none') return <span data-cover="none" data-cover-url={url} className={GROUND} />;
  if (answer.state === 'failed') return <span data-cover="failed" data-cover-url={url} className={GROUND} />;
  if (answer.state !== 'shown' || !answer.href) return <span data-cover="pending" data-cover-url={url} className={GROUND} />;
  return <span data-cover="shown" data-cover-url={url} className={'relative overflow-hidden ' + GROUND}>
    <img src={answer.href} alt="" decoding="async" className="h-full w-full object-cover" />
  </span>;
}

export function FolderCover({urls, count, onReveal}: FolderCoverProps) {
  const [seen, setSeen] = React.useState(false);
  const holder = React.useRef<HTMLSpanElement | null>(null);

  React.useEffect(() => {
    if (seen) return undefined;
    const element = holder.current;
    /* No observer means no way to know the card is seen: ask for nothing rather than everything. */
    if (!element || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(records => {
      for (const record of records) {
        if (!record.isIntersecting) continue;
        observer.disconnect();
        setSeen(true);
        onReveal?.();
        return;
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [seen, onReveal]);

  const cells = Array.from({length: CELLS}, (_, at) => urls[at] ?? null);

  return <span ref={holder} data-collage="" data-collage-cells={Math.min(CELLS, urls.length)} data-collage-count={count}
    className={'relative block aspect-video overflow-hidden rounded-md ' + GROUND}>
    <span aria-hidden className="pointer-events-none absolute inset-0 grid grid-cols-2 grid-rows-2 gap-px bg-black/50">
      {cells.map((url, at) => <Cell key={at} url={url} seen={seen} />)}
    </span>
    <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/55 to-transparent" />
    <span data-collection-badge="" className="pointer-events-none absolute bottom-0.5 left-1 flex items-center gap-1 text-[10.5px] font-medium text-white/90">
      <Folder size={11} strokeWidth={1.6} />
      <span className="tabular-nums">{count}</span>
    </span>
  </span>;
}
