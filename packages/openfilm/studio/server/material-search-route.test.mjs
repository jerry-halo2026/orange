// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * `POST /api/materials/search`: the account's search, and the one thing it adds — whether this computer already holds
 * the bytes (`availability.local` / `cachedMd5`) — plus the gate it sits behind (signed in, POST only, named 501 when
 * this installation has no tenant to search).
 *
 * No database and no supplier: the search is a stub that returns rows, and the "local copy" is a file this test writes
 * into a temporary content library. What is under test is the arithmetic, not psql.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMaterialCenterRoutes } from './material-center-routes.mjs';
import {
  availabilityOf, createLocalLibrary, createMaterialSearchAnswer, searchRequest, withAvailability,
} from './material-search-route.mjs';

/** A response stand-in: records what the handler would send. */
const res = () => {
  /** @type {{status?: number, body?: string, headers?: Record<string, string>}} */
  const seen = {};
  return {
    seen,
    writeHead(status, headers) { seen.status = status; seen.headers = headers; },
    end(body) { seen.body = String(body); },
    get destroyed() { return false; },
    get writableEnded() { return false; },
  };
};

/** A POST with a JSON body, iterable the way `readJson` reads one. */
const posting = (method, body) => ({
  method,
  headers: {},
  async *[Symbol.asyncIterator]() {
    if (body !== undefined) yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  },
});

/** The session every route in this group is read with. */
const session = () => ({ assertActive: () => ({ environmentId: 'env-1', subjectId: '11111111-1111-4111-8111-111111111111' }) });

/** What `media_search` answered, as the route sees it (`media-search.mjs` maps it). */
const ITEMS = [
  {
    mediaKey: '112619657', videoId: '112619657', name: '墨红玫瑰-外包装 (8)', batch: null, product: null,
    gname: '外包装', durationMs: null, score: 0.9768, matchKind: 'vector',
  },
  {
    mediaKey: '129767966', videoId: '129767966', name: '20261106-柠檬宝藏茶200g罐-汤色 (8)', batch: '20261106',
    product: '柠檬宝藏茶200g罐', gname: '汤色', durationMs: 8400, score: 0, matchKind: 'vector',
  },
];

/** A stub search that answers one mode and remembers what it was asked. */
const stubSearch = (result = { mode: 'vector', query: 'q', count: ITEMS.length, items: ITEMS }) => {
  /** @type {any[]} */
  const asked = [];
  return {
    asked,
    async search(request) { asked.push(request); return { ...result, query: request.query }; },
  };
};

/** A digest answer for one id, and the content library it is looked up in. */
const library = (md5s = {}) => ({
  md5Of: (videoId) => md5s[videoId] ?? null,
  has: (md5) => md5 === 'a'.repeat(32),
});

test('a search needs a query: the body is read, `group` is the RPC’s `gname`, and the limit is the contract’s', () => {
  assert.deepEqual(searchRequest({ query: ' 柠檬宝藏茶 外包装 ' }), { query: '柠檬宝藏茶 外包装', filters: {}, limit: 10 });
  assert.deepEqual(searchRequest({ query: '茶', group: '外包装', batch: '20261106', limit: 3 }), {
    query: '茶', filters: { batch: '20261106', gname: '外包装' }, limit: 3,
  });
  assert.deepEqual(searchRequest({ query: '茶', filters: { gname: '汤色', product: 'p' }, group: '外包装' }), {
    query: '茶', filters: { product: 'p', gname: '外包装' }, limit: 10,
  }, 'a flat key wins over the nested one');
  assert.equal(searchRequest({ query: '茶', limit: 10_000 }).limit, 50, 'never more than fifty rows');
  assert.equal(searchRequest({ query: '茶', durationMaxMs: 9000 }).filters.durationMaxMs, 9000);

  for (const body of [{}, { query: '   ' }, { query: 7 }, null, 'text']) {
    assert.throws(() => searchRequest(body), (error) => error.status === 400 && error.extra.code === 'invalid-arguments', JSON.stringify(body));
  }
});

