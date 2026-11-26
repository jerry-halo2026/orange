// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * The two caches that make a second look cost nothing: the supplier's covers (by url, on this computer) and the videos
 * this computer already downloaded (by md5, in a local content library).
 *
 * Every case here counts requests: a cover answered from disk must not be fetched again, a download whose md5 is
 * already here must not reach the supplier at all, and the one that does must leave its bytes in the library. What was
 * saved is read from the structured log, because that is what 「核账」 will read too.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMaterialCenterRoutes } from './material-center-routes.mjs';
import { createContentStore, createCoverStore, createDigestIndex, coverCacheName, materialCacheStats } from './material-media-cache.mjs';
import { createMaterialsService } from './materials-proxy.mjs';

const SECRET = 'test-only-material-secret';
const SUBJECT = '11111111-1111-4111-8111-111111111111';
const INSTANCE = '22222222-2222-4222-8222-222222222222';
/** A supplier host (the real one is `szy-…-sucaiwang.sucaicloud.com`); the whitelist is asked for it, not for a fixture. */
const COVER_URL = 'https://szy-hlcxy-sucaiwang.sucaicloud.com:9001/sucaiwang/255/31950/128b4271.png';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const session = () => ({
  assertActive() { return { environmentId: 'env-1', subjectId: SUBJECT, instanceId: INSTANCE, epoch: 7 }; },
});

/** A response stand-in that keeps what the handler sent. */
const res = () => {
  /** @type {{status?: number, body?: any, headers?: Record<string, string>}} */
  const seen = {};
  return {
    seen,
    writeHead(/** @type {number} */ status, /** @type {Record<string, string>} */ headers) { seen.status = status; seen.headers = headers; },
    end(/** @type {unknown} */ body) { seen.body = body; },
    get writableEnded() { return false; },
  };
};

const req = (/** @type {string} */ url, /** @type {string} */ method = 'GET') => ({ method, url, headers: {} });
const partsOf = (/** @type {string} */ url) => new URL(url, 'http://studio.invalid').pathname.replace(/^\/api\//, '').split('/').filter(Boolean);

/** A fetch that counts every call and answers images. */
const imageFetch = (bytes = PNG, type = 'image/png') => {
  /** @type {string[]} */
  const calls = [];
  const fetchImpl = async (/** @type {string} */ url) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      headers: { get: (/** @type {string} */ name) => (name.toLowerCase() === 'content-type' ? type : null) },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      text: async () => '',
    };
  };
  return { calls, fetchImpl };
};

/** A material cache root of its own, with the log lines the run wrote. */
const mediaSite = async () => {
  const root = await mkdtemp(join(tmpdir(), 'material-media-'));
  /** @type {string[]} */
  const lines = [];
  const log = (/** @type {string} */ line) => { lines.push(line); };
  /** The lines that are JSON objects, parsed: the structured log this module writes. */
  const events = () => lines.map((line) => JSON.parse(line.trim()));
  return { root, log, lines, events, cleanup: () => rm(root, { recursive: true, force: true }) };
};

test('a cover is fetched once, then answered from this computer', async () => {
  const site = await mediaSite();
  try {
    const images = imageFetch();
    const covers = createCoverStore({ root: site.root, fetchImpl: images.fetchImpl, log: site.log });
    const service = createMaterialsService({ upstream: 'https://provider.invalid', secret: SECRET, covers, auth: session(), log: site.log });
    const routes = createMaterialCenterRoutes({ service, auth: session() });
    const url = '/api/materials/cover?url=' + encodeURIComponent(COVER_URL);

    const first = res();
    await routes(/** @type {any} */ (req(url)), /** @type {any} */ (first), partsOf(url));
    assert.equal(first.seen.status, 200);
    assert.equal(images.calls.length, 1, 'the first look asks the supplier once');
    assert.equal(String(first.seen.headers?.['content-type']), 'image/png');
    assert.equal(String(first.seen.headers?.['cache-control']), 'public, max-age=604800');
    assert.equal(first.seen.headers?.['x-cover-cache'], 'miss');
    assert.deepEqual(Buffer.from(first.seen.body), PNG);

    /* Whole on disk, under 32 hex digits of the url's sha256, and readable by this account only. */
    const name = coverCacheName(COVER_URL);
    assert.match(name, /^[a-f0-9]{32}$/);
    const file = join(site.root, 'covers', `${name}.png`);
    assert.deepEqual(readFileSync(file), PNG);
    assert.deepEqual(readdirSync(join(site.root, 'covers')).filter((entry) => entry.endsWith('.tmp')), [], 'no temporary file is left behind');
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600, '0600: this account reads it, nobody else');

    const second = res();
    await routes(/** @type {any} */ (req(url)), /** @type {any} */ (second), partsOf(url));
    assert.equal(images.calls.length, 1, 'the same cover is not asked for twice');
    assert.equal(second.seen.status, 200);
    assert.equal(second.seen.headers?.['x-cover-cache'], 'hit');
    assert.deepEqual(Buffer.from(second.seen.body), PNG);

    const events = site.events().filter((event) => event.event === 'material-cover');
    assert.deepEqual(events.map((event) => event.result), ['miss', 'hit'], 'both outcomes are logged');
    assert.equal(events[0].refetched, true);
    assert.equal(events[1].refetched, false);
    assert.equal(events[1].bytes, PNG.length);
    assert.equal(typeof events[1].ms, 'number', 'how long the second look took is logged too');
  } finally { await site.cleanup(); }
});

