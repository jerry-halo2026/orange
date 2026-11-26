// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The `orangefilm` command the chat's agents run: this app's copy of the package, so the Studio it finds is the one in
 * the window, at the version the window runs. A small script in the app's data folder, put first on the agents' PATH;
 * it runs the package's CLI with the app's own Node (Electron as Node). Reads no Electron module.
 *
 * ORANGE_NO_UPDATE_CHECK: the CLI's "a newer orangefilm is out, run npx -y orangefilm@latest" is not for this copy. The
 * app updates itself, and with it this command and the window's Studio: there is nothing for an agent to run.
 *
 * What the command alone needs from the app is set in it, not given to the agent: the app's ffmpeg first on its PATH
 * (`ffmpeg`) and the headless browser it draws pages in (`env`, PLAYWRIGHT_BROWSERS_PATH). The agent's own commands run
 * with the person's ffmpeg and their own browsers, as in their terminal.
 */
import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { nodeBinary } from './node-runtime.mjs';
import { readIsolationProfile, isolationEnvironment, assertIsolationPath } from 'orangefilm/development-isolation';
import { brandProductName } from './brand.mjs';
const PRODUCT = brandProductName();

const require = createRequire(import.meta.url);

/** The package's CLI. */
export function orangefilmCli() {
  const manifest = require.resolve('orangefilm/package.json');
  const bin = JSON.parse(readFileSync(manifest, 'utf8')).bin.orangefilm;
  return join(dirname(manifest), bin);
}

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** The script's text: Electron as Node, running the CLI with whatever it was given, with the app's ffmpeg and `env`. */
export function commandScript(node, cli, { ffmpeg = null, env = {} } = {}) {
  const set = [...Object.entries(env).map(([k, v]) => `${k}=${sq(v)}`), ...(ffmpeg ? [`PATH=${sq(ffmpeg)}:"$PATH"`] : [])];
  return `#!/bin/sh\n# ${PRODUCT}'s own copy of the orangefilm command (written by the app; changes are lost)\n${set.map((s) => `${s} `).join('')}ELECTRON_RUN_AS_NODE=1 ORANGE_NO_UPDATE_CHECK=1 exec ${sq(node)} ${sq(cli)} "$@"\n`;
}

/** The same for Windows: a `.cmd` (what a command line there finds as `orangefilm`). */
export function commandScriptWindows(node, cli, { ffmpeg = null, env = {} } = {}) {
  const isolated = Boolean(readIsolationProfile(env));
  const batch = (value) => String(value).replace(/%/g, '%%');
  const set = [...Object.entries(env).map(([k, v]) => `set "${k}=${batch(v)}"\r\n`), ...(ffmpeg ? [`set "PATH=${ffmpeg};%PATH%"\r\n`] : [])];
  return `@echo off\r\nrem ${PRODUCT}'s own copy of the orangefilm command (written by the app; changes are lost)\r\nsetlocal${isolated ? ' DisableDelayedExpansion' : ''}\r\n${set.join('')}set ELECTRON_RUN_AS_NODE=1\r\nset ORANGE_NO_UPDATE_CHECK=1\r\n"${node}" "${cli}" %*\r\n`;
}

/**
 * The command in `bin` as an agent's shell types it: its whole path, quoted. Some agents' shells read the person's
 * shell profile again (Codex, Cursor, CodeBuddy), and a PATH set there can put another `orangefilm` before the app's: an
 * older one installed globally, on the person's own Studio. Null on Windows, where the name on the PATH is kept.
 */
export function orangefilmCommand(bin, platform = process.platform) {
  return platform === 'win32' ? null : sq(`${bin}/orangefilm`);
}

/**
 * Write the command into `<dir>/bin` and answer that folder, for PATH. `ffmpeg`: the app's ffmpeg folder, first on the
 * command's PATH; `env`: what else it runs with. It names itself by its whole path (ORANGE_RUN, orangefilmCommand) in
 * all it prints, the manual too.
 */
export function installOrangefilmCommand(dir, { node = nodeBinary(), platform = process.platform, ffmpeg = null, env = {} } = {}) {
  const profile = readIsolationProfile(env);
  if (profile) {
    assertIsolationPath(profile,dir,'userData');
    env = {...env,...isolationEnvironment(profile)};
  }
  const bin = join(dir, 'bin');
  if (profile) {
    assertIsolationPath(profile,bin,'userData');
    const target = join(bin,platform === 'win32' ? 'orangefilm.cmd' : 'orangefilm');
    const info = lstatSync(target,{throwIfNoEntry:false});
    if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error('Isolated CLI command must not be a linked alias.');
  }
  mkdirSync(bin, { recursive: true });
  if (platform === 'win32') {
    writeFileSync(join(bin, 'orangefilm.cmd'), commandScriptWindows(node, orangefilmCli(), { ffmpeg, env }));
    writeFileSync(join(bin, 'orangefilm.cmd'), commandScriptWindows(node, orangefilmCli(), { ffmpeg, env }));
    return bin;
  }
  const file = join(bin, 'orangefilm');
  writeFileSync(file, commandScript(node, orangefilmCli(), { ffmpeg, env: { ...env, ORANGE_RUN: orangefilmCommand(bin, platform) } }));
  chmodSync(file, 0o755);
  const alias = join(bin, 'orangefilm');
  writeFileSync(alias, commandScript(node, orangefilmCli(), { ffmpeg, env: { ...env, ORANGE_RUN: orangefilmCommand(bin, platform) } }));
  chmodSync(alias, 0o755);
  return bin;
}
