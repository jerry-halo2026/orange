// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

﻿// @ts-check
/**
 * Settings → Services in an installed Studio: the account's own store, never the shared one.
 *
 * An installed Studio runs with no isolation profile. Before this, `/api/providers` and
 * `/api/local-models` answered 503 there, so Services could not be reached at all. These cases drive
 * a real Studio server and check what the account gets, what it never gets, and what one account
 * cannot see of another.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const base = process.env.ORANGE_SERVICES_TEST_ROOT ?? join(process.env.TEMP ?? '.', 'openfilm-tests');
const root = await mkdtemp(join(base, 'services-store-'));
const SECRET = 'fixture-key-1234-abcdef';

/** A Studio of its own, with the account the session is. */
async function studio() {
    const home = join(root, `home-${Math.random().toString(16).slice(2)}`);
    const env = {
        OPENFILM_HOME: home, OPENFILM_SHARED_HOME: join(home, 'shared'), OPENFILM_LIBRARY: join(home, 'projects'),
        OPENFILM_LIBRARY_CACHE: join(home, 'cache'), OPENFILM_SAVED: join(home, 'Saved'), OPENFILM_SKILLS: join(home, 'skills'),
        OPENFILM_EXPORTS: join(home, 'exports'), OPENFILM_ISOLATION_PROFILE: undefined, OPENFILM_ISOLATION_ROOT: undefined,
    };
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    for (const path of Object.values(env).filter(Boolean)) await mkdir(path, { recursive: true });
    const editorDir = join(home, 'editor'); await mkdir(editorDir);
    await (await import('node:fs/promises')).writeFile(join(editorDir, 'index.html'), '<html>fixture</html>');
    const { startStudio } = await import('./server.mjs');
    const state = { actor: '11111111-1111-4111-8111-111111111111', signedIn: true };
    const auth = {
        assertActive() {
            if (!state.signedIn) throw new Error('signed out');
            return { environmentId: 'fixture-environment', subjectId: state.actor, instanceId: '33333333-3333-4333-8333-333333333333', epoch: 1 };
        },
        windowScope: () => `scope-${state.actor}`,
        runNative: async (work) => work(), onState: () => () => {}, getPublicState: () => ({ kind: 'active' }),
        authorizeProjectId() { }, authorizeProject() {},
        withProjectMaterialAccess: async (_id, _purpose, work) => work(undefined),
    };
    const server = await startStudio({ port: 0, key: 'fixture-key', editorDir, advertise: false, desktopAuth: auth });
    return { home, state, server, services: join(home, 'services'), shared: join(home, 'providers.json') };
}

const nativeFetch = globalThis.fetch;
async function call(/** @type {any} */ site, /** @type {string} */ path, method = 'GET', body) {
    const response = await nativeFetch(site.server.origin + path, {
        method,
        headers: { 'x-studio-key': site.server.key, connection: 'close', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, text, value: text ? JSON.parse(text) : null };
}

test('an installed Studio reaches Services: providers and local models answer', async () => {
    const site = await studio();
    try {
        const providers = await call(site, '/api/providers');
        assert.equal(providers.status, 200, 'no more "not yet available"');
        assert.ok(Array.isArray(providers.value.providers) && providers.value.providers.length > 0);
        assert.equal(typeof providers.value.providers[0].configured, 'boolean', 'the view says whether it is connected');
        const local = await call(site, '/api/local-models');
        assert.equal(local.status, 200);
        assert.ok(Array.isArray(local.value.models));
    } finally { await site.server.close(); }
});

test('without a session nothing is read and nothing is written', async () => {
    const site = await studio();
    try {
        site.state.signedIn = false;
        const providers = await call(site, '/api/providers');
        assert.equal(providers.status, 403);
        assert.equal(providers.value.code, 'authentication-required');
        const local = await call(site, '/api/local-models');
        assert.equal(local.status, 403);
        assert.equal(existsSync(site.services), false, 'no account folder is made for an anonymous request');
        assert.equal(existsSync(site.shared), false, 'and the shared store is not touched either');
    } finally { await site.server.close(); }
});

test('a key is stored per account, shown only as configured', async () => {
    const site = await studio();
    try {
        const put = await call(site, '/api/providers/openai/key', 'PUT', { key: SECRET });
        assert.equal(put.status, 200);
        assert.ok(!put.text.includes(SECRET), 'the answer never carries the key back');
        const listed = await call(site, '/api/providers');
        assert.equal(listed.status, 200);
        const openai = listed.value.providers.find((/** @type {any} */ p) => p.id === 'openai');
        assert.equal(openai.configured, true);
        assert.equal(openai.last4, SECRET.slice(-4));
        assert.ok(!listed.text.includes(SECRET), 'the listing never carries the key back');
        const files = await readdir(site.services);
        assert.equal(files.length, 1, 'one store for this account');
        const stored = JSON.parse(await readFile(join(site.services, files[0]), 'utf8'));
        assert.equal(stored.keys.openai, SECRET, 'the key is in the account file');
        const mode = (await stat(join(site.services, files[0]))).mode & 0o777;
        if (process.platform === 'win32') {
            // Windows keeps a fixed 0666 mode for files; the writer still asks for 0600 and the folder is the user's own.
            assert.ok(mode & 0o600, 'the file is readable by its owner');
        } else {
            assert.equal(mode, 0o600, 'readable by this user only');
        }
        assert.equal(existsSync(site.shared), false, 'the shared store stays untouched');
        const removed = await call(site, '/api/providers/openai/key', 'DELETE');
        assert.equal(removed.status, 200);
        const after = await call(site, '/api/providers');
        assert.equal(after.value.providers.find((/** @type {any} */ p) => p.id === 'openai').configured, false);
    } finally { await site.server.close(); }
});

test('two accounts never see each other’s services', async () => {
    const site = await studio();
    try {
        await call(site, '/api/providers/openai/key', 'PUT', { key: SECRET });
        const first = await readdir(site.services);
        site.state.actor = '22222222-2222-4222-8222-222222222222';
        const other = await call(site, '/api/providers');
        assert.equal(other.status, 200);
        assert.equal(other.value.providers.find((/** @type {any} */ p) => p.id === 'openai').configured, false, 'the other account starts empty');
        await call(site, '/api/providers/openai/key', 'PUT', { key: 'fixture-key-5678-other' });
        const files = await readdir(site.services);
        assert.equal(files.length, 2, 'one store each');
        assert.notDeepEqual(files, first);
        const mine = JSON.parse(await readFile(join(site.services, files.find((/** @type {string} */ f) => !first.includes(f)) ?? files[0]), 'utf8'));
        assert.equal(mine.keys.openai, 'fixture-key-5678-other');
    } finally { await site.server.close(); }
});

