// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * `POST /api/materials/search`: one query, answered by `media_search` (`docs/sql/012_media_doc.sql`), and the one thing
 * the database cannot know added to every row — **whether this computer already has the bytes**.
 *
 * Why the merge lives here and not in the RPC: `media_doc` is the account's documents, the same for every machine;
 * `material-cache/content/<md5>` is *this* disk (`material-media-cache.mjs`), and 012:393 says so in the function's own
 * comment ("返回列不含本地可用性"). A search answer that says `local: true` must be a search answer this computer can
 * act on without downloading again — `materials.take` is the next thing an agent asks.
 *
 * The two facts it needs are both local and both already written:
 *  - the supplier's `rawMd5` for a `videoId`, from the landed index (`createDigestIndex` → `md5Of`);
 *  - whether that md5 is a whole copy in the content library (`createContentStore` → `has`).
 * A digest this computer does not know is `local: false` with no `cachedMd5` — not a guess, and not a fetch.
 *
 * The library is opened on the first search, not when the server starts: a machine that never searches never touches
 * the folder, and a cache root that turns out to be broken fails one request instead of every Studio start.
 */
import { HttpError } from './http.mjs';
import { createContentStore, createDigestIndex } from './material-media-cache.mjs';
import { materialsCacheRoot } from './materials-cache-root.mjs';
import { MATERIAL_SEARCH_CAPS, createMaterialSearchService, limitOf, normaliseFilters } from '../../src/material-search.mjs';

/** @typedef {{ query: string, filters: Record<string, string | number>, limit: number }} SearchRequest */

/**
 * The request body as the route reads it. Three shapes are accepted because three callers exist: the page (flat keys),
 * the MCP tool (flat keys, `group` for the RPC's `gname`) and a script (`filters`, the RPC's own object).
 *
 * A missing query is `400 invalid-arguments` — a search of nothing is not a search, and answering `[]` to it would hide
 * a caller's bug behind an empty library.
 * @param {any} body
 * @returns {SearchRequest}
 */
export function searchRequest(body) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const query = typeof source.query === 'string' ? source.query.trim() : '';
  if (!query) {
    throw new HttpError(400, 'A search needs a query.', { code: 'invalid-arguments', field: 'query', maxLimit: MATERIAL_SEARCH_CAPS.limit });
  }
  const nested = source.filters && typeof source.filters === 'object' ? source.filters : {};
  const filters = normaliseFilters({
    ...nested,
    batch: source.batch ?? nested.batch,
    product: source.product ?? nested.product,
    /* the agent-facing name is `group`; the database's column is `gname` (012:409) */
    gname: source.group ?? source.gname ?? nested.gname,
    durationMaxMs: source.durationMaxMs ?? nested.durationMaxMs,
    sourceKind: source.sourceKind ?? nested.sourceKind,
  });
  return { query, filters, limit: limitOf(source.limit) };
}

/**
 * What this computer knows about one material's bytes. Never throws: an unusable library is `local: false` — the answer
 * is "not here", which is true of a machine that cannot read its own cache.
 * @param {{ md5Of?: (videoId: string) => string | null, has?: (md5: string) => boolean } | null} library
 * @param {string} videoId
 * @returns {{ local: boolean, cachedMd5?: string }}
 */
export function availabilityOf(library, videoId) {
  if (!library || typeof library.md5Of !== 'function' || typeof library.has !== 'function') return { local: false };
  if (typeof videoId !== 'string' || !videoId) return { local: false };
  /** @type {string | null} */
  let md5 = null;
  try { md5 = library.md5Of(videoId); } catch { md5 = null; }
  if (typeof md5 !== 'string' || !md5) return { local: false };
  /** @type {boolean} */
  let here = false;
  try { here = library.has(md5) === true; } catch { here = false; }
  return here ? { local: true, cachedMd5: md5 } : { local: false };
}

/**
 * The search answer with `availability` on every item. The order, the scores and the modes are the search's; this only
 * adds what the search cannot know.
 * @param {{ mode: string, query: string, count: number, items: any[] }} result
 * @param {(videoId: string) => { local: boolean, cachedMd5?: string }} availability
 */
export function withAvailability(result, availability) {
  const items = (Array.isArray(result?.items) ? result.items : []).map((item) => ({
    ...item, availability: availability(String(item?.videoId ?? '')),
  }));
  return { mode: result?.mode ?? 'index', query: result?.query ?? '', count: items.length, items };
}

/**
 * The content library and the digest index, opened once per Studio start, on the first search that needs them.
 * @param {{ root?: string | null, roots?: () => string, indexDir?: string | null }} [options]
 *   `root` is a resolved cache root; `roots` resolves one lazily (the same `materialsCacheRoot` the cover cache uses);
 *   `indexDir` is the landed index to read the supplier's md5 from (`defaultIndexDir()` when not given).
 */
export function createLocalLibrary({ root = null, roots = () => materialsCacheRoot(), indexDir = null } = {}) {
  /** @type {{ contents: any, digests: any, md5Of: (videoId: string) => string | null, has: (md5: string) => boolean } | null} */
  let opened = null;
  const location = () => {
    if (!opened) {
      const at = typeof root === 'string' && root ? root : roots();
      const contents = createContentStore({ root: at });
      const digests = createDigestIndex(typeof indexDir === 'string' && indexDir ? { dir: indexDir } : {});
      /* the two questions `availabilityOf` asks, bound once: the store and the index are closures, so nothing is lost */
      opened = { contents, digests, md5Of: digests.md5Of, has: contents.has };
    }
    return opened;
  };
  return {
    /** The paths this library reads, resolved (or null when they cannot be). */
    where() {
      try {
        const at = location();
        return { content: at.contents.dir, index: at.digests.file };
      } catch {
        return null;
      }
    },
    /** @param {string} videoId */
    of(videoId) {
      try { return availabilityOf(location(), videoId); } catch { return { local: false }; }
    },
  };
}

/**
 * The route's whole work, without the router: a body in, the answer out. `null` when this installation cannot search —
 * the router answers its own 501 for that, as it does for the index route.
 *
 * @param {{ service?: { search: (request: SearchRequest) => Promise<any> } | null,
 *   availability?: ((videoId: string) => { local: boolean, cachedMd5?: string }) | null }} [options]
 * @returns {((body: any) => Promise<any>) | null}
 */
export function createMaterialSearchAnswer({ service = null, availability = null } = {}) {
  if (!service || typeof service.search !== 'function') return null;
  return async (body) => {
    const request = searchRequest(body);
    const result = await service.search(request);
    return typeof availability === 'function' ? withAvailability(result, availability) : withAvailability(result, () => ({ local: false }));
  };
}

/**
 * The service this installation can actually reach: the RPC over the local database, the embedder on this machine's
 * LM Studio, and the landed index for the third route. `null` when no tenant is configured (`ORANGE_MEDIA_TENANT`).
 * @param {{ env?: Record<string, string | undefined>, fetchImpl?: typeof fetch,
 *   psql?: (script: string) => Promise<any>, index?: (() => any) | null, indexDir?: string | null }} [options]
 */
export function materialSearchService(options = {}) {
  return createMaterialSearchService(options);
}
