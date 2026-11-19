// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * The material centre's data plane: what it asks the provider, and — just as important — what it
 * must never ask. Every case here counts upstream calls, so a prefetch, a list walk or a page of
 * covers "just in case" fails the test instead of passing silently.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMaterialCenterRoutes } from './material-center-routes.mjs';
import { createMaterialsCache, querySignature, isCacheName, SHAPE_VERSION } from './materials-cache.mjs';
import { createMaterialsService } from './materials-proxy.mjs';

const COVER = 'a'.repeat(40);
const SECRET = 'test-only-material-secret';
const ENVIRONMENT = 'env-1';
const SUBJECT = '11111111-1111-4111-8111-111111111111';
const INSTANCE = '22222222-2222-4222-8222-222222222222';

/** The Studio's branded session: the only source of a material principal. */
const session = (/** @type {Record<string, unknown>} */ overrides = {}) => ({
    assertActive() { return { environmentId: ENVIRONMENT, subjectId: SUBJECT, instanceId: INSTANCE, epoch: 7, ...overrides }; }
});

/** A response stand-in that keeps whatever the handler sent. */
const res = () => {
    /** @type {{status?: number, body?: any, headers?: Record<string,string>}} */
    const seen = {};
    return {
        seen,
        writeHead(status, headers) { seen.status = status; seen.headers = headers; },
        end(body) { seen.body = Buffer.isBuffer(body) ? body : String(body ?? ''); },
        get writableEnded() { return false; },
        once() { },
        removeListener() { },
    };
};

/** @param {string} url */
const req = (url, method = 'GET') => ({ method, url, headers: {} });

/** The route parts the Studio server would hand over for that URL. @param {string} url */
const partsOf = (url) => new URL(url, 'http://studio.invalid').pathname.replace(/^\/api\//, '').split('/').filter(Boolean);

/** A fake provider: counts every call, answers from a queue. */
const upstream = (answers = []) => {
    /** @type {{url: string, headers: Record<string,string>}[]} */
    const calls = [];
    const queue = [...answers];
    const fetchImpl = async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
        calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ?? null });
        const next = queue.length ? queue.shift() : { status: 200, body: { rows: [], total: 0 } };
        if (next instanceof Error) throw next;
        return {
            ok: next.status >= 200 && next.status < 300,
            status: next.status,
            headers: { get: (/** @type {string} */ name) => (name.toLowerCase() === 'content-type' ? next.type ?? 'application/json' : null) },
            text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body)),
            arrayBuffer: async () => (next.bytes ?? new Uint8Array([1, 2, 3])).buffer,
        };
    };
    return { calls, fetchImpl };
};

/** A cache in a folder of its own, with a clock the test moves. */
const cacheIn = async ({ maxBytes, evictIntervalMs } = {}) => {
    const root = await mkdtemp(join(tmpdir(), 'materials-cache-'));
    let clock = 1_000_000;
    const cache = createMaterialsCache({
        root,
        now: () => clock,
        ...(maxBytes ? { maxBytes } : {}),
        ...(evictIntervalMs === undefined ? {} : { evictIntervalMs }),
    });
    return { root, cache, advance: (/** @type {number} */ ms) => { clock += ms; }, set: (/** @type {number} */ value) => { clock = value; }, get now() { return clock; }, cleanup: () => rm(root, { recursive: true, force: true }) };
};

const jsonAnswer = (body, status = 200) => ({ status, body });

test('a list is asked once, and answered from disk after that', async () => {
    const folder = await cacheIn();
    try {
        const fake = upstream([jsonAnswer({ rows: [{ videoId: 'v1' }], total: 1 })]);
        const service = createMaterialsService({ upstream: 'https://provider.invalid', secret: SECRET, cache: folder.cache, fetchImpl: fake.fetchImpl, auth: session() });
        const routes = createMaterialCenterRoutes({ service });
        const first = res();
        await routes(req('/api/materials/list?scope=own&pageNo=1&pageSize=24'), first, partsOf('/api/materials/list?scope=own&pageNo=1&pageSize=24'));
        assert.equal(fake.calls.length, 1);
        assert.equal(first.seen.status, 200);
        assert.deepEqual(JSON.parse(String(first.seen.body)), { rows: [{ videoId: 'v1' }], total: 1 });
        assert.equal(fake.calls[0].headers['x-materials-secret'], SECRET, 'the provider token is the server\'s');
        const second = res();
        await routes(req('/api/materials/list?pageSize=24&pageNo=1&scope=own'), second, partsOf('/api/materials/list?pageSize=24&pageNo=1&scope=own'));
        assert.equal(fake.calls.length, 1, 'the same question, asked again, is not asked upstream');
        assert.deepEqual(JSON.parse(String(second.seen.body)), { rows: [{ videoId: 'v1' }], total: 1 });
    } finally { await folder.cleanup(); }
});

test('a list does not fetch covers, other pages or raw bytes', async () => {
    const folder = await cacheIn();
    try {
        const fake = upstream([jsonAnswer({ rows: [{ videoId: 'v1', coverUrl: `${COVER}.jpg` }, { videoId: 'v2' }], total: 900 })]);
        const service = createMaterialsService({ upstream: 'https://provider.invalid', secret: SECRET, cache: folder.cache, fetchImpl: fake.fetchImpl, auth: session() });
        const routes = createMaterialCenterRoutes({ service });
        await routes(req('/api/materials/list?scope=own&pageNo=1'), res(), partsOf('/api/materials/list?scope=own&pageNo=1'));
        assert.equal(fake.calls.length, 1, 'one request, one upstream read');
        assert.deepEqual(fake.calls.filter(call => call.url.includes('/cover/')), [], 'nothing fetched a cover for the cards');
        assert.deepEqual(fake.calls.filter(call => !call.url.includes('/api/materials/list')), [], 'no other page was warmed');
        const coverFiles = await (await import('node:fs/promises')).readdir(join(folder.root, 'materials', 'cover')).catch(() => []);
        assert.deepEqual(coverFiles, [], 'no cover bytes were written by a list request');
    } finally { await folder.cleanup(); }
});

