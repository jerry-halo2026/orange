// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * The material centre's routes, inside the Studio server.
 *
 * Why here and not in a page: the card page asks the *Studio origin* for
 * `/api/materials/...` (that is the client's default base); a browser page must
 * never hold the provider token, so the server owns the request and the token.
 *
 * Deliberately narrow:
 *  - three read routes, one index route, two cover routes (the supplier's id, and the supplier's own url
 *    answered from this computer's cover cache) and one cache reset; a name that is not one of them is a
 *    404, never a fall-through to some other handler;
 *  - reads, the index and covers are `GET` only, the reset is `POST` only (and
 *    signed in — as is the index, which is a file on this computer, and as is the cover read, which
 *    is an outbound fetch of an address a page named: no session, no cover), and a
 *    repeated query parameter is refused rather than resolved;
 *  - until the material service is actually attached, every supplier route
 *    answers 501 with a code the page can name, instead of a bare 404 the page
 *    can only describe as "读取失败".
 *
 * `/index` is not the supplier's: it is the index `material-index-build.mjs`
 * landed here (`material-index-route.mjs`), and it is served without the
 * supplier service being connected at all.
 *
 * `/search` is not the supplier's either: it is this account's own search
 * (`material-search-route.mjs`, answering `media_search` plus the local
 * availability only this computer knows). It is the one `POST` read here,
 * because a query is a body and not a url a log would keep; it is signed in
 * like the index, it is read-only like the rest, and with no tenant
 * configured it answers a named `501` rather than an empty library.
 *
 * `/wiki/...` is the material centre's notes for one material (`ui/src/lib/material-center/wiki.ts`:
 * `/video/:id`, `/entities`, `/entities/:id`, `/entities/:id/arbitrate`). No wiki backend is wired in
 * this installation, and a material that has no notes has no notes — so its one read is answered as the
 * *empty answer it is* (200, a well-formed empty wiki) rather than as a bare 404. A 404 there is what the
 * page's own contract calls "没接通" and what a browser paints red in its console for a card that is
 * merely unknown; the empty answer draws the same panel without the false failure.
 *
 * `video/query/raw` is not a route: no path here can reach it.
 */
import { HttpError, json, readJson } from './http.mjs';
import { isCacheName } from './materials-cache.mjs';
import { pageNamedMaterialHeaders } from './materials-proxy.mjs';

/** @typedef {import('./http.mjs').Req} Req @typedef {import('./http.mjs').Res} Res */

const ROUTES = /** @type {const} */ (['list', 'facets', 'labels']);

/**
 * One material's notes, when this computer has none for it: every field the page's `VideoWiki` reads, empty.
 *
 * The page reads `status`, `production`, `confidence`, `oneLine`, `scenes`, `bestClip`, `tags` and `risks`
 * (`wiki.ts`), so an `{}` here would draw `undefined` into a badge and `NaN%` into the confidence — worse
 * than the 404 it replaces. This is the honest shape of "nothing is known about this material yet".
 * @param {string} videoId
 */
const emptyWiki = (videoId) => ({
  videoId, empty: true, oneLine: '', scenes: [], tags: {}, production: 'code', confidence: 0, risks: [], status: 'candidate',
});

/**
 * @param {{ service?: {list?:Function, facets?:Function, labels?:Function, cover?:Function, clear?:Function} | null,
 *   auth?: { assertActive?: () => unknown } | null,
 *   index?: (() => unknown | Promise<unknown>) | null,
 *   search?: ((body: any) => Promise<unknown>) | null }} [options]
 *   `service` is the seam the proxy fills in once the material service is
 *   attached. Nothing is imported from it here, so this module stays testable
 *   with a plain object. `index` is the landed index reader (`landedIndex` in
 *   material-index-route.mjs): the file on this computer, not a supplier read.
 *   `search` is the search answer (`createMaterialSearchAnswer` in
 *   material-search-route.mjs): the account's own documents plus this
 *   computer's availability, with no supplier service involved.
 */
export function createMaterialCenterRoutes({ service = null, auth = null, index = null, search = null } = {}) {
  /** The one thing a page can do when the data plane is not wired yet. */
  const unavailable = () => {
    throw new HttpError(501, 'The material service is not connected in this installation.', {
      code: 'material-service-unavailable',
    });
  };
  /** @param {string | undefined} method @param {'GET' | 'POST'} allowed @param {string} [what] */
  const assertMethod = (method, allowed, what = 'Material reads') => {
    if (method !== allowed) {
      throw new HttpError(405, `${what} ${allowed === 'POST' ? 'is POST only.' : 'are GET only.'}`, { code: 'method-not-allowed' });
    }
  };
  /**
   * The session seam every change here uses. The status is the caller's to name: a route a page reads with
   * `fetch` keeps the 403 the rest of Studio answers, while a cover — which arrives as an `<img>` — answers 401,
   * because the thing that asked for it cannot read a JSON body and only has the status to go on.
   * @param {number} [status]
   */
  const assertSignedIn = (status = 403) => {
    if (!auth || typeof auth.assertActive !== 'function') throw new HttpError(status, 'Sign in is required.', { code: 'authentication-required' });
    try { auth.assertActive(); } catch { throw new HttpError(status, 'Sign in is required.', { code: 'authentication-required' }); }
  };
  /** @param {string} route */
  const call = (route) => {
    if (!service) unavailable();
    const handler = /** @type {any} */ (service)?.[route];
    if (typeof handler !== 'function') unavailable();
    return handler;
  };

  /**
   * @param {Req} req @param {Res} res @param {string[]} parts
   * @returns {Promise<boolean>} whether this request belonged here
   */
  return async (req, res, parts) => {
    if (parts[0] !== 'materials') return false;
    // The principal and its signature are the server's to make; a page asking to set them is refused.
    if (pageNamedMaterialHeaders(/** @type {Record<string, unknown> | undefined} */ (req.headers))) {
      throw new HttpError(403, 'A page may not name the material principal.', { code: 'material-page-header-refused' });
    }
    const route = parts[1];
    /* The landed index (the 批次/合集 tree on this computer): a read of a local file, so it is GET + signed in, and
       it does not need the supplier service at all. No reader configured is a named 501 the page can fall back on. */
    if (route === 'index' && parts.length === 2) {
      assertMethod(req.method, 'GET');
      assertSignedIn();
      if (typeof index !== 'function') {
        throw new HttpError(501, 'The landed material index is not readable here.', { code: 'material-index-unavailable' });
      }
      json(res, 200, await index());
      return true;
    }
    /* The account's own search (`material-search-route.mjs`): `media_search` over this computer's `media_doc`, plus the
       availability only this disk knows. The one POST read in this group — a query belongs in a body, not in a url that
       ends up in a log — and it is signed in and read-only like the rest. No search configured (no tenant) is a named
       501, never an empty library that would read as "this account has no such material". */
    if (route === 'search' && parts.length === 2) {
      assertMethod(req.method, 'POST', 'The material search');
      assertSignedIn();
      if (typeof search !== 'function') {
        throw new HttpError(501, 'Material search is not configured in this installation.', { code: 'material-search-unavailable' });
      }
      json(res, 200, await search(await readJson(req)));
      return true;
    }
    if (route === 'cover') {
      assertMethod(req.method, 'GET');
      /* Two ways to ask for one cover, and they are not the same question:
         - `cover/<40 hex>`: the supplier's id, answered by the provider through the service (`cover`), which refuses
           a request with no session of its own (403, the group's answer);
         - `cover?url=…`: the supplier's own CDN url, answered from this computer's cover cache (`coverByUrl`,
           material-media-cache.mjs) — the one the page's cards ask for. A url of another host is refused there.
         Both need a session now: this route is a fetch of an address a *page* names, and without a session any
         process on this computer could have used it to fill and warm the cache (`assertSignedIn`). The by-url answer
         is 401 rather than 403 because the caller is an `<img>`: the status is the only part of it a browser shows.
         Anything else is still an unknown route, never a guess. */
      if (parts.length === 3 && isCacheName(parts[2])) {
        await call('cover')(req, res, parts[2]);
        return true;
      }
      if (parts.length === 2) {
        assertSignedIn(401);
        await call('coverByUrl')(req, res);
        return true;
      }
      throw new HttpError(404, 'Unknown material route.', { code: 'material-route-unknown' });
    }
    /* The material centre's notes (`wiki.ts`): `video/:id` and `entities` are reads of this group, and this
       installation has no wiki backend for them. A material with no notes has none — a 200 empty answer, not a
       404 the page must read as a failure. One entity's page is only reachable from a listed entity, so with an
       empty list it stays the named 404 it already was. */
    if (route === 'wiki') {
      assertMethod(req.method, 'GET', 'The material notes');
      assertSignedIn();
      if (parts.length === 4 && parts[2] === 'video' && parts[3]) { json(res, 200, emptyWiki(decodeURIComponent(String(parts[3])))); return true; }
      if (parts.length === 3 && parts[2] === 'entities') { json(res, 200, { entities: [] }); return true; }
      throw new HttpError(404, 'Unknown material route.', { code: 'material-route-unknown' });
    }
    if (route === 'raw' && parts.length === 2) {
      assertMethod(req.method, 'POST', 'The raw download');
      await call('raw')(req, res);
      return true;
    }
    if (route === 'binding' && parts.length === 2) {
      if (!['GET', 'POST', 'DELETE'].includes(String(req.method ?? '').toUpperCase())) {
        throw new HttpError(405, 'A binding is read, made or removed.', { code: 'method-not-allowed' });
      }
      await call('binding')(req, res);
      return true;
    }
    if (route === 'cache' && parts.length === 3 && parts[2] === 'clear') {
      assertMethod(req.method, 'POST');
      assertSignedIn();
      await call('clear')(req, res);
      return true;
    }
    /* What the two media folders hold, against their budgets (`{content, covers}`, each `{bytes, files, limit}`):
       the same read `materialCacheStats()` makes, shown to a person instead of read from a log. */
    if (route === 'cache' && parts.length === 3 && parts[2] === 'stats') {
      assertMethod(req.method, 'GET');
      assertSignedIn();
      await call('cacheStats')(req, res);
      return true;
    }
    if (!route || !ROUTES.includes(/** @type {any} */ (route)) || parts.length !== 2) {
      throw new HttpError(404, 'Unknown material route.', { code: 'material-route-unknown' });
    }
    assertMethod(req.method, 'GET');
    await call(route)(req, res);
    return true;
  };
}





