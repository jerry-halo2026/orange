// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * `GET /api/materials/index`: the index our builder landed, read as it is.
 *
 * The anchors are the ones the last real build printed (`docs/execution/2026-11-16-auth-unify/material-index-encoding.md`):
 * 78 874 videos, 7 real batches, 1 726 derived ones, `pageable` 79 099 against a claim of 230 030. The route's job is to
 * hand that file over and to name the two ways it can be missing — never to invent an empty index.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { landedIndex } from './material-index-route.mjs';
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

/** The file the builder lands, cut down to the fields the route and the page read. */
const builtIndex = (over = {}) => ({
  schema: 'orange/material-index-build/1',
  generatedAt: '2026-11-16T11:06:46.134Z',
  staleAfterMs: 86_400_000,
  sourceTotal: 230_030,
  pageable: 79_099,
  unreachable: 150_931,
  duplicates: 225,
  videos: 78_874,
  parsed: 390,
  unclassified: 78_484,
  pageSize: 100,
  pages: 793,
  warnings: [],
  index: {
    schema: 'orange/material-index/1',
    generatedAt: '2026-11-16T11:06:46.134Z',
    totals: { videos: 78_874, parsed: 390, unclassified: 78_484 },
    batches: Array.from({ length: 7 }, (_, at) => ({
      id: '2026110' + at, name: '2026110' + at, count: 1,
      products: [{ id: 'p' + at, name: 'p' + at, count: 1, groups: [{ id: 'g' + at, name: '外包装', count: 1, videoIds: ['v' + at], entries: [{ videoId: 'v' + at, name: 'n (1)', md5: '' }] }] }],
    })),
    unclassified: [],
    derived: {
      count: 78_484,
      batches: Array.from({ length: 1726 }, (_, at) => ({ id: 'd' + at, name: 'd' + at, count: 1, videoIds: [], derived: true })),
      groups: { id: 'derived:unfiled', name: '未归档', count: 26_160, derived: true, groups: [] },
      unassigned: 25_597,
    },
    reach: { pageable: 79_099, sourceTotal: 230_030, unreachable: 150_931 },
  },
  ...over,
});

/** A directory holding `index.json` with exactly these bytes. */
const dirWith = (text) => {
  const dir = mkdtempSync(join(tmpdir(), 'material-index-route-'));
  writeFileSync(join(dir, 'index.json'), text, 'utf8');
  return dir;
};

test('no index on this computer is a 404 index-missing, never an empty index', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'material-index-absent-')), 'material-index');
  assert.throws(() => landedIndex({ dir }),
    (/** @type {any} */ error) => error.status === 404 && error.extra.code === 'index-missing' && error.extra.file === join(dir, 'index.json'));
});

test('bytes that do not parse, and a file that is not this index, are a 500 index-unreadable', () => {
  for (const text of ['{ not json', '[]', '{"schema":"x"}', '{"index":{"batches":[]}}']) {
    assert.throws(() => landedIndex({ dir: dirWith(text) }),
      (/** @type {any} */ error) => error.status === 500 && error.extra.code === 'index-unreadable',
      text + ' is not an index');
  }
});

test('the landed file comes back as it is, with claimed / totals / batches / derived beside its own fields', () => {
  const answer = /** @type {any} */ (landedIndex({ dir: dirWith(JSON.stringify(builtIndex())), now: new Date('2026-11-16T12:00:00Z') }));
  assert.equal(answer.schema, 'orange/material-index-build/1', 'the file\'s own fields are untouched');
  assert.equal(answer.generatedAt, '2026-11-16T11:06:46.134Z');
  assert.equal(answer.videos, 78_874);
  assert.equal(answer.pageable, 79_099);
  assert.equal(answer.unreachable, 150_931);
  assert.equal(answer.duplicates, 225);
  assert.equal(answer.claimed, 230_030, 'the supplier\'s claim, under the name the page reads');
  assert.deepEqual(answer.totals, { videos: 78_874, parsed: 390, unclassified: 78_484 });
  assert.equal(answer.batches.length, 7, 'the real batches');
  assert.equal(answer.derived.batches.length, 1726, 'the derived layer');
  assert.equal(answer.derived.unassigned, 25_597);
  assert.deepEqual(answer.index.reach, { pageable: 79_099, sourceTotal: 230_030, unreachable: 150_931 }, 'and the nested tree is still there');
  assert.equal(answer.stale, false, '45 minutes after it was built, inside its own 24 h window');
});