test('a cover url that just failed is answered from memory, not asked again for every card', async () => {
  /* Measured on this machine (2026-11-17): `szy-cfzx-sucaiwang.sucaicloud.com:9001` accepts the connection and then
     resets the TLS handshake after five seconds (443 and plain http too), while a sibling host answers the same bytes
     in 65 ms. One dead url in a grid of cards was forty five-second stalls and forty 502s for one answer. */
  const site = await mediaSite();
  try {
    let clock = 1_000_000;
    /** @type {string[]} */
    const calls = [];
    /** @type {Error[]} */
    const reset = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    let failing = true;
    const fetchImpl = async (/** @type {string} */ url) => {
      calls.push(url);
      if (failing) throw reset();
      return {
        ok: true, status: 200,
        headers: { get: (/** @type {string} */ name) => (name.toLowerCase() === 'content-type' ? 'image/png' : null) },
        arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength),
        text: async () => '',
      };
    };
    const covers = createCoverStore({ root: site.root, fetchImpl, log: site.log, now: () => clock });
    /** @type {any} */
    let first = null;
    try { await covers.get(COVER_URL); } catch (error) { first = error; }
    /* No image is not a gateway error: the card draws its placeholder and the browser console stays quiet. */
    assert.equal(first?.status, 204);
    assert.equal(first?.extra?.code, 'material-cover-unreachable');
    assert.equal(calls.length, 1);

    /* The second card asking for the same dead url: the same answer, at once, without the network. */
    const askedAt = clock;
    clock += 1_000;
    /** @type {any} */
    let second = null;
    try { await covers.get(COVER_URL); } catch (error) { second = error; }
    assert.equal(calls.length, 1, 'a remembered failure is not asked again');
    assert.equal(second?.status, 204);
    assert.equal(second?.extra?.code, 'material-cover-unreachable', 'the same status and code, so the page names it the same way');
    const negative = site.events().filter((event) => event.result === 'negative-hit');
    assert.equal(negative.length, 1);
    assert.equal(typeof negative[0].ms, 'number');
    assert.ok(negative[0].ms <= clock - askedAt, 'answered from memory, not from a five-second stall');

    /* A node that comes back must not stay refused: after the minute it is asked again, and its bytes are kept. */
    clock += 60_000;
    failing = false;
    const image = await covers.get(COVER_URL);
    assert.equal(image.hit, false);
    assert.equal(calls.length, 2, 'the failure was forgotten, the url was asked once more');
    assert.deepEqual(image.bytes, PNG);
    const after = await covers.get(COVER_URL);
    assert.equal(after.hit, true);
    assert.equal(calls.length, 2, 'and then it is on disk like any other cover');
  } finally { await site.cleanup(); }
});