test('a stale answer is handed over at once, then revalidated once', async () => {
    const folder = await cacheIn();
    try {
        const fake = upstream([jsonAnswer({ rows: [{ videoId: 'fresh' }] }), jsonAnswer({ rows: [{ videoId: 'newer' }] })]);
        const service = createMaterialsService({ upstream: 'https://provider.invalid', secret: SECRET, cache: folder.cache, fetchImpl: fake.fetchImpl, auth: session() });
        const routes = createMaterialCenterRoutes({ service });
        await routes(req('/api/materials/list?scope=own'), res(), partsOf('/api/materials/list?scope=own'));
        assert.equal(fake.calls.length, 1);
        folder.advance(16 * 60_000);  // past the 15 minute metadata life
        const stale = res();
        await routes(req('/api/materials/list?scope=own'), stale, partsOf('/api/materials/list?scope=own'));
        assert.equal(fake.calls.length, 2, 'the stale read asked for one revalidation');
        assert.deepEqual(JSON.parse(String(stale.seen.body)), { rows: [{ videoId: 'fresh' }] }, 'the person sees the old answer, not a spinner');
        await new Promise(done => setTimeout(done, 100));
        const fresh = res();
        await routes(req('/api/materials/list?scope=own'), fresh, partsOf('/api/materials/list?scope=own'));
        assert.deepEqual(JSON.parse(String(fresh.seen.body)), { rows: [{ videoId: 'newer' }] }, 'after revalidation the next read is the new one');
    } finally { await folder.cleanup(); }
});

test('a failed revalidation keeps the answer that was there', async () => {
    const folder = await cacheIn();
    try {
        const failure = new Error('provider down');
        failure.name = 'TypeError';
        /* four failures: one read and the three tries a read that could not be made at all is given (`retryDelays`) */
        const fake = upstream([jsonAnswer({ rows: [{ videoId: 'old' }] }), failure, failure, failure, failure]);
        const service = createMaterialsService({ upstream: 'https://provider.invalid', secret: SECRET, cache: folder.cache, fetchImpl: fake.fetchImpl, auth: session(), sleep: async () => {} });
        const routes = createMaterialCenterRoutes({ service });
        await routes(req('/api/materials/list?scope=own'), res(), partsOf('/api/materials/list?scope=own'));
        folder.advance(16 * 60_000);
        const first = res();
        await routes(req('/api/materials/list?scope=own'), first, partsOf('/api/materials/list?scope=own'));
        assert.equal(first.seen.status, 200);
        await new Promise(done => setTimeout(done, 100));
        const second = res();
        await routes(req('/api/materials/list?scope=own'), second, partsOf('/api/materials/list?scope=own'));
        assert.equal(second.seen.status, 200);
        assert.deepEqual(JSON.parse(String(second.seen.body)), { rows: [{ videoId: 'old' }] }, 'a failed check never erases the old body');
    } finally { await folder.cleanup(); }
});

test('the vocabulary lives longer than a page of cards', async () => {
    const folder = await cacheIn();
    try {
        const fake = upstream([jsonAnswer({ oneLevel: [] }), jsonAnswer({ oneLevel: [{ id: 1 }] })]);
        const service = createMaterialsService({ upstream: 'https://provider.invalid', secret: SECRET, cache: folder.cache, fetchImpl: fake.fetchImpl, auth: session() });
        const routes = createMaterialCenterRoutes({ service });
        await routes(req('/api/materials/facets'), res(), partsOf('/api/materials/facets'));
        folder.advance(60 * 60_000);  // an hour: a list answer would be stale, the vocabulary is not
        await routes(req('/api/materials/facets'), res(), partsOf('/api/materials/facets'));
        assert.equal(fake.calls.length, 1, 'categories are kept for 24 hours');
        await routes(req('/api/materials/labels?videoType=1'), res(), partsOf('/api/materials/labels?videoType=1'));
        assert.equal(fake.calls.length, 2, 'labels are their own question');
    } finally { await folder.cleanup(); }
});

test('a cover is fetched only when that cover is asked for', async () => {
    const folder = await cacheIn();
    try {
        const fake = upstream([{ status: 200, bytes: new Uint8Array([9, 9, 9]), type: 'image/jpeg' }]);
        const service = createMaterialsService({ upstream: 'https://provider.invalid', secret: SECRET, cache: folder.cache, fetchImpl: fake.fetchImpl, auth: session() });
        const routes = createMaterialCenterRoutes({ service });
        assert.equal(fake.calls.length, 0, 'nothing is fetched before a page asks');
        const first = res();
        await routes(req(`/api/materials/cover/${COVER}?v=3`), first, ['materials', 'cover', COVER]);
        assert.equal(fake.calls.length, 1);
        assert.equal(first.seen.status, 200);
        assert.equal(first.seen.headers?.['content-type'], 'image/jpeg');
        assert.match(String(first.seen.headers?.['cache-control']), /immutable/);
        const second = res();
        await routes(req(`/api/materials/cover/${COVER}?v=3`), second, ['materials', 'cover', COVER]);
        assert.equal(fake.calls.length, 1, 'a cover on disk is not asked for again');
        assert.equal(second.seen.headers?.['cache-control'], 'immutable, max-age=31536000');
    } finally { await folder.cleanup(); }
});

test('capacity is enforced by dropping the least recently used cover', async () => {
    const folder = await cacheIn({ maxBytes: 250, evictIntervalMs: 0 });
    try {
        const first = 'b'.repeat(40), second = 'c'.repeat(40), third = 'd'.repeat(40);
        await folder.cache.writeCover(first, new Uint8Array(100), 'image/jpeg');
        await folder.cache.writeCover(second, new Uint8Array(100), 'image/jpeg');
        // reading the first one makes it the most recently used
        folder.advance(1_000);
        assert.ok(await folder.cache.readCover(first));
        folder.advance(1_000);
        await folder.cache.writeCover(third, new Uint8Array(100), 'image/jpeg');
        const stats = await folder.cache.stats();
        assert.ok(stats.bytes <= 250, `the tree stays within its limit, got ${stats.bytes}`);
        assert.equal(await folder.cache.readCover(first), null, 'the least recently used entry went first');
        assert.ok(await folder.cache.readCover(third), 'the newest entry stays');
    } finally { await folder.cleanup(); }
});

test('raw and download are not routes, and reach nothing', async () => {
    const folder = await cacheIn();
    try {
        const fake = upstream([]);
        const service = createMaterialsService({ upstream: 'https://provider.invalid', secret: SECRET, cache: folder.cache, fetchImpl: fake.fetchImpl, auth: session() });
        const routes = createMaterialCenterRoutes({ service });
        for (const path of [['materials', 'download'], ['materials', 'video', 'query', 'raw'], ['materials', 'cover', 'not-a-cover'], ['materials', 'raw', 'extra']]) {
            await assert.rejects(
                () => routes(req('/api/' + path.join('/')), res(), path),
                (/** @type {any} */ error) => error.status === 404 && error.extra.code === 'material-route-unknown',
                path.join('/') + ' must be an unknown route',
            );
        }
        assert.equal(fake.calls.length, 0, 'an unknown route never becomes an upstream read');
        await assert.rejects(() => routes(req('/api/materials/raw'), res(), ['materials', 'raw']), (/** @type {any} */ error) => error.status === 405 && error.extra.code === 'method-not-allowed', 'the raw download is POST only');
    } finally { await folder.cleanup(); }
});

