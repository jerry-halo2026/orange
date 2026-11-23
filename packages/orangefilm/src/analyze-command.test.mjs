// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * `openfilm analyze` from the command line: default options, `--json` shape, and the four exit codes.
 * The analyser itself is faked here (the service module is loaded for real when it is reachable);
 * what is under test is the command's own behaviour.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANALYZE_DEFAULTS, EXIT } from './analyze-command.mjs';
import { componentDir, servicesRoot } from './analyze.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const cli = join(packageRoot, 'bin', 'openfilm.mjs');

/** A component that is installed (so the command gets past the exit-4 gate). */
function withComponent(/** @type {Record<string, string | undefined>} */ extra = {}) {
    const root = mkdtempSync(join(tmpdir(), 'analyze-cli-'));
    mkdirSync(join(root, 'services', 'rea-video'), { recursive: true });
    writeFileSync(join(root, 'services', 'rea-video', '.installed'), '');
    return { root, env: { ...process.env, OPENFILM_SERVICES_ROOT: root, ...extra } };
}

test('the defaults are the measured ones: 6 frames at a 512 long edge', async () => {
    assert.deepEqual(ANALYZE_DEFAULTS, { frames: 6, longEdge: 512 });
    const seen = [];
    const service = {
        analysisWorkspace: (/** @type {string} */ project) => join(project, '.openfilm', 'analysis'),
        runAnalyze: async (/** @type {any} */ ask) => { seen.push(ask); return { ok: true, uploaded: false, cache: 'local', detail: { summary: {}, timings: {}, states: {} } }; },
    };
    const site = withComponent();
    const before = process.env.OPENFILM_SERVICES_ROOT;
    process.env.OPENFILM_SERVICES_ROOT = site.root;
    try {
        await inProcessWith(service, ['clip.mp4'], { json: true });
        assert.equal(seen.length, 1);
        assert.equal(seen[0].options.frameOptions.maxFrames, 6, 'six frames by default');
        assert.equal(seen[0].options.frameOptions.longEdge, 512, '512 long edge by default');
        await inProcessWith(service, ['clip.mp4'], { json: true, frames: 3, longEdge: 768 });
        assert.equal(seen[1].options.frameOptions.maxFrames, 3, 'a flag wins');
        assert.equal(seen[1].options.frameOptions.longEdge, 768);
    } finally {
        if (before === undefined) delete process.env.OPENFILM_SERVICES_ROOT; else process.env.OPENFILM_SERVICES_ROOT = before;
    }
});

/** The command with its service replaced. */
async function inProcessWith(/** @type {any} */ service, /** @type {string[]} */ args, /** @type {any} */ opts) {
    const module = await import('./analyze-command.mjs');
    const printed = { out: [], err: [] };
    const original = { log: console.log, error: console.error, exitCode: process.exitCode };
    console.log = (/** @type {any} */ ...list) => printed.out.push(list.join(' '));
    console.error = (/** @type {any} */ ...list) => printed.err.push(list.join(' '));
    // the module resolves its service through an import; a stub is installed on the module object
    try {
        const answer = await module.analyzeCommandWith(service, args, opts, 'openfilm');
        return { answer, printed, exitCode: answer.code };
    } finally {
        console.log = original.log;
        console.error = original.error;
        process.exitCode = original.exitCode;
    }
}

test('--json prints exactly the fields an agent needs, and no media path', async () => {
    const media = '/home/someone/clips/private-name.mp4';
    const service = {
        analysisWorkspace: (/** @type {string} */ project) => join(project, '.openfilm', 'analysis'),
        runAnalyze: async () => ({
            ok: true, uploaded: true, cache: 'local+remote',
            detail: {
                summary: { oneLine: '一条测试素材', states: { judge: 'ok' }, production: { frames: 6 } },
                timings: { frames: 300, describe: 24000, total: 25000 },
                states: { scene: 'ok', ocr: 'not-configured', transcribe: 'not-configured', judge: 'ok', embed: 'ok' },
            },
        }),
    };
    const site = withComponent();
    const before = process.env.OPENFILM_SERVICES_ROOT;
    process.env.OPENFILM_SERVICES_ROOT = site.root;
    try {
        const { printed } = await inProcessWith(service, [media], { json: true });
        const value = JSON.parse(printed.out.at(-1) ?? '{}');
        assert.deepEqual(Object.keys(value).sort(), ['cache', 'ok', 'states', 'summary', 'timings', 'uploaded']);
        assert.equal(value.ok, true);
        assert.equal(value.uploaded, true);
        assert.equal(value.cache, 'local+remote');
        assert.equal(value.timings.total, 25000);
        assert.equal(value.states.ocr, 'not-configured');
        const said = printed.out.join('\n');
        assert.ok(!said.includes(media), 'the answer does not carry the media path');
        assert.ok(!/\/home\/someone|private-name/.test(said), 'nor any piece of it');
    } finally {
        if (before === undefined) delete process.env.OPENFILM_SERVICES_ROOT; else process.env.OPENFILM_SERVICES_ROOT = before;
    }
});

test('an analysis that failed exits 5 with its own code', async () => {
    const service = {
        analysisWorkspace: (/** @type {string} */ project) => join(project, '.openfilm', 'analysis'),
        runAnalyze: async () => ({ ok: false, uploaded: false, reason: 'frames-empty' }),
    };
    const site = withComponent();
    const before = process.env.OPENFILM_SERVICES_ROOT;
    process.env.OPENFILM_SERVICES_ROOT = site.root;
    try {
        const { printed, answer } = await inProcessWith(service, ['clip.mp4'], { json: true });
        assert.equal(answer.code, EXIT.failed);
        assert.equal(EXIT.failed, 5);
        const value = JSON.parse(printed.out.at(-1) ?? '{}');
        assert.equal(value.ok, false);
        assert.equal(value.code, 'frames-empty');
    } finally {
        if (before === undefined) delete process.env.OPENFILM_SERVICES_ROOT; else process.env.OPENFILM_SERVICES_ROOT = before;
    }
});

test('the real command: no media is a usage error (2), and a missing component is 4', () => {
    const usage = spawnSync(process.execPath, [cli, 'analyze'], { encoding: 'utf8', env: process.env });
    assert.equal(usage.status, 2, 'no media: the command itself is wrong');
    assert.match(usage.stderr, /which media/);

    const empty = mkdtempSync(join(tmpdir(), 'no-component-'));
    const missing = spawnSync(process.execPath, [cli, 'analyze', 'clip.mp4', '--json'], {
        encoding: 'utf8', env: { ...process.env, OPENFILM_SERVICES_ROOT: empty },
    });
    assert.equal(missing.status, 4, 'the component is not installed');
    const report = JSON.parse((missing.stderr ?? '').trim().split('\n').at(-1) ?? '{}');
    assert.equal(report.reason, 'component-missing');
    assert.equal(report.component, 'rea-video');
});

test('the component is looked for where the app puts it', () => {
    const root = mkdtempSync(join(tmpdir(), 'component-'));
    const options = { env: { OPENFILM_SERVICES_ROOT: root } };
    assert.equal(servicesRoot(options), root);
    assert.equal(componentDir(options), join(root, 'services', 'rea-video'));
});