test('the cover route answers 204 — not 502 — for a supplier host it cannot reach, and keeps every other refusal', async () => {
  /* Measured on this machine (2026-11-17): `szy-cfzx-sucaiwang.sucaicloud.com:9001` accepts the connection and then
     resets the TLS handshake after five seconds. A page of cards drew forty of those as red 502s in a console for one
     dead node; a host that cannot be reached has no cover, which is a 204 (the placeholder), not a gateway error. */
  const site = await mediaSite();
  try {
    let clock = 1_000_000;
    /** @type {string[]} */
    const calls = [];
    const reset = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    const fetchImpl = async (/** @type {string} */ url) => { calls.push(url); throw reset(); };
    const covers = createCoverStore({ root: site.root, fetchImpl, log: site.log, now: () => clock });
    const service = createMaterialsService({ upstream: 'https://provider.invalid', secret: SECRET, covers, auth: session(), log: site.log });
    const routes = createMaterialCenterRoutes({ service, auth: session() });
    /** @param {string} url @returns {Promise<any>} the response stand-in the route wrote to (or the error it threw) */
    const ask = async (url) => {
      const path = '/api/materials/cover?url=' + encodeURIComponent(url);
      const answer = res();
      try { await routes(/** @type {any} */ (req(path)), /** @type {any} */ (answer), partsOf(path)); }
      catch (error) { return { thrown: error }; }
      return answer;
    };

    /* ① a dead host: no body, no failure — the card keeps its placeholder. */
    const first = await ask(COVER_URL);
    assert.equal(first.seen.status, 204);
    assert.equal(first.seen.body, undefined, '204 carries no body: there is no picture to describe');
    assert.equal(calls.length, 1);

    /* ② the same url at once: still 204, and the supplier is not asked a second time. */
    clock += 5_000;
    const again = await ask(COVER_URL);
    assert.equal(again.seen.status, 204);
    assert.equal(calls.length, 1, 'the remembered minute answers it, not a second five-second stall');

    /* ③ another host is still a refusal, not "no image": the whitelist did not soften with the status. */
    const lookalike = await ask('https://sucaicloud.com.evil.test/cover.png');
    assert.equal(lookalike.thrown?.status, 403);
    assert.equal(lookalike.thrown?.extra?.code, 'material-cover-host-refused');
    assert.equal((await ask('')).thrown?.status, 400);
    assert.equal(calls.length, 1, 'a refused host is never fetched');
  } finally { await site.cleanup(); }
});

test('a cover of a host that is not the supplier is refused, and so is every other scheme', async () => {
  const site = await mediaSite();
  try {
    const images = imageFetch();
    const covers = createCoverStore({ root: site.root, fetchImpl: images.fetchImpl, log: site.log });
    const service = createMaterialsService({ upstream: 'https://provider.invalid', secret: SECRET, covers, auth: session(), log: site.log });
    const routes = createMaterialCenterRoutes({ service, auth: session() });
    /** @param {string} url @returns {Promise<any>} the request's answer, as the route threw it */
    const ask = async (url) => {
      const path = '/api/materials/cover?url=' + encodeURIComponent(url);
      try {
        await routes(/** @type {any} */ (req(path)), /** @type {any} */ (res()), partsOf(path));
        return null;
      } catch (error) { return error; }
    };

    /* The metadata address, a lookalike domain, a private address and a file url: none of them is the supplier. */
    for (const refused of [
      'http://169.254.169.254/latest/meta-data/',
      'https://sucaicloud.com.evil.test/cover.png',
      'http://127.0.0.1:8080/secret.png',
      'file:///C:/Windows/win.ini',
      'gopher://sucaicloud.com/',
    ]) {
      const error = await ask(refused);
      assert.equal(error?.status, refused.startsWith('file:') || refused.startsWith('gopher:') ? 400 : 403, refused + ' must be refused');
      /* Signed in, and still refused: the whitelist is the session's and the network's, not one or the other. */
      if (error?.status === 403) assert.equal(error.extra?.code, 'material-cover-host-refused', refused + ' is refused for its host');
    }
    assert.equal(images.calls.length, 0, 'a refused host is never fetched');
    assert.deepEqual(covers.list(), [], 'and nothing is written for it');

    const missing = await ask('');
    assert.equal(missing?.status, 400);
    assert.equal(missing?.extra?.code, 'material-cover-url-missing');
  } finally { await site.cleanup(); }
});

