// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchFfmpeg, ffmpegCacheProblems, ffmpegIn, unzipEntry } from './ffmpeg-runtime.mjs';
import { zipFiles } from '../../../packages/orangefilm/studio/server/zip.mjs';

/** A response whose body comes in one piece. */
const answer = (bytes) => new Response(new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }), { headers: { 'content-length': String(bytes.length) } });

test('a build whose checksum is not the pinned one is not kept', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'of-ffmpeg-'));
  const asked = [];
  const fetch = async (url) => { asked.push(url); return answer(Buffer.from('not ffmpeg')); };
  await assert.rejects(fetchFfmpeg(dir, { platform: 'darwin', arch: 'arm64', fetch }), /did not match its checksum/);
  assert.equal(ffmpegIn(dir, 'darwin'), false);
  /* macOS arm64 的 ffmpeg/ffprobe 各是一个自己的 zip（osxexperts 9.0.2，带 libass） */
  assert.deepEqual([...new Set(asked)].sort(), ['https://www.osxexperts.net/ffmpeg902arm.zip', 'https://www.osxexperts.net/ffprobe902arm.zip'].sort());
});

test('no build for a platform says so', async () => {
  await assert.rejects(fetchFfmpeg(mkdtempSync(join(tmpdir(), 'of-ffmpeg-')), { platform: 'linux', arch: 'x64' }), /no ffmpeg to download for linux-x64/);
});

test('a download that fails is tried again, three times in all', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'of-ffmpeg-'));
  const asked = [];
  const fetch = async (url) => { asked.push(url.split('/').pop()); throw new TypeError('fetch failed'); };
  await assert.rejects(fetchFfmpeg(dir, { platform: 'win32', arch: 'x64', fetch }), /fetch failed/);
  assert.deepEqual(asked.filter((n) => n === 'ffmpeg-9.0.2-essentials_build.zip').length, 3, 'one archive, both programs in it');
});

test('a download that stops coming is stopped and tried again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'of-ffmpeg-'));
  let tries = 0;
  const fetch = async (url, { signal }) => {
    if (url.endsWith('ffmpeg-osx-x64')) tries++;
    /* fetch ends a body whose request is aborted with an error */
    return new Response(new ReadableStream({ start(c) { signal.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError'))); } }));
  };
  await assert.rejects(fetchFfmpeg(dir, { platform: 'darwin', arch: 'x64', fetch, stallMs: 50 }), /stalled/);
  assert.equal(tries, 3);
});

test('the installer\'s copy has FFmpeg\'s license and where its source is', async () => {
  /* the programs themselves are the pinned builds: a stand-in with the pinned checksum is not to be had, so this
     checks the license files only, with the programs already there */
  const dir = mkdtempSync(join(tmpdir(), 'of-ffmpeg-'));
  writeFileSync(join(dir, 'ffmpeg'), '');
  writeFileSync(join(dir, 'ffprobe'), '');
  const asked = [];
  const fetch = async (url) => { asked.push(url); return answer(Buffer.from('GPL v3 text')); };
  await fetchFfmpeg(dir, { platform: 'darwin', arch: 'arm64', license: true, fetch });
  assert.deepEqual(asked, ['https://raw.githubusercontent.com/FFmpeg/FFmpeg/n9.0.2/COPYING.GPLv3'], 'the license of the version it is, nothing else');
  assert.equal(readFileSync(join(dir, 'LICENSE'), 'utf8'), 'GPL v3 text');
  assert.match(readFileSync(join(dir, 'SOURCE'), 'utf8'), /^FFmpeg 9\.0\.2,[^]*ffmpeg-9\.0\.2\.tar\.xz/);
});

test('a program comes out of a zip as it went in', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'of-ffmpeg-'));
  const program = Buffer.from('MZ'.repeat(5000));
  await zipFiles(join(dir, 'build.zip'), [{ name: 'build/LICENSE', data: Buffer.from('license') }, { name: 'build/bin/ffmpeg.exe', data: program }]);
  const zip = readFileSync(join(dir, 'build.zip'));
  assert.deepEqual(unzipEntry(zip, 'build/bin/ffmpeg.exe'), program);
  assert.equal(unzipEntry(zip, 'build/LICENSE').toString(), 'license');
  assert.throws(() => unzipEntry(zip, 'build/bin/ffprobe.exe'), /has no build\/bin\/ffprobe\.exe/);
  assert.throws(() => unzipEntry(Buffer.from('not a zip'), 'x'), /not a zip/);
});

test('a cache folder holding both programs for a platform with no per-program pin is usable', () => {
  /* Windows is one zip of the two programs: the pin is the archive's, so what a cache can be held to is its shape —
     ffmpeg.exe and ffprobe.exe in the folder that becomes resources/runtime/ffmpeg */
  const dir = mkdtempSync(join(tmpdir(), 'of-cache-'));
  writeFileSync(join(dir, 'ffmpeg.exe'), 'not really ffmpeg');
  writeFileSync(join(dir, 'ffprobe.exe'), 'not really ffprobe');
  assert.deepEqual(ffmpegCacheProblems(dir, { platform: 'win32', arch: 'x64' }), []);
});

test('a cache folder that is a folder too deep is not usable', () => {
  /* 2026-11-25: `dir/ffmpeg/ffmpeg.exe` was what a Windows cache had to look like for the old existsSync gate, and
     the copy nested it — resources/runtime/ffmpeg/ffmpeg/ffmpeg.exe, an installer with no ffmpeg */
  const dir = mkdtempSync(join(tmpdir(), 'of-cache-'));
  mkdirSync(join(dir, 'ffmpeg'));
  writeFileSync(join(dir, 'ffmpeg', 'ffmpeg.exe'), '');
  writeFileSync(join(dir, 'ffmpeg', 'ffprobe.exe'), '');
  assert.deepEqual(ffmpegCacheProblems(dir, { platform: 'win32', arch: 'x64' }), ['ffmpeg.exe is missing', 'ffprobe.exe is missing']);
});

test('a cache folder of another version than the pin is not usable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'of-cache-'));
  writeFileSync(join(dir, 'ffmpeg'), 'an 8.1.2 build, not the 9.0.2 pin');
  assert.deepEqual(ffmpegCacheProblems(dir, { platform: 'darwin', arch: 'arm64' }), [
    'ffmpeg is not the pinned 9.0.2 program (sha256 ' + createHash('sha256').update('an 8.1.2 build, not the 9.0.2 pin').digest('hex').slice(0, 12) + '…)',
    'ffprobe is missing',
  ]);
});

test('a platform this build has no ffmpeg for is said so, not silently accepted', () => {
  assert.deepEqual(ffmpegCacheProblems(mkdtempSync(join(tmpdir(), 'of-cache-')), { platform: 'linux', arch: 'x64' }), ['there is no linux-x64 build to compare the cache with']);
});
