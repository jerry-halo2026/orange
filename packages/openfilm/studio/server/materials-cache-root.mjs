// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * Where the material centre's cache lives, in every kind of Studio run.
 *
 * Priority (the first that applies wins):
 *   1. an isolation profile            → its `cache` location (byte-for-byte what shipped before);
 *   2. `MATERIALS_CACHE_ROOT`          → the operator's own folder: absolute, and a folder (made if missing);
 *   3. nothing said                    → `<studioHomeDir>/material-cache`, beside Studio's other private data.
 *
 * A `MATERIALS_CACHE_ROOT` that names a file (or a relative path) is an operator mistake, not a
 * reason to drop caching quietly: it throws with a fixed code, so the failure is named.
 *
 * The cache root must also stand apart from the Saved library, in both directions: `clear()` removes
 * `<root>/materials`, which is harmless only while the root holds cache and nothing else. A root that
 * *is* Saved, sits inside Saved, or contains Saved fails with its own fixed code — never adjusted
 * silently, never guessed at.
 *
 * `createMaterialsCache`'s `clear()` removes `<root>/materials` and never the root itself.
 */
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { savedRoot, studioHomeDir } from '../../src/locations.mjs';

/** The folder a run without an isolation profile keeps its material cache in. */
export const MATERIALS_CACHE_DIR = 'material-cache';
/** The code a bad `MATERIALS_CACHE_ROOT` fails with. */
export const MATERIALS_CACHE_ROOT_INVALID = 'MATERIALS_CACHE_ROOT_INVALID';
/** The code a cache root that overlaps Saved fails with. */
export const MATERIALS_CACHE_ROOT_IS_SAVED = 'MATERIALS_CACHE_ROOT_IS_SAVED';

/** @param {string} message @returns {Error & { code: string }} */
const invalid = (message) => Object.assign(new Error(message), { code: MATERIALS_CACHE_ROOT_INVALID });
/** @param {string} message @returns {Error & { code: string }} */
const overlapsSaved = (message) => Object.assign(new Error(message), { code: MATERIALS_CACHE_ROOT_IS_SAVED });

/** Windows compares paths without case; the filesystem does too. @param {string} value */
const fold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);

/**
 * Whether `inside` is `outer` or lies below it.
 * @param {string} outer @param {string} inside
 */
const contains = (outer, inside) => {
  const from = fold(resolve(outer));
  const to = fold(resolve(inside));
  if (from === to) return true;
  const step = relative(from, to);
  return step !== '' && !step.startsWith('..') && !isAbsolute(step) && !step.startsWith(`..${sep}`);
};

/**
 * @param {{ isolation?: { paths?: { cache?: string } } | null, env?: NodeJS.ProcessEnv, home?: () => string,
 *   saved?: () => string | null }} [options]
 * @returns {string} an absolute folder that exists
 */
export function materialsCacheRoot({ isolation = null, env = process.env, home = studioHomeDir, saved = savedRoot } = {}) {
  const isolated = isolation && typeof isolation.paths?.cache === 'string' ? isolation.paths.cache : null;
  /** @param {string} root */
  const apart = (root) => {
    /** @type {string | null} */
    let library = null;
    try { library = saved ? saved() : null; } catch { library = null; }
    if (typeof library === 'string' && library) {
      if (contains(library, root)) throw overlapsSaved(`The material cache must not live in Saved (${root} is ${library} or inside it).`);
      if (contains(root, library)) throw overlapsSaved(`The material cache must not contain Saved (${root} holds ${library}).`);
    }
    return root;
  };
  if (isolated) return apart(isolated);
  const asked = typeof env.MATERIALS_CACHE_ROOT === 'string' ? env.MATERIALS_CACHE_ROOT.trim() : '';
  if (asked) {
    if (!isAbsolute(asked)) throw invalid(`MATERIALS_CACHE_ROOT must be an absolute folder, not ${JSON.stringify(asked)}.`);
    if (existsSync(asked) && !statSync(asked).isDirectory()) {
      throw invalid(`MATERIALS_CACHE_ROOT names a file, not a folder: ${asked}`);
    }
    apart(asked);
    mkdirSync(asked, { recursive: true });
    return asked;
  }
  const fallback = apart(join(home(), MATERIALS_CACHE_DIR));
  mkdirSync(fallback, { recursive: true });
  return fallback;
}