test('a download whose md5 is already here is a copy, and one that is not leaves its bytes here', async () => {
  const site = await mediaSite();
  const saved = await mkdtemp(join(tmpdir(), 'material-media-saved-'));
  try {
    /* The provider: one staged file per call, counted. */
    const stagedBody = Buffer.alloc(2048, 7);
    const staging = join(saved, 'staging', 'take.mp4');
    await mkdir(join(saved, 'staging'), { recursive: true });
    await writeFile(staging, stagedBody);
    const stagedSha = createHash('sha256').update(stagedBody).digest('hex');
    const staged = { path: staging, bytes: stagedBody.length, sha256: stagedSha, name: 'take.mp4' };
    /** @type {any[]} */
    const providerCalls = [];
    const fetchImpl = async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
      providerCalls.push({ url, method: init.method, body: init.body });
      return {
        ok: true, status: 200,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify(staged),
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    };

    const contents = createContentStore({ root: site.root, log: site.log });
    /* The supplier's own md5 for this video, as the landed index carries it; the library already holds those bytes. */
    const md5 = createHash('md5').update(stagedBody).digest('hex');
    await contents.put({ md5, source: staging, sha256: stagedSha, bytes: stagedBody.length, ext: '.mp4' });
    const digests = { md5Of: (/** @type {string} */ id) => (id === 'v-hit' ? md5 : null) };

    const post = (/** @type {string} */ videoId) => {
      const payload = Buffer.from(JSON.stringify({ videoId }));
      return { method: 'POST', url: '/api/materials/raw', headers: {}, async *[Symbol.asyncIterator]() { yield payload; } };
    };
    const serviceFor = () => createMaterialsService({
      upstream: 'https://provider.invalid', secret: SECRET, cache: null, fetchImpl, auth: session(),
      savedRoot: async () => saved, removeStaged: async () => {},
      covers: createCoverStore({ root: site.root, fetchImpl: imageFetch().fetchImpl, log: site.log }),
      contents, digests, log: site.log,
    });

    /* ① hit: the bytes are here, so the supplier is asked nothing at all. */
    const routes = createMaterialCenterRoutes({ service: serviceFor() });
    const hit = res();
    await routes(/** @type {any} */ (post('v-hit')), /** @type {any} */ (hit), ['materials', 'raw']);
    assert.equal(hit.seen.status, 200);
    assert.equal(providerCalls.length, 0, 'a download of bytes this computer has never reaches the supplier');
    const hitBody = JSON.parse(String(hit.seen.body));
    assert.deepEqual(hitBody, { landed: 'saved/云素材/v-hit.mp4', reused: false, sha256: stagedSha, bytes: stagedBody.length, cache: 'hit' });
    assert.deepEqual(readFileSync(join(saved, '云素材', 'v-hit.mp4')), stagedBody, 'the copy is the same bytes');

    /* ② miss: no digest for this id, so the supplier answers once and the bytes stay in the library. */
    const miss = res();
    await routes(/** @type {any} */ (post('v-miss')), /** @type {any} */ (miss), ['materials', 'raw']);
    assert.equal(miss.seen.status, 200);
    assert.equal(providerCalls.length, 1, 'one provider call, not two');
    const missBody = JSON.parse(String(miss.seen.body));
    assert.equal(missBody.reused, false);
    assert.equal(Object.hasOwn(missBody, 'cache'), false, 'an ordinary download says nothing about a cache it did not use');
    assert.equal(contents.has(md5), true, 'the fetched bytes are in the content library, under their own md5');
    assert.deepEqual(readFileSync(join(site.root, 'content', md5)), stagedBody);
    const sidecar = JSON.parse(readFileSync(join(site.root, 'content', `${md5}.json`), 'utf8'));
    assert.equal(sidecar.sha256, stagedSha);
    assert.equal(sidecar.bytes, stagedBody.length);
    assert.equal(sidecar.ext, '.mp4');

    /* ③ and the next download of *that* md5 is the copy branch — with the digest read for another id, since the same id
       twice would land on Saved's "already there" branch. */
    const known = res();
    const second = createMaterialsService({
      upstream: 'https://provider.invalid', secret: SECRET, cache: null, fetchImpl, auth: session(),
      savedRoot: async () => saved, removeStaged: async () => {}, contents, digests: { md5Of: () => md5 }, log: site.log,
    });
    await createMaterialCenterRoutes({ service: second })(/** @type {any} */ (post('v-hit-2')), /** @type {any} */ (known), ['materials', 'raw']);
    assert.equal(providerCalls.length, 1, 'still one provider call for three downloads');
    assert.equal(JSON.parse(String(known.seen.body)).cache, 'hit');

    const events = site.events().filter((event) => event.event === 'material-content');
    const hits = events.filter((event) => event.result === 'hit');
    const misses = events.filter((event) => event.result === 'miss');
    assert.equal(hits.length, 2, 'one line per hit');
    assert.deepEqual(hits.map((event) => event.md5), [md5, md5]);
    assert.deepEqual(hits.map((event) => event.bytes), [stagedBody.length, stagedBody.length]);
    assert.equal(misses.length, 1, 'one line per miss');
    assert.equal(misses[0].md5, md5);
    assert.equal(misses[0].bytes, stagedBody.length);
    assert.equal(misses[0].stored, 'written');
  } finally {
    await rm(saved, { recursive: true, force: true });
    await site.cleanup();
  }
});