test('the provider keeps its own status and code, and such an answer is not cached', async () => {
    const folder = await cacheIn();
    try {
        const fake = upstream([{ status: 400, body: { code: 'scope-invalid', message: 'no such scope' } }]);
        const service = createMaterialsService({ upstream: 'https://provider.invalid', secret: SECRET, cache: folder.cache, fetchImpl: fake.fetchImpl, auth: session() });
        const routes = createMaterialCenterRoutes({ service });
        const first = res();
        await routes(req('/api/materials/list?scope=nope'), first, partsOf('/api/materials/list?scope=nope'));
        assert.equal(first.seen.status, 400);
        assert.deepEqual(JSON.parse(String(first.seen.body)), { code: 'scope-invalid', message: 'no such scope' });
        await routes(req('/api/materials/list?scope=nope'), res(), partsOf('/api/materials/list?scope=nope'));
        assert.equal(fake.calls.length, 2, 'a refusal is not remembered as an answer');
    } finally { await folder.cleanup(); }
});

test('a provider that does not answer in time is named, not guessed at', async () => {
    const folder = await cacheIn();
    try {
        const timeout = new Error('timed out');
        timeout.name = 'TimeoutError';
        const fake = upstream([timeout, timeout, timeout, timeout]);
        const service = createMaterialsService({ upstream: 'https://provider.invalid', secret: SECRET, cache: folder.cache, fetchImpl: fake.fetchImpl, auth: session(), timeoutMs: 1, sleep: async () => {} });
        const routes = createMaterialCenterRoutes({ service });
        await assert.rejects(
            () => routes(req('/api/materials/list'), res(), partsOf('/api/materials/list')),
            (/** @type {any} */ error) => error.status === 504 && error.extra.code === 'material-upstream-timeout',
        );
        assert.equal(fake.calls.length, 4, 'a read that could not be made is asked again before it is the page\'s answer');
    } finally { await folder.cleanup(); }
});

test('the provider saying "not now" is asked again, and the page gets the answer it finally gives', async () => {
    /* Measured on this machine (2026-11-17): the supplier answers `503 {code:'provider-unconfirmed'}` (供应商结果未知) for
       roughly two in five reads — 4 of 10 in a row, 10 of 20 in a burst — and the very same question answers 200 on the
       next try. Passed straight through, that was a card list flickering to "读取失败" with nothing wrong here. */
    const folder = await cacheIn();
    try {
        const unconfirmed = { status: 503, body: { code: 'provider-unconfirmed', message: '供应商结果未知' } };
        const fake = upstream([unconfirmed, jsonAnswer({ rows: [{ videoId: 'after-retry' }], total: 1 })]);
        const service = createMaterialsService({ upstream: 'https://provider.invalid', secret: SECRET, cache: folder.cache, fetchImpl: fake.fetchImpl, auth: session(), sleep: async () => {} });
        const routes = createMaterialCenterRoutes({ service });
        const answer = res();
        await routes(req('/api/materials/list?scope=company&name=3.5&pageNo=1&pageSize=4&videoType=1'), answer, partsOf('/api/materials/list?scope=company&name=3.5&pageNo=1&pageSize=4&videoType=1'));
        assert.equal(fake.calls.length, 2, 'one more try, because the first said "not now"');
        assert.equal(answer.seen.status, 200);
        assert.deepEqual(JSON.parse(String(answer.seen.body)), { rows: [{ videoId: 'after-retry' }], total: 1 });
    } finally { await folder.cleanup(); }
});

test('the supplier\'s rate limit is the page\'s to see, and is never answered by asking again', async () => {
    /* `429 provider-rate-limited` (供应商限流) is the supplier's quota, not this read's bad luck: asking again 150 ms
       later is what keeps it tripped. The page already has words for it, so it travels untouched. */
    const folder = await cacheIn();
    try {
        const limited = { status: 429, body: { code: 'provider-rate-limited', message: '供应商限流' } };
        const fake = upstream([limited, limited, limited, limited]);
        const service = createMaterialsService({ upstream: 'https://provider.invalid', secret: SECRET, cache: folder.cache, fetchImpl: fake.fetchImpl, auth: session(), sleep: async () => {} });
        const routes = createMaterialCenterRoutes({ service });
        const answer = res();
        await routes(req('/api/materials/list?scope=company'), answer, partsOf('/api/materials/list?scope=company'));
        assert.equal(fake.calls.length, 1, 'a quota is not a hiccup: one read, one answer');
        assert.equal(answer.seen.status, 429);
        assert.deepEqual(JSON.parse(String(answer.seen.body)), { code: 'provider-rate-limited', message: '供应商限流' });
    } finally { await folder.cleanup(); }
});

test('a provider that keeps saying "not now" still answers with its own status and code', async () => {
    const folder = await cacheIn();
    try {
        const unconfirmed = { status: 503, body: { code: 'provider-unconfirmed', message: '供应商结果未知' } };
        const fake = upstream([unconfirmed, unconfirmed, unconfirmed, unconfirmed, unconfirmed]);
        const service = createMaterialsService({ upstream: 'https://provider.invalid', secret: SECRET, cache: folder.cache, fetchImpl: fake.fetchImpl, auth: session(), sleep: async () => {} });
        const routes = createMaterialCenterRoutes({ service });
        const answer = res();
        await routes(req('/api/materials/list?scope=company'), answer, partsOf('/api/materials/list?scope=company'));
        assert.equal(fake.calls.length, 4, 'one read and three tries, then the provider is believed');
        assert.equal(answer.seen.status, 503);
        assert.deepEqual(JSON.parse(String(answer.seen.body)), { code: 'provider-unconfirmed', message: '供应商结果未知' });
    } finally { await folder.cleanup(); }
});

test('the same question asked twice at once is asked upstream once', async () => {
    /* A page drawing a list and its cards from one query used to spend one provider read each — and every extra read
       is one more chance of the provider's "not now". */
    const folder = await cacheIn();
    try {
        let released = () => {};
        const gate = new Promise((done) => { released = () => done(undefined); });
        /** @type {number} */
        let calls = 0;
        const fetchImpl = async () => {
            calls += 1;
            await gate;
            return {
                ok: true, status: 200,
                headers: { get: () => 'application/json' },
                text: async () => JSON.stringify({ rows: [{ videoId: 'v1' }], total: 1 }),
                arrayBuffer: async () => new ArrayBuffer(0),
            };
        };
        const service = createMaterialsService({ upstream: 'https://provider.invalid', secret: SECRET, cache: folder.cache, fetchImpl, auth: session(), sleep: async () => {} });
        const first = res();
        const second = res();
        const both = Promise.all([
            service.list(req('/api/materials/list?scope=company&pageNo=1'), first),
            service.list(req('/api/materials/list?scope=company&pageNo=1'), second),
        ]);
        await new Promise((done) => setTimeout(done, 20));
        released();
        await both;
        assert.equal(calls, 1, 'one upstream read for one question');
        assert.equal(first.seen.status, 200);
        assert.deepEqual(JSON.parse(String(second.seen.body)), { rows: [{ videoId: 'v1' }], total: 1 });
    } finally { await folder.cleanup(); }
});

