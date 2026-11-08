// @ts-check
/**
 * What changes in a project folder while someone watches it: film.html (`film`, with its new revision) or any other
 * file (`files`: a page, a picture, a sound). A write of someone else's is merged with the person's edits first
 * (person-edits.mjs), so the pages hear of the film and the files as they end up. One watcher per open project, shared
 * by every page showing it, closed when the last one leaves. Studio's own folders and the usual build and dependency
 * folders are not watched.
 */
import { readdirSync, watch } from 'node:fs';
import { join } from 'node:path';
import { readProjectFilm, settleProjectFilm } from './film.mjs';
import { settleFiles } from './person-edits.mjs';
import { FILM_FILE } from '../../src/film-doc.mjs';
import { projectMissing } from './project-presence.mjs';

/* a dot folder is a tool's (Studio's own .film, .git…, a compound clip's film's own too, in parts/), and what builds
   and packages make is not the film */
const IGNORED = /(^|[/\\])(\.[^/\\]+|node_modules|dist|build)([/\\]|$)/;
/** How long changes are gathered before one event: an agent writes a file in several chunks, and often several files. */
const SETTLE_MS = 120;
/** How long missing project files are rechecked before their pages are told (the project gone, or its film.html). */
const GONE_RECHECK_MS = 400;
/** A deleted root is not reliably reported by every file system's watcher. */
const PRESENCE_MS = 1000;

/* Studio's own half-written files (a file written whole through a random-named sibling, atomic.mjs; an import
   streaming in, files.mjs): only the result is a change */
const WRITING = /(^|[/\\])([^/\\]+\.[0-9a-f-]{8,}\.tmp|\.\d+\.\d+\.importing)$/;

/**
 * `files`: `paths` are the files that changed (folder relative), or none when the system could not say.
 * `ask` / `asked`: a question about spending for the person, and that it was answered; `notice`: something the person
 * is told, such as a provider with no balance left (get.mjs).
 * `history`: the version history changed (history.mjs); `moved`: its action changed the folder's files (a version
 * restored), so Studio's own state of the film is read again. `history-progress`: how far an action is, `op` which
 * ('save', 'restore'…).
 * `project`: the project renamed, as it is now. `canvas`: an agent changed the canvas (canvas.mjs).
 * @typedef {{ type: 'film', rev: string } | { type: 'files', paths?: string[] } | { type: 'history', moved?: boolean } | { type: 'export', job: object }
 *   | { type: 'history-progress', op: string, phase: string, done: number, total: number } | { type: 'project', project: object }
 *   | { type: 'ask', ask: object } | { type: 'asked', id: string } | { type: 'notice', notice: object }
 *   | { type: 'canvas' } | { type: 'film-missing' } | { type: 'gone' }} FolderEvent   `gone`: the project was deleted, or
 *   its folder is missing. `film-missing`: its folder is there but film.html is not (being written again, or lost): the
 *   project stays open, and its pages hear of the film (`film`) once it is back
 */

/** @typedef {{ readProjectFilm?: typeof readProjectFilm, settleProjectFilm?: typeof settleProjectFilm, settleFiles?: typeof settleFiles }} TrustedNode */

/**
 * Watch `root`; `send` gets each change once it settles. Returns `close`.
 * @param {string} root @param {(event: FolderEvent) => void} send
 * @param {{ trustedNode?: TrustedNode }} [options] Internal Node wrappers only; defaults are the original IO functions.
 * @returns {() => Promise<void>} Stable completion of entered IO and actual watcher close events, not merge success.
 */
