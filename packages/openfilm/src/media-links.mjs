// @ts-check
/**
 * Media kept elsewhere (a NAS, another disk), linked into a project rather than copied: a link in its assets/ folder
 * that points at the file or folder, so the film names it by a project path like any other.
 *
 * A link out of a project is followed only to a place the person linked on this computer, kept in Studio's home
 * (`links.json`): a project from elsewhere (a download, a zip) can carry a link to any of the person's files, and the
 * pages in it are code that could read what it reaches. Only reading goes through a link; nothing is written there.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';


/** Only trusted Node callers install this callback; it is never a JSON grant. */
const sourceAuthority = new AsyncLocalStorage();
/** @template T @param {(source:string, operation:string)=>any} authorize @param {()=>T} work @returns {T} */
export function withSourceAuthorization(authorize, work) {
  if (typeof authorize !== 'function' || typeof work !== 'function') throw sourceAccessError();
  return sourceAuthority.run(authorize, work);
}
export function sourceAccessError(code = 'source-access-denied', status = 403) {
  return Object.assign(new Error(code === 'source-selection-required' ? 'Select this source in the system file dialog first.' : 'Source access is not available.'), { code, status });
}
/** @param {string} source @param {string} [operation] @returns {any} */
export function assertSourceAccess(source, operation = 'read') {
  const authorize = sourceAuthority.getStore();
  if (authorize) return authorize(source, operation);
  if(typeof source!=='string'||!isAbsolute(source))return null;
  // A separately started native reader may not turn a controlled path into an
  // unmarked standalone resource. Unmarked native projects keep their behavior.
  let real = source;
  try { real = realpathSync.native(source); } catch { /* lexical ancestors still checked */ }
  for (const start of new Set([source, real])) for (let at = start; ; at = dirname(at)) {
    if (existsSync(join(at, '.openfilm-control.json')) || existsSync(join(at, '.film', 'control.json'))) throw sourceAccessError();
    if (at === dirname(at)) break;
  }
  return null;
}

/** Studio's home: OPENFILM_HOME, else ~/.openfilm (studio/server/projects.mjs studioHome). */
const home = () => process.env.OPENFILM_HOME || join(homedir(), '.openfilm');
const file = () => join(home(), 'links.json');

/** @type {{ at: string, mtime: number, places: string[] } | null} */
let kept = null;

/** The places the person linked, as real paths. */
export function linkedPlaces() {
  const at = file();
  let mtime = -1;
  try { mtime = statSync(at).mtimeMs; } catch { /* none yet */ }
  if (kept && kept.at === at && kept.mtime === mtime) return kept.places;
  /** @type {string[]} */
  let places = [];
  try {
    const raw = JSON.parse(readFileSync(at, 'utf8'));
    places = Array.isArray(raw?.places) ? raw.places.filter((/** @type {unknown} */ p) => typeof p === 'string' && isAbsolute(p)) : [];
  } catch { /* none, or unreadable: none */ }
  kept = { at, mtime, places };
  return places;
}

/** Remember places the person linked (files or folders, followed to where they really are). @param {string[]} paths */
export function addLinkedPlaces(paths) {
  const places = new Set(linkedPlaces());
  for (const path of paths) {
    try { places.add(realpathSync.native(path)); } catch { /* gone meanwhile: nothing to allow */ }
  }
  const at = file();
  mkdirSync(dirname(at), { recursive: true });
  const tmp = `${at}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ places: [...places].sort() }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, at);
  kept = null;
}

/** Whether `real` (a real path) is a place the person linked, or inside one. @param {string} real */
export function linkAllowed(real) {
  assertSourceAccess(real, 'linked-read');
  return linkedPlaces().some((place) => {
    const back = relative(place, real);
    return !back || (back.split(sep)[0] !== '..' && !isAbsolute(back));
  });
}

/**
 * Whether a project path that leads out of the project may be read: it is in the project's assets/ folder, and where
 * it really leads is a place the person linked. `abs` is the path as written; the project is `root`.
 * @param {string} root @param {string} abs
 */
export function readableLink(root, abs) {
  const back = relative(root, abs);
  if (back.split(sep)[0] !== 'assets' || back.startsWith('..') || isAbsolute(back)) return false;
  try { return linkAllowed(realpathSync.native(abs)); } catch { return false; }
}
