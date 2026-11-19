// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * The analysis pipeline with every collaborator faked: what the card, the evidence and the vector
 * look like, that the warm-up is counted apart, that the vision model's guess at on-screen text never
 * reaches an authoritative field, and that a second run costs nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ANALYZER_VER, FRAME_DEFAULTS, cachePath, mediaDigest, renderVideoMd, runAnalysis,
} from './analyze-runner.mjs';

const workspace = () => mkdtempSync(join(tmpdir(), 'analyze-ws-'));
const media = () => {
  const dir = mkdtempSync(join(tmpdir(), 'analyze-media-'));
  const path = join(dir, 'clip.mp4');
  writeFileSync(path, 'fixture bytes of a clip');
  return { path };
};

/** Counters for every injected collaborator. */
function fakes(overrides = {}) {
    const calls = { frames: 0, describe: 0, ocr: 0, transcribe: 0, judge: 0, embed: 0, warmup: 0, describeArgs: [] };
    const built = {
        calls,
        frames: async (ask) => {
            calls.frames++;
            calls.frameAsk = ask;
            return [0, 1, 2].map((at) => ({ at, jpeg: Buffer.from(`frame-${at}`), width: 1280, height: 720 }));
        },
        describe: async (ask) => {
            calls.describe++;
            calls.describeArgs.push(ask);
            if (ask.warmup) { calls.warmup++; return { text: 'ok' }; }
            // the model invents a brand: it must never become a fact
            return { text: `画面 ${ask.at}`, hints: 'BRAND: 幽灵品牌 GHOST' };
        },
        ocr: async (ask) => { calls.ocr++; return { text: ask.at === 0 ? '真实品牌 REAL' : '' }; },
        transcribe: async () => { calls.transcribe++; return { text: '这是旁白', segments: [] }; },
        judge: async () => { calls.judge++; return { oneLine: '一条测试素材', confidence: 0.72, bestClip: { at: 1, until: 2 }, risks: ['画面偏暗'] }; },
        embed: async () => { calls.embed++; return { model: 'fake-embed', ver: ANALYZER_VER, vector: [0.1, 0.2, 0.3] }; },
        ...overrides,
    };
    return built;
}

const meta = { name: '真实素材名', accountName: '橙子工作室', category1: '美食', category2: '探店', labels: ['招牌菜', '夜晚'] };

test('a full fake run gives a card, graded evidence and a vector of the right shape', async () => {
    const fake = fakes();
    const run = await runAnalysis({ media: media(), meta, workspace: workspace(), now: Date.now, ...fake });
    assert.equal(run.ok, true);
    assert.equal(run.cached, false);
    const { summary, videoMd, embedding } = run;
    assert.equal(typeof summary.oneLine, 'string');
    assert.ok(Array.isArray(summary.scenes) && summary.scenes.length === 3);
    assert.ok(summary.bestClip && typeof summary.bestClip.at === 'number');
    assert.equal(summary.tags.category1, '美食');
    assert.equal(summary.tags.category2, '探店');
    assert.deepEqual(summary.tags.labels, ['招牌菜', '夜晚']);
    assert.ok(summary.production && summary.production.frames === 3);
    assert.equal(typeof summary.confidence, 'number');
    assert.ok(Array.isArray(summary.risks));
    assert.deepEqual(embedding.vector, [0.1, 0.2, 0.3]);
    assert.equal(embedding.model, 'fake-embed');
    assert.equal(typeof videoMd, 'string');
    assert.equal(run.summary.states.judge, 'ok');
});

test('the warm-up happens once, before the frames, and is timed apart from them', async () => {
    const fake = fakes();
    // The clock only moves when work happens: the cold warm-up is made deliberately slow (26.8 s in
    // the real measurement) and each warm frame fast (1.35 s), so the two numbers must differ.
    let clock = 0;
    const now = () => clock;
    const describe = async (/** @type {any} */ ask) => {
        fake.calls.describe++;
        fake.calls.describeArgs.push(ask);
        clock += ask.warmup ? 26800 : 1350;
        if (ask.warmup) { fake.calls.warmup++; return { text: 'ok' }; }
        return { text: `画面 ${ask.at}`, hints: 'BRAND: 幽灵品牌 GHOST' };
    };
    const run = await runAnalysis({ media: media(), meta, workspace: workspace(), now, ...fake, describe });
    assert.equal(fake.calls.warmup, 1, 'one warm-up request, no more');
    assert.equal(fake.calls.describe, 4, 'three frames plus the warm-up');
    assert.equal(fake.calls.describeArgs[0].warmup, true, 'the warm-up is the first thing sent');
    assert.equal(typeof run.timings.warmup, 'number');
    assert.equal(run.timings.warmup, 26800, 'the cold start is reported as itself');
    assert.equal(run.timings.describe, 4050, 'and the three warm frames as theirs');
    assert.ok(run.timings.warmup > run.timings.describe, 'cold and warm are not folded together');
    assert.equal(fake.calls.ocr, 3);
});

