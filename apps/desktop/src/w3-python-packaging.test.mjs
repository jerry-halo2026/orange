// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOT_INSTALLED_EXIT, componentDir, installed, manifest, missingReport, servicesRoot } from '../../../packages/openfilm/src/analyze.mjs';
import { editorModulesDir } from './openfilm-mcp.mjs';
import { PACKED_EDITOR_MODULES, PACKED_EDITOR_ROOT } from '../scripts/packed-editor-modules.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, '..');
const repo = join(desktop, '..', '..');
const cli = join(repo, 'packages/openfilm/bin/openfilm.mjs');

/** A services root of its own, so a test never touches the person's real one. */
const servicesRootOf = () => mkdtempSync(join(tmpdir(), 'services-root-'));

test('the component describes itself, and says where it would live', () => {
    const described = manifest();
    assert.equal(described.name, 'rea-video');
    assert.equal(described.license, 'Apache-2.0');
    assert.match(described.requires.python, />=3\.10/);
    assert.equal(described.install.onDemand, true);
    const root = servicesRootOf();
    const options = { env: { OPENFILM_SERVICES_ROOT: root }, platform: 'win32' };
    assert.equal(servicesRoot(options), root);
    assert.equal(componentDir(options), join(root, 'services', 'rea-video'));
    assert.equal(installed(options), false, 'nothing is installed in an empty root');
    const report = missingReport(options);
    assert.equal(report.reason, 'component-missing');
    assert.equal(report.sizeMB, described.install.sizeMB);
    assert.match(report.message, /首次使用分析功能需要安装组件/);
});

test('without the component `openfilm analyze` says so in one structured line, and exits 4 — not 2', () => {
    const root = servicesRootOf();
    const run = spawnSync(process.execPath, [cli, 'analyze', 'clip.mp4'], {
        encoding: 'utf8',
        env: { ...process.env, OPENFILM_SERVICES_ROOT: root },
    });
    assert.equal(run.status, NOT_INSTALLED_EXIT, 'its own code: the component is missing');
    assert.notEqual(run.status, 2, 'never a usage error');
    // The contract a caller can rely on: stdout empty, stderr exactly one line, that line JSON.
    assert.equal(run.stdout, '', 'nothing is pretended on stdout');
    const lines = (run.stderr ?? '').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'exactly one line on stderr, whatever flags were passed');
    const report = JSON.parse(lines[0]);
    assert.equal(report.analyze, 'unavailable');
    assert.equal(report.reason, 'component-missing');
    assert.equal(report.component, 'rea-video');
    assert.ok(report.sizeMB > 0);
    // and the same without --json: the shape does not depend on the flag
    const plain = spawnSync(process.execPath, [cli, 'analyze', 'clip.mp4'], { encoding: 'utf8', env: { ...process.env, OPENFILM_SERVICES_ROOT: root } });
    assert.equal(plain.status, NOT_INSTALLED_EXIT);
    assert.equal(plain.stdout, '');
    assert.equal((plain.stderr ?? '').trim().split('\n').filter(Boolean).length, 1);
    assert.equal(JSON.parse((plain.stderr ?? '').trim()).reason, 'component-missing');
});

test('an installed component is not mistaken for a missing one', () => {
    const root = servicesRootOf();
    const dir = join(root, 'services', 'rea-video');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.installed'), '');
    assert.equal(installed({ env: { OPENFILM_SERVICES_ROOT: root } }), true, 'the marker says it is there');
    // Installed means the command goes on to analyse: it does not answer as "component missing" (4).
    // Nothing here can analyse (no media, no ffmpeg, no model), so the honest answer is 5 with a code.
    // `--video-id` is given because the write-back is keyed by it: without one the command stops before reading a
    // frame (`video-id-required`), which would prove the component was installed but not that it was tried.
    const run = spawnSync(process.execPath, [cli, 'analyze', 'clip.mp4', '--video-id', 'fixture-video', '--json'], {
        encoding: 'utf8',
        env: { ...process.env, OPENFILM_SERVICES_ROOT: root },
    });
    assert.notEqual(run.status, NOT_INSTALLED_EXIT, 'not "component missing"');
    assert.equal(run.status, 5, 'it tried, and the analysis failed with its own code');
    const answer = JSON.parse((run.stdout ?? '').trim().split('\n').at(-1) ?? '{}');
    assert.equal(answer.ok, false);
    assert.match(answer.code, /media-missing|frames-empty|not-configured/, 'a named reason, not a stack');
});
test('the packaged app reaches the editor modules from resources, a source run from the checkout', () => {
    // packaged: resources/openfilm/packages/... is where scripts/release.mjs puts them
    const resources = mkdtempSync(join(tmpdir(), 'resources-'));
    for (const relative of PACKED_EDITOR_MODULES) {
        const file = join(resources, PACKED_EDITOR_ROOT, relative);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, 'export const fixture = true;\n');
    }
    const packaged = editorModulesDir({ resources, env: {} });
    assert.equal(packaged, join(resources, PACKED_EDITOR_ROOT), 'the installed app reads its resources');

    // source: no resources folder, so the checkout this file lives in
    const source = editorModulesDir({ resources: undefined, env: {} });
    assert.equal(source, repo, 'a source run reads the checkout');

    // either way an explicit folder wins (a moved install, and the tests that need a stub)
    assert.equal(editorModulesDir({ resources, env: { OPENFILM_EDITOR_MODULES: '/somewhere/else' } }), resolve('/somewhere/else'));
});

test('the release packs exactly the modules the MCP server loads', () => {
    assert.ok(PACKED_EDITOR_MODULES.includes('packages/openfilm/src/film-doc.mjs'));
    assert.ok(PACKED_EDITOR_MODULES.includes('packages/openfilm/studio/server/ops.mjs'));
    assert.ok(PACKED_EDITOR_MODULES.includes('packages/openfilm/src/clip-motion.mjs'), 'ops.mjs imports it');
    // release.mjs runs its build when imported, so its packaging step is read as text.
    const text = readFileSync(join(desktop, 'scripts', 'release.mjs'), 'utf8');
    assert.match(text, /PACKED_EDITOR_MODULES/, 'the release copies the list, not a hand-written one');
    assert.match(text, /to: PACKED_EDITOR_ROOT/, 'and ships it as resources/openfilm');
    for (const relative of PACKED_EDITOR_MODULES) {
        assert.ok(existsSync(join(repo, relative)), relative + ' exists to be copied');
    }
});
