// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

﻿// @ts-check
/**
 * The material cache's root, in every kind of Studio run: an isolation profile, the operator's
 * MATERIALS_CACHE_ROOT, or Studio's own private folder. The last two exist so an ordinary desktop
 * run (no ORANGE_ISOLATION_*) still builds the material service instead of answering 501 forever.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MATERIALS_CACHE_DIR, MATERIALS_CACHE_ROOT_INVALID, MATERIALS_CACHE_ROOT_IS_SAVED, materialsCacheRoot } from './materials-cache-root.mjs';

const folder = async () => mkdtemp(join(tmpdir(), 'materials-root-'));

test('an isolation profile keeps its own cache location, whatever the environment says', async () => {
    const home = await folder();
    try {
        const isolation = { paths: { cache: join(home, 'profile-cache') } };
        const root = materialsCacheRoot({ isolation, env: { MATERIALS_CACHE_ROOT: join(home, 'asked') }, home: () => join(home, 'home') });
        assert.equal(root, isolation.paths.cache);
    } finally { await rm(home, { recursive: true, force: true }); }
});

test('MATERIALS_CACHE_ROOT is used, and made, when there is no isolation profile', async () => {
    const home = await folder();
    try {
        const asked = join(home, 'cache-here');
        const root = materialsCacheRoot({ isolation: null, env: { MATERIALS_CACHE_ROOT: asked }, home: () => join(home, 'home') });
        assert.equal(root, asked);
        assert.equal((await stat(asked)).isDirectory(), true, 'a missing folder is made');
        assert.deepEqual(await readdir(join(home, 'home')).catch(() => []), [], 'the home folder is not used or made');
    } finally { await rm(home, { recursive: true, force: true }); }
});

test('with nothing said the cache sits in Studio\'s own folder', async () => {
    const home = await folder();
    try {
        const root = materialsCacheRoot({ isolation: null, env: {}, home: () => join(home, 'home') });
        assert.equal(root, join(home, 'home', MATERIALS_CACHE_DIR));
        assert.equal((await stat(root)).isDirectory(), true);
    } finally { await rm(home, { recursive: true, force: true }); }
});

test('a MATERIALS_CACHE_ROOT that names a file fails loudly, with a fixed code', async () => {
    const home = await folder();
    try {
        const file = join(home, 'not-a-folder');
        await writeFile(file, 'x');
        assert.throws(
            () => materialsCacheRoot({ isolation: null, env: { MATERIALS_CACHE_ROOT: file }, home: () => join(home, 'home') }),
            (/** @type {any} */ error) => error.code === MATERIALS_CACHE_ROOT_INVALID && /file, not a folder/.test(error.message),
        );
        assert.throws(
            () => materialsCacheRoot({ isolation: null, env: { MATERIALS_CACHE_ROOT: 'relative/cache' }, home: () => join(home, 'home') }),
            (/** @type {any} */ error) => error.code === MATERIALS_CACHE_ROOT_INVALID,
        );
    } finally { await rm(home, { recursive: true, force: true }); }
});

