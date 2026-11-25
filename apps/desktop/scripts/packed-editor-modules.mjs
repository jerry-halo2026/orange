// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The editor's own modules the installed app needs at run time.
 *
 * `src/orangefilm-mcp.mjs` runs the editor's code for its tools (`film-doc.mjs` reads and writes
 * film.html, `ops.mjs` applies an edit, `clip-motion.mjs` is what `ops.mjs` imports). In the checkout
 * it reaches them by relative path; in an installed app there is no checkout, so `scripts/release.mjs`
 * copies exactly these files to `resources/orangefilm` and the MCP server loads them from there.
 *
 * The list is data, not prose: the release copies it, the tests check it, and a module added to the
 * editor's side has one place to be added here.
 */

/**
 * The material index, which is what the three `material.*` tools are: `orangefilm-mcp.mjs` loads
 * `material-tools.mjs` by name, and the closure of what it imports by relative path is the list:
 * `material-index-build.mjs` and `material-index.mjs` for the index itself, `material-search.mjs` for the
 * filters and search caps, and `material-pack.mjs`, `locations.mjs` and `development-isolation.mjs` that
 * those two need. An install that lacked them answered every `material.*` call with `not-configured`
 * (the load fails, the tools say what is missing) even though the checkout worked: the list, not the
 * code, was short. A module added below that one of these imports has to be added here too — the test
 * in `packaged-selfcheck.test.mjs` walks the imports and fails on one that is missing.
 */
export const PACKED_MATERIAL_MODULES = Object.freeze([
  'packages/orangefilm/src/material-tools.mjs',
  'packages/orangefilm/src/material-index-build.mjs',
  'packages/orangefilm/src/material-index.mjs',
  /* material-index.mjs imports it for a product's name: without it every material.* tool answers not-configured */
  'packages/orangefilm/src/material-product.mjs',
  'packages/orangefilm/src/material-index-bootstrap.mjs',
  'packages/orangefilm/src/material-search.mjs',
  'packages/orangefilm/src/material-pack.mjs',
  'packages/orangefilm/src/locations.mjs',
  'packages/orangefilm/src/development-isolation.mjs',
  /* the packaged app starts this detached to build the landed index; without it `/api/materials/index` is 404. */
  'packages/orangefilm/scripts/material-index-build.mjs',
  'packages/orangefilm/scripts/material-index-bootstrap.mjs',
]);

/** The modules, by their path in the repository (which is also their path under `resources/orangefilm`). */
export const PACKED_EDITOR_MODULES = Object.freeze([
  'packages/orangefilm/src/film-doc.mjs',
  'packages/orangefilm/src/clip-motion.mjs',
  'packages/orangefilm/studio/server/ops.mjs',
  /* the sign-in environment resolver: the window loads it at startup, so an install without it cannot start */
  'packages/orangefilm/src/auth-environment.mjs',
  ...PACKED_MATERIAL_MODULES,
]);

/**
 * Where the packed modules sit, relative to the app's resources folder. The MCP server computes the
 * same path; both read this constant so they cannot drift.
 */
export const PACKED_EDITOR_ROOT = 'orangefilm';
