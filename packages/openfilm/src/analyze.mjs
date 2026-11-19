// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * The analysis component (`rea-video`): where it lives, whether it is installed, and what to tell the
 * person when it is not.
 *
 * It is **not** shipped in the installer: the manifest beside this file says what it is (Apache-2.0,
 * Python ≥ 3.10, ~180 MB with its model weights), and it is installed into the app's data folder the
 * first time analysis is used. This module is the skeleton of that install: it answers "where", "how
 * big", "is it there"; the download and unpack step is deliberately absent until the component's own
 * hashes are pinned (the same discipline as `apps/desktop/src/python-runtime.mjs`).
 *
 * Nothing here throws for "not installed": that is an ordinary state, reported as data.
 */
import { existsSync, readFileSync } from 'node:fs';
import { PRODUCT_NAME } from './product-name.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** This component's own description, read once. */
const HERE = new URL('../services/rea-video/', import.meta.url);

/** @returns {{ name: string, version: string, license: string, source: string, requires: { python: string }, entry: string, invoke: string[], install: { into: string, sizeMB: number, onDemand: boolean }, provides: string[] }} */
export function manifest() {
  return JSON.parse(readFileSync(new URL('manifest.json', HERE), 'utf8'));
}

/**
 * Where the component goes: `OPENFILM_SERVICES_ROOT` when something names it (tests, a portable
 * install), else the per-user application data folder that the desktop app uses.
 * @param {{ env?: NodeJS.ProcessEnv, platform?: string }} [options]
 */
export function servicesRoot({ env = process.env, platform = process.platform } = {}) {
  const named = (env.OPENFILM_SERVICES_ROOT ?? '').trim();
  if (named) return named;
  const product = (env.OPENFILM_PRODUCT_NAME ?? PRODUCT_NAME).trim() || PRODUCT_NAME;
  if (platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), product);
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', product);
  return join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), product);
}

/** The folder this component is installed into. */
export const componentDir = (/** @type {{ env?: NodeJS.ProcessEnv, platform?: string }} */ options = {}) => join(servicesRoot(options), manifest().install.into);

/** Whether the component is installed: its entry file and a marker the install writes. */
export function installed(options = {}) {
  const dir = componentDir(options);
  const described = manifest();
  return existsSync(join(dir, described.entry)) || existsSync(join(dir, '.installed'));
}

/**
 * What `openfilm analyze` says when it cannot run: a structured line a script can read (JSON on
 * stderr), never a stack trace, never a usage error.
 * @param {{ env?: NodeJS.ProcessEnv, platform?: string }} [options]
 */
export function missingReport(options = {}) {
  const described = manifest();
  return {
    analyze: 'unavailable',
    reason: 'component-missing',
    component: described.name,
    version: described.version,
    license: described.license,
    sizeMB: described.install.sizeMB,
    installsInto: componentDir(options),
    requires: { python: described.requires.python },
    message: `首次使用分析功能需要安装组件 ${described.name}（约 ${described.install.sizeMB} MB）`,
    hint: `openfilm services install ${described.name}`,
  };
}

/** The exit code `analyze` uses when the component is not installed: its own, not a usage error (2). */
export const NOT_INSTALLED_EXIT = 4;
