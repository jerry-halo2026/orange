// @ts-check
/**
 * Projects: folders, and the list of them (~/.openfilm/studio.json): every project in the library (src/locations.mjs,
 * one folder each, found again at each listing) and the ones opened from elsewhere. A project is its folder, and
 * everything about it is in the folder, so moving or copying the folder moves or copies the project:
 *
 *   film.html, its pages and code, assets/   the work
 *   .film/id, .film/subtitles.json           its id (a copy gets its own) and the subtitles' style (captions.mjs)
 *   .film/settings.json                      the editor's settings: its frame rate, its tracks' names (project-settings.mjs)
 *   .film/history/                           its versions (history.mjs)
 *   .film/chat/                              an app's conversations about it, with its agent's sessions
 *   .film/logs/                              an app's full record of every turn, for debugging
 *   .film/cache/                             what can be made again: frames, posters, waves, look and render output
 *
 * Each part is a folder of its own, so the project's export (exports.mjs, kind 'project') takes or leaves it.
 */
import { types } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createProjectControlGuard, assertGuardSwitch, controlError, ordinaryControlPath } from './project-control-guard.mjs';
import { readIsolationProfile, assertIsolationPath } from '../../src/development-isolation.mjs';
import { studioHomeDir } from '../../src/locations.mjs';
import { moveToTrash } from './trash.mjs';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { EMPTY_FILM } from './film.mjs';
import { FILM_FILE, filmHtml } from '../../src/film-doc.mjs';
import { writeAtomic } from './atomic.mjs';
import { coverAt } from './cover.mjs';
import { libraryProjects, libraryRoot as nativeLibraryRoot, libraryDefault, sharedHome } from '../../src/locations.mjs';
import { projectMissing } from './project-presence.mjs';
import { compoundOuter } from './parts.mjs';

export const TOOL_DIR = '.film';

/** What an export of the project may take besides the work, each a folder in `.film/` (see above); never the cache. */
export const PROJECT_PARTS = /** @type {const} */ (['history', 'chat', 'logs']);

