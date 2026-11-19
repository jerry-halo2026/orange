// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The API's view of the index client — a re-export, not a second implementation.
 *
 * The one client is `packages/openfilm/src/index-client.mjs`: dependency-free so the desktop can load it from a
 * packaged asar, and the only place that knows the `/rest/v1/rpc/<fn>` shape. `apps/api` keeps this module so its
 * imports keep their name (`./index/client.ts`) and so the types live next to the code that uses them; the RPC SQL
 * is not copied here (or anywhere) — `docs/sql/contract.json` is the shape, and the migrations are its source.
 *
 * This re-export is a **source-checkout convenience**: its relative path resolves because `apps/api` and
 * `packages/openfilm` sit in one workspace. The packaged desktop never loads this module (`src/main.ts` does not
 * import it), so nothing in an asar depends on that path; the desktop itself imports the package subpath
 * `openfilm/index-client`, which is what `release.mjs` installs from the packed tarball.
 */
export {createIndexClient,RPC_NAMES} from '../../../../packages/openfilm/src/index-client.mjs';
export type {
  IndexClient,
  IndexClientOptions,
  IndexRow,
  SearchFilters,
  SearchHit,
} from '../../../../packages/openfilm/src/index-client.mjs';
