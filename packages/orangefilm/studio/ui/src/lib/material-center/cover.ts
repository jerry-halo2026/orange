// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * Covers are asked for one at a time, and only when their card is in view.
 *
 * The contract (§8.4) makes a cover a loopback request the server serves from its cache; it also says the page must
 * not fetch a cover it is not showing, must not walk the page to warm covers and must not prefetch the next page. A
 * gate per card is the smallest thing that can keep that: nothing is asked until an observation says `isIntersecting`,
 * and one card asks once.
 *
 * The url is never built here — the supplier's own `coverUrl` is handed to {@link coverRequestUrl}, which turns it into
 * the Studio origin's route (`GET /api/materials/cover?url=…`). The server keeps that image on this computer, so a
 * second look at the same card costs nothing and a page that lost the network still draws the covers it already saw.
 * The page still names no host of its own: the address it asks is this origin's, and which supplier hosts may be
 * fetched is the server's rule (`material-media-cache.mjs`), not the page's.
 */

export type CoverRequest = (url: string) => void;

/** The Studio origin's cover route: one supplier url in, one image out (from this computer when it is already there). */
export const COVER_ROUTE = '/api/materials/cover';

/**
 * The supplier's `coverUrl` as the request the page actually makes: the same-origin route above, with that url as its
 * one parameter. Nothing is decided here — a url the server will not fetch is answered with an error, and the card
 * keeps its placeholder instead of drawing a broken image.
 * @param url the `coverUrl` the supplier gave, exactly as it was given
 */
export function coverRequestUrl(url: string): string {
  return `${COVER_ROUTE}?url=${encodeURIComponent(url)}`;
}

/**
 * What the cover route said about one url:
 *
 *  - `none` — **204 No Content**: this url has no image, and that is not a failure. The server answers it for a
 *    supplier host it cannot reach at all (a node that accepts the connection and drops the TLS handshake), the same
 *    way it answers a film with no poster. The card draws its placeholder and nothing is reported;
 *  - `failed` — any other refusal (a host that is not the supplier, a url that is not one, an answer too large):
 *    the placeholder again, said as a failure, because this is one;
 *  - `shown` — a body: the image is here as this origin's own object url, ready for an `img`.
 *
 * Read with `fetch`, not by putting the route straight on an `img`: an image element cannot see the status, so a 204
 * would arrive as a load error, and every card of a dead supplier would paint its console red — which is the very
 * thing a 204 replaces. One read per card, no retry: the answer here is the answer drawn.
 */
export type CoverRead =
  | {readonly state: 'none'}
  | {readonly state: 'failed'}
  | {readonly state: 'shown'; readonly href: string};

/** How an image's bytes become something an `img` can draw (a browser object url; a test's own stand-in). */
export type CoverHref = (blob: Blob) => string;

/**
 * One cover, read once from this origin's route.
 *
 * The status is the point: a 204 is "no cover" (placeholder, no failure), and everything that is not an ok answer is
 * a failure. A network error at this end is the same failure — the read is never retried here, because the server
 * already remembers a url that just failed for a minute (`material-media-cache.mjs`).
 *
 * @param request the route address, as {@link coverRequestUrl} makes it
 * @param options `signal`: a card that goes away stops caring (its bytes are dropped, its object url revoked by the
 *   caller); `toHref`: how the bytes become an `img` source
 */
export async function readCover(
  request: string,
  {signal, toHref = (blob) => URL.createObjectURL(blob)}: {readonly signal?: AbortSignal; readonly toHref?: CoverHref} = {},
): Promise<CoverRead> {
  /** @type {Response} */
  let answer;
  try {
    answer = await fetch(request, {method: 'GET', credentials: 'same-origin', signal});
  } catch (error) {
    /* A card unmounted while its cover was on the way: nobody is left to draw it. */
    if ((error as {name?: string})?.name === 'AbortError') throw error;
    return {state: 'failed'};
  }
  /* 204 is an ok status and an empty one: read it before `ok`, or "no image" would be read as an image. */
  if (answer.status === 204) return {state: 'none'};
  if (!answer.ok) return {state: 'failed'};
  let blob: Blob;
  try { blob = await answer.blob(); } catch { return {state: 'failed'}; }
  if (!blob.size) return {state: 'failed'};
  return {state: 'shown', href: toHref(blob)};
}

export type CoverGate = {
  /** In view now: asks at most once. `false` when this gate has already asked (or there is nothing to ask for). */
  enter(url: string | null): boolean;
  /** How many cover requests this card has caused. `0` until it is actually in view. */
  requests(): number;
};

export function createCoverGate(request: CoverRequest): CoverGate {
  let asked = 0;
  return {
    enter(url) {
      if (asked > 0 || !url) return false;
      asked += 1;
      request(url);
      return true;
    },
    requests: () => asked,
  };
}

/**
 * What the observer reports, as the gate reads it: only `isIntersecting` opens a cover, and only once.
 * Kept separate from the DOM so the rule can be held without a browser.
 */
export function observeOnce(entries: readonly {readonly isIntersecting: boolean}[], gate: CoverGate, url: string | null): boolean {
  for (const entry of entries) if (entry.isIntersecting) return gate.enter(url);
  return false;
}
