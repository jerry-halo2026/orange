// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * Orange's own Studio routes, in one place: the seam between upstream's server and what we added to it.
 *
 * Why one file: each of our route groups used to be an import, a constructor call and a dispatch line threaded into
 * `server.mjs`, so `server.mjs` grew a little more ours with every addition and showed it in every diff of upstream's
 * file. Here they are built once, at `startStudio`'s one call site, and dispatched by the one line beside it — which
 * is what the overlay step needs: one import, one call, one dispatch to carry.
 *
 * What it must not do: no route of its own, no changed path, no changed order. Each group keeps the constructor, the
 * options and the order it had in `server.mjs`; this function only decides which group a request belongs to, and says
 * so with `true`. A request that is neither group's answers `false` and goes on through the server untouched.
 *
 * The groups, and whose they are:
 *  - `materials`: the material centre's routes (upstream's `material-center-routes.mjs`, built here with the service
 *    this installation can actually reach);
 *  - `fission-local`: local batch editing (upstream's `fission-local-routes.mjs`, built with the service and the draft
 *    importer the desktop app hands to `startStudio`).
 */
import { createLocalFissionRoutes } from './fission-local-routes.mjs';
import { createRenderBatchRoutes } from './fission-render-routes.mjs';
import { createRenderBatchBridge } from './render-batch-bridge.mjs';
import { landedIndex } from './material-index-route.mjs';
import { createMaterialCenterRoutes } from './material-center-routes.mjs';
import { createLocalLibrary, createMaterialSearchAnswer, materialSearchService } from './material-search-route.mjs';
import { createMaterialsCache } from './materials-cache.mjs';
import { materialsCacheRoot } from './materials-cache-root.mjs';
import { materialsServiceFromEnv } from './materials-proxy.mjs';
import { studioHomeDir } from '../../src/locations.mjs';

/** @typedef {import('./http.mjs').Req} Req @typedef {import('./http.mjs').Res} Res */

/**
 * @param {{
 *   localFission?: unknown,
 *   localFissionDraft?: unknown,
 *   auth?: { assertActive?: () => unknown } | null,
 *   isolation?: { paths?: { cache?: string } } | null,
 *   home?: () => string,
 *   env?: Record<string, string | undefined>,
 * }} [deps] What `startStudio` holds: the desktop's local batch service and draft importer, the session it signs
 *   requests with, and where this run keeps its home (the cache root is resolved from that, never from a project).
 * @returns {(req: Req, res: Res, parts: string[]) => Promise<boolean>} whether this request belonged here
 */
export function createOrangeRoutes({
  localFission = null,
  localFissionDraft = null,
  auth = null,
  isolation = null,
  home = studioHomeDir,
  env = process.env,
} = {}) {
  /** Local batch editing: the desktop app's service and draft importer, the session as the owner. */
  const localFissionRoutes = createLocalFissionRoutes({ service: localFission, draft: localFissionDraft, auth });

  /* 批量出片：与 MCP 的 plan.render 共用同一个批次注册表（ission-batch-jobs.mjs）。
     工程用 id 解析（页面不传路径），渲染器路径由服务端自己算。 */
  const renderBatchRoutes = createRenderBatchRoutes(createRenderBatchBridge({ auth, home }));

  /* Material centre: the page asks this origin; the provider token never reaches the page.
     The cache lives in the isolated profile's cache directory — never in a project folder — and
     without both an upstream (MATERIALS_UPSTREAM/MATERIALS_SECRET) and that owned root the routes
     keep answering 501 through the skeleton's named code. */
  /* The cache root is resolved for every kind of run (isolation profile → MATERIALS_CACHE_ROOT →
     <studioHomeDir>/material-cache); a root that names a file fails with MATERIALS_CACHE_ROOT_INVALID
     rather than quietly leaving the material service unbuilt. */
  const materialsConfigured = Boolean((env.MATERIALS_UPSTREAM ?? '').trim() && (env.MATERIALS_SECRET ?? '').trim());
  const materialsCacheRootPath = materialsConfigured || (env.MATERIALS_CACHE_ROOT ?? '').trim()
    ? materialsCacheRoot({ isolation, home })
    : null;
  /* The two local facts a search answer needs (`material-search-route.mjs`): the content library (`content/<md5>`) and
     the digest index (the supplier's md5 per videoId), from the same owned root the covers are kept in. Opened on the
     first search rather than at start: a machine that never searches opens neither folder, and a cache root that turns
     out to be unusable fails one request instead of every Studio start. */
  const localLibrary = createLocalLibrary({
    roots: () => materialsCacheRootPath ?? materialsCacheRoot({ isolation, home }),
  });
  const materialCenterRoutes = createMaterialCenterRoutes({
    service: materialsServiceFromEnv({
      cache: materialsCacheRootPath ? createMaterialsCache({ root: materialsCacheRootPath }) : null,
      auth,
      /* The same root, two more folders inside it: `covers/` keeps the supplier's images by url,
         `content/<md5>` keeps the videos this computer already downloaded (`material-media-cache.mjs`).
         Nothing is served from either to anyone but this loopback page. */
      mediaRoot: materialsCacheRootPath,
    }),
    auth,
    /* `GET /api/materials/index`: the 批次/合集 index material-index-build.mjs landed on this computer, read as it is.
       It is a file read (`$ORANGE_MATERIAL_INDEX_DIR`, else ~/.orangefilm-dev/material-index), never a supplier call,
       so it is handed in beside the service instead of through it. Read on every request: a rebuild lands a new file
       and the next read sees it, with no restart and no cache of ours in between. */
    index: () => landedIndex(),
    /* `POST /api/materials/search`: the account's own search (`media_search` over this computer's `media_doc`) with the
       availability only this disk knows. It needs no supplier service — a tenant (`ORANGE_MEDIA_TENANT`), the local
       embedder and the local database are what it reads — so it is built beside the service, from the same environment.
       The content library and the digest index are opened on the first search, from the same owned root the covers use. */
    search: createMaterialSearchAnswer({
      service: materialSearchService({ env }),
      availability: localLibrary.of,
    }),
  });
  /**
   * The one entry the server calls: `true` once one of our groups took the request (it has written its own response or
   * thrown the error that becomes one), `false` for every path that is not ours.
   */
  return async (req, res, parts) => {
    if (parts[0] === 'fission-local') { await localFissionRoutes(req, res, parts); return true; }
    if (parts[0] === 'materials') { await materialCenterRoutes(req, res, parts); return true; }
    if (parts[0] === 'fission-render') { await renderBatchRoutes(req, res, parts); return true; }
    return false;
  };
}
