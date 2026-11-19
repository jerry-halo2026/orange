// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The app as the benchmark runs it: the `bench` flavour (src/flavor.mjs), everything in a throwaway folder, the
 * window's page built first, Electron with a DevTools port to drive and read both pages.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launcherEnvironment, loginShellEnvironment } from '../src/environment.mjs';

const require = createRequire(import.meta.url);
export const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The bench's own sign-in details, kept out of the repository's history in `.dev/bench-auth.env` (git-ignored):
 * `ORANGE_AUTH_CONFIG_FILE` (the isolated environment's runtime configuration, `{environmentId, authOrigin,
 * publishableKey}`), `ORANGE_BENCH_EMAIL` and `ORANGE_BENCH_PASSWORD`. Read here and nowhere else; never printed.
 */
const AUTH_FILES = [
  join(DESKTOP, '.dev', 'bench-auth.env'),
  resolve(DESKTOP, '..', '..', '.dev', 'bench-auth.env'),
];
const WANTED = ['ORANGE_AUTH_CONFIG_FILE', 'ORANGE_BENCH_EMAIL', 'ORANGE_BENCH_PASSWORD'];

/**
 * The sign-in details, or null when the bench is not signed in to anything. `ORANGE_AUTH_CONFIG_FILE` is put in
 * `process.env`, which is what the app started from here is given (src/environment.mjs: LAUNCHER_FLAGS), so Studio
 * reads the same runtime configuration. The email and the password stay in this process, for `signIn` alone.
 * @param {Record<string, string | undefined>} [environment]
 * @returns {{ configFile: string, email: string, password: string, file: string | null } | null}
 */
export function loadBenchAuth(environment = process.env) {
  const file = AUTH_FILES.find((path) => existsSync(path)) ?? null;
  /** @type {Record<string, string>} */
  const kept = {};
  if (file) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const found = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (found) kept[found[1]] = found[2].replace(/^(['"])([\s\S]*)\1$/, '$2');
    }
  }
  const pick = (name) => (typeof environment[name] === 'string' && environment[name] ? /** @type {string} */ (environment[name]) : kept[name] ?? '');
  const configFile = pick('ORANGE_AUTH_CONFIG_FILE');
  const email = pick('ORANGE_BENCH_EMAIL');
  const password = pick('ORANGE_BENCH_PASSWORD');
  if (!configFile || !email || !password) return null;
  process.env.ORANGE_AUTH_CONFIG_FILE = configFile;
  return { configFile, email, password, file };
}

/**
 * A test's sign-in, or `null` with the test skipped: the bench cannot sign in without `.dev/bench-auth.env`.
 * Without a test context (a file that runs its own scenario) the run ends here, saying why.
 * @param {{ skip?: (message: string) => void } | null} [t]
 */
export function withBenchAuth(t = null) {
  const auth = loadBenchAuth();
  if (auth) return auth;
  const reason = `bench sign-in is not configured: write ORANGE_AUTH_CONFIG_FILE, ORANGE_BENCH_EMAIL and ORANGE_BENCH_PASSWORD to ${AUTH_FILES[0]}`;
  if (t && typeof t.skip === 'function') {
    t.skip(reason);
    return null;
  }
  console.log(`Skipped: ${reason}`);
  process.exit(0);
}

/**
 * Sign in to the run's Studio (`POST /api/auth/sign-in`, from the Studio's own origin, as its window does). Studio
 * answers 200 `{ ok: true }`, else the failure's own code — never the attempt's details.
 * @param {{ origin: string, key: string }} run @param {{ email: string, password: string }} auth
 */
export async function signIn(run, auth) {
  const response = await fetch(`${run.origin}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-studio-key': run.key, origin: run.origin },
    body: JSON.stringify({ email: auth.email, password: auth.password }),
  });
  /** @type {{ ok?: boolean, code?: string } | null} */
  const result = await response.json().catch(() => null);
  assert.equal(response.status, 200, `bench sign-in: HTTP ${response.status}${result?.code ? ` (${result.code})` : ''}`);
  assert.equal(result?.ok, true, `bench sign-in: code ${result?.code ?? 'none'}`);
  return result;
}

