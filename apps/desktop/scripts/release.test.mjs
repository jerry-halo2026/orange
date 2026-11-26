// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the Windows installer keeps the videos under node_modules', () => {
  /* release.mjs builds as it is run, so its setting is read as written */
  const script = readFileSync(new URL('./release.mjs', import.meta.url), 'utf8');
  assert.match(script, /nsis: \{[^}]*preCompressedFileExtensions: null/s);
});

test('the ffmpeg cache is copied only when it is shaped like resources/runtime/ffmpeg', () => {
  /* 2026-11-25: the gate was `existsSync(join(cachedFfmpeg, 'ffmpeg'))`, which on Windows (a `ffmpeg.exe`) could only be
     satisfied by a `ffmpeg/` folder inside the cache — copied whole, it left the installer with no ffmpeg at all.
     The decision is ffmpeg-runtime.mjs's `ffmpegCacheProblems`: the programs in the folder, the pin's bytes where it
     names them. Its own tests are in src/ffmpeg-runtime.test.mjs. */
  const script = readFileSync(new URL('./release.mjs', import.meta.url), 'utf8');
  assert.match(script, /ffmpegCacheProblems\(cachedFfmpeg, \{ platform, arch \}\)/);
  assert.doesNotMatch(script, /existsSync\(join\(cachedFfmpeg, 'ffmpeg'\)\)/);
});

test('a build that is incomplete says which file, and does not read a list that does not exist', () => {
  /* `reportSelfCheck()` answers `{ lines, ok }`; the failure branch read `report.checks` and threw
     `TypeError: Cannot read properties of undefined (reading 'filter')` instead of naming the missing file */
  const script = readFileSync(new URL('./release.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(script, /report\.checks/);
  assert.match(script, /report\.lines\.filter\(\(line\) => line\.startsWith\('MISSING '\)\)/);
});
