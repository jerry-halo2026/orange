// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * The adapter that puts Studio's own derivation (`studio/server/derived.mjs`) where the analyser's extractor
 * goes, tested without ffmpeg, without media and without a cache directory:
 *
 * 1. a media path outside the project it claims to be in is **refused by name** (`media-outside-project`), not
 *    read as some other file;
 * 2. the moments it asks for are monotonic, inside the seconds it was given, and at most `maxFrames` — the
 *    bound the runner's cost measurement argues for;
 * 3. a failing `probe` ends with a `code` the pipeline can branch on (`frames-failed`, `media-missing`,
 *    `not-configured`), never a bare Error;
 * 4. `scene` is `'not-supported'`: derived.mjs has no cut detection and must not be given credit for one;
 * 5. with `inject`, `derived.mjs` is never imported — no ffmpeg process, no `.film/` directory — which is why
 *    every fake below can answer for a file that does not exist.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { derivedFrames, frameWidth, moments, placeOf, SCENE_STATE } from './derived-frames.mjs';

const dir = (/** @type {string} */ name) => mkdtempSync(join(tmpdir(), `derived-frames-${name}-`));

/** `derived.mjs`'s signatures, counted, with no ffmpeg behind them. */
function fakes({ duration = 90, width = 1920, height = 1080, probeThrows = null, frameThrows = null, bytes = null } = /** @type {any} */ ({})) {
  /** @type {any} */
  const calls = { probe: 0, frame: 0, roots: [], rels: [], moments: [], widths: [] };
  return {
    calls,
    inject: {
      probe: async (/** @type {string} */ root, /** @type {string} */ rel) => {
        calls.probe++;
        calls.roots.push(root);
        calls.rels.push(rel);
        if (probeThrows) throw probeThrows;
        return { duration, width, height, fps: 30, audio: true };
      },
      frame: async (/** @type {string} */ root, /** @type {string} */ rel, /** @type {number} */ ms, /** @type {number} */ w) => {
        calls.frame++;
        calls.moments.push(ms);
        calls.widths.push(w);
        if (frameThrows) throw frameThrows;
        return bytes ?? Buffer.from(`jpeg-${ms}`);
      },
    },
  };
}

/** A media path that does not exist on disk: only injected tools could answer for it. */
const ghost = (/** @type {string} */ root) => ({ path: join(root, 'assets', 'ghost.mp4') });

test('a media path that leaves the project is refused by name', () => {
  const home = dir('home');
  const elsewhere = join(dir('elsewhere'), 'clip.mp4');
  assert.throws(
    () => placeOf({ path: elsewhere }, home),
    (/** @type {any} */ error) => error.code === 'media-outside-project' && error.message.includes('not a file inside'),
  );
  /* the same file seen from an absolute path is the same refusal, not a silent relative `../` */
  assert.equal(placeOf({ path: join(home, 'assets', 'a.mp4') }, home).rel, 'assets/a.mp4');
  assert.equal(placeOf({ path: join(home, 'assets', 'a.mp4') }, home).root, home);
  /* with no root the media's own folder is the project: nothing can be outside it */
  assert.deepEqual(placeOf({ path: join(home, 'assets', 'a.mp4') }), { root: join(home, 'assets'), rel: 'a.mp4' });
});

test('a run over a path that leaves the stated project fails before any frame is asked for', async () => {
  const { inject, calls } = fakes();
  await assert.rejects(
    () => derivedFrames({ media: ghost(dir('outside')), root: dir('project'), inject }),
    (/** @type {any} */ error) => error.code === 'media-outside-project',
  );
  assert.equal(calls.probe, 0, 'no probe on a path it may not read');
  assert.equal(calls.frame, 0);
});

