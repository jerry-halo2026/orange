// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * Where the product keeps the person's work on this computer: the projects library (one folder per project, the folders
 * Studio's Projects list shows) and the exports folder. The library has a default and may be moved in Studio's
 * Settings → General: Studio's `prefs.json` (`projectsFolder`), read by Studio and by the `orangefilm` command alike, so
 * a project fetched from the command line lands where Studio's go. A Studio with a home of its own (ORANGE_HOME, as
 * `pnpm dev` and the desktop app's dev and preview builds have) shares the person's library when ORANGE_SHARED_HOME
 * names the home that keeps it (~/.orangefilm). ORANGE_LIBRARY sets the default (a build, or a Studio kept apart);
 * what the person chose comes first. Exports go to the folder picked when exporting (the export dialog keeps the last
 * one), else to the exports default.
 *
 * Reads no Studio module, so the command can use it.
 */
import { accessSync, constants, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statfsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { readIsolationProfile, assertIsolationPath } from './development-isolation.mjs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

/** Studio's own home (its settings and keys, not the person's work): ORANGE_HOME, else ~/.orangefilm. */
/** @param {string} key @param {()=>string} fallback */
const isolatedLocation = (key, fallback) => { const p = readIsolationProfile(); return p ? assertIsolationPath(p,p.paths[key],key) : fallback(); };
const envText = (name) => process.env[`ORANGE_${name}`];
/** Studio's home is ~/.orangefilm, and nothing else: the old ~/.orangefilm is read only by the explicit import. */
export const defaultStudioHome = (home = homedir()) => join(home, '.orangefilm');
export const studioHomeDir = () => isolatedLocation('home', () => envText('HOME') || defaultStudioHome());

/**
 * The Studio home whose prefs.json holds what every OrangeFilm on this computer shares (where the library is, the skills
 * turned off): ORANGE_SHARED_HOME, else Studio's own.
 */
export const sharedHome = () => isolatedLocation('sharedHome', () => envText('SHARED_HOME') || studioHomeDir());

/** One value of the shared prefs.json (`home`: the home that holds it), or undefined. @param {string} key */
export function sharedPref(key, home = sharedHome()) {
  try {
    const raw = JSON.parse(readFileSync(join(home, 'prefs.json'), 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw[key] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Keep one value in the shared prefs.json. The file is shared with every OrangeFilm on this computer, older or newer:
 * what this one does not know of it is written back as it was. @param {string} key @param {unknown} value
 */
export function setSharedPref(key, value, home = sharedHome()) {
  const at = join(home, 'prefs.json');
  let kept = {};
  try { const raw = JSON.parse(readFileSync(at, 'utf8')); if (raw && typeof raw === 'object' && !Array.isArray(raw)) kept = raw; } catch { /* none yet */ }
  mkdirSync(home, { recursive: true });
  writeFileSync(`${at}.${process.pid}.tmp`, `${JSON.stringify({ ...kept, [key]: value }, null, 2)}\n`);
  renameSync(`${at}.${process.pid}.tmp`, at);
}

/** The product's folder in the person's own folders: brand.json's `productName` (…/Videos/OrangeFilm). */
const PRODUCT_FOLDER = 'OrangeFilm';
/** The folder it was before the product was renamed: what a first start moves, once (…/Videos/OrangeFilm). */
const LEGACY_PRODUCT_FOLDER = 'OpenFilm';

/** The folder the product keeps its projects, saved things and skills in: ~/Movies/<product>, or ~/Videos/<product>. */
export const productFolder = () => join(homedir(), process.platform === 'darwin' ? 'Movies' : 'Videos', PRODUCT_FOLDER);
/** Where that folder was before the rename (migrateProductFolder). */
export const legacyProductFolder = () => join(homedir(), process.platform === 'darwin' ? 'Movies' : 'Videos', LEGACY_PRODUCT_FOLDER);

/** Where new projects go unless the person chose: ORANGE_LIBRARY, else ~/Movies/OrangeFilm/Projects on macOS, ~/Videos/OrangeFilm/Projects elsewhere. */
export const libraryDefault = () => isolatedLocation('projects', () => envText('LIBRARY')
  || join(productFolder(), 'Projects'));

/**
 * Where exports go unless a folder is picked when exporting: ORANGE_EXPORTS, else `exports` in ORANGE_HOME when
 * that is set (a Studio kept apart, for work on OrangeFilm itself, leaves nothing in the person's own folder), else the
 * Desktop.
 */
export const exportsDefault = () => isolatedLocation('exports', () => envText('EXPORTS')
  || (envText('HOME') ? join(envText('HOME'), 'exports') : '')
  || join(homedir(), 'Desktop'));

/**
 * Where what the person saved goes (clips and files kept to use again in any project, studio/server/saved.mjs): beside
 * the projects' default folder, `Saved` (~/Movies/OrangeFilm/Saved on macOS), else ORANGE_SAVED. Not moved with the
 * projects folder: what was saved stays where it was found.
 */
export const savedRoot = () => isolatedLocation('saved', () => envText('SAVED') || join(dirname(libraryDefault()), 'Saved'));

/**
 * The product's folder under its new name, moving the one it had before (`…/Videos/OrangeFilm` → `…/Videos/OrangeFilm`),
 * so the person's projects — and `Saved` and `Skills` beside them — keep being theirs after the rename.
 *
 * The whole product folder moves, not just `Projects`: the three live side by side, and a `Saved` left behind under the
 * old name would be a second library nothing points at. It moves only when the new folder is not there yet: two
 * folders are never merged, and nothing is ever overwritten. `rename` keeps every byte, permission and date, and is the
 * one step that cannot leave a half-moved folder behind; when the two are on different disks (or a file is open and
 * Windows refuses) it is copied instead, the old folder is kept as it was, and the reason is logged — a lost project is
 * worse than a stray folder.
 *
 * Under an isolation profile (development-isolation.mjs) the person's own folders are not touched at all.
 *
 * @param {{ from?: string, to?: string, log?: (line: string) => void }} [options]
 * @returns {{ status: 'none' | 'already' | 'moved' | 'failed', from: string, to: string, method: 'rename' | 'copy' | null, keptOld: boolean }}
 */
export function migrateProductFolder({ from = legacyProductFolder(), to = productFolder(), log = (line) => process.stderr.write(`${line}\n`) } = {}) {
  if (readIsolationProfile()) return { status: 'none', from, to, method: null, keptOld: false };
  if (existsSync(to)) return { status: 'already', from, to, method: null, keptOld: false };
  if (!existsSync(from)) return { status: 'none', from, to, method: null, keptOld: false };
  try {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    log(`[library] moved ${from} to ${to}`);
    return { status: 'moved', from, to, method: 'rename', keptOld: false };
  } catch (error) {
    try {
      cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    } catch (copyError) {
      log(`[library] could not move ${from} to ${to}: ${error?.message ?? error}; copying it failed too: ${copyError?.message ?? copyError}`);
      return { status: 'failed', from, to, method: null, keptOld: false };
    }
    log(`[library] copied ${from} to ${to} (${error?.code ?? error?.message ?? error}); the old folder is kept as it was`);
    return { status: 'moved', from, to, method: 'copy', keptOld: true };
  }
}

/** The folders the person can choose, by their key in prefs.json. */
export const LOCATION_KEYS = /** @type {const} */ ({ projects: 'projectsFolder' });

/** A folder the person chose, as kept in prefs.json: an absolute path, or null (none chosen, or not one). */
export function chosenFolder(/** @type {'projectsFolder'} */ key) {
  const value = sharedPref(key);
  const profile = readIsolationProfile();
  if (profile && value !== undefined && value !== null) assertIsolationPath(profile,value,'projects');
  return typeof value === 'string' && isAbsolute(value) ? resolve(value) : null;
}

/**
 * Keep a folder the person chose (null: back to the default) in the shared prefs.json.
 * @param {'projectsFolder'} key @param {string | null} value
 */
export function chooseFolder(key, value) {
  const profile = readIsolationProfile();
  if (profile && value !== null) assertIsolationPath(profile,value,'projects');
  setSharedPref(key, value);
}

export const libraryRoot = () => chosenFolder('projectsFolder') ?? libraryDefault();

/**
 * The projects in a library, by full path: its folders that hold a film (film.html, or Studio's `.film/id` for one
 * that lost it), not hidden ones. Nothing deeper: a project is a folder of the library.
 */
export function libraryProjects(root = libraryRoot()) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && (existsSync(join(root, d.name, 'film.html')) || existsSync(join(root, d.name, '.film', 'id'))))
      .map((d) => join(root, d.name));
  } catch {
    return [];
  }
}

/** Where exports go when no folder is picked. */
export const exportsRoot = () => exportsDefault();

/** The free space, in bytes, on the disk a folder is on (the folder, or the nearest one above it that is there), or null. */
export function freeSpace(/** @type {string} */ folder) {
  let at = resolve(folder);
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
  try {
    const s = statfsSync(at);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

/**
 * Each folder the person can choose, for Settings: where it is now, its default, whether it was chosen, the free
 * space on its disk, and how many projects are in it (Settings asks whether they move with it).
 */
export function locations() {
  const one = (/** @type {string} */ path, /** @type {string} */ fallback, /** @type {boolean} */ chosen) => ({ path, default: fallback, chosen, free: freeSpace(path), count: libraryProjects(path).length });
  return {
    projects: one(libraryRoot(), libraryDefault(), chosenFolder('projectsFolder') !== null),
  };
}

/**
 * A folder offered for new projects, as it will be kept: absolute, not a disk's root, not inside Studio's own
 * home; made if it is not there yet. Throws a sentence the person can read.
 * @param {unknown} value @returns {string}
 */
export function usableFolder(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('Choose a folder by its full path.');
  const profile = readIsolationProfile();
  if (profile) assertIsolationPath(profile,value,'projects');
  const path = resolve(value);
  if (dirname(path) === path) throw new Error('Choose a folder on that disk, not the disk itself.');
  for (const home of new Set([resolve(studioHomeDir()), resolve(sharedHome())])) {
    if (path === home || path.startsWith(home + sep)) throw new Error(`${PRODUCT_FOLDER} keeps its own settings there: choose another folder.`);
  }
  try {
    mkdirSync(path, { recursive: true });
    accessSync(path, constants.W_OK);
  } catch {
    throw new Error('That folder cannot be written to: choose another one.');
  }
  return path;
}