test('a repeated parameter is refused instead of resolved', async () => {
    const folder = await cacheIn();
    try {
        const fake = upstream([]);
        const service = createMaterialsService({ upstream: 'https://provider.invalid', secret: SECRET, cache: folder.cache, fetchImpl: fake.fetchImpl, auth: session() });
        const routes = createMaterialCenterRoutes({ service });
        await assert.rejects(
            () => routes(req('/api/materials/list?scope=own&scope=company'), res(), partsOf('/api/materials/list?scope=own&scope=company')),
            (/** @type {any} */ error) => error.status === 400 && error.extra.code === 'material-query-ambiguous',
        );
        assert.equal(fake.calls.length, 0);
    } finally { await folder.cleanup(); }
});

test('clearing the cache needs a signed-in person and empties what was kept', async () => {
    const folder = await cacheIn();
    try {
        const fake = upstream([jsonAnswer({ rows: [] }), { status: 200, bytes: new Uint8Array([1]), type: 'image/png' }]);
        const service = createMaterialsService({ upstream: 'https://provider.invalid', secret: SECRET, cache: folder.cache, fetchImpl: fake.fetchImpl, auth: session() });
        await service.list(req('/api/materials/list'), res());
        await service.cover(req(`/api/materials/cover/${COVER}`), res(), COVER);
        const before = await folder.cache.stats();
        assert.ok(before.files >= 2, 'something was cached first');

        const anonymous = createMaterialCenterRoutes({ service });
        await assert.rejects(
            () => anonymous(req('/api/materials/cache/clear', 'POST'), res(), ['materials', 'cache', 'clear']),
            (/** @type {any} */ error) => error.status === 403 && error.extra.code === 'authentication-required',
        );
        assert.deepEqual(await folder.cache.stats(), before, 'an unsigned request changes nothing');

        const signed = createMaterialCenterRoutes({ service, auth: { assertActive() { return { id: 'me' }; } } });
        const cleared = res();
        await signed(req('/api/materials/cache/clear', 'POST'), cleared, ['materials', 'cache', 'clear']);
        assert.equal(cleared.seen.status, 200);
        assert.deepEqual(await folder.cache.stats(), { files: 0, bytes: 0 });
        await assert.rejects(() => stat(join(folder.root, 'materials')), /ENOENT/);
    } finally { await folder.cleanup(); }
});

test('the signature is the same question in any order, and a cover name is only hex', async () => {
    assert.equal(querySignature('list', { scope: 'own', pageNo: '1' }), querySignature('list', { pageNo: '1', scope: 'own' }));
    assert.notEqual(querySignature('list', { scope: 'own' }), querySignature('facets', { scope: 'own' }));
    assert.equal(isCacheName(COVER), true);
    assert.equal(isCacheName('../escape'), false);
    assert.equal(isCacheName('A'.repeat(40)), false);
});

/** The provider's own verification, written out the same way its contract states it. */
const verifySignature = (/** @type {Record<string,string>} */ headers, /** @type {string} */ method, /** @type {string} */ path, /** @type {string} */ query, /** @type {string} */ secret) => {
    const principal = headers['x-materials-principal'];
    const canonical = `v1\n${principal}\n${method}\n${path}\n${query}`;
    return createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
};

test('every upstream read carries a short-lived principal signed over the exact path and query', async () => {
    const folder = await cacheIn();
    try {
        const fake = upstream([jsonAnswer({ rows: [] })]);
        const clock = 1_700_000_000_000;
        const service = createMaterialsService({ upstream: 'https://provider.invalid', secret: SECRET, cache: folder.cache, fetchImpl: fake.fetchImpl, auth: session(), now: () => clock });
        const routes = createMaterialCenterRoutes({ service });
        await routes(req('/api/materials/list?scope=own&pageNo=1'), res(), ['materials', 'list']);
        assert.equal(fake.calls.length, 1);
        const headers = fake.calls[0].headers;
        const principal = JSON.parse(Buffer.from(headers['x-materials-principal'], 'base64url').toString('utf8'));
        assert.deepEqual(Object.keys(principal).sort(), ['environmentId', 'epoch', 'exp', 'instanceId', 'subjectId']);
        assert.equal(principal.environmentId, ENVIRONMENT);
        assert.equal(principal.subjectId, SUBJECT);
        assert.equal(principal.instanceId, INSTANCE);
        assert.equal(principal.epoch, 7);
        assert.equal(principal.exp, Math.floor(clock / 1000) + 60, 'a minute, in Unix seconds');
        assert.ok(principal.exp * 1000 > clock, 'the delegation outlives this read');
        assert.match(headers['x-materials-signature'], /^[a-f0-9]{64}$/);
        assert.equal(verifySignature(headers, 'GET', '/api/materials/list', 'scope=own&pageNo=1', SECRET), headers['x-materials-signature'], 'the provider can recompute it');
    } finally { await folder.cleanup(); }
});

test('a tampered path or a swapped query does not verify', async () => {
    const folder = await cacheIn();
    try {
        const fake = upstream([jsonAnswer({ rows: [] })]);
        const service = createMaterialsService({ upstream: 'https://provider.invalid', secret: SECRET, cache: folder.cache, fetchImpl: fake.fetchImpl, auth: session() });
        const routes = createMaterialCenterRoutes({ service });
        await routes(req('/api/materials/list?scope=own'), res(), ['materials', 'list']);
        const headers = fake.calls[0].headers;
        assert.notEqual(verifySignature(headers, 'GET', '/api/materials/labels', 'scope=own', SECRET), headers['x-materials-signature'], 'another path is another signature');
        assert.notEqual(verifySignature(headers, 'GET', '/api/materials/list', 'scope=company', SECRET), headers['x-materials-signature'], 'another query is another signature');
        assert.notEqual(verifySignature(headers, 'POST', '/api/materials/list', 'scope=own', SECRET), headers['x-materials-signature'], 'another method is another signature');
        assert.notEqual(verifySignature(headers, 'GET', '/api/materials/list', 'scope=own', 'another-secret'), headers['x-materials-signature'], 'another key is another signature');
    } finally { await folder.cleanup(); }
});