test('the digest index answers from the file it reads, and says nothing it was not told', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'material-index-'));
  try {
    const md5 = 'a'.repeat(32);
    const built = {
      schema: 'orange/material-index-build/1', generatedAt: new Date().toISOString(), sourceTotal: 2, pageable: 2, unreachable: 0,
      videos: 2, parsed: 1, unclassified: 1,
      index: {
        schema: 'orange/material-index/1', generatedAt: new Date().toISOString(),
        totals: { videos: 2, parsed: 1, unclassified: 1 },
        batches: [{ id: '20261106', name: '20261106', count: 1, products: [{ id: 'p', name: 'p', count: 1, groups: [{ id: 'g', name: '外包装', count: 1, videoIds: ['v1'], entries: [{ videoId: 'v1', name: 'n', md5 }] }] }] }],
        unclassified: [{ videoId: 'v2', name: 'm', md5: '' }],
      },
    };
    writeFileSync(join(dir, 'index.json'), JSON.stringify(built));
    const digests = createDigestIndex({ dir });
    assert.equal(digests.md5Of('v1'), md5, 'the supplier\u2019s own digest is what it answers');
    assert.equal(digests.md5Of('v2'), null, 'a row without a digest is not given one');
    assert.equal(digests.md5Of('nobody'), null);

    /* A rebuild is a new file: the table is read again rather than kept for the life of the process. */
    const next = 'b'.repeat(32);
    const rebuilt = JSON.parse(JSON.stringify(built));
    rebuilt.index.batches[0].products[0].groups[0].entries[0].md5 = next;
    await new Promise((done) => setTimeout(done, 10));
    writeFileSync(join(dir, 'index.json'), JSON.stringify(rebuilt) + ' ');
    assert.equal(digests.md5Of('v1'), next);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a content library copy that is not the bytes it promised is forgotten, not served', async () => {
  const site = await mediaSite();
  try {
    const bytes = Buffer.alloc(64, 3);
    const md5 = createHash('md5').update(bytes).digest('hex');
    const source = join(site.root, 'source.mp4');
    mkdirSync(site.root, { recursive: true });
    writeFileSync(source, bytes);
    const contents = createContentStore({ root: site.root, log: site.log });
    await contents.put({ md5, source, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, ext: '.mp4' });
    assert.equal(contents.has(md5), true);
    /* Someone truncated it: the sidecar no longer describes the file, so it is not a copy of anything. */
    writeFileSync(join(site.root, 'content', md5), Buffer.alloc(10, 9));
    assert.equal(contents.open(md5), null, 'a file of another size is a miss');
    assert.equal(contents.has(md5), false);
    contents.forget(md5);
    assert.deepEqual(contents.list(), [], 'and the unusable copy is gone');
    assert.deepEqual(site.events().map((event) => event.result), ['forgotten']);
    /* A name that is not an md5 is never a path. */
    assert.equal(contents.open('../escape'), null);
    chmodSync(source, 0o600);
  } finally { await site.cleanup(); }
});