export function watchFolder(root, send, { trustedNode = {} } = {}) {
  const read = trustedNode.readProjectFilm ?? readProjectFilm;
  const settleFilm = trustedNode.settleProjectFilm ?? settleProjectFilm;
  const settleOther = trustedNode.settleFiles ?? settleFiles;
  /** @type {Set<Promise<void>>} */
  const work = new Set();
  // Record ownership before invoking external code, including synchronous throws/reentry.
  /** @param {() => Promise<void>} job */
  const track = (job) => {
    const task = Promise.resolve().then(job).catch(() => {});
    work.add(task);
    void task.then(() => work.delete(task));
    return task;
  };
  /** @type {Promise<void> | undefined} */
  let closing;
  /** @type {Set<'film' | 'files'>} */
  const pending = new Set();
  /** @type {Set<string> | null} null: some change could not say which file */
  let paths = new Set();
  let timer = /** @type {NodeJS.Timeout | null} */ (null);
  let lastRev = '';
  let closed = false;
  let checking = false;
  let gone = false;
  /* film.html missing from a folder still there, and said so */
  let filmMissing = false;
  track(async () => { const f = await read(root); if (!closed) lastRev = f.rev; });

  const flush = async () => {
    timer = null;
    if (closed || gone || checking) return;
    checking = true;
    try {
      /* A missing film is not an empty one. Recheck after a short grace period: editors can replace files while
         saving, and a rename in Studio moves the subscription to its new folder, closing this watcher. */
      let missing = projectMissing(root);
      if (missing) {
        await new Promise((done) => setTimeout(done, GONE_RECHECK_MS));
        if (closed) return;
        missing = projectMissing(root);
        if (missing === 'folder') { gone = true; pending.clear(); send({ type: 'gone' }); return; }
      }
      /* Only the folder going ends the project. film.html alone can be missing for minutes while an agent writes it
         again (a tool that deletes the file, then adds it whole): its pages are told, and the film once it is back,
         even with the same text as before */
      if (missing === 'film') {
        pending.delete('film');
        if (!filmMissing) { filmMissing = true; lastRev = ''; send({ type: 'film-missing' }); }
      } else if (filmMissing) { filmMissing = false; pending.add('film'); }
      if (closed) return;
      const kinds = [...pending];
      const changed = paths;
      pending.clear();
      paths = new Set();
      if (kinds.includes('film')) {
        const { rev } = await Promise.resolve().then(() => settleFilm(root, { stable: true })).catch(() => ({ rev: '' }));
        /* the same text written again (an editor's save, Studio's own write echoed back) is no change */
        if (closed) return;
        /* deleted during the read: wait for presence to settle instead of publishing an empty film */
        if (projectMissing(root)) { pending.add('film'); return; }
        if (rev && rev !== lastRev) { lastRev = rev; send({ type: 'film', rev }); }
      }
      if (closed) return;
      if (kinds.includes('files')) {
        await settleOther(root, changed ? [...changed] : null);
        if (closed) return;
        send(changed ? { type: 'files', paths: [...changed] } : { type: 'files' });
      }
    } finally {
      checking = false;
      if (!closed && !gone && pending.size) schedule();
    }
  };
  const schedule = () => { if (!timer && !checking && !closed && !gone) timer = setTimeout(() => { if (!closed) track(flush); }, SETTLE_MS); };

  const close = watchTree(root, (name) => {
    if (closed || gone) return;
    if (!name) { pending.add('files'); pending.add('film'); paths = null; }
    else {
      const rel = name;
      if (IGNORED.test(rel) || WRITING.test(rel)) return;
      if (rel === FILM_FILE) pending.add('film');
      else { pending.add('files'); paths?.add(rel); }
    }
    schedule();
  });
  /* the folder gone, or film.html gone or back since last said */
  const presence = setInterval(() => {
    if (closed || gone) return;
    try {
      const missing = projectMissing(root);
      if (missing === 'folder' || (missing === 'film') !== filmMissing) schedule();
    } catch { /* next presence check may succeed */ }
  }, PRESENCE_MS);
  presence.unref();
  return () => {
    if (closing) return closing;
    closed = true;
    clearInterval(presence);
    if (timer) clearTimeout(timer);
    const handles = close();
    closing = Promise.all([handles, ...work]).then(() => {});
    return closing;
  };
}

/**
 * Every change under `root`, as a folder-relative name (null: something changed, the system could not say what).
 * macOS and Windows watch a tree natively. Elsewhere Node's recursive watch follows each file's inode, so a file
 * replaced by a rename (film.html written by a rename, most editors' saves) goes unseen after the first time: there each
 * folder is watched on its own, which names whatever lands in it, and a new folder is taken in as it appears.
 * @param {string} root @param {(name: string | null) => void} onChange @param {boolean} [native] @returns {() => Promise<void>} close
 */
