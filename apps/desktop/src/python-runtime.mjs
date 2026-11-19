// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

﻿/**
 * A Python 3 for the analysis component (`services/rea-video`), the same way the app gets ffmpeg
 * (src/ffmpeg-runtime.mjs): the installer brings one in its resources (`runtime/python`, with its
 * license and a note saying where its source is), or a build without one downloads it once into its
 * data folder. Nothing is guessed: every archive is checked against the sha256 pinned here, and a
 * download that does not match is thrown away — never unpacked, never left half-written.
 *
 * The builds are python-build-standalone's (`astral-sh/python-build-standalone`, MPL-2.0 for the
 * build scripts, the CPython license for Python itself): a relocatable Python 3.12 for each platform,
 * unpacked as a folder. The URLs follow its published release names; a release is only pinned here
 * once its archive's sha256 has been recorded, so `PYTHON_BUILDS` is the single place a version is
 * changed. A platform with no entry cannot download one (the person installs Python themselves).
 *
 * Reads no Electron module, so `node --test` can use it.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The oldest Python the analysis component runs on (rea-video's own requirement). */
export const PYTHON_MIN = '3.10';

/** The release the pinned builds come from: python-build-standalone, 2024-10-16 (CPython 3.12.7). */
const STANDALONE = 'https://github.com/astral-sh/python-build-standalone/releases/download/20241016';

/**
 * The pinned builds, one per platform: the Python version the folder is, the archive it comes from,
 * that archive's sha256 (filled in when a release is pinned — see below), and where its license lives.
 *
 * `sha256: null` means "not pinned yet": such a build is refused instead of trusted, so an unpinned
 * platform fails loudly rather than unpacking something nobody checked. `scripts/release.mjs` fills
 * the table (and ships the folder) for the platform it builds for.
 */
export const PYTHON_BUILDS = Object.freeze({
  'win32-x64': {
    version: '3.12.7',
    url: `${STANDALONE}/cpython-3.12.7+20241016-x86_64-pc-windows-msvc-shared-install_only.tar.gz`,
    sha256: null,
    license: { name: 'PSF-2.0', url: `${STANDALONE}/cpython-3.12.7+20241016-x86_64-pc-windows-msvc-shared-install_only.tar.gz.sha256` },
    binary: 'python.exe',
  },
  'darwin-arm64': {
    version: '3.12.7',
    url: `${STANDALONE}/cpython-3.12.7+20241016-aarch64-apple-darwin-install_only.tar.gz`,
    sha256: null,
    license: { name: 'PSF-2.0', url: `${STANDALONE}/cpython-3.12.7+20241016-aarch64-apple-darwin-install_only.tar.gz.sha256` },
    binary: 'python3',
  },
  'darwin-x64': {
    version: '3.12.7',
    url: `${STANDALONE}/cpython-3.12.7+20241016-x86_64-apple-darwin-install_only.tar.gz`,
    sha256: null,
    license: { name: 'PSF-2.0', url: `${STANDALONE}/cpython-3.12.7+20241016-x86_64-apple-darwin-install_only.tar.gz.sha256` },
    binary: 'python3',
  },
});

/** A download that brings nothing for this long has stalled. */
const STALL_MS = 30_000;
/** Where the license and where its source is go, beside the binaries (what the installer ships too). */
export const PYTHON_LICENSE_FILE = 'LICENSE.md';

/** The folder a Python runtime goes in, inside the app's data folder. */
export const pythonDir = (dataDir, platform = process.platform, arch = process.arch) => join(dataDir, 'runtime', 'python', `${platform}-${arch}`);

/** The program inside `dir` for this platform ('python.exe' on Windows, 'python/bin/python3' elsewhere). */
export const pythonBinary = (dir, platform = process.platform) => {
  const build = PYTHON_BUILDS[`${platform}-${process.arch}`];
  const name = build?.binary ?? (platform === 'win32' ? 'python.exe' : 'python3');
  return platform === 'win32' ? join(dir, name) : join(dir, 'python', 'bin', name);
};

/** Whether `dir` already holds a usable Python (the installer's folder, or a download that finished). */
export const pythonIn = (dir, platform = process.platform) => {
  const binary = pythonBinary(dir, platform);
  const marker = join(dir, 'python-runtime.json');
  if (!existsSync(binary) || !existsSync(marker)) return false;
  try {
    const recorded = JSON.parse(readFileSync(marker, 'utf8'));
    return typeof recorded?.version === 'string' && versionAtLeast(recorded.version, PYTHON_MIN);
  } catch {
    return false;
  }
};