test('a page may not name the material principal', async () => {
    const folder = await cacheIn();
    try {
        const fake = upstream([jsonAnswer({ rows: [] })]);
        const service = createMaterialsService({ upstream: 'https://provider.invalid', secret: SECRET, cache: folder.cache, fetchImpl: fake.fetchImpl, auth: session() });
        const routes = createMaterialCenterRoutes({ service });
        const forged = {
            method: 'GET',
            url: '/api/materials/list?scope=own',
            headers: { 'x-materials-principal': 'Zm9yZ2Vk', 'x-materials-signature': 'deadbeef' },
        };
        await assert.rejects(
            () => routes(/** @type {any} */ (forged), res(), ['materials', 'list']),
            (/** @type {any} */ error) => error.status === 403 && error.extra.code === 'material-page-header-refused',
        );
        assert.equal(fake.calls.length, 0, 'a refused page never reaches the provider');
    } finally { await folder.cleanup(); }
});

test('without a session nothing is asked of the provider', async () => {
    const folder = await cacheIn();
    try {
        const fake = upstream([jsonAnswer({ rows: [] })]);
        const service = createMaterialsService({ upstream: 'https://provider.invalid', secret: SECRET, cache: folder.cache, fetchImpl: fake.fetchImpl, auth: { assertActive() { throw new Error('signed out'); } } });
        const routes = createMaterialCenterRoutes({ service });
        for (const path of [['materials', 'list'], ['materials', 'facets'], ['materials', 'labels'], ['materials', 'cover', COVER]]) {
            await assert.rejects(
                () => routes(req('/api/' + path.join('/'), 'GET'), res(), path),
                (/** @type {any} */ error) => error.status === 403 && error.extra.code === 'authentication-required',
                path.join('/') + ' must refuse without a session',
            );
        }
        assert.equal(fake.calls.length, 0, 'no session, no upstream read');
        assert.deepEqual(await folder.cache.stats(), { files: 0, bytes: 0 });
    } finally { await folder.cleanup(); }
});

test('the provider refusal authorization-denied is passed through as it is', async () => {
    const folder = await cacheIn();
    try {
        const fake = upstream([{ status: 403, body: { code: 'authorization-denied', message: 'no layer grants this' } }]);
        const service = createMaterialsService({ upstream: 'https://provider.invalid', secret: SECRET, cache: folder.cache, fetchImpl: fake.fetchImpl, auth: session() });
        const routes = createMaterialCenterRoutes({ service });
        const answer = res();
        await routes(req('/api/materials/list?scope=company'), answer, ['materials', 'list']);
        assert.equal(answer.seen.status, 403);
        assert.equal(JSON.parse(String(answer.seen.body)).code, 'authorization-denied', 'the layer is the provider\'s to name, not this proxy\'s');
    } finally { await folder.cleanup(); }
});

/* ── the raw download: one provider call, then Saved's flat cloud folder ──────────────────────── */

/** A POST whose body arrives as the stream `readJson` walks. */
const postReq = (/** @type {string} */ url, /** @type {unknown} */ body) => {
    const payload = Buffer.from(JSON.stringify(body));
    return { method: 'POST', url, headers: {}, async *[Symbol.asyncIterator]() { yield payload; } };
};

const STAGED = { path: 'E:\\staging\\p1\\abc.mp4', bytes: 1024, sha256: 'b'.repeat(64), name: 'abc.mp4' };

/** A Saved folder of its own, plus the staging file the provider would have written. */
const savedSite = async (staged = STAGED) => {
    const root = await mkdtemp(join(tmpdir(), 'saved-raw-'));
    const staging = join(root, 'staging', 'abc.mp4');
    await (await import('node:fs/promises')).mkdir(join(root, 'staging'), { recursive: true });
    const body = Buffer.alloc(staged.bytes, 7);
    const { createHash } = await import('node:crypto');
    const sha256 = createHash('sha256').update(body).digest('hex');
    await (await import('node:fs/promises')).writeFile(staging, body);
    /** @type {string[]} */
    const discarded = [];
    return {
        root, staging, sha256, discarded,
        staged: { ...staged, path: staging, sha256 },
        service: (/** @type {any} */ fake, /** @type {any} */ overrides = {}) => createMaterialsService({
            upstream: 'https://provider.invalid', secret: SECRET, cache: null, fetchImpl: fake.fetchImpl, auth: session(),
            savedRoot: async () => root,
            removeStaged: async (/** @type {string} */ path) => { discarded.push(path); },
            ...overrides,
        }),
        cloud: () => join(root, '云素材'),
        cleanup: () => rm(root, { recursive: true, force: true }),
    };
};

test('a raw download lands in Saved as <videoId>.<ext> with its dot sidecar', async () => {
    const site = await savedSite();
    try {
        const fake = upstream([{ status: 200, body: site.staged }]);
        const service = site.service(fake);
        const routes = createMaterialCenterRoutes({ service });
        const answer = res();
        await routes(postReq('/api/materials/raw', { videoId: 'v-1' }), answer, ['materials', 'raw']);
        assert.equal(fake.calls.length, 1);
        assert.equal(answer.seen.status, 200);
        const body = JSON.parse(String(answer.seen.body));
        assert.deepEqual(body, { landed: 'saved/云素材/v-1.mp4', reused: false, sha256: site.sha256, bytes: 1024 });
        assert.equal((await readFile(join(site.cloud(), 'v-1.mp4'))).length, 1024, 'the bytes are in the flat cloud folder');
        const sidecar = JSON.parse(await readFile(join(site.cloud(), '.meta', 'v-1.json'), 'utf8'));
        assert.deepEqual(Object.keys(sidecar).sort(),
            ['bytes', 'name', 'providerAccountKey', 'sha256', 'subjectId', 'takenAt', 'version', 'videoId', 'videoType'],
            'sidecar v2: the person and the provider account are separate fields, and no bare accountKey');
        assert.equal(sidecar.version, 2);
        assert.equal(sidecar.videoId, 'v-1');
        assert.equal(sidecar.videoType, 1, 'the provider default, recorded');
        assert.equal(sidecar.sha256, site.sha256);
        assert.equal(sidecar.subjectId, SUBJECT, 'the signed-in person, named honestly');
        assert.equal(sidecar.providerAccountKey, null, 'the provider names no account yet: null, never the subject id');
        assert.equal(Object.hasOwn(sidecar, 'accountKey'), false, 'the old conflated field is gone');
        assert.deepEqual(site.discarded, [site.staging], 'the staging copy is let go once landed');
        assert.doesNotMatch(String(answer.seen.body), /provider\.invalid|test-only-material-secret/);
    } finally { await site.cleanup(); }
});

test('the same video is never downloaded twice', async () => {
    const site = await savedSite();
    try {
        const fake = upstream([{ status: 200, body: site.staged }]);
        const service = site.service(fake);
        const routes = createMaterialCenterRoutes({ service });
        await routes(postReq('/api/materials/raw', { videoId: 'v-1' }), res(), ['materials', 'raw']);
        const second = res();
        await routes(postReq('/api/materials/raw', { videoId: 'v-1' }), second, ['materials', 'raw']);
        assert.equal(fake.calls.length, 1, 'the second press does not ask the provider again');
        const body = JSON.parse(String(second.seen.body));
        assert.equal(body.reused, true);
        assert.equal(body.sha256, site.sha256);
        const files = (await readdir(site.cloud())).filter((name) => name.startsWith('v-1.'));
        assert.deepEqual(files, ['v-1.mp4'], 'still one copy');
    } finally { await site.cleanup(); }
});