test('the service says what the two folders hold, so a page can show it', async () => {
  const site = await mediaSite();
  try {
    const images = imageFetch();
    const covers = createCoverStore({ root: site.root, fetchImpl: images.fetchImpl, log: site.log, limitBytes: 1_000 });
    const contents = createContentStore({ root: site.root, log: site.log, limitBytes: 4_000 });
    const service = createMaterialsService({ upstream: 'https://provider.invalid', secret: SECRET, covers, contents, auth: session(), log: site.log });
    const routes = createMaterialCenterRoutes({ service, auth: session() });

    const url = '/api/materials/cover?url=' + encodeURIComponent(COVER_URL);
    await routes(/** @type {any} */ (req(url)), /** @type {any} */ (res()), partsOf(url));

    const answer = res();
    await routes(/** @type {any} */ (req('/api/materials/cache/stats', 'GET')), /** @type {any} */ (answer), ['materials', 'cache', 'stats']);
    assert.equal(answer.seen.status, 200);
    assert.deepEqual(JSON.parse(String(answer.seen.body)), {
      content: { bytes: 0, files: 0, limit: 4_000 },
      covers: { bytes: PNG.length, files: 1, limit: 1_000 },
    });
  } finally { await site.cleanup(); }
});

test('a content library over its budget drops the least recently used copy, and never one still in use', async () => {
  const site = await mediaSite();
  try {
    /* A clock the test owns: a "use" is an mtime the sweep can order, so the times here have to be distinct. */
    let clock = Date.now();
    const now = () => clock;
    const contents = createContentStore({ root: site.root, log: site.log, now, limitBytes: 2_000 });
    /* Two hundred bytes of identity per copy, and none of them counted: the budget is the media's. */
    const keep = async (fill, size) => {
      const bytes = Buffer.alloc(size, fill);
      const source = join(site.root, `source-${fill}.bin`);
      mkdirSync(site.root, { recursive: true });
      writeFileSync(source, bytes);
      const md5 = createHash('md5').update(bytes).digest('hex');
      await contents.put({ md5, source, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: size, ext: '.mp4' });
      clock += 1_000;
      return md5;
    };

    const a = await keep(1, 1_000);
    const b = await keep(2, 1_000);
    assert.deepEqual(contents.stats(), { bytes: 2_000, files: 2, limit: 2_000 }, 'two copies of 1 KB fill a 2 KB budget exactly');

    /* A is used after B, so B is the least recently used copy. Nothing is dropped while the folder fits. */
    assert.ok(contents.open(a));
    clock += 60_000;
    assert.deepEqual(site.events().filter((event) => event.result === 'evict'), [], 'under budget, nothing is evicted');

    /* B is being copied into Saved right now: the sweep may take A, never B. */
    const release = contents.pin(b);
    const c = await keep(3, 1_000);
    assert.equal(contents.has(b), true, 'a copy something is reading is never evicted, however old it is');
    assert.equal(contents.has(a), false, 'the least recently used copy goes first');
    assert.equal(contents.has(c), true, 'the copy just written is the one the sweep protects');
    assert.deepEqual(contents.stats(), { bytes: 2_000, files: 2, limit: 2_000 }, 'the folder is back inside its budget');

    const evicted = site.events().filter((event) => event.result === 'evict');
    assert.deepEqual(evicted.map((event) => event.md5), [a], 'one structured line per copy dropped');
    assert.equal(evicted[0].bytes, 1_000);
    assert.equal(evicted[0].total, 2_000, 'what the folder holds after the drop is logged');
    assert.equal(evicted[0].limit, 2_000);
    assert.equal(existsSync(join(site.root, 'content', `${a}.json`)), false, 'a dropped copy takes its sidecar with it');

    /* Once the reader is done, the same budget takes B on the next write. C was read last, so it is the newest. */
    release();
    assert.ok(contents.open(c));
    assert.deepEqual(contents.stats(), { bytes: 2_000, files: 2, limit: 2_000 });
    const d = await keep(4, 1_000);
    assert.equal(contents.has(b), false, 'released: B is the oldest use again, and goes');
    assert.equal(contents.has(c), true);
    assert.equal(contents.has(d), true);

    /* The same read a route shows (`materialCacheStats`), not a second accounting of the same folder. */
    assert.deepEqual(materialCacheStats({ root: site.root, limitBytes: 2_000 }), contents.stats());

    /* A library an operator lowered the budget for is trimmed when the next run opens it, not only on the next write. */
    const trimmed = createContentStore({ root: site.root, log: site.log, now, limitBytes: 1_000 });
    assert.equal(trimmed.stats().bytes, 1_000, 'the smaller budget is already applied');
    assert.equal(trimmed.stats().files, 1);
  } finally { await site.cleanup(); }
});

