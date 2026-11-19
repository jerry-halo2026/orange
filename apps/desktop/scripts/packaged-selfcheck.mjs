// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * What an unpacked app (`release.mjs --dir`) must carry, checked where the app will read it from.
 *
 * A build can finish and still be an install nobody can use: the modules the MCP tools load were missing once
 * (`material-tools.mjs` and its two imports), and so was the environment the app signs into, so every material call
 * answered `not-configured` and the window could not even say which environment it belonged to. `--dir` looked at
 * fission and ffmpeg only, so neither absence failed a build.
 *
 * Each check below is one thing that was missing, named with the path it should be at, and each failure says what is
 * not there — an installer short of a file is a failed build, not a warning. The rule for the environment file is the
 * app's own (`environmentProblems()` from `packages/openfilm/src/auth-environment.mjs`), so the check and the reader
 * cannot disagree about what "the three keys" means.
 *
 * Run on its own to look at a build already made, without making it again:
 *   node scripts/packaged-selfcheck.mjs --platform=win-x64
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { environmentProblems } from '../../../packages/openfilm/src/auth-environment.mjs';
import { PACKED_EDITOR_ROOT, PACKED_MATERIAL_MODULES } from './packed-editor-modules.mjs';

/** The build's own description of the environment it signs into (`resolveEnvironment({ resourcesDir })` reads it). */
export const AUTH_ENVIRONMENT_FILE = 'auth-environment.json';

/**
 * Where a build's `resources` folder is: electron-builder's own layout, not a guess.
 * @param {{out: string, win: boolean, arch: string, name: string}} build
 */
export function unpackedResources({ out, win, arch, name }) {
  return win ? join(out, 'win-unpacked', 'resources') : join(out, `mac${arch === 'arm64' ? '-arm64' : ''}`, `${name}.app`, 'Contents', 'Resources');
}

/** @typedef {{ label: string, ok: boolean, detail: string, missing: string[] }} Check */

/** One check from the paths that should be there: the ones present, or the ones missing, always spelled out. */
function verdict(label, wanted) {
  const missing = wanted.filter((file) => !existsSync(file));
  if (missing.length) return { label, ok: false, detail: missing.join(', '), missing };
  return { label, ok: true, detail: wanted.join(', '), missing: [] };
}

/**
 * The environment file: there, JSON, and the three fields a sign-in needs. Its values are never printed — only which
 * fields it carries — because the file holds a key.
 * @param {string} resources @returns {Check}
 */
export function authEnvironmentCheck(resources) {
  const label = 'auth-environment';
  const file = join(resources, AUTH_ENVIRONMENT_FILE);
  if (!existsSync(file)) return { label, ok: false, detail: `${file} is missing`, missing: [file] };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return { label, ok: false, detail: `${file} is not JSON (${String(error?.message ?? error)})`, missing: [] };
  }
  const problems = environmentProblems(parsed);
  if (problems.length) return { label, ok: false, detail: `${file} lacks ${problems.join(', ')}`, missing: problems };
  return { label, ok: true, detail: `${file} (${Object.keys(parsed).sort().join(', ')})`, missing: [] };
}

/**
 * The material index modules the `material.*` tools load from `resources/openfilm`: `material-tools.mjs` and the two
 * files it imports. Their absence is exactly the `not-configured` answer this check exists to stop shipping.
 * @param {string} resources @returns {Check}
 */
export function materialModulesCheck(resources) {
  return verdict('material modules', PACKED_MATERIAL_MODULES.map((relative) => join(resources, PACKED_EDITOR_ROOT, relative)));
}

/**
 * ffmpeg and ffprobe, both: the mixer's FFmpeg is this folder (`src/ffmpeg-runtime.mjs`), and a build carrying one of
 * the two programs answers "no video" the moment anything asks for a duration.
 * @param {string} resources @param {{win: boolean}} platform @returns {Check}
 */
export function ffmpegCheck(resources, { win }) {
  const dir = join(resources, 'runtime', 'ffmpeg');
  return verdict('ffmpeg', [join(dir, win ? 'ffmpeg.exe' : 'ffmpeg'), join(dir, win ? 'ffprobe.exe' : 'ffprobe')]);
}

/**
 * Fission, when this build has one: the batch mixer's CLI and the host that starts it.
 * @param {string} resources @param {{cli: string, host: string}} fission @returns {Check}
 */
export function fissionCheck(resources, fission) {
  return verdict('fission', [join(resources, 'fission', fission.cli), join(resources, 'fission', fission.host)]);
}

/**
 * Every check for one build, in the order they are reported. `ffmpeg` is false only where the build carries none
 * (no download exists for that platform and chip), and `fission` is null for the same reason.
 * @param {{out: string, win: boolean, arch: string, name: string,
 *          fission?: {cli: string, host: string} | null, ffmpeg?: boolean}} build
 * @returns {{ resources: string, checks: Check[], ok: boolean }}
 */
export function packagedSelfCheck({ out, win, arch, name, fission = null, ffmpeg = true }) {
  const resources = unpackedResources({ out, win, arch, name });
  const checks = [
    authEnvironmentCheck(resources),
    materialModulesCheck(resources),
    ...(ffmpeg ? [ffmpegCheck(resources, { win })] : []),
    ...(fission ? [fissionCheck(resources, fission)] : []),
  ];
  return { resources, checks, ok: checks.every((check) => check.ok) };
}

/**
 * The same, printed: one line per check, in full, the way a build log should read.
 * @param {{ resources: string, checks: Check[], ok: boolean }} result
 * @returns {{ lines: string[], ok: boolean }}
 */
export function reportSelfCheck({ resources, checks, ok }) {
  const lines = [`unpacked: ${resources}`];
  for (const check of checks) lines.push(check.ok ? `ok   ${check.label}: ${check.detail}` : `MISSING ${check.label}: ${check.detail}`);
  if (!ok) lines.push(`the unpacked app is incomplete: ${checks.filter((check) => !check.ok).map((check) => check.label).join(', ')}`);
  return { lines, ok };
}

/* On its own: check the build already in `.release/`, without building it again — the way to look at what an installed
   app actually carries (and to see a hand-deleted file fail). Same flags as `release.mjs`. */
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const platformArg = process.argv.find((arg) => arg.startsWith('--platform')) ?? '';
  const platformValue = platformArg.includes('=') ? platformArg.split('=')[1] : process.argv[process.argv.indexOf('--platform') + 1] ?? '';
  const win = /win/i.test(platformValue);
  const askedArch = process.argv.find((arg) => arg.startsWith('--arch='))?.slice('--arch='.length);
  const arch = askedArch === 'arm64' ? 'arm64' : 'x64';
  const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
  const brandFile = join(desktop, '..', '..', 'brand.json');
  const brand = existsSync(brandFile) ? JSON.parse(readFileSync(brandFile, 'utf8')) : {};
  const name = typeof brand.productName === 'string' && brand.productName.trim() ? brand.productName.trim() : 'OrangeFilm';
  const report = reportSelfCheck(packagedSelfCheck({ out: join(desktop, '.release', win ? `win-${arch}` : arch, 'out'), win, arch, name }));
  console.log(report.lines.join('\n'));
  process.exitCode = report.ok ? 0 : 1;
}
