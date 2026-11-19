// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * The frame extractor's two real bugs, pinned so they cannot come back:
 *
 * 1. ffmpeg 9's mjpeg encoder refuses a non-full-range YUV and exits **-22**; the JPEG output needs
 *    `-pix_fmt yuvj420p`.
 * 2. `fps=1` and `select='gt(scene,0.3)'` in one pass cancel each other: a second apart, neighbouring
 *    frames differ by less than the threshold, so the pass selects **0 frames and still exits 0** —
 *    a silent empty result, which is worse than an error. The passes are separate.
 *
 * The extractor is exercised through an injected `spawn`, so these tests run ffmpeg's *shape* with no
 * media and no ffmpeg on the machine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FRAME_DEFAULTS, ffmpegFrames, framesFailure, framesPasses, mergeFrames, ptsTimes, runAnalysis } from './analyze-runner.mjs';

const out = () => mkdtempSync(join(tmpdir(), 'frames-out-'));
const ask = { fps: 1, seconds: 60, maxFrames: 12, longEdge: 1280, quality: 85, scene: 0.3 };

test('the JPEG output carries -pix_fmt yuvj420p: ffmpeg 9 refuses a non-full-range YUV', () => {
    const passes = framesPasses('clip.mp4', ask, out());
    for (const [name, args] of Object.entries(passes)) {
        const at = args.indexOf('-pix_fmt');
        assert.notEqual(at, -1, `${name} pass sets a pixel format`);
        assert.equal(args[at + 1], 'yuvj420p', `${name} pass asks for full range`);
        assert.ok(args.includes('-q:v'), `${name} pass sets the JPEG quality`);
    }
});

test('the steady pass has no scene select, and the scene pass keeps its own frames (-fps_mode vfr)', () => {
    const passes = framesPasses('clip.mp4', ask, out());
    const steadyVf = passes.steady[passes.steady.indexOf('-vf') + 1];
    assert.ok(!/select=/.test(steadyVf), 'fps and select in one pass would cancel each other out');
    assert.match(steadyVf, /^fps=1,trim=duration=60,scale=/);
    const sceneVf = passes.scene[passes.scene.indexOf('-vf') + 1];
    assert.match(sceneVf, /^select='gt\(scene\\,0\.3\)',scale=/);
    assert.ok(passes.scene.includes('-fps_mode'), 'the selected frames are kept as they are');
    assert.equal(passes.scene[passes.scene.indexOf('-fps_mode') + 1], 'vfr');
    assert.ok(!passes.scene.includes('-vsync'), 'ffmpeg 9 removed -vsync: it only survives in the retry');
    assert.ok(passes.sceneLegacy.includes('-vsync'), 'an older build still gets the old spelling');
    // different file names, so the two runs cannot overwrite each other
    assert.ok(passes.steady.at(-1).endsWith('f%03d.jpg'));
    assert.ok(passes.scene.at(-1).endsWith('s%03d.jpg'));
});

test('an exit of 0 with no frames is a failure, not an empty success', async () => {
    const dir = out();
    const spawn = () => ({ status: 0, stderr: '' });
    await assert.rejects(
        () => ffmpegFrames({ media: { path: 'clip.mp4' }, spawn, mkdtemp: () => dir, readdir: () => [], read: () => Buffer.alloc(0) }),
        (/** @type {any} */ error) => error.code === 'frames-empty',
    );
});

test('ffmpeg’s -22 on a non-full-range YUV explains what the encoder wants', () => {
    assert.throws(
        () => framesFailure({ status: -22, stderr: '[mjpeg] Non full-range YUV is non-standard, set strict_std_compliance to at most unofficial to use it.\nff_frame_thread_encoder_init failed' }, 'steady'),
        (/** @type {any} */ error) => error.code === 'frames-encoder-range' && /yuvj420p/.test(error.message),
    );
});

