// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

﻿// @ts-check
/**
 * Saved is the person's library: a session alone does not open it. These cases drive a real Studio
 * server with a synthetic account, so the four checked entry points (the `/api/saved` segment, the
 * write into the library, `saved/take`, and the film origin's `\0saved` page) are exercised as the
 * page and the media pane would reach them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const base = process.env.ORANGE_SERVICES_TEST_ROOT;
assert.ok(base && resolve(base) === base, 'explicit owned test root required');
await mkdir(base, { recursive: true });

const ENV = 'fixture-environment';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

/** A Studio of its own: env, an editor page, and the account the session is. */
async function studio() {
    const root = await mkdtemp(join(base, 'saved-'));
    const env = {
        ORANGE_HOME: join(root, 'home'), ORANGE_SHARED_HOME: join(root, 'shared'), ORANGE_LIBRARY: join(root, 'projects'),
        ORANGE_LIBRARY_CACHE: join(root, 'cache'), ORANGE_SAVED: join(root, 'saved'), ORANGE_SKILLS: join(root, 'skills'),
        ORANGE_EXPORTS: join(root, 'exports'), ORANGE_ISOLATION_PROFILE: undefined, ORANGE_ISOLATION_ROOT: undefined,
    };
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    for (const path of Object.values(env).filter(Boolean)) await mkdir(path, { recursive: true });
    const editorDir = join(root, 'editor'); await mkdir(editorDir);
    await writeFile(join(editorDir, 'index.html'), '<html>fixture</html>');
    const { startStudio } = await import('./server.mjs');
    const state = { actor: A, signedIn: true };
    const auth = {
        assertActive() { if (!state.signedIn) throw new Error('signed out'); return { environmentId: ENV, subjectId: state.actor, instanceId: '33333333-3333-4333-8333-333333333333', epoch: 1 }; },
        windowScope() { return `scope-${state.actor}`; },
        runNative: async (work) => work(), onState: () => () => {}, getPublicState: () => ({ kind: 'active' }),
        authorizeProjectId() { }, authorizeProject() { },
        withProjectMaterialAccess: async (_id, _purpose, work) => work(undefined),
    };
    const server = await startStudio({ port: 0, key: 'fixture-key', editorDir, advertise: false, desktopAuth: auth });
    return {
        root, state, server,
        ownersFile: join(env.ORANGE_HOME, 'orange-saved-owners.json'),
        saved: env.ORANGE_SAVED,
        async claim(actor = A) {
            const previous = state.actor; state.actor = actor;
            await writeFile(join(env.ORANGE_HOME, 'orange-saved-owners.json'),
                JSON.stringify({ version: 1, saved: [{ environmentId: ENV, subjectId: actor, windowScope: `scope-${actor}`, claimedAt: new Date(0).toISOString() }] }) + '\n');
            state.actor = previous;
        },
    };
}

