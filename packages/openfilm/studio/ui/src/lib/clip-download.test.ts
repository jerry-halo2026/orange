// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The clip's download state, as the store the timeline reads: nothing → downloading (with the cover already known) →
 * ready (the file landed) → nothing again; and downloading → failed (with a reason) → nothing again.
 *
 * The three words are the whole state machine, it is per clip src, and the timers that end `ready` / `failed` are the
 * only thing that ever removes an entry on its own — so a clip can never keep a badge it no longer needs, and never
 * keeps a spinner that has nothing behind it.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  DOWNLOAD_FAILED_MS, DOWNLOAD_READY_MS, beginDownload, downloadOf, downloadsOf, failDownload, resetDownloads,
  settleDownload, subscribeDownloads,
} from './clip-download.ts';

test('⑤ a download ends: downloading → ready, and the ready state goes by itself', () => {
  resetDownloads();
  assert.equal(downloadOf('assets/a.mp4'), undefined, 'a clip with nothing behind it says nothing');
  const seen: string[] = [];
  const stop = subscribeDownloads(() => seen.push(downloadOf('assets/a.mp4')?.state ?? 'none'));

  beginDownload('assets/a.mp4', {cover: '/api/materials/cover?url=a.jpg'});
  assert.deepEqual(downloadOf('assets/a.mp4'), {state: 'downloading', cover: '/api/materials/cover?url=a.jpg'},
    'the clip shows the cover it already had while the file comes');
  assert.equal(downloadsOf().size, 1);

  settleDownload('assets/a.mp4');
  assert.deepEqual(downloadOf('assets/a.mp4'), {state: 'ready'}, 'then it landed: the clip no longer says 正在下载');
  assert.deepEqual(seen, ['downloading', 'ready'], 'one notification per change, in that order');
  assert.equal(DOWNLOAD_READY_MS > 0 && DOWNLOAD_READY_MS < 10_000, true, 'the landing word is a moment, not a state');
  stop();
  resetDownloads();
  assert.equal(downloadsOf().size, 0);
});

test('④ a stand-in src hands its landing over to the clip that was really written', () => {
  resetDownloads();
  /* a material is drawn where it will land under a stand-in name; the clip written afterwards has the project's path */
  beginDownload('assets/materials/m1.mp4', {cover: '/cover.jpg'});
  settleDownload('assets/materials/m1.mp4', 'assets/m1.mp4');
  assert.equal(downloadOf('assets/materials/m1.mp4'), undefined, 'the placeholder is not saying two things at once');
  assert.deepEqual(downloadOf('assets/m1.mp4'), {state: 'ready'}, 'the clip that exists is the one that says it landed');
  resetDownloads();
});

test('⑤ a failure is visible, says why, and is not forever', () => {
  resetDownloads();
  beginDownload('assets/b.mp4');
  failDownload('assets/b.mp4', '无权下载');
  assert.deepEqual(downloadOf('assets/b.mp4'), {state: 'failed', reason: '无权下载'},
    'a failed download keeps the reason on the clip, so it never turns forever');
  assert.equal(DOWNLOAD_FAILED_MS > DOWNLOAD_READY_MS, true, 'the reason is readable for longer than the landing word');
  resetDownloads();
  assert.equal(downloadOf('assets/b.mp4'), undefined);
});

test('a second drop of the same clip starts again, and an empty src is nothing', () => {
  resetDownloads();
  beginDownload('assets/c.mp4', {cover: '/c.jpg'});
  failDownload('assets/c.mp4', '下载超时');
  beginDownload('assets/c.mp4');
  assert.deepEqual(downloadOf('assets/c.mp4'), {state: 'downloading'}, 'a retry drops the old failure');
  beginDownload('');
  assert.equal(downloadOf(''), undefined);
  resetDownloads();
});