test('frames are bounded and scaled the way the measurements ask for', async () => {
    const fake = fakes();
    const many = async (/** @type {any} */ ask) => {
        fake.calls.frameAsk = ask;
        return Array.from({ length: 30 }, (_, at) => ({ at, jpeg: Buffer.from('x'), width: 1280, height: 720 }));
    };
    const run = await runAnalysis({ media: media(), meta, workspace: workspace(), ...fake, frames: many });
    const ask = fake.calls.frameAsk;
    assert.equal(ask.maxFrames, FRAME_DEFAULTS.maxFrames, '12 frames at most');
    assert.equal(ask.longEdge, 1280, 'long edge 1280');
    assert.equal(ask.quality, 85, 'JPEG q85');
    assert.equal(ask.fps, 1, 'one frame a second');
    assert.equal(ask.seconds, 60, 'from the first minute');
    assert.equal(run.summary.production.frames, 12, 'a 30-frame answer is cut to the cap');
    const tightened = await runAnalysis({ media: media(), meta, workspace: workspace(), ...fake, frames: many, frameOptions: { maxFrames: 3, longEdge: 960, quality: 70 } });
    assert.equal(fake.calls.frameAsk.maxFrames, 3);
    assert.equal(fake.calls.frameAsk.longEdge, 960);
    assert.equal(fake.calls.frameAsk.quality, 70);
    assert.equal(tightened.summary.production.frames, 3);
});

test('what the vision model thinks it read never becomes a fact', async () => {
    const fake = fakes();
    const run = await runAnalysis({ media: media(), meta, workspace: workspace(), ...fake });
    const { summary, videoMd } = run;
    const ghost = '幽灵品牌';
    assert.ok(JSON.stringify(summary.tags).indexOf(ghost) === -1, 'the invented brand is not a tag');
    assert.ok(videoMd.indexOf(ghost) === -1, 'and it is not in the evidence either');
    assert.ok(JSON.stringify(summary.hints).indexOf(ghost) !== -1, 'it is kept, marked as a hint');
    assert.ok(videoMd.includes('真实品牌'), 'OCR text, which is a fact, is in the evidence');
});

test('without OCR the run says so and the other steps still happen', async () => {
    const fake = fakes({ ocr: async () => { throw Object.assign(new Error('OCR is not configured'), { code: 'not-configured' }); } });
    const run = await runAnalysis({ media: media(), meta, workspace: workspace(), ...fake });
    assert.equal(run.ok, true);
    assert.equal(run.summary.states.ocr, 'not-configured');
    assert.equal(fake.calls.describe, 4, 'vision still ran');
    assert.equal(fake.calls.judge, 1);
    assert.equal(fake.calls.embed, 1);
    assert.deepEqual(run.summary.tags, { category1: '美食', category2: '探店', labels: ['招牌菜', '夜晚'] }, 'no OCR tokens invented');
});

test('without a key the decision falls back to the vision model and is marked degraded', async () => {
    const fake = fakes({ judge: async () => { throw Object.assign(new Error('the decision model is not configured'), { code: 'not-configured' }); } });
    const run = await runAnalysis({ media: media(), meta, workspace: workspace(), ...fake });
    assert.equal(run.ok, true);
    assert.equal(run.summary.states.judge, 'degraded');
    assert.ok(run.summary.confidence > 0 && run.summary.confidence <= 1, 'a confidence is still reported');
});

