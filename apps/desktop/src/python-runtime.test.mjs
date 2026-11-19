// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

﻿import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PYTHON_BUILDS, PYTHON_MIN, ensurePython, fetchPython, pythonBinary, pythonDir, pythonDownloadable, pythonIn, versionAtLeast } from './python-runtime.mjs';

const dataDir = () => mkdtempSync(join(tmpdir(), 'python-runtime-'));
const bytes = Buffer.from('fixture-archive-bytes');
const sha = createHash('sha256').update(bytes).digest('hex');
const answer = (/** @type {Buffer} */ body, status = 200) => new Response(body, { status, headers: { 'content-length': String(body.length) } });

test('the version table is per platform and names a license and a program', () => {
    for (const [key, build] of Object.entries(PYTHON_BUILDS)) {
        assert.match(key, /^(win32|darwin)-(x64|arm64)$/);
        assert.match(build.version, /^\d+\.\d+\.\d+$/);
        assert.ok(versionAtLeast(build.version, PYTHON_MIN), `${key} is at least ${PYTHON_MIN}`);
        assert.match(build.url, /^https:\/\/github\.com\/astral-sh\/python-build-standalone\/releases\/download\//);
        assert.equal(typeof build.license.name, 'string');
        assert.ok(build.binary === 'python.exe' || build.binary === 'python3');
    }
});

test('versions compare as numbers, so 3.9 is older than 3.10', () => {
    assert.equal(versionAtLeast('3.10.0', '3.10'), true);
    assert.equal(versionAtLeast('3.12.7', '3.10'), true);
    assert.equal(versionAtLeast('3.9.18', '3.10'), false);
    assert.equal(versionAtLeast('2.7.18', '3.10'), false);
});

test('an unpinned platform downloads nothing, and says why', async () => {
    const dir = pythonDir(dataDir());
    assert.equal(pythonDownloadable('linux', 'x64'), false);
    await assert.rejects(() => fetchPython(dir, { platform: 'linux', arch: 'x64', fetch: async () => answer(bytes) }), /no Python runtime to download/);
    assert.equal(existsSync(dir), false, 'nothing is made for a platform with no build');
});

test('an archive that does not match the pinned sha256 is refused and leaves no file behind', async () => {
    const build = PYTHON_BUILDS['win32-x64'];
    const pinned = { ...build, sha256: 'a'.repeat(64) };
    PYTHON_BUILDS['win32-x64'].sha256 = 'a'.repeat(64);
    const dir = pythonDir(dataDir(), 'win32', 'x64');
    try {
        await assert.rejects(
            () => fetchPython(dir, { platform: 'win32', arch: 'x64', fetch: async () => answer(bytes) }),
            /did not match its sha256/,
        );
        assert.deepEqual(readdirSync(dir), [], 'not one file of a refused download is left');
        assert.equal(pythonIn(dir, 'win32'), false);
    } finally { PYTHON_BUILDS['win32-x64'].sha256 = pinned.sha256; }
});

test('the bytes land in the cache folder once, and are recognised next time', async () => {
    PYTHON_BUILDS['win32-x64'].sha256 = sha;
    const root = dataDir();
    let asked = 0;
    try {
        const dir = await ensurePython(root, { platform: 'win32', arch: 'x64', fetch: async () => { asked++; return answer(bytes); }, license: true });
        assert.equal(dir, pythonDir(root, 'win32', 'x64'));
        assert.equal(asked, 1);
        assert.equal(readFileSync(join(dir, 'python-runtime.tar.gz')).length, bytes.length);
        const recorded = JSON.parse(readFileSync(join(dir, 'python-runtime.json'), 'utf8'));
        assert.equal(recorded.sha256, sha);
        assert.equal(recorded.version, PYTHON_BUILDS['win32-x64'].version);
        assert.match(readFileSync(join(dir, 'LICENSE.md'), 'utf8'), /PSF-2\.0/);
        // the program itself is put there by unpacking; a folder with a marker and a program counts as ready
        mkdirSync(join(dir, 'python', 'bin'), { recursive: true });
        writeFileSync(pythonBinary(dir, 'win32'), '');
        assert.equal(pythonIn(dir, 'win32'), true);
        const again = await ensurePython(root, { platform: 'win32', arch: 'x64', fetch: async () => { asked++; return answer(bytes); } });
        assert.equal(again, dir);
        assert.equal(asked, 1, 'a runtime already there is not downloaded twice');
    } finally { PYTHON_BUILDS['win32-x64'].sha256 = null; }
});

test('a marker saying an old Python is there is not used', () => {
    const dir = pythonDir(dataDir(), 'win32', 'x64');
    mkdirSync(dir, { recursive: true });
    writeFileSync(pythonBinary(dir, 'win32'), '');
    writeFileSync(join(dir, 'python-runtime.json'), JSON.stringify({ version: '3.8.10' }));
    assert.equal(pythonIn(dir, 'win32'), false, 'the component needs 3.10 or later');
});