test('a landing that cannot write is a 500, and the staged copy is taken away', async () => {
    const site = await savedSite();
    try {
        await writeFile(join(site.root, '云素材'), 'not a folder');  // mkdir of .meta now fails
        const fake = upstream([{ status: 200, body: site.staged }]);
        const service = site.service(fake);
        const routes = createMaterialCenterRoutes({ service });
        await assert.rejects(
            () => routes(postReq('/api/materials/raw', { videoId: 'v-1' }), res(), ['materials', 'raw']),
            (/** @type {any} */ error) => error.status === 500 && error.extra.code === 'material-raw-land-failed',
        );
        assert.deepEqual(site.discarded, [site.staging]);
    } finally { await site.cleanup(); }
});

test('the caller\'s video type travels as it is, and is never invented', async () => {
    const site = await savedSite();
    try {
        const fake = upstream([{ status: 200, body: site.staged }, { status: 200, body: site.staged }]);
        const service = site.service(fake);
        const routes = createMaterialCenterRoutes({ service });
        await routes(postReq('/api/materials/raw', { videoId: 'v-1' }), res(), ['materials', 'raw']);
        assert.deepEqual(JSON.parse(fake.calls[0].body), { videoId: 'v-1' }, 'no type given, none invented');
        await routes(postReq('/api/materials/raw', { videoId: 'v-2', videoType: 3 }), res(), ['materials', 'raw']);
        assert.deepEqual(JSON.parse(fake.calls[1].body), { videoId: 'v-2', videoType: 3 });
        for (const bad of [5, -1, 1.5, '3', true]) {
            await assert.rejects(() => routes(postReq('/api/materials/raw', { videoId: 'v-3', videoType: bad }), res(), ['materials', 'raw']), (/** @type {any} */ error) => error.status === 422);
        }
        assert.equal(fake.calls.length, 2, 'an invalid type never reaches the provider');
    } finally { await site.cleanup(); }
});

test('a raw download without a session never reaches the provider, and a refusal lands nothing', async () => {
    const site = await savedSite();
    try {
        const fake = upstream([{ status: 403, body: { code: 'authorization-denied' } }]);
        const signedOut = site.service(fake, { auth: { assertActive() { throw new Error('signed out'); } } });
        await assert.rejects(
            () => createMaterialCenterRoutes({ service: signedOut })(postReq('/api/materials/raw', { videoId: 'v-1' }), res(), ['materials', 'raw']),
            (/** @type {any} */ error) => error.status === 403 && error.extra.code === 'authentication-required',
        );
        assert.equal(fake.calls.length, 0);
        const refused = res();
        await createMaterialCenterRoutes({ service: site.service(fake) })(postReq('/api/materials/raw', { videoId: 'v-1' }), refused, ['materials', 'raw']);
        assert.equal(refused.seen.status, 403);
        assert.equal(JSON.parse(String(refused.seen.body)).code, 'authorization-denied');
        assert.deepEqual(await readdir(site.cloud()).catch(() => []), [], 'a refusal writes nothing');
    } finally { await site.cleanup(); }
});

test('a video id that could escape the folder is refused before the provider', async () => {
    const site = await savedSite();
    try {
        const fake = upstream([{ status: 200, body: site.staged }]);
        const service = site.service(fake);
        const routes = createMaterialCenterRoutes({ service });
        for (const id of ['v.1', 'v/1', '..', '../v1', 'v 1', 'a\\\\b', '']) {
            await assert.rejects(
                () => routes(postReq('/api/materials/raw', { videoId: id }), res(), ['materials', 'raw']),
                (/** @type {any} */ error) => error.status === 422 && error.extra.code === 'invalid-query',
                `videoId ${JSON.stringify(id)} is not a file name`,
            );
        }
        assert.equal(fake.calls.length, 0, 'a traversal attempt never reaches the provider');
    } finally { await site.cleanup(); }
});

/* ── the account binding: forwarded, never re-implemented here ──────────────────────────────────── */

test('the binding is read, made and removed as three plain forwards', async () => {
    const folder = await cacheIn();
    try {
        const fake = upstream([jsonAnswer({ binding: null }), jsonAnswer({ binding: { account: 'A1', state: 'claimed' } }), jsonAnswer({ binding: null })]);
        const service = createMaterialsService({ upstream: 'https://provider.invalid', secret: SECRET, cache: folder.cache, fetchImpl: fake.fetchImpl, auth: session() });
        const routes = createMaterialCenterRoutes({ service });

        const read = res();
        await routes({ method: 'GET', url: '/api/materials/binding', headers: {} }, read, ['materials', 'binding']);
        assert.equal(fake.calls.length, 1);
        assert.equal(fake.calls[0].url, 'https://provider.invalid/api/materials/binding');
        assert.equal(fake.calls[0].method, 'GET');
        assert.equal(fake.calls[0].body, null, 'a read carries no body');
        assert.equal(fake.calls[0].headers['x-materials-secret'], SECRET);
        assert.equal(verifySignature(fake.calls[0].headers, 'GET', '/api/materials/binding', '', SECRET), fake.calls[0].headers['x-materials-signature']);
        assert.deepEqual(JSON.parse(String(read.seen.body)), { binding: null });

        const made = res();
        await routes({ method: 'POST', url: '/api/materials/binding', headers: {}, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ account: 'A1' })); } }, made, ['materials', 'binding']);
        assert.equal(fake.calls.length, 2);
        assert.equal(fake.calls[1].method, 'POST');
        assert.deepEqual(JSON.parse(fake.calls[1].body), { account: 'A1' }, 'only the account travels');
        assert.equal(fake.calls[1].headers['content-type'], 'application/json');
        assert.equal(verifySignature(fake.calls[1].headers, 'POST', '/api/materials/binding', '', SECRET), fake.calls[1].headers['x-materials-signature']);
        assert.equal(made.seen.status, 200);
        assert.equal(JSON.parse(String(made.seen.body)).binding.state, 'claimed');

        const removed = res();
        await routes({ method: 'DELETE', url: '/api/materials/binding', headers: {} }, removed, ['materials', 'binding']);
        assert.equal(fake.calls.length, 3);
        assert.equal(fake.calls[2].method, 'DELETE');
        assert.equal(fake.calls[2].body, null);
        assert.equal(verifySignature(fake.calls[2].headers, 'DELETE', '/api/materials/binding', '', SECRET), fake.calls[2].headers['x-materials-signature']);
        assert.deepEqual(JSON.parse(String(removed.seen.body)), { binding: null });
    } finally { await folder.cleanup(); }
});