/** Boot a Studio the way a desktop run does: no isolation profile, the given environment. */
async function boot(/** @type {Record<string, string | undefined>} */ env) {
    const root = await mkdtemp(join(tmpdir(), 'materials-boot-'));
    // Every boot starts from no material settings at all, so one test cannot leak into the next.
    for (const key of ['MATERIALS_UPSTREAM', 'MATERIALS_SECRET', 'MATERIALS_CACHE_ROOT']) delete process.env[key];
    const settings = { ORANGE_HOME: join(root, 'home'), ORANGE_SHARED_HOME: join(root, 'shared'), ORANGE_LIBRARY: join(root, 'projects'), ORANGE_LIBRARY_CACHE: join(root, 'cache'), ORANGE_SAVED: join(root, 'saved'), ORANGE_SKILLS: join(root, 'skills'), ORANGE_EXPORTS: join(root, 'exports'), ORANGE_ISOLATION_PROFILE: undefined, ORANGE_ISOLATION_ROOT: undefined, ...env };
    for (const [key, value] of Object.entries(settings)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    for (const path of [settings.ORANGE_HOME, settings.ORANGE_SHARED_HOME, settings.ORANGE_LIBRARY, settings.ORANGE_LIBRARY_CACHE, settings.ORANGE_SAVED, settings.ORANGE_SKILLS, settings.ORANGE_EXPORTS]) if (path) await mkdir(path, { recursive: true });
    const editorDir = join(root, 'editor'); await mkdir(editorDir); await writeFile(join(editorDir, 'index.html'), '<html>fixture</html>');
    const { startStudio } = await import('./server.mjs');
    // The material routes name the person: a synthetic signed-in session, as the desktop would have.
    const auth = {
        assertActive: () => ({ environmentId: 'fixture-environment', subjectId: '11111111-1111-4111-8111-111111111111', instanceId: '33333333-3333-4333-8333-333333333333', epoch: 1 }),
        windowScope: () => 'fixture-scope', runNative: async (work) => work(), onState: () => () => {},
        getPublicState: () => ({ kind: 'active' }), authorizeProjectId() { }, authorizeProject() { },
        withProjectMaterialAccess: async (_id, _purpose, work) => work(undefined),
    };
    const studio = await startStudio({ port: 0, key: 'fixture-key', editorDir, advertise: false, desktopAuth: auth });
    return { root, studio, settings };
}

const nativeFetch = globalThis.fetch;
const ask = async (/** @type {any} */ studio) => {
    const response = await nativeFetch(studio.origin + '/api/materials/list', { headers: { 'x-studio-key': studio.key, connection: 'close' } });
    return { status: response.status, body: await response.json().catch(() => null) };
};

test('an ordinary desktop run builds the service: the configured root is enough', async () => {
    const site = await boot({ MATERIALS_UPSTREAM: 'http://127.0.0.1:1', MATERIALS_SECRET: 'fixture-secret' });
    try {
        assert.equal(existsSync(join(site.settings.ORANGE_HOME ?? '', MATERIALS_CACHE_DIR)), true, 'the cache folder exists beside Studio data');
        const answer = await ask(site.studio);
        assert.notEqual(answer.status, 501, 'the service is there: no "not connected" answer');
        assert.equal(answer.body?.code, 'material-upstream-unreachable', 'and it really tried to read the configured upstream');
    } finally { await site.studio.close(); }
});

test('MATERIALS_CACHE_ROOT decides where that run keeps its cache', async () => {
    const chosen = await mkdtemp(join(tmpdir(), 'chosen-cache-'));
    const site = await boot({ MATERIALS_UPSTREAM: 'http://127.0.0.1:1', MATERIALS_SECRET: 'fixture-secret', MATERIALS_CACHE_ROOT: chosen });
    try {
        const answer = await ask(site.studio);
        assert.notEqual(answer.status, 501, 'the service is built from the chosen root');
        assert.equal(existsSync(chosen), true, 'the configured root is the one used (it is made)');
        assert.equal(existsSync(join(site.settings.ORANGE_HOME ?? '', MATERIALS_CACHE_DIR)), false, 'and the home fallback is not touched');
    } finally { await site.studio.close(); await rm(chosen, { recursive: true, force: true }); }
});

test('without an upstream or a secret the routes still say the service is not connected', async () => {
    const site = await boot({});
    try {
        const answer = await ask(site.studio);
        assert.equal(answer.status, 501);
        assert.equal(answer.body?.code, 'material-service-unavailable');
    } finally { await site.studio.close(); }
});

test('a cache root that is Saved, sits in Saved, or holds Saved is refused', async () => {
    const home = await folder();
    try {
        const saved = join(home, 'Saved');
        await mkdir(saved, { recursive: true });
        const withSaved = (/** @type {string} */ root) => materialsCacheRoot({ isolation: null, env: { MATERIALS_CACHE_ROOT: root }, home: () => join(home, 'home'), saved: () => saved });
        for (const [label, root] of [
            ['Saved itself', saved],
            ['the parent of Saved', home],
            ['inside Saved', join(saved, 'cache')],
            ['inside Saved, deeper', join(saved, '云素材', 'cache')],
        ]) {
            assert.throws(
                () => withSaved(root),
                (/** @type {any} */ error) => error.code === MATERIALS_CACHE_ROOT_IS_SAVED,
                `${label} must be refused by name`,
            );
        }
        const sibling = join(home, 'cache-next-door');
        assert.equal(withSaved(sibling), sibling, 'a sibling folder is fine');
        const fallback = materialsCacheRoot({ isolation: null, env: {}, home: () => join(home, 'home'), saved: () => saved });
        assert.equal(fallback, join(home, 'home', MATERIALS_CACHE_DIR), 'the home fallback is a sibling of Saved, not inside it');
    } finally { await rm(home, { recursive: true, force: true }); }
});

test('an isolation profile whose cache location overlapped Saved would be refused too', async () => {
    const home = await folder();
    try {
        const saved = join(home, 'Saved');
        await mkdir(saved, { recursive: true });
        assert.throws(
            () => materialsCacheRoot({ isolation: { paths: { cache: join(saved, 'cache') } }, env: {}, home: () => join(home, 'home'), saved: () => saved }),
            (/** @type {any} */ error) => error.code === MATERIALS_CACHE_ROOT_IS_SAVED,
        );
        const apart = join(home, 'profile-cache');
        assert.equal(materialsCacheRoot({ isolation: { paths: { cache: apart } }, env: {}, home: () => join(home, 'home'), saved: () => saved }), apart);
    } finally { await rm(home, { recursive: true, force: true }); }
});