test('an index past its own staleAfterMs is still served, and says it is stale', () => {
  const answer = /** @type {any} */ (landedIndex({ dir: dirWith(JSON.stringify(builtIndex())), now: new Date('2026-11-18T00:00:00Z') }));
  assert.equal(answer.stale, true);
  assert.equal(answer.batches.length, 7, 'a stale index is read, not hidden: the page says "可重建" over the data');
});

test('a file with no generatedAt is stale by its own admission, not by a guess', () => {
  const answer = /** @type {any} */ (landedIndex({ dir: dirWith(JSON.stringify(builtIndex({ generatedAt: undefined, staleAfterMs: undefined }))), now: new Date('2026-11-16T12:00:00Z') }));
  assert.equal(answer.stale, true);
});

test('the route is GET, signed in, and needs no supplier service', async () => {
  const signedIn = { assertActive: () => ({ scope: 'window' }) };
  const unsigned = { assertActive: () => { throw new Error('sealed'); } };

  const unsignedRoutes = createMaterialCenterRoutes({ auth: unsigned, index: () => ({ ok: true }) });
  await assert.rejects(() => unsignedRoutes(/** @type {any} */ ({ method: 'GET', headers: {} }), /** @type {any} */ (res()), ['materials', 'index']),
    (/** @type {any} */ error) => error.status === 403 && error.extra.code === 'authentication-required',
    'the index is a file on this computer: a session is required to read it');

  const noReader = createMaterialCenterRoutes({ auth: signedIn });
  await assert.rejects(() => noReader(/** @type {any} */ ({ method: 'GET', headers: {} }), /** @type {any} */ (res()), ['materials', 'index']),
    (/** @type {any} */ error) => error.status === 501 && error.extra.code === 'material-index-unavailable',
    'no reader wired is a named 501 the page falls back from');

  /* `now` pinned: the fixture index was built at 2026-11-16T11:06Z with a 24 h window, so reading it against the wall
     clock makes the freshness assertion depend on the day the suite runs */
  const routes = createMaterialCenterRoutes({ auth: signedIn, index: () => landedIndex({ dir: dirWith(JSON.stringify(builtIndex())), now: new Date('2026-11-16T12:00:00Z') }) });
  await assert.rejects(() => routes(/** @type {any} */ ({ method: 'POST', headers: {} }), /** @type {any} */ (res()), ['materials', 'index']),
    (/** @type {any} */ error) => error.status === 405 && error.extra.code === 'method-not-allowed', 'a read is GET only');

  const response = res();
  assert.equal(await routes(/** @type {any} */ ({ method: 'GET', headers: {} }), /** @type {any} */ (response), ['materials', 'index']), true);
  assert.equal(response.seen.status, 200);
  const body = JSON.parse(response.seen.body ?? '{}');
  assert.equal(body.claimed, 230_030);
  assert.equal(body.batches.length, 7);
  assert.equal(body.derived.batches.length, 1726);
  assert.deepEqual(body.totals, { videos: 78_874, parsed: 390, unclassified: 78_484 });
  assert.equal(body.stale, false);
});

test('a missing file through the route is the 404 the page falls back from', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'material-index-empty-')), 'material-index');
  mkdirSync(dir, { recursive: true });
  const routes = createMaterialCenterRoutes({ auth: { assertActive: () => ({}) }, index: () => landedIndex({ dir }) });
  await assert.rejects(() => routes(/** @type {any} */ ({ method: 'GET', headers: {} }), /** @type {any} */ (res()), ['materials', 'index']),
    (/** @type {any} */ error) => error.status === 404 && error.extra.code === 'index-missing');
});