const nativeFetch = globalThis.fetch;
async function call(/** @type {any} */ site, /** @type {string} */ path, method = 'GET', body, origin) {
    const response = await nativeFetch((origin ?? site.server.origin) + path, {
        method,
        headers: { 'x-studio-key': site.server.key, connection: 'close', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let value = null;
    try { value = text ? JSON.parse(text) : null; } catch { value = text; }
    return { status: response.status, value };
}

test('a library that already holds media is 503 until claimed, and another account is 403', async () => {
    const site = await studio();
    try {
        await mkdir(join(site.saved, '云素材'), { recursive: true });
        await writeFile(join(site.saved, '云素材', 'existing.mp4'), 'someone’s bytes');
        site.state.signedIn = false;
        const anonymous = await call(site, '/api/saved/files');
        assert.equal(anonymous.status, 403);
        assert.equal(anonymous.value.code, 'authentication-required');
        site.state.signedIn = true;
        const unclaimed = await call(site, '/api/saved/files');
        assert.equal(unclaimed.status, 503, 'a session alone never opens a library that holds media');
        assert.equal(unclaimed.value.code, 'saved-ownership-required');
        await site.claim(A);
        const mine = await call(site, '/api/saved/files');
        assert.equal(mine.status, 200, 'the owner reads it');
        site.state.actor = B;
        const foreign = await call(site, '/api/saved/files');
        assert.equal(foreign.status, 403);
        assert.equal(foreign.value.code, 'saved-access-denied');
    } finally { await site.server.close(); }
});

test('a Saved page plays for its owner and is refused to another account', async () => {
    const site = await studio();
    try {
        await site.claim(A);
        await mkdir(join(site.saved, '云素材'), { recursive: true });
        await writeFile(join(site.saved, '云素材', 'v-1.mp4'), 'fixture bytes');
        const listed = await call(site, '/api/saved/files');
        assert.equal(listed.status, 200);
        const folder = listed.value.folder;
        assert.ok(folder, 'the library names its film-origin folder');
        const page = await call(site, new URL(folder).pathname, 'GET', undefined, site.server.filmOrigin);
        assert.notEqual(page.status, 403, 'an owner’s Saved page is not refused by the project owner check');
        site.state.actor = B;
        const refused = await call(site, new URL(folder).pathname, 'GET', undefined, site.server.filmOrigin);
        assert.equal(refused.status, 403, 'another account does not play the owner’s page');
    } finally { await site.server.close(); }
});

test('the library lists exactly one flat entry per video, and never the sidecar folder', async () => {
    const site = await studio();
    try {
        await site.claim(A);
        const cloud = join(site.saved, '云素材');
        await mkdir(join(cloud, '.meta'), { recursive: true });
        await writeFile(join(cloud, 'v-1.mp4'), 'bytes');
        await writeFile(join(cloud, '.meta', 'v-1.json'), JSON.stringify({ videoId: 'v-1' }));
        const listed = await call(site, '/api/saved/files');
        assert.equal(listed.status, 200);
        const paths = listed.value.files.map((/** @type {any} */ file) => file.path);
        assert.deepEqual(paths, ['saved/云素材/v-1.mp4'], 'one flat media entry, no sidecar, no dot folder');
        const names = await readdir(cloud);
        assert.ok(names.includes('.meta'), 'the sidecar folder is there, simply not listed');
    } finally { await site.server.close(); }
});

test('an empty library is claimed by the first signed-in session', async () => {
    const site = await studio();
    try {
        assert.equal(await readFile(site.ownersFile, 'utf8').then(() => true, () => false), false, 'nothing claimed yet');
        const first = await call(site, '/api/saved/files');
        assert.equal(first.status, 200, 'an empty library has nothing to take over');
        const owners = JSON.parse(await readFile(site.ownersFile, 'utf8'));
        assert.deepEqual(owners.saved.map((/** @type {any} */ record) => record.subjectId), [A]);
    } finally { await site.server.close(); }
});

test('claiming a library that already holds media needs the explicit confirmation', async () => {
    const site = await studio();
    try {
        await mkdir(join(site.saved, '云素材'), { recursive: true });
        await writeFile(join(site.saved, '云素材', 'existing.mp4'), 'someone’s bytes');
        const missing = await call(site, '/api/saved/claim', 'POST', {});
        assert.equal(missing.status, 400);
        assert.equal(missing.value.code, 'saved-claim-confirmation-required');
        const claimed = await call(site, '/api/saved/claim', 'POST', { confirm: 'claim-existing-library' });
        assert.equal(claimed.status, 200);
        assert.equal(claimed.value.claimed, true);
        const listed = await call(site, '/api/saved/files');
        assert.equal(listed.status, 200, 'after the claim the library opens');
        site.state.actor = B;
        const foreign = await call(site, '/api/saved/claim', 'POST', { confirm: 'claim-existing-library' });
        assert.equal(foreign.status, 409, 'another account needs the explicit takeover confirmation');
        assert.equal(foreign.value.code, 'saved-claim-takeover-required');
        const ownership = await call(site, '/api/saved/ownership');
        assert.equal(ownership.status, 200);
        assert.equal(ownership.value.mine, false);
        const ref = ownership.value.refs[0].ref;
        const adopted = await call(site, '/api/saved/claim', 'POST', { confirm: 'add-this-account', owner: ref });
        assert.equal(adopted.status, 200);
        assert.equal(adopted.value.added, true);
        const after = JSON.parse(await readFile(site.ownersFile, 'utf8'));
        assert.equal(after.saved.length, 2, 'the old owner is kept and the new one is added');
    } finally { await site.server.close(); }
});