test('availability is the two local facts, and a machine that cannot answer says false rather than guessing', () => {
  assert.deepEqual(availabilityOf(library({ v1: 'a'.repeat(32) }), 'v1'), { local: true, cachedMd5: 'a'.repeat(32) });
  assert.deepEqual(availabilityOf(library({ v1: 'b'.repeat(32) }), 'v1'), { local: false }, 'a digest we know, bytes we do not');
  assert.deepEqual(availabilityOf(library({}), 'v1'), { local: false }, 'no digest in the landed index');
  assert.deepEqual(availabilityOf(null, 'v1'), { local: false }, 'no library at all');
  assert.deepEqual(availabilityOf({ md5Of: () => { throw new Error('index unreadable'); }, has: () => true }, 'v1'), { local: false });
  assert.deepEqual(availabilityOf({ md5Of: () => 'a'.repeat(32), has: () => { throw new Error('gone'); } }, 'v1'), { local: false });
  assert.deepEqual(availabilityOf(library({ v1: 'a'.repeat(32) }), ''), { local: false });
});

test('the merge adds availability to every row and changes nothing else', () => {
  const merged = withAvailability({ mode: 'vector', query: '茶', count: 2, items: ITEMS }, (videoId) => (
    videoId === '129767966' ? { local: true, cachedMd5: 'a'.repeat(32) } : { local: false }
  ));
  assert.equal(merged.mode, 'vector');
  assert.equal(merged.query, '茶');
  assert.equal(merged.count, 2);
  assert.deepEqual(merged.items[0].availability, { local: false });
  assert.deepEqual(merged.items[1].availability, { local: true, cachedMd5: 'a'.repeat(32) });
  assert.deepEqual(Object.keys(merged.items[0]).slice(0, 9), Object.keys(ITEMS[0]), 'the row itself is untouched');
});

test('the answer is null without a service, and a body with no query is refused before the search runs', async () => {
  assert.equal(createMaterialSearchAnswer({}), null);
  const answer = createMaterialSearchAnswer({
    service: stubSearch(), availability: () => ({ local: false }),
  });
  assert.ok(answer);
  await assert.rejects(() => answer({}), (error) => error.status === 400 && error.extra.code === 'invalid-arguments');

  const payload = await answer({ query: '柠檬宝藏茶 外包装' });
  assert.equal(payload.mode, 'vector');
  assert.equal(payload.count, 2);
  assert.deepEqual(payload.items.map((item) => item.videoId), ['112619657', '129767966']);
  assert.deepEqual(payload.items[1].availability, { local: false }, 'no library means not local, never "unknown"');
});

test('the local library reads `content/<md5>` and the landed index it was pointed at', () => {
  const root = mkdtempSync(join(tmpdir(), 'material-search-library-'));
  const indexDir = join(root, 'material-index');
  mkdirSync(indexDir, { recursive: true });
  const bytes = Buffer.from('not really a video');
  const md5 = createHash('md5').update(bytes).digest('hex');
  mkdirSync(join(root, 'content'), { recursive: true });
  writeFileSync(join(root, 'content', md5), bytes);
  writeFileSync(join(root, 'content', `${md5}.json`), JSON.stringify({
    version: 1, md5, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, ext: '.mp4',
  }));
  writeFileSync(join(indexDir, 'index.json'), JSON.stringify({
    schema: 'orange/material-index-build/1', generatedAt: '2026-11-17T00:00:00.000Z',
    sourceTotal: 2, videos: 2, parsed: 0, unclassified: 2, warnings: [],
    index: {
      schema: 'orange/material-index/1', generatedAt: '2026-11-17T00:00:00.000Z',
      totals: { videos: 2, parsed: 0, unclassified: 2 }, batches: [], derived: { count: 2, batches: [], groups: {}, unassigned: 2 },
      unclassified: [{ videoId: 'here', name: 'a.mp4', md5 }, { videoId: 'away', name: 'b.mp4', md5: 'c'.repeat(32) }],
    },
  }));

  const local = createLocalLibrary({ root, indexDir });
  assert.deepEqual(local.of('here'), { local: true, cachedMd5: md5 }, 'the digest is known and the bytes are here');
  assert.deepEqual(local.of('away'), { local: false }, 'a digest this computer knows but never downloaded');
  assert.deepEqual(local.of('unknown'), { local: false });
  const where = local.where();
  assert.equal(where.content, join(root, 'content'));
  assert.equal(where.index, join(indexDir, 'index.json'));

  /* a root that cannot be opened fails the request, not the server: "not here" is the answer */
  const broken = createLocalLibrary({ roots: () => { throw new Error('MATERIALS_CACHE_ROOT_INVALID'); } });
  assert.deepEqual(broken.of('here'), { local: false });
  assert.equal(broken.where(), null);
});