test('the same input twice costs nothing the second time', async () => {
    const ws = workspace();
    const path = media();
    const fake = fakes();
    const first = await runAnalysis({ media: path, meta, workspace: ws, ...fake });
    assert.equal(first.cached, false);
    const used = { ...fake.calls };
    const second = await runAnalysis({ media: path, meta, workspace: ws, ...fake });
    assert.equal(second.cached, true);
    assert.equal(fake.calls.frames, used.frames, 'no frame extraction');
    assert.equal(fake.calls.describe, used.describe, 'no vision request');
    assert.equal(fake.calls.ocr, used.ocr);
    assert.equal(fake.calls.embed, used.embed);
    assert.deepEqual(second.summary, first.summary, 'the stored card comes back as it was');
    assert.equal(second.videoMd, first.videoMd);
    const files = readdirSync(join(ws, 'analysis'));
    assert.equal(files.length, 1, 'one cache file for one input');
    assert.ok(files[0].startsWith(mediaDigest(path)), 'named by the media digest');
});

test('a step that throws ends as data, with no stack and no half result', async () => {
    const boom = new Error('the vision endpoint answered 500');
    boom.code = 'describe-failed';
    const fake = fakes({ describe: async (ask) => { if (ask.warmup) return { text: 'ok' }; throw boom; } });
    const run = await runAnalysis({ media: media(), meta, workspace: workspace(), ...fake });
    assert.equal(run.ok, false);
    assert.equal(run.step, 'describe');
    assert.equal(run.code, 'describe-failed');
    assert.match(run.message, /vision endpoint answered 500/);
    assert.equal(run.summary, undefined, 'nothing half-made is returned');
    assert.equal(typeof run.timings.total, 'number');
});

test('the evidence carries its four layers by name', async () => {
    const run = await runAnalysis({ media: media(), meta, workspace: workspace(), ...fakes() });
    for (const layer of ['<!-- card -->', '<!-- overview -->', '<!-- timeline -->', '<!-- shot -->']) {
        assert.ok(run.videoMd.includes(layer), `missing ${layer}`);
    }
    assert.ok(run.videoMd.indexOf('<!-- card -->') < run.videoMd.indexOf('<!-- shot -->'), 'card comes first, shots last');
    assert.ok(run.videoMd.includes('真实素材名'), 'the name comes from metadata');
});

test('the reported total is at least the sum of its parts', async () => {
    const ticks = [0];
    const now = () => { ticks[0] += 5; return ticks[0]; };
    const run = await runAnalysis({ media: media(), meta, workspace: workspace(), now, ...fakes() });
    const parts = run.timings.frames + run.timings.describe + run.timings.ocr + run.timings.transcribe + run.timings.judge + run.timings.embed + run.timings.warmup;
    assert.ok(run.timings.total >= parts, `total ${run.timings.total} >= parts ${parts}`);
    assert.ok(run.timings.total > 0);
});

test('a media that is not there is refused before anything is sent', async () => {
    const fake = fakes();
    const run = await runAnalysis({ media: { path: join(tmpdir(), 'no-such-clip-9481.mp4') }, meta, workspace: workspace(), ...fake });
    assert.equal(run.ok, false);
    assert.equal(run.step, 'media');
    assert.equal(run.code, 'media-missing');
    assert.equal(fake.calls.describe, 0);
    assert.equal(fake.calls.frames, 0);
});

test('a cache entry written by another analyzer version is not used', async () => {
    const ws = workspace();
    const path = media();
    const digest = mediaDigest(path);
    mkdirSync(join(ws, 'analysis'), { recursive: true });
    writeFileSync(cachePath(ws, digest), JSON.stringify({ analyzerVer: 'an-older-runner', summary: { oneLine: 'stale' }, videoMd: '' }));
    const fake = fakes();
    const run = await runAnalysis({ media: path, meta, workspace: ws, ...fake });
    assert.equal(run.cached, false, 'a different analyzer version is a different answer');
    assert.equal(fake.calls.frames, 1);
    assert.notEqual(run.summary.oneLine, 'stale');
});

test('the evidence renders without scenes, without OCR and without speech', () => {
    const md = renderVideoMd({
        summary: { oneLine: '空素材', confidence: 0.3, states: { ocr: 'not-configured', transcribe: 'not-configured', judge: 'degraded', embed: 'not-configured' }, production: { frames: 0, seconds: 0 }, tags: {}, risks: [] },
        scenes: [], read: [], transcript: '', picked: [], meta: { name: '空素材' },
    });
    assert.ok(md.includes('<!-- card -->') && md.includes('<!-- shot -->'));
    assert.ok(md.includes('OCR not-configured'));
    assert.ok(md.includes('（没有帧可选）'));
});