export function watchTree(root, onChange, native = process.platform === 'darwin' || process.platform === 'win32') {
  let closed = false;
  /** @type {Promise<void> | undefined} */
  let closing;
  /** @type {Set<import('node:fs').FSWatcher>} */
  const handles = new Set();
  /** @type {Set<Promise<void>>} */
  const completions = new Set();
  /** @param {import('node:fs').FSWatcher} watcher */
  const own = (watcher) => {
    handles.add(watcher);
    const done = new Promise(resolve => watcher.once('close', () => resolve()));
    completions.add(done);
    void done.then(() => { handles.delete(watcher); completions.delete(done); });
  };
  /** @param {string | null} name */
  const changed = (name) => { if (!closed) { try { onChange(name); } catch { /* notification failure is not a handle failure */ } } };
  const close = () => {
    if (closing) return closing;
    closed = true;
    closing = Promise.all([...completions]).then(() => {});
    for (const watcher of handles) watcher.close();
    return closing;
  };
  if (native) {
    let watcher;
    try { watcher = watch(root, { recursive: true }, (_event, name) => changed(name ? String(name).split('\\').join('/') : null)); }
    catch { return close; }
    own(watcher);
    watcher.on('error', () => { watcher.close(); changed(null); });
    return close;
  }
  /** @type {Map<string, import('node:fs').FSWatcher>} */
  const folders = new Map();
  const add = (/** @type {string} */ rel) => {
    if (closed || folders.has(rel) || (rel && IGNORED.test(rel))) return;
    let watcher;
    try {
      watcher = watch(rel ? join(root, rel) : root, (_event, name) => {
        if (closed) return;
        if (!name) { changed(null); return; }
        const path = rel ? rel + '/' + name : String(name);
        changed(path);
        if (closed) return;
        try { if (readdirSync(join(root, path))) { add(path); addBelow(path); } } catch { /* a file, or gone */ }
      });
    } catch { return; }
    own(watcher);
    watcher.on('error', () => { watcher.close(); if (folders.get(rel) === watcher) folders.delete(rel); changed(null); });
    folders.set(rel, watcher);
  };
  const addBelow = (/** @type {string} */ rel) => {
    if (closed || (rel && IGNORED.test(rel))) return;
    let entries;
    try { entries = readdirSync(rel ? join(root, rel) : root, { withFileTypes: true }); } catch { return; }
    for (const e of entries) if (!closed && e.isDirectory()) { const sub = rel ? rel + '/' + e.name : e.name; add(sub); addBelow(sub); }
  };
  add('');
  addBelow('');
  return close;
}

/**
 * Every project someone is watching, and who: `subscribe` starts the folder's watcher with its first listener and stops
 * it with its last. `onChange` hears every change of a watched folder itself (not what `emit` tells).
 * @param {{ onChange?: (root: string, e: FolderEvent) => void, trustedNode?: TrustedNode }} [o]
 */
export function createWatchers({ onChange, trustedNode } = {}) {
  let terminal = false;
  /** @type {Promise<void> | undefined} */
  let draining;
  /** @type {Set<Promise<void>>} */
  const retired = new Set();
  /** @param {{ close: () => Promise<void> }} entry */
  const retire = (entry) => {
    const done = entry.close();
    retired.add(done);
    void done.then(() => retired.delete(done));
  };
  /** @typedef {{ root: string, listener: (e: FolderEvent) => void }} Subscription */
  /** @type {Map<string, { close: () => Promise<void>, listeners: Set<Subscription> }>} */
  const byRoot = new Map();
  /** @param {string} root @param {Set<Subscription>} listeners */
  const start = (root, listeners) => {
    const entry = { listeners, close: watchFolder(root, (e) => {
      if (terminal || byRoot.get(root) !== entry) return;
      try { onChange?.(root, e); } catch { /* isolate listeners */ }
      for (const subscription of listeners) {
        if (terminal || byRoot.get(root) !== entry) break;
        try { subscription.listener(e); } catch { /* isolate listeners */ }
      }
    }, { trustedNode }) };
    return entry;
  };
  return {
    /** @param {string} root @param {(e: FolderEvent) => void} listener */
    subscribe(root, listener) {
      if (terminal) return () => {};
      let entry = byRoot.get(root);
      if (!entry) {
        entry = start(root, new Set());
        byRoot.set(root, entry);
      }
      const subscription = { root, listener };
      entry.listeners.add(subscription);
      return () => {
        const current = byRoot.get(subscription.root);
        if (!current || !current.listeners.has(subscription)) return;
        current.listeners.delete(subscription);
        if (!current.listeners.size) { byRoot.delete(subscription.root); retire(current); }
      };
    },
    /** A renamed folder: keep its pages subscribed, but watch and read the new path. */
    move(/** @type {string} */ from, /** @type {string} */ to) {
      if (terminal || from === to) return;
      const entry = byRoot.get(from);
      if (!entry) return;
      retire(entry);
      byRoot.delete(from);
      const target = byRoot.get(to);
      if (target) retire(target);
      for (const subscription of target?.listeners ?? []) entry.listeners.add(subscription);
      for (const subscription of entry.listeners) subscription.root = to;
      byRoot.set(to, start(to, entry.listeners));
    },
    /** The projects someone is watching now. */
    roots: () => [...byRoot.keys()],
    /** Tell everyone watching `root` something the folder itself does not say (a new version in its history). */
    emit(/** @type {string} */ root, /** @type {FolderEvent} */ event) {
      const entry = byRoot.get(root);
      for (const { listener } of entry?.listeners ?? []) {
        if (terminal || byRoot.get(root) !== entry) break;
        try { listener(event); } catch { /* isolate listeners */ }
      }
    },
    closeAll() { const entries = [...byRoot.values()]; byRoot.clear(); for (const entry of entries) retire(entry); },
    drain() {
      if (draining) return draining;
      terminal = true;
      const entries = [...byRoot.values()]; byRoot.clear();
      for (const entry of entries) retire(entry);
      draining = Promise.all([...retired]).then(() => {});
      return draining;
    },
  };
}