test('the extractor still produces the frames the passes wrote', async () => {
    const dir = out();
    const spawn = (/** @type {string} */ _command, /** @type {string[]} */ args) => {
        const at = args.findIndex((arg) => arg.endsWith('%03d.jpg'));
        const pattern = args[at];
        for (const index of [1, 2, 3, 4]) {
            writeFileSync(pattern.replace('%03d', String(index).padStart(3, '0')), Buffer.from(`frame ${index}`));
        }
        return { status: 0, stderr: pattern.includes('s%03d') ? 'pts_time:2.5\npts_time:6.5\n' : '' };
    };
    const answer = await ffmpegFrames({ media: { path: 'clip.mp4' }, spawn, mkdtemp: () => dir });
    const frames = answer.frames;
    assert.equal(answer.scene, 'ok');
    // four steady frames at 0,1,2,3 plus two cuts at 2.5 and 6.5 — 2.5 sits between 2 and 3 and is kept
    assert.deepEqual(frames.map((frame) => frame.at), [0, 1, 2, 2.5, 3, 6.5].filter((at) => at <= 3 || at === 6.5).slice(0, frames.length));
    assert.ok(frames.length >= 4, `at least the steady frames (got ${frames.length})`);
    for (const frame of frames) assert.ok(Buffer.isBuffer(frame.jpeg));
});

test('a media that yields nothing stops the pipeline with frames-empty', async () => {
    const fake = {
        frames: async () => [],
        describe: async () => ({ text: 'x', hints: '' }),
        ocr: async () => ({ text: '' }),
        transcribe: async () => { throw Object.assign(new Error('none'), { code: 'not-configured' }); },
        judge: async () => { throw Object.assign(new Error('none'), { code: 'not-configured' }); },
        embed: async () => ({ model: 'm', ver: 'v', vector: [1] }),
    };
    const dir = out();
    const media = join(dir, 'clip.mp4');
    writeFileSync(media, 'bytes');
    const run = await runAnalysis({ media: { path: media }, workspace: join(dir, 'ws'), ...fake });
    assert.equal(run.ok, false);
    assert.equal(run.step, 'frames');
    assert.equal(run.code, 'frames-empty');
});

test('the scene pass log gives the cut times, and merges dedupe the same moment', () => {
    const log = 'frame= 1 pts=1024 pts_time:1.024\nframe= 2 pts=2048 pts_time:2.048\n';
    assert.deepEqual(ptsTimes(log), [1.024, 2.048]);
    assert.deepEqual(ptsTimes('nothing here'), []);
    const merged = mergeFrames([
        { at: 0, jpeg: Buffer.from('a') }, { at: 1, jpeg: Buffer.from('b') },
        { at: 1.1, jpeg: Buffer.from('c') }, { at: 2.6, jpeg: Buffer.from('d') },
    ]);
    assert.deepEqual(merged.map((frame) => frame.at), [0, 1, 2.6], 'the same moment from both passes is one frame');
});

test('a build with no ffmpeg at all is not-configured, not a crash', () => {
    assert.throws(
        () => framesFailure({ status: null, stderr: '', error: Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }) }, 'steady'),
        (/** @type {any} */ error) => error.code === 'not-configured',
    );
});

test('the defaults are the ones the measurements argue for', () => {
    assert.equal(FRAME_DEFAULTS.fps, 1);
    assert.equal(FRAME_DEFAULTS.maxFrames, 12);
    assert.equal(FRAME_DEFAULTS.longEdge, 1280);
    assert.equal(FRAME_DEFAULTS.quality, 85);
    assert.equal(FRAME_DEFAULTS.scene, 0.3);
});