test('a binding body that is not exactly one account is refused before the provider', async () => {
    const folder = await cacheIn();
    try {
        const fake = upstream([]);
        const service = createMaterialsService({ upstream: 'https://provider.invalid', secret: SECRET, cache: folder.cache, fetchImpl: fake.fetchImpl, auth: session() });
        const routes = createMaterialCenterRoutes({ service });
        const bodies = [{ account: 'A1', extra: 1 }, {}, { account: '' }, { account: 'x'.repeat(65) }, { account: 7 }, ['A1']];
        for (const body of bodies) {
            await assert.rejects(
                () => routes({ method: 'POST', url: '/api/materials/binding', headers: {}, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } }, res(), ['materials', 'binding']),
                (/** @type {any} */ error) => error.status === 422 && error.extra.code === 'invalid-query',
                JSON.stringify(body),
            );
        }
        assert.equal(fake.calls.length, 0, 'an unusable body never reaches the provider');
    } finally { await folder.cleanup(); }
});

test('a GET with a body still forwards a plain read', async () => {
    const folder = await cacheIn();
    try {
        const fake = upstream([jsonAnswer({ binding: null })]);
        const service = createMaterialsService({ upstream: 'https://provider.invalid', secret: SECRET, cache: folder.cache, fetchImpl: fake.fetchImpl, auth: session() });
        const routes = createMaterialCenterRoutes({ service });
        const read = res();
        await routes({ method: 'GET', url: '/api/materials/binding', headers: {}, async *[Symbol.asyncIterator]() { yield Buffer.from('{"ignored":true}'); } }, read, ['materials', 'binding']);
        assert.equal(fake.calls.length, 1);
        assert.equal(fake.calls[0].method, 'GET');
        assert.equal(fake.calls[0].body, null, 'the body is not forwarded on a read');
        assert.deepEqual(JSON.parse(String(read.seen.body)), { binding: null });
    } finally { await folder.cleanup(); }
});

test('a provider binding refusal keeps its own status and code', async () => {
    const folder = await cacheIn();
    try {
        for (const refusal of [
            { status: 400, body: { code: 'invalid-query', message: 'no such account' } },
            { status: 401, body: { code: 'authentication-required' } },
            { status: 403, body: { code: 'authorization-denied' } },
            { status: 501, body: { code: 'binding-not-configured' } },
        ]) {
            const fake = upstream([refusal]);
            const service = createMaterialsService({ upstream: 'https://provider.invalid', secret: SECRET, cache: folder.cache, fetchImpl: fake.fetchImpl, auth: session() });
            const routes = createMaterialCenterRoutes({ service });
            const answer = res();
            await routes({ method: 'GET', url: '/api/materials/binding', headers: {} }, answer, ['materials', 'binding']);
            assert.equal(answer.seen.status, refusal.status);
            assert.deepEqual(JSON.parse(String(answer.seen.body)), refusal.body, 'the provider’s words, unchanged');
            assert.equal(fake.calls.length, 1);
        }
    } finally { await folder.cleanup(); }
});

test('a page may not name the principal on the binding, and an unattached service says so', async () => {
    const folder = await cacheIn();
    try {
        const fake = upstream([]);
        const service = createMaterialsService({ upstream: 'https://provider.invalid', secret: SECRET, cache: folder.cache, fetchImpl: fake.fetchImpl, auth: session() });
        const routes = createMaterialCenterRoutes({ service });
        await assert.rejects(
            () => routes({ method: 'GET', url: '/api/materials/binding', headers: { 'x-materials-principal': 'forged' } }, res(), ['materials', 'binding']),
            (/** @type {any} */ error) => error.status === 403 && error.extra.code === 'material-page-header-refused',
        );
        assert.equal(fake.calls.length, 0);
        const unattached = createMaterialCenterRoutes({});
        for (const method of ['GET', 'POST', 'DELETE']) {
            await assert.rejects(
                () => unattached({ method, url: '/api/materials/binding', headers: {}, async *[Symbol.asyncIterator]() { yield Buffer.from('{}'); } }, res(), ['materials', 'binding']),
                (/** @type {any} */ error) => error.status === 501 && error.extra.code === 'material-service-unavailable',
            );
        }
    } finally { await folder.cleanup(); }
});

/* ── the cache key carries the answer's shape, so a fixed shape is never served from an old file ── */

test('a different shape version is a different question, and an old entry is dropped', async () => {
    const folder = await cacheIn();
    try {
        // (2) the same version hits: one request, then none.
        const fake = upstream([jsonAnswer({ facets: ['a'] }), jsonAnswer({ facets: ['a', 'b'] })]);
        const service = createMaterialsService({ upstream: 'https://provider.invalid', secret: SECRET, cache: folder.cache, fetchImpl: fake.fetchImpl, auth: session() });
        const routes = createMaterialCenterRoutes({ service });
        await routes(req('/api/materials/facets'), res(), ['materials', 'facets']);
        await routes(req('/api/materials/facets'), res(), ['materials', 'facets']);
        assert.equal(fake.calls.length, 1, 'the same shape and the same question is answered from disk');

        // (1) another shape version writes to another file and does not hit the old one.
        const otherShape = createMaterialsCache({ root: folder.root, now: () => folder.now, shapeVersion: SHAPE_VERSION + 1 });
        assert.equal(await otherShape.readMeta('facets', {}), null, 'the old entry is not this shape’s answer');
        const second = createMaterialsService({ upstream: 'https://provider.invalid', secret: SECRET, cache: otherShape, fetchImpl: fake.fetchImpl, auth: session() });
        await createMaterialCenterRoutes({ service: second })(req('/api/materials/facets'), res(), ['materials', 'facets']);
        assert.equal(fake.calls.length, 2, 'a new shape must be fetched, not served from the old file');
        const files = await readdir(folder.cache.metaDir);
        assert.equal(files.length, 2, 'the two shapes are two files');
    } finally { await folder.cleanup(); }
});

test('an entry without the current shape version is a miss, and its file is removed', async () => {
    const folder = await cacheIn();
    try {
        await (await import('node:fs/promises')).mkdir(folder.cache.metaDir, { recursive: true });
        // Both cases sit at *this* cache's own name: a file written before versioning, and a file whose
        // answer shape is behind. Either one must be treated as a miss and taken away.
        const at = join(folder.cache.metaDir, `${querySignature('facets', {})}.json`);
        const legacy = { version: 1, route: 'facets', savedAt: folder.now, ttlMs: 1000, status: 200, body: { wrapped: true } };
        await writeFile(at, JSON.stringify(legacy));
        assert.equal(await folder.cache.readMeta('facets', {}), null, 'an entry written before shapeVersion existed is a miss');
        await assert.rejects(() => stat(at), /ENOENT/, 'and the stale file is gone');

        await writeFile(at, JSON.stringify({ ...legacy, shapeVersion: SHAPE_VERSION - 1 }));
        assert.equal(await folder.cache.readMeta('facets', {}), null, 'an entry of another shape is a miss');
        await assert.rejects(() => stat(at), /ENOENT/, 'and that file is gone too');
    } finally { await folder.cleanup(); }
});

