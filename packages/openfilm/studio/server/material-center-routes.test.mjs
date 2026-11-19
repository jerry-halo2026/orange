// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMaterialCenterRoutes } from './material-center-routes.mjs';

/** A response stand-in: records what the handler would send. */
const res = () => {
    /** @type {{status?: number, body?: string, headers?: Record<string,string>}} */
    const seen = {};
    return {
        seen,
        writeHead(status, headers) { seen.status = status; seen.headers = headers; },
        end(body) { seen.body = String(body); },
        get destroyed() { return false; },
        get writableEnded() { return false; },
    };
};

/** A request stand-in; only the method is ever read here. */
const req = (method = 'GET') => ({ method });
/** The session every route in this group is read with. */
const session = () => ({ assertActive: () => ({ environmentId: 'env-1', subjectId: '11111111-1111-4111-8111-111111111111' }) });
/** A request that names a path, as the cover route does. */
const asking = (url, method = 'GET') => ({ method, url, headers: {} });

test('a path that is not the material centre is not this handler', async () => {
    const routes = createMaterialCenterRoutes({});
    assert.equal(await routes(/** @type {any} */ (req()), /** @type {any} */ (res()), ['projects', 'x']), false);
});

test('an unknown material route is a named 404, never a fall-through', async () => {
    const routes = createMaterialCenterRoutes({});
    await assert.rejects(
        () => routes(/** @type {any} */ (req()), /** @type {any} */ (res()), ['materials', 'cover', 'not-a-name']),
        (/** @type {any} */ error) => error.status === 404 && error.extra.code === 'material-route-unknown',
    );
    await assert.rejects(
        () => routes(/** @type {any} */ (req()), /** @type {any} */ (res()), ['materials']),
        (/** @type {any} */ error) => error.status === 404,
    );
});

test('a cover asked for by url is its own route, and says what is missing when nothing answers it', async () => {
    /* `cover?url=…` is the supplier's CDN address, answered from this computer's cover cache: the route exists before
       any service does, so an installation without one names the missing service instead of pretending the path is
       unknown (the page's cards would read a 404 as "this material has no cover"). */
    /** @type {string[]} */
    const called = [];
    const routes = createMaterialCenterRoutes({ service: { coverByUrl: async () => { called.push('coverByUrl'); } }, auth: session() });
    assert.equal(await routes(/** @type {any} */ (asking('/api/materials/cover?url=x')), /** @type {any} */ (res()), ['materials', 'cover']), true);
    assert.deepEqual(called, ['coverByUrl']);
    await assert.rejects(
        () => createMaterialCenterRoutes({ auth: session() })(/** @type {any} */ (asking('/api/materials/cover?url=x')), /** @type {any} */ (res()), ['materials', 'cover']),
        (/** @type {any} */ error) => error.status === 501 && error.extra.code === 'material-service-unavailable',
    );
});

test('a cover read needs a session, and answers 401 when it has none', async () => {
    /* The cover is an outbound fetch of an address a page named, kept on this computer: without a session any process
       on the machine could drive it. The refusal is 401 (`<img>` can only show a status), and it happens before the
       service — an unsigned request reaches neither the cache nor the network. */
    /** @type {string[]} */
    const called = [];
    const routes = createMaterialCenterRoutes({
        service: { coverByUrl: async () => { called.push('coverByUrl'); } },
        auth: { assertActive() { throw new Error('signed out'); } },
    });
    await assert.rejects(
        () => routes(/** @type {any} */ (asking('/api/materials/cover?url=https%3A%2F%2Fsucaicloud.com%2Fa.png')), /** @type {any} */ (res()), ['materials', 'cover']),
        (/** @type {any} */ error) => error.status === 401 && error.extra.code === 'authentication-required',
        'no session, no cover',
    );
    /* No auth seam at all is the same refusal, not a fall-through to the service. */
    await assert.rejects(
        () => createMaterialCenterRoutes({ service: { coverByUrl: async () => { called.push('coverByUrl'); } } })(/** @type {any} */ (asking('/api/materials/cover?url=x')), /** @type {any} */ (res()), ['materials', 'cover']),
        (/** @type {any} */ error) => error.status === 401 && error.extra.code === 'authentication-required',
    );
    assert.deepEqual(called, [], 'an unsigned cover read is not handed to the service at all');
});

test('the cache statistics route reports both folders, and is a signed-in read', async () => {
    /** @type {string[]} */
    const called = [];
    const routes = createMaterialCenterRoutes({ service: { cacheStats: async () => { called.push('stats'); } }, auth: session() });
    assert.equal(await routes(/** @type {any} */ (asking('/api/materials/cache/stats')), /** @type {any} */ (res()), ['materials', 'cache', 'stats']), true);
    assert.deepEqual(called, ['stats']);
    await assert.rejects(
        () => createMaterialCenterRoutes({ service: { cacheStats: async () => { called.push('stats'); } } })(/** @type {any} */ (asking('/api/materials/cache/stats')), /** @type {any} */ (res()), ['materials', 'cache', 'stats']),
        (/** @type {any} */ error) => error.status === 403 && error.extra.code === 'authentication-required',
        'how much room is used is a read of this computer, and needs the same session as the index',
    );
    await assert.rejects(
        () => routes(/** @type {any} */ (asking('/api/materials/cache/stats', 'POST')), /** @type {any} */ (res()), ['materials', 'cache', 'stats']),
        (/** @type {any} */ error) => error.status === 405 && error.extra.code === 'method-not-allowed',
    );
    assert.deepEqual(called, ['stats'], 'only the signed-in GET reached the service');
});