test('the route is POST, signed in, and a named 501 when this installation has no tenant to search', async () => {
  /** @type {any[]} */
  const asked = [];
  const routes = createMaterialCenterRoutes({
    auth: session(),
    search: async (body) => { asked.push(body); return { mode: 'lexical', query: body.query, count: 0, items: [] }; },
  });
  const answered = res();
  assert.equal(await routes(/** @type {any} */ (posting('POST', { query: '柠檬宝藏茶 外包装' })), /** @type {any} */ (answered), ['materials', 'search']), true);
  assert.equal(answered.seen.status, 200);
  assert.deepEqual(JSON.parse(String(answered.seen.body)), { mode: 'lexical', query: '柠檬宝藏茶 外包装', count: 0, items: [] });
  assert.deepEqual(asked, [{ query: '柠檬宝藏茶 外包装' }], 'the router hands the body over as it arrived');

  await assert.rejects(
    () => routes(/** @type {any} */ (posting('GET')), /** @type {any} */ (res()), ['materials', 'search']),
    (error) => error.status === 405 && error.extra.code === 'method-not-allowed',
  );
  await assert.rejects(
    () => createMaterialCenterRoutes({ search: async () => ({}) })(/** @type {any} */ (posting('POST', { query: 'x' })), /** @type {any} */ (res()), ['materials', 'search']),
    (error) => error.status === 403 && error.extra.code === 'authentication-required',
  );
  await assert.rejects(
    () => createMaterialCenterRoutes({ auth: session() })(/** @type {any} */ (posting('POST', { query: 'x' })), /** @type {any} */ (res()), ['materials', 'search']),
    (error) => error.status === 501 && error.extra.code === 'material-search-unavailable',
  );
  await assert.rejects(
    () => routes(/** @type {any} */ (posting('POST', '{ not json')), /** @type {any} */ (res()), ['materials', 'search']),
    (error) => error.status === 400,
  );
  /* a path that is not the route is still a named 404, never a fall-through into the search */
  await assert.rejects(
    () => routes(/** @type {any} */ (posting('POST', {})), /** @type {any} */ (res()), ['materials', 'search', 'extra']),
    (error) => error.status === 404 && error.extra.code === 'material-route-unknown',
  );
});

test('the whole answer end to end: the RPC rows plus this computer’s two local facts', async () => {
  const search = stubSearch();
  const answer = createMaterialSearchAnswer({
    service: search,
    availability: (videoId) => (videoId === '112619657' ? { local: false } : { local: true, cachedMd5: 'd'.repeat(32) }),
  });
  const payload = await answer({ query: '柠檬宝藏茶', batch: '20261106', limit: 5 });
  assert.deepEqual(search.asked, [{ query: '柠檬宝藏茶', filters: { batch: '20261106' }, limit: 5 }]);
  assert.deepEqual(payload.items.map((item) => [item.videoId, item.availability.local]), [['112619657', false], ['129767966', true]]);
  assert.equal(payload.items[1].availability.cachedMd5, 'd'.repeat(32));
});