/** Whether this machine has a pinned build to download at all. */
export const pythonDownloadable = (platform = process.platform, arch = process.arch) => {
  const build = PYTHON_BUILDS[`${platform}-${arch}`];
  return Boolean(build && build.sha256);
};

/** `3.12.7` is at least `3.10`? Compared as numbers, never as strings ('3.9' < '3.10'). */
export function versionAtLeast(/** @type {string} */ version, /** @type {string} */ minimum) {
  const parts = (/** @type {string} */ value) => {
    const list = value.split('.').map((piece) => Number.parseInt(piece, 10) || 0);
    while (list.length < 3) list.push(0);
    return list;
  };
  const [aMajor, aMinor, aPatch] = parts(version);
  const [bMajor, bMinor, bPatch] = parts(minimum);
  if (aMajor !== bMajor) return aMajor > bMajor;
  if (aMinor !== bMinor) return aMinor > bMinor;
  return aPatch >= bPatch;
}

/** @param {Buffer} bytes @param {string} expected */
const matches = (bytes, expected) => createHash('sha256').update(bytes).digest('hex') === expected.toLowerCase();

/**
 * Fetch the pinned archive for this platform and verify it — nothing is written until the bytes match
 * the pinned sha256, and a mismatch removes everything it wrote.
 * @param {string} dir @param {{ platform?: string, arch?: string, fetch?: typeof fetch, onProgress?: (fraction: number) => void, license?: boolean }} [options]
 */
export async function fetchPython(dir, { platform = process.platform, arch = process.arch, fetch: fetchImpl = fetch, onProgress = () => {}, license = false } = {}) {
  const key = `${platform}-${arch}`;
  const build = PYTHON_BUILDS[key];
  if (!build) throw new Error(`There is no Python runtime to download for ${key}: install Python ${PYTHON_MIN}+ yourself.`);
  if (!build.sha256) throw new Error(`The Python runtime for ${key} is not pinned yet (no sha256): it is never trusted unchecked.`);
  mkdirSync(dir, { recursive: true });
  const part = join(dir, 'python-runtime.tar.gz.part');
  let bytes;
  try {
    const response = await fetchImpl(build.url, { signal: AbortSignal.timeout(STALL_MS) });
    if (!response.ok) throw new Error(`The Python runtime download answered ${response.status}.`);
    const total = Number(response.headers.get('content-length') ?? 0);
    /** @type {Buffer[]} */
    const chunks = [];
    let got = 0;
    if (response.body) {
      // @ts-ignore a web stream is iterable in Node 18+
      for await (const chunk of response.body) {
        const piece = Buffer.from(chunk);
        chunks.push(piece);
        got += piece.length;
        if (total) onProgress(Math.min(0.99, got / total));
      }
    } else {
      chunks.push(Buffer.from(await response.arrayBuffer()));
    }
    bytes = Buffer.concat(chunks);
    if (!matches(bytes, build.sha256)) throw new Error(`The Python runtime download did not match its sha256 (${key}): it was not kept.`);
  } catch (error) {
    rmSync(part, { force: true });
    rmSync(join(dir, 'python-runtime.json'), { force: true });
    throw error;
  }
  // Only a verified archive reaches the disk, as one file, renamed into place.
  writeFileSync(part, bytes);
  renameSync(part, join(dir, 'python-runtime.tar.gz'));
  writeFileSync(join(dir, 'python-runtime.json'), JSON.stringify({
    version: build.version, platform, arch, url: build.url, sha256: build.sha256,
  }, null, 2) + '\n');
  if (license) {
    writeFileSync(join(dir, PYTHON_LICENSE_FILE), [
      `# Python ${build.version}`,
      '',
      `Licensed under the ${build.license.name} (see ${build.license.url}).`,
      `Brought from python-build-standalone: ${build.url}`,
      'Its source is CPython: https://github.com/python/cpython',
    ].join('\n') + '\n');
  }
  onProgress(1);
  return dir;
}

let downloading = null;

/**
 * A Python runtime under `dataDir`, downloading it once when this install has none (a running
 * download is shared). `onProgress(0..1)`.
 * @param {string} dataDir @param {{ onProgress?: (fraction: number) => void, fetch?: typeof fetch, license?: boolean, platform?: string, arch?: string }} [options]
 * @returns {Promise<string>} the folder holding it
 */
export function ensurePython(dataDir, { onProgress = () => {}, fetch: fetchImpl = fetch, license = false, platform = process.platform, arch = process.arch } = {}) {
  const dir = pythonDir(dataDir, platform, arch);
  if (pythonIn(dir, platform)) return Promise.resolve(dir);
  downloading ??= fetchPython(dir, { platform, arch, fetch: fetchImpl, onProgress, license }).finally(() => { downloading = null; });
  return downloading;
}