test('the covers and the content library are two budgets, and filling one never evicts the other', async () => {
  const site = await mediaSite();
  try {
    let clock = Date.now();
    const now = () => clock;
    const PNG_800 = Buffer.concat([PNG, Buffer.alloc(800 - PNG.length, 5)]);
    const images = imageFetch(PNG_800);
    /* A cover cache of 1 KB and a content library of 4 KB: the two numbers are asked for, and kept apart. */
    const covers = createCoverStore({ root: site.root, fetchImpl: images.fetchImpl, log: site.log, now, limitBytes: 1_000 });
    const contents = createContentStore({ root: site.root, log: site.log, now, limitBytes: 4_000 });
    const service = createMaterialsService({ upstream: 'https://provider.invalid', secret: SECRET, covers, auth: session(), log: site.log });
    const routes = createMaterialCenterRoutes({ service, auth: session() });
    /** @param {string} url */
    const ask = async (url) => {
      const path = '/api/materials/cover?url=' + encodeURIComponent(url);
      const answer = res();
      await routes(/** @type {any} */ (req(path)), /** @type {any} */ (answer), partsOf(path));
      return answer;
    };
    const keep = async (fill, size) => {
      const bytes = Buffer.alloc(size, fill);
      const source = join(site.root, `source-${fill}.bin`);
      mkdirSync(site.root, { recursive: true });
      writeFileSync(source, bytes);
      const md5 = createHash('md5').update(bytes).digest('hex');
      await contents.put({ md5, source, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: size, ext: '.mp4' });
      clock += 1_000;
      return md5;
    };

    /* Two covers of 800 bytes in a 1 KB cache: the first goes, and the content library is not touched. */
    await ask(`${COVER_URL}?first`);
    clock += 1_000;
    await ask(`${COVER_URL}?second`);
    assert.deepEqual(covers.stats(), { bytes: 800, files: 1, limit: 1_000 });
    assert.deepEqual(contents.stats(), { bytes: 0, files: 0, limit: 4_000 }, 'a cover sweep takes no content');

    /* And the other way: two 2 KB copies fill the content library, a third evicts one — the cover stays. */
    const first = await keep(11, 2_000);
    const second = await keep(12, 2_000);
    assert.deepEqual(contents.stats(), { bytes: 4_000, files: 2, limit: 4_000 });
    assert.ok(contents.open(second), 'the second copy is the last one used');
    clock += 60_000;
    await keep(13, 2_000);
    assert.deepEqual(contents.stats(), { bytes: 4_000, files: 2, limit: 4_000 });
    assert.equal(contents.has(first), false, 'the least recently used copy is the one dropped');
    assert.deepEqual(covers.stats(), { bytes: 800, files: 1, limit: 1_000 }, 'a content sweep takes no cover');

    const evicted = site.events().filter((event) => event.result === 'evict');
    assert.deepEqual(evicted.map((event) => event.event), ['material-cover', 'material-content'], 'each folder logs its own drops');
    assert.deepEqual(materialCacheStats({ root: site.root, kind: 'covers', limitBytes: 1_000 }), covers.stats());
    assert.deepEqual(materialCacheStats({ root: site.root, kind: 'content', limitBytes: 4_000 }), contents.stats(), 'the two limits are never one number');
    assert.equal(materialCacheStats({ root: site.root, kind: 'covers' }).limit, 512 * 1024 * 1024, 'the cover budget defaults to 512 MB');
    assert.equal(materialCacheStats({ root: site.root }).limit, 2 * 1024 * 1024 * 1024, 'the content budget defaults to 2 GB');

    /* The operator's own numbers, from the environment, per folder. */
    assert.equal(materialCacheStats({ root: site.root, env: { ORANGE_MATERIAL_CACHE_MAX_BYTES: '1048576' } }).limit, 1_048_576);
    assert.equal(materialCacheStats({ root: site.root, kind: 'covers', env: { ORANGE_MATERIAL_COVERS_MAX_BYTES: '2048' } }).limit, 2_048);
    assert.equal(materialCacheStats({ root: site.root, kind: 'covers', env: { ORANGE_MATERIAL_CACHE_MAX_BYTES: '2048' } }).limit,
      512 * 1024 * 1024, 'the content variable never moves the cover budget');
  } finally { await site.cleanup(); }
});