test('a build that does not know -fps_mode is asked again with -vsync, once', async () => {
    const dir = out();
    /** @type {string[][]} */
    const seen = [];
    const spawn = (/** @type {string} */ _c, /** @type {string[]} */ args) => {
        seen.push(args);
        if (args.includes('-fps_mode')) return { status: 1, stderr: "Unrecognized option 'fps_mode'.\nError splitting the argument list: Option not found" };
        const pattern = args[args.findIndex((arg) => arg.endsWith('%03d.jpg'))];
        if (pattern.includes('s%03d')) return { status: 0, stderr: 'pts_time:2.5\n' };
        for (const index of [1, 2]) writeFileSync(pattern.replace('%03d', String(index).padStart(3, '0')), Buffer.from('f'));
        return { status: 0, stderr: '' };
    };
    const answer = await ffmpegFrames({ media: { path: 'clip.mp4' }, spawn, mkdtemp: () => dir });
    assert.equal(answer.scene, 'ok', 'the retry succeeded');
    assert.equal(seen.filter((args) => args.includes('-fps_mode')).length, 1, 'tried the current spelling once');
    assert.equal(seen.filter((args) => args.includes('-vsync')).length, 1, 'and fell back once');
});

test('a scene pass that fails does not lose the steady frames', async () => {
    const dir = out();
    const spawn = (/** @type {string} */ _c, /** @type {string[]} */ args) => {
        const pattern = args[args.findIndex((arg) => arg.endsWith('%03d.jpg'))];
        if (pattern.includes('s%03d')) return { status: 1, stderr: 'Error splitting the argument list: Option not found' };
        for (const index of [1, 2, 3]) writeFileSync(pattern.replace('%03d', String(index).padStart(3, '0')), Buffer.from('f'));
        return { status: 0, stderr: '' };
    };
    const answer = await ffmpegFrames({ media: { path: 'clip.mp4' }, spawn, mkdtemp: () => dir });
    assert.equal(answer.scene, 'failed');
    assert.equal(answer.frames.length, 3, 'the steady frames are still there');
});

test('the pipeline carries a failed scene pass as a state, and describes the frames anyway', async () => {
    const dir = out();
    const media = join(dir, 'clip.mp4');
    writeFileSync(media, 'bytes');
    const spawn = (/** @type {string} */ _c, /** @type {string[]} */ args) => {
        const pattern = args[args.findIndex((arg) => arg.endsWith('%03d.jpg'))];
        if (pattern.includes('s%03d')) return { status: 1, stderr: 'Error splitting the argument list: Option not found' };
        for (const index of [1, 2]) writeFileSync(pattern.replace('%03d', String(index).padStart(3, '0')), Buffer.from('f'));
        return { status: 0, stderr: '' };
    };
    let described = 0;
    const run = await runAnalysis({
        media: { path: media }, workspace: join(dir, 'ws'),
        frames: async (ask) => ffmpegFrames({ media: { path: media }, ...ask, spawn, mkdtemp: () => out() }),
        describe: async (ask) => { if (!ask.warmup) described++; return { text: 'a frame', hints: '' }; },
        ocr: async () => { throw Object.assign(new Error('none'), { code: 'not-configured' }); },
        transcribe: async () => { throw Object.assign(new Error('none'), { code: 'not-configured' }); },
        judge: async () => { throw Object.assign(new Error('none'), { code: 'not-configured' }); },
        embed: async () => ({ model: 'm', ver: 'v', vector: [1, 2] }),
    });
    assert.equal(run.ok, true, 'the material is still described');
    assert.equal(run.summary.states.scene, 'failed');
    assert.equal(run.timings.sceneFailed, true);
    assert.equal(described, 2, 'both steady frames went to the vision model');
});

test('no frames from either pass is still frames-empty', async () => {
    const dir = out();
    const spawn = () => ({ status: 0, stderr: '' });
    await assert.rejects(
        () => ffmpegFrames({ media: { path: 'clip.mp4' }, spawn, mkdtemp: () => dir, readdir: () => [], read: () => Buffer.alloc(0) }),
        (/** @type {any} */ error) => error.code === 'frames-empty',
    );
});