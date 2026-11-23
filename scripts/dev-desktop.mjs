#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * `pnpm dev:desktop`: the desktop app, with the material index bootstrapping beside it.
 *
 * Two things, in this order, and the order is the whole point:
 *
 *  1. **the index** — `packages/orangefilm/scripts/material-index-bootstrap.mjs --detach` is spawned detached, its output
 *     discarded, and it is never awaited. If the index is missing or past its 24 h window it sweeps in the background
 *     and writes its progress to `~/.openfilm-dev/material-index/status.json`; if it is fresh it does nothing at all.
 *     A launcher that cannot even start that child (no node, a locked spawn) prints one line and goes on.
 *  2. **the window** — `pnpm --filter @openfilm/desktop start`, with stdio inherited so the app's own output is what you
 *     see. The exit code is the app's, and Ctrl+C reaches it.
 *
 * The index can therefore never stop the app from starting: it is a separate process with no way to fail back into this
 * one. What it *can* do is be seen — `node packages/orangefilm/scripts/material-index-bootstrap.mjs --status` says
 * `absent` / `building` / `landed` / `stale` / `failed` at any moment, with the reason when it failed.
 *
 * `OPENFILM_DESKTOP_START` replaces the command (used to verify this wiring without opening a window); it is not a
 * product setting, and the default is the real app.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The bootstrap CLI this launches (`--detach`). */
export const BOOTSTRAP_SCRIPT = join(ROOT, 'packages', 'openfilm', 'scripts', 'material-index-bootstrap.mjs');

/** What `dev:desktop` starts: the desktop package's own `start`. */
export const DESKTOP_ARGS = Object.freeze(['--filter', '@openfilm/desktop', 'start']);

/** The command line, as `[command, ...args]`; `OPENFILM_DESKTOP_START` wins when it is set. */
export function desktopCommand(env = process.env) {
  const override = typeof env.OPENFILM_DESKTOP_START === 'string' ? env.OPENFILM_DESKTOP_START.trim() : '';
  if (override) {
    const [command, ...args] = override.split(/\s+/);
    return [command, ...args];
  }
  return ['pnpm', ...DESKTOP_ARGS];
}

/**
 * Spawn the index bootstrap and forget it: `detached`, `stdio: 'ignore'`, `unref()`. Returns what happened, never
 * throws — a bootstrap that cannot start is a line in the log, not a failed launch.
 * @param {{spawnFn?: typeof spawn, execPath?: string, script?: string, env?: NodeJS.ProcessEnv, cwd?: string}} [options]
 */
export function startMaterialIndexBootstrap({
  spawnFn = spawn, execPath = process.execPath, script = BOOTSTRAP_SCRIPT, env = process.env, cwd = ROOT,
} = {}) {
  try {
    const child = spawnFn(execPath, [script, '--detach', '--quiet'], {
      cwd, detached: true, stdio: 'ignore', windowsHide: true, env,
    });
    child?.on?.('error', () => { /* the child's failure is its own; it is recorded in status.json, not here */ });
    child?.unref?.();
    return { spawned: true, pid: child?.pid ?? null };
  } catch (error) {
    return { spawned: false, pid: null, error: String(/** @type {any} */ (error)?.message ?? error) };
  }
}

/**
 * Start the app and resolve with its exit code (0 when it exited without one, 1 when it died from a signal).
 * Signals are forwarded unless `forwardSignals` is false (a test must not add process listeners).
 * @param {{spawnFn?: typeof spawn, env?: NodeJS.ProcessEnv, cwd?: string, forwardSignals?: boolean}} [options]
 */
export function startDesktop({ spawnFn = spawn, env = process.env, cwd = ROOT, forwardSignals = true } = {}) {
  const [command, ...args] = desktopCommand(env);
  const child = spawnFn(command, args, { cwd, stdio: 'inherit', env, shell: process.platform === 'win32' });
  if (forwardSignals) {
    const forward = (/** @type {NodeJS.Signals} */ signal) => { try { child.kill(signal); } catch { /* already gone */ } };
    process.once('SIGINT', () => forward('SIGINT'));
    process.once('SIGTERM', () => forward('SIGTERM'));
  }
  return new Promise((/** @type {(code: number) => void} */ done) => {
    child.once('exit', (code, signal) => done(typeof code === 'number' ? code : signal ? 1 : 0));
    child.once('error', (error) => {
      console.error(`dev:desktop: 启动 ${command} 失败：${String(/** @type {any} */ (error)?.message ?? error)}`);
      done(1);
    });
  });
}

const isMain = () => {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return fileURLToPath(import.meta.url) === entry; } catch { return false; }
};

if (isMain()) {
  const bootstrap = startMaterialIndexBootstrap();
  if (!bootstrap.spawned) {
    console.warn(`dev:desktop: 素材索引自举没能启动（${bootstrap.error ?? 'unknown'}），不影响应用启动`);
  }
  process.exitCode = await startDesktop();
}
