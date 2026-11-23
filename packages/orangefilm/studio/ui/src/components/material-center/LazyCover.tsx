// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import React from 'react';
import {coverRequestUrl, createCoverGate, readCover} from '@/lib/material-center/cover';

export type LazyCoverProps = {
  /** The `coverUrl` the server gave, used exactly as given; `null` when the entry has no cover. */
  readonly src: string | null;
  /** Said in the cover's place while there is nothing to show (the entry's own words come from the page). */
  readonly label: string;
  readonly className?: string;
};

/** What a card is drawing, once it has asked: `idle` before the route answered, then the route's own three answers. */
type Answered = 'idle' | 'none' | 'shown' | 'failed';

/**
 * A cover is not requested until its card is in view (contract §8.4): nothing is read until an `IntersectionObserver`
 * said the card is intersecting, so a card below the fold, a filtered-out card and a page that is never scrolled send
 * nothing at all.
 *
 * The address is this origin's cover route (`coverRequestUrl`): the supplier's url travels as its parameter and the
 * server answers from the image it already keeps on this computer — so the second look at a card costs no request
 * outside this machine, and a Studio that lost the network still draws what it saw before.
 *
 * The answer is read as a status, not by hanging the route on an `img` (`readCover`): a **204** means this url has no
 * image — a supplier host the server cannot reach at all — and that card keeps its placeholder without a broken image
 * or a console entry. A refusal of any other kind (`failed`) keeps the same placeholder, said as what it is. Neither
 * is retried: the server remembers a url that just failed, so asking again would buy the same answer.
 *
 * `data-cover` says which of those this card is in, so a run can be read without a network trace:
 * `none` (nothing to draw: no url, or a 204) · `pending` (not in view yet, or asked and not answered) ·
 * `shown` (the route answered with a picture, drawn here) · `failed` (the route refused: placeholder).
 */
export function LazyCover({src, label, className}: LazyCoverProps) {
  const [shown, setShown] = React.useState(false);
  const [answer, setAnswer] = React.useState<{state: Answered; href: string | null}>({state: 'idle', href: null});
  const holder = React.useRef<HTMLSpanElement | null>(null);
  const gate = React.useRef<ReturnType<typeof createCoverGate> | null>(null);
  gate.current ??= createCoverGate(() => setShown(true));
  /* One address per url: the read the gate opens and the image this card draws are the same one. */
  const requested = React.useMemo(() => (src ? coverRequestUrl(src) : null), [src]);

  React.useEffect(() => {
    if (!src || shown) return undefined;
    const element = holder.current;
    /* No observer means no way to know the card is seen: ask for nothing rather than everything. */
    if (!element || typeof IntersectionObserver === 'undefined') return undefined;
    const here = gate.current!;
    const observer = new IntersectionObserver(records => {
      for (const record of records) if (record.isIntersecting) { here.enter(src); observer.disconnect(); return; }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [src, shown]);

  /* Another url is another image: what the last one answered says nothing about this one. */
  React.useEffect(() => { setAnswer({state: 'idle', href: null}); }, [requested]);

  /* In view: one read of the route, whose status decides between a picture and a placeholder. The bytes this card
     turned into an object url are this card's to release. */
  const made = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!requested || !shown) return undefined;
    const control = new AbortController();
    void readCover(requested, {signal: control.signal}).then(
      next => {
        /* A card that went away while its cover was on the way: the picture is nobody's now. */
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
  }, [requested, shown]);

  const mark = !src ? 'none' : answer.state === 'idle' ? 'pending' : answer.state;

  return <span ref={holder} data-cover={mark} className={'flex items-center justify-center bg-[var(--bg-hover)] ' + (className ?? '')}>
    {answer.state === 'shown' && answer.href
      ? <img src={answer.href} alt="" decoding="async" className="h-full w-full object-cover" />
      : <span className="px-2 text-center text-[12px] text-[var(--text-muted)]">{label}</span>}
  </span>;
}