export class ProjectError extends Error {
  /** `code`, when the editor says it in its own words ('not-found', 'no-film', 'listed'). @param {string} message @param {number} status @param {string} [code] */
  constructor(message, status = 400, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Where Studio keeps its own state (not projects): ~/.openfilm, or OPENFILM_HOME. */
export const studioHome = studioHomeDir;

/**
 * The key this machine's Studio opens with (~/.openfilm/key, readable by this user only), the same at every launch: an
 * address Studio printed, and a page open on it, still work after it restarts (an update, a reboot).
 */
function nativeStudioKey() {
  const file = ordinaryControlPath(join(studioHome(), 'key'));
  try {
    const key = readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{48}$/.test(key)) return key;
  } catch { /* none yet */ }
  const key = randomBytes(24).toString('hex');
  mkdirSync(studioHome(), { recursive: true });
  writeFileSync(file, key, { mode: 0o600 });
  return key;
}

/** Where new projects go: the folder chosen in Settings, else ~/Movies/OpenFilm/Projects on macOS, ~/Videos/OpenFilm/Projects elsewhere (src/locations.mjs). */
export function libraryRoot() {
  return guardedSync(homeResources(), () => {
    checkPrivateControlState();
    const root = nativeLibraryRoot();
    return guardedSync({ homes: [], roots: [resolve(root)], targets: [] }, () => root);
  });
}

/**
 * @typedef {{ id: string, path: string, openedAt: number, folderId?: string }} Recent
 * @typedef {{ id: string, name: string, createdAt: number, parentId?: string }} ProjectFolder   a folder of the Projects
 *   list (not on disk); `parentId` the folder it is in (none: the top level)
 * @typedef {{ recent: Recent[], folders: ProjectFolder[] }} StudioState
 */

/* One change of the list at a time in this Studio: each reads the list and writes it back, so two at once (several
   projects deleted together, a project made while another is deleted) would each write over the other's change. */
let stateTurn = Promise.resolve();
/** @template T @param {() => Promise<T>} change @returns {Promise<T>} */
function exclusive(change) {
  const run = stateTurn.then(change, change);
  stateTurn = run.then(() => {}, () => {});
  return run;
}

/** The list of projects and the person's preferences, read fresh each time (another Studio command may have written). */
async function native_readState() {
  let text;
  try { text = await readFile(join(studioHome(), 'studio.json'), 'utf8'); }
  catch (e) { if (e?.code === 'ENOENT') return /** @type {StudioState} */ ({ recent: [], folders: [] }); throw controlError(); }
  let raw;
  try { raw = JSON.parse(text); } catch { throw controlError(); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (raw.recent !== undefined && !Array.isArray(raw.recent))) throw controlError();
  const recent = raw.recent ?? [];
  // Validate the whole list before resolving/admitting any item; corruption is not an empty history.
  if (recent.some(r => !r || typeof r !== 'object' || Array.isArray(r) || typeof r.id !== 'string' || typeof r.path !== 'string' || !isAbsolute(r.path) || r.path.includes('\0'))) throw controlError();
  const state = /** @type {StudioState} */ ({
    recent,
    folders: Array.isArray(raw.folders) ? raw.folders.filter((/** @type {any} */ f) => f && typeof f.id === 'string' && typeof f.name === 'string') : [],
  });
  await includeProjects(state.recent.map(r => resolve(r.path)));
  return state;
}

/* the file is shared with every OpenFilm on this computer (`npx openfilm`, the app), older or newer: what this one does
   not know of it is written back as it was */
async function writeState(/** @type {StudioState} */ state) {
  await mkdir(studioHome(), { recursive: true });
  const path = join(studioHome(), 'studio.json');
  const kept = await readFile(path, 'utf8').then(JSON.parse, () => null);
  await writeAtomic(path, `${JSON.stringify({ ...(kept && typeof kept === 'object' && !Array.isArray(kept) ? kept : {}), ...state }, null, 2)}\n`);
}

/** Folders that are never a project: the disk's root, the home folder, and Studio's own. */
function refuse(/** @type {string} */ folder) {
  const profile = readIsolationProfile();
  if (profile) {
    try { assertIsolationPath(profile,folder,'projects'); assertIsolationPath(profile,join(folder,TOOL_DIR),'projects'); }
    catch { throw new ProjectError('Project path is not available in this isolated instance.', 403, 'isolation-path'); }
  }
  const home = homedir();
  if (folder === dirname(folder)) throw new ProjectError('the root of a disk cannot be a project; make a folder for it');
  if (folder === home) throw new ProjectError('your home folder cannot be a project; make a folder for it');
  const own = resolve(studioHome());
  if (folder === own || folder.startsWith(own + sep)) throw new ProjectError('Studio keeps its own files there');
}

const newId = () => randomBytes(9).toString('base64url');

/** The folder's project id (`.film/id`), made on first open. A copied folder that brings its original's id gets a new one. */
/** Whether two paths are one folder on disk. */
function sameFolder(/** @type {string} */ a, /** @type {string} */ b) {
  try {
    const x = statSync(a);
    const y = statSync(b);
    return x.dev === y.dev && x.ino === y.ino;
  } catch { return false; }
}

async function folderId(/** @type {string} */ folder, /** @type {StudioState} */ state) {
  const file = join(folder, TOOL_DIR, 'id');
  let id = '';
  try { id = (await readFile(file, 'utf8')).trim(); } catch { /* first open */ }
  /* the same id listed at another folder: this one is a copy of it (and needs its own); the same folder by another
     spelling (case, on a disk that ignores it) is not */
  const other = id && state.recent.find((r) => r.id === id && r.path !== folder && !sameFolder(r.path, folder) && existsSync(join(r.path, TOOL_DIR, 'id')));
  if (!/^[\w-]{6,40}$/.test(id) || other) {
    id = newId();
    await mkdir(join(folder, TOOL_DIR), { recursive: true });
    await writeFile(file, `${id}\n`);
  }
  return id;
}

/**
 * Open a folder as a project: it is made when missing; an empty film.html goes in when there is none (an existing one
 * is never touched); `.film/` keeps itself out of the folder's own git. Returns the project and puts it first in the list.
 * `create` false: only a folder that is there and holds a film opens (else 'not-found' or 'no-film', and nothing is
 * written), so the editor can ask before it starts a film in a folder.
 * @param {string} path @param {{ create?: boolean }} [options]
 */
async function native_openProject(path, { create = true } = {}) {
  const state = await native_readState();
  const profile = readIsolationProfile();
  if (profile) {
    try { assertIsolationPath(profile,path,'projects'); }
    catch { throw new ProjectError('Project path is not available in this isolated instance.', 403, 'isolation-path'); }
  }
  const asked = resolve(path);
  refuse(asked);
  if (existsSync(asked) && !statSync(asked).isDirectory()) throw new ProjectError(`${asked} is a file; a project is a folder`);
  if (!create && !existsSync(asked)) throw new ProjectError('That folder does not exist.', 404, 'not-found');
  if (!create && !existsSync(join(asked, FILM_FILE))) throw new ProjectError('There is no film.html in that folder.', 409, 'no-film');
  await mkdir(join(asked, TOOL_DIR), { recursive: true });
  /* one folder is one project however it is reached (through a link; /var and /private/var on macOS) */
  const folder = realpathSync(asked);
  refuse(folder);
  await writeFile(join(folder, TOOL_DIR, '.gitignore'), '*\n');
  if (!existsSync(join(folder, FILM_FILE))) await writeFile(join(folder, FILM_FILE), filmHtml(EMPTY_FILM), { flag: 'wx' }).catch(() => {});
  {
    const id = await folderId(folder, state);
    /* reopened: it stays in its folder of the list */
    const listed = state.recent.find((r) => r.id === id)?.folderId;
    const entry = { id, path: folder, openedAt: Date.now(), ...(listed ? { folderId: listed } : {}) };
    state.recent = [entry, ...state.recent.filter((r) => r.id !== id && r.path !== folder)];
    await writeState(state);
    return describe(entry);
  }
}

/** A new project in the library: "Untitled", "Untitled 2", … never an existing folder. */
async function native_createProject(name = 'Untitled') {
  await native_readState();
  const clean = folderName(name);
  const root = libraryRoot();
  await mkdir(root, { recursive: true });
  let candidate = join(root, clean);
  for (let n = 2; existsSync(candidate); n++) candidate = join(root, `${clean} ${n}`);
  await includeProjects([candidate]);
  return native_openProject(candidate);
}

/**
 * A project's folder name: what a person typed, less only what a file system refuses (`/ \ : * ? " < > |` and
 * control characters; a run of them, with the spaces around it, becomes one space). Spaces stay as typed, as the media
 * pane keeps them (files.mjs cleanName). Trimmed, no leading dots, at most 120 characters.
 */
function folderName(/** @type {string} */ name) {
  const clean = String(name).replace(/\s*[/\\:*?"<>|\u0000-\u001f\u007f]+\s*/g, ' ').trim().replace(/^[.\s]+/, '').slice(0, 120).trimEnd();
  if (!clean) throw new ProjectError('a project needs a name');
  return clean;
}

/**
 * A project as the API gives it: `createdAt` is when its folder was made; `duration` (s) the film's length when Studio
 * has drawn the film since film.html last changed (its poster), else absent; `folderId` its folder in the list; `cover`
 * when the person last set a cover of its own (cover.mjs), else absent.
 */
const describe = (/** @type {Recent} */ r) => {
  const profile = readIsolationProfile();
  if (profile) {
    try { assertIsolationPath(profile,r.path,'projects'); assertIsolationPath(profile,join(r.path,TOOL_DIR),'projects'); }
    catch { throw new ProjectError('Project path is not available in this isolated instance.', 403, 'isolation-path'); }
  }
  const created = statSync(r.path, { throwIfNoEntry: false });
  const missingReason = projectMissing(r.path);
  const duration = filmDuration(r.path);
  const cover = coverAt(r.path);
  return {
    id: r.id, path: r.path, name: basename(r.path), openedAt: r.openedAt, missing: Boolean(missingReason),
    ...(missingReason ? { missingReason } : {}),
    createdAt: created ? Math.round(created.birthtimeMs || created.ctimeMs) : r.openedAt,
    ...(duration != null ? { duration } : {}),
    ...(r.folderId ? { folderId: r.folderId } : {}),
    ...(cover != null ? { cover } : {}),
  };
};

/** The film's length as Studio last learnt it (pageframes.mjs FILM_DURATION), if film.html has not changed since. */
function filmDuration(/** @type {string} */ folder) {
  try {
    const film = statSync(join(folder, FILM_FILE));
    const known = JSON.parse(readFileSync(join(folder, TOOL_DIR, 'cache', 'film-duration.json'), 'utf8'));
    return known.film === `${film.mtimeMs}:${film.size}` && Number.isFinite(known.duration) ? Number(known.duration) : null;
  } catch { return null; }
}

/**
 * The list follows the library: a project folder that came into it (made by an agent, copied in, a library moved here)
 * joins the list, at the time its film last changed, or, when it is a listed project whose folder is gone (moved here
 * outside Studio), the list points at it from now on; one that left it (deleted or moved away outside Studio) leaves
 * the list. Nothing changes while the library's folder is not there (a disk not plugged in). Returns whether it changed.
 * @param {StudioState} state
 */
async function followLibrary(state) {
  const root = libraryRoot();
  if (!existsSync(root)) return false;
  const real = realpathSync(root);
  const before = state.recent.length;
  state.recent = state.recent.filter((r) => !((dirname(r.path) === real || dirname(r.path) === root) && !existsSync(r.path)));
  let changed = state.recent.length !== before;
  const foundProjects = libraryProjects(real);
  await includeProjects([...state.recent.map(r => resolve(r.path)), ...foundProjects]);
  for (const found of foundProjects) {
    if (state.recent.some((r) => r.path === found)) continue;
    await mkdir(join(found, TOOL_DIR), { recursive: true });
    await writeFile(join(found, TOOL_DIR, '.gitignore'), '*\n');
    const id = await folderId(found, state);
    changed = true;
    /* folderId gave a copy its own id, so a listed one with this id is this project, moved */
    const moved = state.recent.find((r) => r.id === id);
    if (moved) { moved.path = found; continue; }
    const film = statSync(join(found, FILM_FILE), { throwIfNoEntry: false }) ?? statSync(found);
    state.recent.push({ id, path: found, openedAt: Math.round(film.mtimeMs) });
  }
  if (changed) state.recent.sort((a, b) => b.openedAt - a.openedAt);
  return changed;
}

/** Every project of the library and the ones opened from elsewhere, most recent first; one whose folder is gone says so (`missing`). */
async function native_listProjects() {
  return exclusive(async () => {
    const state = await native_readState();
    if (await followLibrary(state)) await writeState(state);
    const folders = new Set(state.folders.map((f) => f.id));
    /* a project in a folder that was deleted is back at the top level; a compound clip's film is reached through
       its project, not listed (parts.mjs) */
    return state.recent.filter((r) => compoundOuter(r.path) === resolve(r.path)).map((r) => describe(r.folderId && !folders.has(r.folderId) ? { ...r, folderId: undefined } : r));
  });
}

/* ── folders of the Projects list: only a way to group the list, kept in studio.json; nothing moves on disk ── */

/** A folder's name: what a person typed, trimmed (the list shows 40 characters). */
function listFolderName(/** @type {unknown} */ name) {
  const clean = String(name ?? '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!clean) throw new ProjectError('a folder needs a name');
  return clean;
}

/** The list's folders, oldest first. */
async function native_listFolders() {
  return (await native_readState()).folders;
}

/** A new folder in the list: at the top level, or in the folder `parentId`. */
async function native_createFolder(/** @type {unknown} */ name, /** @type {unknown} */ parentId = null) {
  return exclusive(async () => {
    const state = await native_readState();
    const parent = typeof parentId === 'string' && parentId ? parentId : null;
    if (parent && !state.folders.some((f) => f.id === parent)) throw new ProjectError('no such folder', 404);
    const folder = { id: newId(), name: listFolderName(name), createdAt: Date.now(), ...(parent ? { parentId: parent } : {}) };
    state.folders.push(folder);
    await writeState(state);
    return folder;
  });
}

/** Rename a folder of the list. */
async function native_renameFolder(/** @type {string} */ id, /** @type {unknown} */ name) {
  return exclusive(async () => {
    const state = await native_readState();
    const folder = state.folders.find((f) => f.id === id);
    if (!folder) throw new ProjectError('no such folder', 404);
    folder.name = listFolderName(name);
    await writeState(state);
    return folder;
  });
}

/**
 * Move a folder of the list into another (null: the top level), with what is in it. Never into itself or a folder
 * inside it.
 * @param {string} id @param {string | null} parentId
 */
async function native_moveFolder(id, parentId) {
  return exclusive(async () => {
    const state = await native_readState();
    const folder = state.folders.find((f) => f.id === id);
    if (!folder) throw new ProjectError('no such folder', 404);
    if (parentId != null && !state.folders.some((f) => f.id === parentId)) throw new ProjectError('no such folder', 404);
    if (parentId != null && folderTree(state.folders, id).has(parentId)) throw new ProjectError('a folder cannot go inside itself', 400, 'inside-itself');
    if (parentId) folder.parentId = parentId;
    else delete folder.parentId;
    await writeState(state);
    return folder;
  });
}

/** A folder and every folder inside it, at any depth: their ids. @param {ProjectFolder[]} folders @param {string} id */
export function folderTree(folders, id) {
  const ids = new Set([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const f of folders) if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) { ids.add(f.id); grew = true; }
  }
  return ids;
}

/**
 * Take a folder off the list, with the folders inside it; their projects go back to the top level. Returns the ids of
 * the projects that were in them (deleting a folder deletes them too: the caller deletes each, see deleteProject).
 */
async function native_deleteFolder(/** @type {string} */ id) {
  return exclusive(async () => {
    const state = await native_readState();
    if (!state.folders.some((f) => f.id === id)) throw new ProjectError('no such folder', 404);
    const gone = folderTree(state.folders, id);
    state.folders = state.folders.filter((f) => !gone.has(f.id));
    const inside = state.recent.filter((r) => r.folderId && gone.has(r.folderId));
    for (const r of inside) delete r.folderId;
    await writeState(state);
    return inside.map((r) => r.id);
  });
}

/** Put a project in a folder of the list, or (null) back at the top level. */
async function native_moveProjectToFolder(/** @type {string} */ id, /** @type {string | null} */ folderId) {
  return exclusive(async () => {
    const state = await native_readState();
    const entry = state.recent.find((r) => r.id === id);
    if (!entry) throw new ProjectError('no such project', 404);
    if (folderId != null && !state.folders.some((f) => f.id === folderId)) throw new ProjectError('no such folder', 404);
    if (folderId) entry.folderId = folderId;
    else delete entry.folderId;
    await writeState(state);
    return describe(entry);
  });
}

/** The project with this id, or a 404. */
async function native_projectById(/** @type {string} */ id) {
  const found = (await native_readState()).recent.find((r) => r.id === id);
  if (!found) throw new ProjectError('no such project', 404);
  return describe(found);
}

/**
 * The person opened the project in Studio (from the Projects window, or by its address): it is the one opened last, as
 * `openProject` makes a project the CLI opens, so `openfilm open` alone comes back to it.
 */
async function native_markOpened(/** @type {string} */ id) {
  return exclusive(async () => {
    const state = await native_readState();
    const entry = state.recent.find((r) => r.id === id);
    if (!entry) throw new ProjectError('no such project', 404);
    entry.openedAt = Date.now();
    state.recent = [entry, ...state.recent.filter((r) => r !== entry)];
    await writeState(state);
    return describe(entry);
  });
}

/**
 * A project whose folder was moved or renamed outside Studio, found again: the list points at `path` from now on,
 * with the same id, so its place in the list stays (its history is in the folder, and follows it: history.mjs). The
 * folder must hold a film, and not be another project of the list.
 * @param {string} id @param {string} path
 */
async function native_locateProject(id, path) {
  return exclusive(async () => {
    const state = await native_readState();
    const entry = state.recent.find((r) => r.id === id);
    if (!entry) throw new ProjectError('no such project', 404);
    const profile = readIsolationProfile();
    if (profile) {
      try { assertIsolationPath(profile,path,'projects'); }
      catch { throw new ProjectError('Project path is not available in this isolated instance.', 403, 'isolation-path'); }
    }
    const asked = resolve(path);
    refuse(asked);
    if (!existsSync(asked) || !statSync(asked).isDirectory()) throw new ProjectError('That folder does not exist.', 404, 'not-found');
    const folder = realpathSync(asked);
    refuse(folder);
    if (!existsSync(join(folder, FILM_FILE))) throw new ProjectError('There is no film.html in that folder.', 409, 'no-film');
    const other = state.recent.find((r) => r.id !== id && (r.path === folder || sameFolder(r.path, folder)));
    if (other) throw new ProjectError(`That folder is already in the list, as “${basename(other.path)}”.`, 409, 'listed');
    await mkdir(join(folder, TOOL_DIR), { recursive: true });
    await writeFile(join(folder, TOOL_DIR, '.gitignore'), '*\n');
    /* the folder carries the project's id: a copy made of it later is told apart from it (folderId) */
    let had = '';
    try { had = (await readFile(join(folder, TOOL_DIR, 'id'), 'utf8')).trim(); } catch { /* none yet */ }
    if (had !== id) await writeFile(join(folder, TOOL_DIR, 'id'), `${id}\n`);
    entry.path = folder;
    await writeState(state);
    return describe(entry);
  });
}

/** Rename a project: its folder is renamed beside itself (the project's name is its folder's name). */
async function native_renameProject(/** @type {string} */ id, /** @type {string} */ name) {
  return exclusive(async () => {
    const state = await native_readState();
    const entry = state.recent.find((r) => r.id === id);
    if (!entry) throw new ProjectError('no such project', 404);
    const to = join(dirname(entry.path), folderName(name));
    await includeProjects([to]);
    if (to === entry.path) return describe(entry);
    /* taken: retrying can't help, so it says so; the same folder in another case (on a disk that ignores it) is not */
    if (existsSync(to) && !sameFolder(to, entry.path)) throw new ProjectError(`the name "${basename(to)}" is taken: there is already a folder by that name beside this project`, 409);
    await rename(entry.path, to);
    entry.path = to;
    await writeState(state);
    return describe(entry);
  });
}

/**
 * Delete a project: its folder goes to the system's Trash (where the person can still take it back), and it leaves the
 * list. An unavailable project just leaves the list; any remaining files are kept.
 */
async function native_deleteProject(/** @type {string} */ id) {
  const found = (await native_readState()).recent.find((r) => r.id === id);
  if (!found) throw new ProjectError('no such project', 404);
  if (!projectMissing(found.path)) await moveToTrash(found.path);
  await forgetProject(id);
}

/** Take a project off the list. Its folder stays as it is. */
async function native_forgetProject(/** @type {string} */ id) {
  return exclusive(async () => {
    const state = await native_readState();
    state.recent = state.recent.filter((r) => r.id !== id);
    await writeState(state);
  });
}

/**
 * Move the library: from now on new projects go to `to` (null: the default), and with `move`, the projects in the old
 * library go with it, each folder whole (to "Name 2" when the new library already has a "Name"). Across disks a project
 * is copied, then its old folder goes to the Trash. Anything else in the old folder stays. A project that cannot move
 * stays where it is, in the list, and is named in `failed`. Across disks a project is copied whole and the old folder
 * sent to the trash; an old folder the trash will not take (the Recycle Bin refusing one bigger than it holds, a
 * trash on another disk) stays on the old disk and is named in `left`: the project has moved, the copy being whole.
 * @param {string | null} to @param {{ move?: boolean, choose: (folder: string | null) => void }} options
 */
async function native_moveLibrary(to, { move = false, choose }) {
  const from = libraryRoot();
  await native_readState();
  await includeProjects(libraryProjects(from));
  await includeProjects([resolve(from), resolve(to ?? libraryDefault())]);
  choose(to);
  const into = libraryRoot();
  await includeProjects([resolve(into)]);
  /** @type {{ name: string, error: string }[]} */
  const failed = [];
  /** @type {{ name: string, path: string, error: string }[]} */
  const left = [];
  let moved = 0;
  if (!move || resolve(from) === resolve(into) || !existsSync(from)) return { moved, failed, left };
  await mkdir(into, { recursive: true });
  return exclusive(async () => {
    const state = await native_readState();
    const realFrom = realpathSync(from);
    const moving = libraryProjects(from);
    await includeProjects(moving);
    for (const folder of moving) {
      let target = join(into, basename(folder));
      for (let n = 2; existsSync(target); n++) target = join(into, `${basename(folder)} ${n}`);
      await includeProjects([target]);
      try {
        try {
          await rename(folder, target);
        } catch (e) {
          if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'EXDEV') throw e;
          try {
            await cp(folder, target, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
          } catch (copying) {
            /* half a copy is no project: it goes, the original stays */
            if (existsSync(target)) await moveToTrash(target).catch(() => {});
            throw copying;
          }
          /* the copy whole, the project is moved; an old folder the trash refuses stays, and is said */
          try { await moveToTrash(folder); }
          catch (e) { left.push({ name: basename(folder), path: folder, error: /** @type {Error} */ (e).message }); }
        }
      } catch (e) {
        failed.push({ name: basename(folder), error: /** @type {Error} */ (e).message });
        continue;
      }
      moved++;
      const real = realpathSync(target);
      const was = join(realFrom, basename(folder));
      for (const r of state.recent) if (r.path === folder || r.path === was) r.path = real;
    }
    await writeState(state);
    return { moved, failed, left };
  });
}

const projectGuardContext = new AsyncLocalStorage();
const defaultProjectGuard = createProjectControlGuard();
export function withProjectControlGuard(guard, work) {
  try { assertGuardSwitch(guard); } catch (e) { throw new ProjectError(e.message, e.status, e.code); }
  return projectGuardContext.run(guard, work);
}

const projectLeaseContext = new AsyncLocalStorage();
function homeResources() { return { homes: [...new Set([resolve(studioHome()), resolve(sharedHome())])], roots: [], targets: [] }; }
function asProjectError(e) { if (e?.code?.startsWith('control-') && !(e instanceof ProjectError)) return new ProjectError(e.message, e.status, e.code); return e; }
function guardedSync(resources, work) { try { return (projectGuardContext.getStore() ?? defaultProjectGuard).withNativeAccessSync(resources, work); } catch (e) { throw asProjectError(e); } }
async function includeProjects(paths) {
  const lease = projectLeaseContext.getStore();
  if (!lease) throw new ProjectError('Project control is invalid.', 403, 'control-invalid');
  if (!paths.length) return;
  await lease.include(paths);
  // compoundOuter itself reads native path evidence, only after the candidate paths were admitted.
  const outers = paths.map(p => compoundOuter(p));
  await lease.include(outers);
  // Preserve native project-root aliases, but never traverse a linked metadata directory/file.
  // Batch every intended metadata path before the first caller can initialize any project.
  const metadata = [...new Set([...paths, ...outers])].flatMap(project => {
    let parent = resolve(project), tail = [];
    while (!existsSync(parent)) { tail.unshift(basename(parent)); const up = dirname(parent); if (up === parent) throw controlError(); parent = up; }
    const real = resolve(realpathSync(parent), ...tail);
    return ['', 'id', '.gitignore', 'cache/film-duration.json', 'cover.jpg', 'cover.png', 'cover.webp', 'cover.gif'].map(leaf => ordinaryControlPath(join(real, TOOL_DIR, leaf)));
  });
  await lease.include(metadata);
}
async function guardedProject(targets, work) {
  const guard = projectGuardContext.getStore() ?? defaultProjectGuard;
  try {
    return await guard.withNativeAccess(homeResources(), lease => projectLeaseContext.run(lease, async () => {
      checkPrivateControlState();
      const root = libraryRoot();
      await includeProjects([resolve(root), ...targets]);
      return work();
    }));
  } catch (e) { throw asProjectError(e); }
}
export function studioKey() { return guardedSync(homeResources(), () => { checkPrivateControlState(); return nativeStudioKey(); }); }
function checkPrivateControlState() {
  for (const home of homeResources().homes) {
    ordinaryControlPath(join(home, 'prefs.json'));
    const file = ordinaryControlPath(join(home, 'studio.json'));
    if (!existsSync(file)) continue;
    let raw;
    try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { throw controlError(); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw controlError();
    if (Object.hasOwn(raw, 'orangeControl')) throw controlError('control-required');
  }
}
export async function readState() { const args = []; return guardedProject([], () => native_readState(...args)); }
export async function openProject(path, options) { const args = [path, options]; return guardedProject([resolve(args[0])], () => exclusive(() => native_openProject(...args))); }
export async function createProject(name) { const args = [name]; return guardedProject([], () => exclusive(() => native_createProject(...args))); }
export async function listProjects() { const args = []; return guardedProject([], () => native_listProjects(...args)); }
export async function listFolders() { const args = []; return guardedProject([], () => native_listFolders(...args)); }
export async function createFolder(name, parentId) { const args = [name, parentId]; return guardedProject([], () => native_createFolder(...args)); }
export async function renameFolder(id, name) { const args = [id, name]; return guardedProject([], () => native_renameFolder(...args)); }
export async function moveFolder(id, parentId) { const args = [id, parentId]; return guardedProject([], () => native_moveFolder(...args)); }
export async function deleteFolder(id) { const args = [id]; return guardedProject([], () => native_deleteFolder(...args)); }
export async function moveProjectToFolder(id, folderId) { const args = [id, folderId]; return guardedProject([], () => native_moveProjectToFolder(...args)); }
export async function projectById(id) { const args = [id]; return guardedProject([], () => native_projectById(...args)); }
export async function markOpened(id) { const args = [id]; return guardedProject([], () => native_markOpened(...args)); }
export async function locateProject(id, path) { const args = [id, path]; return guardedProject([resolve(args[1])], () => native_locateProject(...args)); }
export async function renameProject(id, name) { const args = [id, name]; return guardedProject([], () => native_renameProject(...args)); }
export async function deleteProject(id) { const args = [id]; return guardedProject([], () => native_deleteProject(...args)); }
export async function forgetProject(id) { const args = [id]; return guardedProject([], () => native_forgetProject(...args)); }
export async function moveLibrary(to, options) { const args = [to, options]; return guardedProject([resolve(args[0] ?? libraryDefault())], () => native_moveLibrary(...args)); }

const projectControlCapabilities = Object.freeze({ scope: 'projects-admission-v1', projectsApiFenced: true, registrationWritesDenyMarkersOnly: true, nativeEntryPointsFenced: false, backgroundIoDrained: false, productionControlledActivation: false, ownerAuthorization: false });
/** Trusted Node producer only. This writes deny markers, never an owner or an activation permission. */
export async function registerProjectControl(identity) {
  const invalid = () => new ProjectError('Project control is invalid.', 403, 'control-invalid');
  // Inspect descriptors rather than executing a supplied getter.
  if (types.isProxy(identity) || !identity || typeof identity !== 'object' || Object.getPrototypeOf(identity) !== Object.prototype) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(identity);
  if (Reflect.ownKeys(descriptors).length !== 2 || ['domainId','environmentId'].some(k => !descriptors[k] || !('value' in descriptors[k]) || typeof descriptors[k].value !== 'string' || !descriptors[k].value.trim())) throw invalid();
  const { domainId, environmentId } = identity;
  const guard = projectGuardContext.getStore() ?? defaultProjectGuard;
  return exclusive(async () => {
    let reservation;
    try {
      // Reserve the prefs homes before discovering the library, then atomically reserve the whole set.
      const homes = homeResources();
      reservation = await guard.acquireControlledReservation(homes);
      for (const home of homes.homes) ordinaryControlPath(join(home, 'prefs.json'));
      const root = resolve(nativeLibraryRoot());
      reservation.close(); reservation = null;
      reservation = await guard.acquireControlledReservation({ ...homes, roots: [root] });
      if (resolve(nativeLibraryRoot()) !== root) throw invalid();
      const home = resolve(studioHome()), file = ordinaryControlPath(join(home, 'studio.json'));
      const markers = [...new Set([home, root])].map(at => ordinaryControlPath(join(at, '.openfilm-control.json')));
      // A registration may reopen its own two committed markers, never an ancestor's domain.
      for (const start of [...homes.homes, root]) for (let at = start;; at = dirname(at)) {
        for (const candidate of [join(at, '.openfilm-control.json'), join(at, '.film', 'control.json')]) {
          ordinaryControlPath(candidate);
          if (existsSync(candidate) && !markers.includes(candidate)) throw controlError('control-required');
        }
        if (dirname(at) === at) break;
      }
      let raw = {};
      if (existsSync(file)) {
        try { raw = JSON.parse(await readFile(file, 'utf8')); } catch { throw invalid(); }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid();
      }
      // Resolve the library without creating it, including a missing final tail.
      let parent = root, tail = [];
      while (!existsSync(parent)) { tail.unshift(basename(parent)); parent = dirname(parent); }
      const canonicalRoot = resolve(realpathSync(parent), ...tail);
      const expected = { version: 1, domainId, environmentId, registration: 'committed', roots: [canonicalRoot] };
      const control = raw.orangeControl;
      if (control !== undefined) {
        if (!control || typeof control !== 'object' || Array.isArray(control) || Object.keys(control).sort().join() !== Object.keys(expected).sort().join() || control.version !== 1 || control.domainId !== domainId || control.environmentId !== environmentId || control.registration !== 'committed' || !Array.isArray(control.roots) || control.roots.length !== 1 || control.roots[0] !== canonicalRoot) throw invalid();
        for (const marker of markers) {
          let value; try { value = JSON.parse(await readFile(marker, 'utf8')); } catch { throw invalid(); }
          if (!value || Object.keys(value).sort().join() !== 'domainId,version' || value.version !== 1 || value.domainId !== domainId) throw invalid();
        }
      } else {
        if (markers.some(p => existsSync(p))) throw invalid();
        await mkdir(home, { recursive: true });
        // No rollback removes pending state: an interrupted registration remains denied.
        await writeAtomic(file, JSON.stringify({ ...raw, orangeControl: { ...expected, registration: 'pending' } }));
        await mkdir(root, { recursive: true });
        for (const marker of markers) await writeFile(marker, JSON.stringify({ version: 1, domainId }), { flag: 'wx', mode: 0o600 });
        await writeAtomic(file, JSON.stringify({ ...raw, orangeControl: expected }));
      }
      const handle = Object.freeze({ ...reservation, capabilities: projectControlCapabilities });
      reservation = null;
      return handle;
    } catch (e) { throw e?.code?.startsWith('control-') ? asProjectError(e) : invalid(); }
    finally { if (reservation) reservation.close(); }
  });
}