test('the moments are monotonic, inside the window, and never more than maxFrames', () => {
  const long = moments({ duration: 600, fps: 1, seconds: 60, maxFrames: 12 });
  assert.equal(long.length, 12, 'a long clip is cut to the cap');
  assert.deepEqual(long, [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 11000]);
  for (let i = 1; i < long.length; i++) assert.ok(long[i] > long[i - 1], 'strictly increasing');
  assert.ok(long.every((ms) => ms < 60_000), 'inside the first minute');

  /* a clip shorter than the window stops before its end: a frame at the last millisecond is a decoder's empty answer */
  assert.deepEqual(moments({ duration: 3.2, fps: 1, seconds: 60, maxFrames: 12 }), [0, 1000, 2000, 3000]);
  assert.deepEqual(moments({ duration: 3, fps: 1, seconds: 60, maxFrames: 12 }), [0, 1000, 2000]);
  assert.deepEqual(moments({ duration: 0.4, fps: 1, seconds: 60, maxFrames: 12 }), [0]);
  /* a still has no length: one frame, not a guessed duration */
  assert.deepEqual(moments({ duration: NaN }), [0]);
  assert.deepEqual(moments({ duration: 30, fps: 2, seconds: 10, maxFrames: 4 }), [0, 500, 1000, 1500]);
  assert.deepEqual(moments({ duration: 30, maxFrames: 0 }), [], 'no cap, no frames');
});

test('a run asks for one frame per moment, scaled like Studio’s own thumbnails', async () => {
  const root = dir('run');
  const { inject, calls } = fakes();
  const answer = await derivedFrames({ media: ghost(root), root, fps: 1, seconds: 60, maxFrames: 3, inject });
  assert.equal(calls.probe, 1, 'the length is asked for once');
  assert.deepEqual(calls.roots, [root]);
  assert.deepEqual(calls.rels, ['assets/ghost.mp4'], 'the project-relative path, forward slashes');
  assert.deepEqual(calls.moments, [0, 1000, 2000]);
  assert.ok(calls.widths.every((w) => w === 640), 'derived.mjs clamps a frame to 640 at most');
  assert.equal(answer.frames.length, 3);
  assert.deepEqual(answer.frames.map((frame) => frame.at), [0, 1, 2], 'at is in seconds');
  assert.equal(answer.frames[0].width, 640);
  assert.equal(answer.frames[0].height, 360, '1920×1080 at 640 wide');
  assert.ok(Buffer.isBuffer(answer.frames[1].jpeg));
  assert.equal(frameWidth(1280), 640);
  assert.equal(frameWidth(96), 96);
  assert.equal(frameWidth(0), 160, 'the same fallback derived.mjs uses');
});

test('scene is not-supported: no cut pass ran, and none is claimed', async () => {
  const root = dir('scene');
  const { inject } = fakes();
  const answer = await derivedFrames({ media: ghost(root), root, inject });
  assert.equal(answer.scene, 'not-supported');
  assert.equal(SCENE_STATE, 'not-supported');
  assert.notEqual(answer.scene, 'ok', 'a pass that never ran is not a success');
  assert.notEqual(answer.scene, 'failed', 'and it is not ffmpeg’s failure either');
});

test('a failing probe ends with a code, not a bare Error', async () => {
  const root = dir('probe');
  const plain = await derivedFrames({ media: ghost(root), root, inject: fakes({ probeThrows: new Error('ffmpeg said no') }).inject })
    .then(() => null, (/** @type {any} */ error) => error);
  assert.equal(plain?.code, 'frames-failed');
  assert.equal(plain?.step, 'probe');
  assert.match(plain?.message, /ffmpeg said no/);

  /* derived.mjs's MediaError carries a status and no code: the name comes from the status */
  const missing = await derivedFrames({ media: ghost(root), root, inject: fakes({ probeThrows: Object.assign(new Error('a.mp4 is not there'), { status: 404 }) }).inject })
    .then(() => null, (/** @type {any} */ error) => error);
  assert.equal(missing?.code, 'media-missing');

  const noTool = await derivedFrames({ media: ghost(root), root, inject: fakes({ probeThrows: Object.assign(new Error('ffprobe is not installed'), { status: 501 }) }).inject })
    .then(() => null, (/** @type {any} */ error) => error);
  assert.equal(noTool?.code, 'not-configured', 'a missing tool is a named state, not a crash');
});