test('clearing the cache removes only its own folder', async () => {
    const folder = await cacheIn();
    try {
        await writeFile(join(folder.root, 'keep-me.txt'), 'not cache');
        await folder.cache.writeCover('a'.repeat(40), new Uint8Array([1]), 'image/png');
        await folder.cache.clear();
        assert.equal(existsSync(join(folder.root, 'materials')), false, 'the cache folder is gone');
        assert.equal(existsSync(join(folder.root, 'keep-me.txt')), true, 'its neighbours in the root stay');
    } finally { await folder.cleanup(); }
});


// ---------------------------------------------------------------------------
// 下载下来的文件名：素材自己那一行名字，不是一墙数字
// ---------------------------------------------------------------------------
test('safeName：路径分隔符、控制字符、结尾点、设备名、长度都要处理', async () => {
  const { safeName } = await import('./materials-proxy.mjs');
  assert.equal(safeName('20261106-柠檬宝藏茶200g罐-外包装 (46)'), '20261106-柠檬宝藏茶200g罐-外包装 (46)');
  assert.equal(safeName('a/b\\c:d*e?f"g<h>i|j'), 'a／b／c／d／e／f／g／h／i／j', '一律换成全角的／，不留任何分隔符');
  assert.equal(safeName('  结尾有点.  '), '结尾有点', 'Windows 不允许名字以点或空格结尾');
  assert.equal(safeName('CON'), '_CON', '设备名不能当文件名');
  assert.equal(safeName('   '), null);
  assert.equal(safeName(undefined), null);
  assert.equal(Array.from(safeName('长'.repeat(200))).length, 60, '中文一字三字节，60 字以内才塞得下 id 与扩展名');
});

test('下载落盘用素材名 + id：云素材文件夹里能认出这是哪一条', async () => {
  const site = await savedSite();
  try {
    const fake = upstream([{ status: 200, body: site.staged }]);
    const service = site.service(fake, { names: { nameOf: () => '20261106-柠檬宝藏茶200g罐-外包装 (46)' } });
    const routes = createMaterialCenterRoutes({ service });
    const answer = res();
    await routes(postReq('/api/materials/raw', { videoId: 'v-1' }), answer, ['materials', 'raw']);
    const body = JSON.parse(String(answer.seen.body));
    assert.equal(body.landed, 'saved/云素材/20261106-柠檬宝藏茶200g罐-外包装 (46) (v-1).mp4');
    assert.equal(body.reused, false);
    const sidecar = JSON.parse(await readFile(join(site.cloud(), '.meta', 'v-1.json'), 'utf8'));
    assert.equal(sidecar.name, '20261106-柠檬宝藏茶200g罐-外包装 (46) (v-1).mp4', '侧车记下整个名字，重复下载靠它对上');
  } finally {
    await site.cleanup();
  }
});

test('没有名字时退回 <id>.mp4；再下载一次走侧车，不再问供应商', async () => {
  const site = await savedSite();
  try {
    const fake = upstream([{ status: 200, body: site.staged }]);
    const service = site.service(fake, { names: { nameOf: () => null } });
    const routes = createMaterialCenterRoutes({ service });
    const first = res();
    await routes(postReq('/api/materials/raw', { videoId: 'v-2' }), first, ['materials', 'raw']);
    assert.equal(JSON.parse(String(first.seen.body)).landed, 'saved/云素材/v-2.mp4', '没有名字就是 id，行为不变');
    assert.equal(fake.calls.length, 1);

    const again = res();
    await routes(postReq('/api/materials/raw', { videoId: 'v-2' }), again, ['materials', 'raw']);
    assert.equal(fake.calls.length, 1, '已经有这份字节：不再问供应商');
    assert.equal(JSON.parse(String(again.seen.body)).reused, true);
  } finally {
    await site.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 云管家绑定：绑一次就记住（按登录主体），供应商忘了也不再问人
// ---------------------------------------------------------------------------
test('绑定成功后记在本机，供应商说"没绑"时自动重新认领一次', async () => {
  const site = await savedSite();
  const memory = join(site.root, 'cloud-steward.json');
  try {
    /* 第一次：页面绑定 A1 → 记下来 */
    const claiming = upstream([jsonAnswer({ binding: { account: 'A1', state: 'claimed' } })]);
    const first = site.service(claiming, { stewardMemory: memory });
    const bound = res();
    await createMaterialCenterRoutes({ service: first })(postReq('/api/materials/binding', { account: 'A1' }), bound, ['materials', 'binding']);
    assert.equal(bound.seen.status, 200);
    const saved = JSON.parse(await readFile(memory, 'utf8'));
    assert.deepEqual(Object.values(saved), ['A1'], '按主体记下账号名');

    /* 重启/换机器：供应商先回"没绑"，本机把记住的那个再认领一次 —— 页面看到的是已绑定 */
    const forgetting = upstream([jsonAnswer({ binding: null }), jsonAnswer({ binding: { account: 'A1', state: 'claimed' } })]);
    const second = site.service(forgetting, { stewardMemory: memory });
    const read = res();
    await createMaterialCenterRoutes({ service: second })({ method: 'GET', url: '/api/materials/binding', headers: {} }, read, ['materials', 'binding']);
    assert.equal(forgetting.calls.length, 2, '一次问状态、一次自动认领');
    assert.deepEqual(JSON.parse(String(read.seen.body)), { binding: { account: 'A1', state: 'claimed' } });
  } finally {
    await site.cleanup();
  }
});

test('记住的账号认领失败时不硬撑：提示清掉，回到未绑定', async () => {
  const site = await savedSite();
  const memory = join(site.root, 'cloud-steward.json');
  await writeFile(memory, JSON.stringify({ [SUBJECT]: 'GONE' }), 'utf8');
  try {
    const fake = upstream([jsonAnswer({ binding: null }), jsonAnswer({ error: 'no such account' }, 400)]);
    const service = site.service(fake, { stewardMemory: memory });
    const read = res();
    await createMaterialCenterRoutes({ service })({ method: 'GET', url: '/api/materials/binding', headers: {} }, read, ['materials', 'binding']);
    assert.deepEqual(JSON.parse(String(read.seen.body)), { binding: null }, '老老实实回未绑定，不假装成功');
    assert.deepEqual(JSON.parse(await readFile(memory, 'utf8')), {}, '认领失败就把提示清掉，不再反复试');
  } finally {
    await site.cleanup();
  }
});
