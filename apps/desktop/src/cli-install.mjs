// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * The `orangefilm` command on the person's PATH, for the app to offer instead of a line of shell to copy.
 *
 * macOS only: the app writes the command into its own data folder (`<userData>/bin/orangefilm`), and nothing puts that
 * folder on PATH — so a terminal says `orangefilm: command not found` (2026-11-26, and the same class of report as the
 * Windows "找不到 orangefilm.exe"). The app never edits a shell profile: it points a symlink in a folder that is
 * already on PATH at the shim, and when none of those folders is writable it says which line to add.
 *
 * Windows needs none of this: the app already appends `%APPDATA%\OrangeFilm\bin` to the user PATH and puts
 * `orangefilm.exe` beside itself (main.mjs `exposeCommandEverywhere`).
 */
import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Where `name` is on this machine as a *login shell* would see it (it reads the profile, which is what a terminal the
 * person opens later does), or null.
 * @param {string} name @returns {string | null}
 */
export function onPath(name) {
  for (const shell of ['/bin/zsh', '/bin/sh']) {
    try {
      const out = execFileSync(shell, ['-l', '-c', `command -v ${name}`], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      const found = out.split('\n').map((line) => line.trim()).find(Boolean);
      if (found) return found;
    } catch { /* that shell is not here, or it does not answer: the next one decides */ }
  }
  return null;
}

/**
 * The folders a symlink may be put in, best first: the ones a command line already searches, then two that people add.
 * Only the ones that exist and this user may write to are returned — a folder that needs an administrator is not one.
 * @param {{ platform?: NodeJS.Platform, home?: string, exists?: (path: string) => boolean, writable?: (path: string) => boolean }} [where]
 * @returns {string[]}
 */
export function candidateDirs(where = {}) {
  const platform = where.platform ?? process.platform;
  const home = where.home ?? homedir();
  if (platform === 'win32') return [];
  const exists = where.exists ?? ((/** @type {string} */ path) => existsSync(path));
  const writable = where.writable ?? ((/** @type {string} */ path) => {
    try { accessSync(path, constants.W_OK); return true; } catch { return false; }
  });
  return ['/usr/local/bin', join(home, '.local', 'bin'), join(home, 'bin')]
    .filter((dir) => exists(dir) && writable(dir));
}

/**
 * What the app can say about the command right now.
 * @param {{ platform?: NodeJS.Platform, home?: string, shim: string, found?: (name: string) => string | null }} where
 */
export function cliStatus({ platform = process.platform, home = homedir(), shim, found = onPath }) {
  const here = existsSync(shim);
  if (platform === 'win32') return { supported: false, here, onPath: found('orangefilm'), shim, installable: [] };
  return { supported: true, here, onPath: found('orangefilm'), shim, installable: candidateDirs({ platform, home }) };
}

/**
 * Point a symlink at the shim, in the first folder on PATH that this user may write to. An existing `orangefilm` that
 * does not point at our shim is left alone (it is somebody else's command), and said so.
 * @param {{ platform?: NodeJS.Platform, home?: string, shim: string, found?: (name: string) => string | null }} where
 * @returns {{ ok: boolean, code: string, path?: string, onPathAfter?: string | null }}
 */
export function installCli({ platform = process.platform, home = homedir(), shim, found = onPath }) {
  if (platform === 'win32') return { ok: false, code: 'not-needed' };
  if (!existsSync(shim)) return { ok: false, code: 'shim-missing' };
  const dirs = candidateDirs({ platform, home });
  if (!dirs.length) return { ok: false, code: 'no-writable-folder' };
  for (const dir of dirs) {
    const link = join(dir, 'orangefilm');
    try {
      if (existsSync(link)) {
        const mine = lstatSync(link).isSymbolicLink() && readlinkSync(link) === shim;
        if (mine) return { ok: true, code: 'already', path: link, onPathAfter: found('orangefilm') };
        continue; /* somebody else's `orangefilm`: not ours to replace */
      }
      symlinkSync(shim, link);
      return { ok: true, code: 'linked', path: link, onPathAfter: found('orangefilm') };
    } catch (error) {
      /* a folder that looked writable and is not: try the next one */
      try { if (existsSync(link) && lstatSync(link).isSymbolicLink() && readlinkSync(link) === shim) unlinkSync(link); } catch { /* nothing of ours to undo */ }
    }
  }
  return { ok: false, code: 'link-failed' };
}

/** The folder the shim lives in, from the shim itself (the app passes the shim it wrote). */
export function shimDir(/** @type {string} */ shim) {
  return dirname(shim);
}

/** The line to add when no folder can be written: what a terminal needs. */
export function pathLine(/** @type {string} */ shim) {
  return `export PATH="${shimDir(shim)}:$PATH"`;
}

/** Make the folders a person does not have yet, so `candidateDirs` has somewhere to put the link. */
export function makeUserBin(/** @type {string} */ home = homedir()) {
  const dir = join(home, '.local', 'bin');
  try { mkdirSync(dir, { recursive: true }); } catch { /* said by the caller when the link cannot be made */ }
  return dir;
}