test('a frame that fails keeps its code, and a run with nothing to show is frames-empty', async () => {
  const root = dir('frame');
  const boom = await derivedFrames({ media: ghost(root), root, inject: fakes({ frameThrows: Object.assign(new Error('no such stream'), { status: 422 }) }).inject })
    .then(() => null, (/** @type {any} */ error) => error);
  assert.equal(boom?.code, 'frames-failed');
  assert.equal(boom?.step, 'frame');

  const empty = await derivedFrames({ media: ghost(root), root, maxFrames: 2, inject: fakes({ bytes: Buffer.alloc(0) }).inject })
    .then(() => null, (/** @type {any} */ error) => error);
  assert.equal(empty?.code, 'frames-empty', 'the runner’s own word for an extractor that produced nothing');
});

test('with an injected probe and frame, derived.mjs is never imported: no ffmpeg, no cache directory', async () => {
  const root = dir('injected');
  const { inject, calls } = fakes();
  const answer = await derivedFrames({ media: ghost(root), root, inject });
  assert.equal(answer.frames.length, 12);
  assert.equal(calls.frame, 12, 'every frame came from the fake');
  /* derived.mjs writes its cache under `<root>/.film/cache`: an empty temp folder proves nothing on that
     side ran, and the media file it was told about does not exist at all */
  assert.equal(existsSync(join(root, '.film')), false);
  assert.equal(existsSync(ghost(root).path), false);
  assert.equal(existsSync(join(root, 'assets')), false);
});

test('a run with no probe or frame injected refuses the half-injected pair by name', async () => {
  const root = dir('half');
  await assert.rejects(
    () => derivedFrames({ media: ghost(root), root, inject: { probe: async () => ({ duration: 1 }) } }),
    (/** @type {any} */ error) => error.code === 'derived-inject-invalid',
  );
});

test('media that is not a local file is named, not guessed at', async () => {
  const { inject } = fakes();
  await assert.rejects(() => derivedFrames({ media: null, inject }), (/** @type {any} */ error) => error.code === 'media-missing');
  await assert.rejects(
    () => derivedFrames({ media: { url: 'https://example.invalid/a.mp4' }, inject }),
    (/** @type {any} */ error) => error.code === 'media-not-local',
  );
});

test('the pipeline’s default extractor is this adapter, and ffmpegFrames stays exported as the fallback', async () => {
  const runner = await import('../../../packages/openfilm/src/analyze-runner.mjs');
  assert.equal(typeof runner.studioFrames, 'function');
  assert.equal(typeof runner.ffmpegFrames, 'function', 'the extractor with the cut pass is still there');
  const root = dir('runner');
  const { inject, calls } = fakes({ duration: 4 });
  /* the runner's own default, exercised with an injected pair: the wiring is what is under test, not ffmpeg */
  const answer = await runner.studioFrames({ media: ghost(root), root, inject });
  assert.equal(answer.scene, 'not-supported');
  assert.equal(calls.frame, 4, 'four seconds, one a second');
  assert.equal(runner.ANALYZER_VER, 'analyze-runner-2', 'a different extractor is a different cache entry');
});

test('a real file placed inside its own project needs nothing but the injected tools', async () => {
  /* the pair that proves the split is not just a string trick: a file that exists, under a root that exists */
  const root = dir('real');
  const assets = join(root, 'assets');
  mkdirSync(assets, { recursive: true });
  const path = join(assets, 'clip.mp4');
  writeFileSync(path, 'fixture bytes');
  const { inject, calls } = fakes({ duration: 2.5 });
  const answer = await derivedFrames({ media: { path }, root, inject });
  assert.deepEqual(calls.rels, ['assets/clip.mp4']);
  assert.deepEqual(answer.frames.map((frame) => frame.at), [0, 1, 2]);
});