/** The window the runs share: the same size every time. */
export const WINDOW = { width: 1600, height: 1000, chatWidth: 420 };

/** The window's page (shell/), as the app serves it. */
export function buildShell() {
  const vite = join(dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');
  execFileSync(process.execPath, [vite, 'build', '--config', 'shell/vite.config.ts', '--logLevel', 'warn'], { cwd: DESKTOP, stdio: 'inherit' });
}

/**
 * The sample film's footage, made once with ffmpeg and kept in .dev/ (git-ignored): two clips as heavy to decode as
 * camera footage (1280×720, 60 fps, ~16 Mb/s, moving noise over a test pattern) and a strip of trip.mp4's frames.
 */
function footage() {
  const dir = join(DESKTOP, '.dev', 'bench-media');
  if (existsSync(join(dir, 'ready'))) return dir;
  mkdirSync(dir, { recursive: true });
  const ffmpeg = (...args) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args]);
  const clip = (name, seconds, source) => ffmpeg('-f', 'lavfi', '-i', `${source}=size=1280x720:rate=60`, '-t', String(seconds), '-vf', 'noise=alls=24:allf=t',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-b:v', '16M', '-maxrate', '18M', '-bufsize', '32M', join(dir, name));
  clip('trip.mp4', 14.5, 'testsrc2');
  clip('broll.mp4', 6, 'mandelbrot');
  ffmpeg('-i', join(dir, 'trip.mp4'), '-vf', 'fps=2,scale=96:54,tile=29x1', '-frames:v', '1', join(dir, 'strip.jpg'));
  writeFileSync(join(dir, 'ready'), '');
  return dir;
}

/** The sample film, with its media, in `dir`. */
export function makeProject(dir) {
  mkdirSync(join(dir, 'assets'), { recursive: true });
  cpSync(join(DESKTOP, 'bench/fixture'), dir, { recursive: true });
  const media = footage();
  for (const name of ['trip.mp4', 'broll.mp4', 'strip.jpg']) cpSync(join(media, name), join(dir, 'assets', name));
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=30', '-f', 'lavfi', '-i', 'anoisesrc=d=30:a=0.03',
    '-filter_complex', '[0][1]amix=inputs=2:duration=first', '-c:a', 'aac', '-b:a', '96k', join(dir, 'assets/bed.m4a')]);
}

/** A fresh folder for one launch: the app's data (with the window's size), its Studio home and its projects. */
export function prepare(dir) {
  for (const sub of ['data', 'home', 'projects']) mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, 'data/window.json'), JSON.stringify({ bounds: { x: 60, y: 40, width: WINDOW.width, height: WINDOW.height }, chatWidth: WINDOW.chatWidth, chatOpen: true }));
}

/**
 * Start the app. Resolves once the process is up; `cdp` is the DevTools address.
 * @param {{ dir: string, cdpPort: number, log?: (line: string) => void }} o
 */
export async function launch({ dir, cdpPort, log = () => {} }) {
  const electron = require('electron');
  const { PATH } = await loginShellEnvironment();
  const env = { ...launcherEnvironment(process.env, PATH), OPENFILM_DESKTOP_FLAVOR: 'bench', OPENFILM_BENCH_DIR: dir };
  const child = spawn(electron, [DESKTOP, `--remote-debugging-port=${cdpPort}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => log(String(d)));
  child.stderr.on('data', (d) => log(String(d)));
  return { child, cdp: `http://127.0.0.1:${cdpPort}` };
}

/** Wait until DevTools answers. */
export async function waitForCdp(cdp, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(`${cdp}/json/version`)).ok) return; } catch { /* not yet */ }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error('the app did not open its DevTools port');
}

/** Stop the app as a person would (it stops its Studio first), then for sure. */
export async function quit(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const gone = new Promise((done) => child.once('exit', done));
  const late = new Promise((done) => setTimeout(done, 15_000));
  await Promise.race([gone, late]);
  if (child.exitCode === null) child.kill('SIGKILL');
}