test('only GET is accepted', async () => {
    const routes = createMaterialCenterRoutes({});
    await assert.rejects(
        () => routes(/** @type {any} */ (req('POST')), /** @type {any} */ (res()), ['materials', 'list']),
        (/** @type {any} */ error) => error.status === 405 && error.extra.code === 'method-not-allowed',
    );
});

test('a read that has no service behind it says so, with a code the page can name', async () => {
    const routes = createMaterialCenterRoutes({});
    for (const route of ['list', 'facets', 'labels']) {
        await assert.rejects(
            () => routes(/** @type {any} */ (req()), /** @type {any} */ (res()), ['materials', route]),
            (/** @type {any} */ error) => error.status === 501 && error.extra.code === 'material-service-unavailable',
            route + ' must name the missing service instead of failing vaguely',
        );
    }
});

test('once a service is attached the route is handed the request, nothing else', async () => {
    /** @type {string[]} */
    const called = [];
    const routes = createMaterialCenterRoutes({
        service: {
            list: async () => { called.push('list'); },
            facets: async () => { called.push('facets'); },
            labels: async () => { called.push('labels'); },
        },
    });
    const response = res();
    assert.equal(await routes(/** @type {any} */ (req()), /** @type {any} */ (response), ['materials', 'list']), true);
    await routes(/** @type {any} */ (req()), /** @type {any} */ (response), ['materials', 'facets']);
    assert.deepEqual(called, ['list', 'facets']);
});

test('a service missing one route answers for that route only', async () => {
    const routes = createMaterialCenterRoutes({ service: { list: async () => {} } });
    await assert.rejects(
        () => routes(/** @type {any} */ (req()), /** @type {any} */ (res()), ['materials', 'labels']),
        (/** @type {any} */ error) => error.status === 501,
    );
});

test('a material with no notes is an empty answer, not a 404 the page must read as a failure', async () => {
    /* `/api/materials/wiki/video/:id` is the panel's own read (`ui/src/lib/material-center/wiki.ts`). No wiki backend is
       wired here, and a material nothing is known about has no notes: a 404 is what that page calls "没接通" and what a
       browser paints red for a card that is merely unknown. The answer is the panel's shape with nothing in it. */
    const routes = createMaterialCenterRoutes({ auth: session() });
    const response = res();
    assert.equal(await routes(/** @type {any} */ (asking('/api/materials/wiki/video/130100557')), /** @type {any} */ (response), ['materials', 'wiki', 'video', '130100557']), true);
    assert.equal(response.seen.status, 200);
    assert.deepEqual(JSON.parse(String(response.seen.body)), {
        videoId: '130100557', empty: true, oneLine: '', scenes: [], tags: {}, production: 'code', confidence: 0, risks: [], status: 'candidate',
    });

    const entities = res();
    assert.equal(await routes(/** @type {any} */ (asking('/api/materials/wiki/entities')), /** @type {any} */ (entities), ['materials', 'wiki', 'entities']), true);
    assert.equal(entities.seen.status, 200);
    assert.deepEqual(JSON.parse(String(entities.seen.body)), { entities: [] });
});

test('the notes are a signed-in read, and a path that is not one of them is still a named 404', async () => {
    const routes = createMaterialCenterRoutes({ auth: session() });
    await assert.rejects(
        () => createMaterialCenterRoutes({})(/** @type {any} */ (asking('/api/materials/wiki/video/130100557')), /** @type {any} */ (res()), ['materials', 'wiki', 'video', '130100557']),
        (/** @type {any} */ error) => error.status === 403 && error.extra.code === 'authentication-required',
        'a cover answered `no session` as 401 because an <img> cannot read a body; this one is a fetch, so 403',
    );
    await assert.rejects(
        () => createMaterialCenterRoutes({ auth: session() })(/** @type {any} */ (asking('/api/materials/wiki/shot/7')), /** @type {any} */ (res()), ['materials', 'wiki', 'shot', '7']),
        (/** @type {any} */ error) => error.status === 404 && error.extra.code === 'material-route-unknown',
        'the empty answer is for the two documented reads, never for a path nobody asked for',
    );
    await assert.rejects(
        () => routes(/** @type {any} */ (asking('/api/materials/wiki/entities', 'POST')), /** @type {any} */ (res()), ['materials', 'wiki', 'entities']),
        (/** @type {any} */ error) => error.status === 405 && error.extra.code === 'method-not-allowed',
    );
});
