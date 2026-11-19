// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * Building the index from the supplier's pages: the guards that keep a sweep finite and honest.
 *
 * The feed this stands in for is the Studio's `/api/materials/list` over the real account (448 materials in batch
 * 20261106, 221 in its 柠檬宝藏茶200g罐 collection), so the shapes pinned here — a last page that is not full, a total
 * that moves, a page that repeats — are the ones that account actually produces.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_THROTTLE_MS, PAGE_SIZE, STALE_AFTER_MS, backoffMs, buildMaterialIndexFromApi, collectMaterialRows,
  countMetadata, defaultIndexDir, indexAgeMs, isIndexStale, isRateLimited, loadMaterialIndex, materialIndexPath,
  readMaterialIndex, rowOf, rowsFromPage, writeMaterialIndex,
} from './material-index-build.mjs';
import { readRunFile, parseArgs, runMaterialIndexBuild, summaryLines } from '../scripts/material-index-build.mjs';

const NOW = new Date('2026-11-16T00:00:00Z');
const tmp = () => mkdtempSync(join(tmpdir(), 'material-index-build-'));

/** The six card fields an entry always carries, empty when the row said nothing (`ENTRY_META_FIELDS`). */
const NO_CARD = Object.freeze({ labels: [], durationMs: null, author: '', coverUrl: '', oneLevel: '', twoLevel: '' });

/** A page stub that serves `rows` in slices of `pageSize` and answers `total` every time. */
function pager(rows, total = rows.length) {
  const asks = [];
  const fetchPage = async ({ videoType, pageNo, pageSize }) => {
    asks.push({ videoType, pageNo, pageSize });
    return { items: rows.slice((pageNo - 1) * pageSize, pageNo * pageSize), total };
  };
  return { fetchPage, asks };
}

/** Only class `filled` has rows; the other four are empty, which is what a real account mostly looks like. */
function oneClass(filled, rows) {
  const asks = [];
  const fetchPage = async ({ videoType, pageNo, pageSize }) => {
    asks.push({ videoType, pageNo, pageSize });
    if (videoType !== filled) return { items: [], total: 0 };
    return { items: rows.slice((pageNo - 1) * pageSize, pageNo * pageSize), total: rows.length };
  };
  return { fetchPage, asks };
}

const named = (id, sequence = 1) => ({ videoId: id, name: `20261106-柠檬宝藏茶200g罐-外包装 (${sequence})` });

test('a sweep reads to the last page, which is not full, and says how many pages it took', async () => {
  const rows = [named('a', 1), named('b', 2), named('c', 3)];
  const { fetchPage, asks } = pager(rows, 3);

  const result = await buildMaterialIndexFromApi({ fetchPage, pageSize: 2, videoTypes: [1], throttleMs: 0, now: NOW });

  assert.deepEqual(asks, [{ videoType: 1, pageNo: 1, pageSize: 2 }, { videoType: 1, pageNo: 2, pageSize: 2 }]);
  assert.equal(result.videos, 3);
  assert.equal(result.parsed, 3);
  assert.equal(result.unclassified, 0);
  assert.equal(result.sourceTotal, 3);
  assert.equal(result.pages.fetched, 2);
  assert.equal(result.pages.perType[0].stopped, 'short-page');
  assert.deepEqual(result.warnings, [], 'a clean sweep has nothing to warn about');
  assert.deepEqual(result.index.batches.map((batch) => batch.id), ['20261106']);
});

test('a video that arrives twice — in one page, or on the next — is one material, and the gap is said out loud', async () => {
  const pages = {
    1: { items: [named('a', 1), named('a', 1)], total: 3 },
    2: { items: [named('a', 1), named('b', 2)], total: 3 },
    3: { items: [], total: 3 },
  };
  const fetchPage = async ({ pageNo }) => pages[pageNo];

  const result = await buildMaterialIndexFromApi({ fetchPage, pageSize: 2, videoTypes: [1], throttleMs: 0, now: NOW });

  assert.equal(result.videos, 2, 'a and b, once each');
  assert.equal(result.sourceTotal, 3, 'the supplier still counts three');
  const mismatch = result.warnings.find((warning) => warning.code === 'source-total-mismatch');
  assert.ok(mismatch, 'the difference is a warning');
  assert.equal(mismatch.difference, 1);
  assert.equal(mismatch.counted, 2);
});

test('a page that repeats the one before it ends the class instead of asking again', async () => {
  let asks = 0;
  const fetchPage = async () => { asks += 1; return { items: [named('a', 1), named('b', 2)], total: 10 }; };

  const result = await buildMaterialIndexFromApi({ fetchPage, pageSize: 2, videoTypes: [1], throttleMs: 0, now: NOW });

  assert.equal(asks, 2, 'page 2 said nothing new: no page 3');
  assert.equal(result.pages.perType[0].stopped, 'repeat-page');
  assert.ok(result.warnings.some((warning) => warning.code === 'repeat-page'));
  assert.equal(result.videos, 2);
  assert.equal(result.sourceTotal, 10, 'total is still the supplier\'s word');
});

test('a class the account has nothing in is empty, not a warning', async () => {
  const fetchPage = async () => ({ items: [], total: 0 });

  const result = await buildMaterialIndexFromApi({ fetchPage, pageSize: 2, videoTypes: [4], throttleMs: 0, now: NOW });

  assert.equal(result.pages.perType[0].stopped, 'empty-page');
  assert.deepEqual(result.warnings, []);
  assert.equal(result.sourceTotal, 0);
  assert.equal(result.videos, 0);
});

test('an empty page ends the class, and a total nobody reached stays a warning', async () => {
  const fetchPage = async ({ pageNo }) => (pageNo === 1
    ? { items: [named('a', 1), named('b', 2)], total: 5 }
    : { items: [], total: 5 });

  const result = await buildMaterialIndexFromApi({ fetchPage, pageSize: 2, videoTypes: [1], throttleMs: 0, now: NOW });

  assert.equal(result.pages.perType[0].stopped, 'empty-page');
  assert.ok(result.warnings.some((warning) => warning.code === 'empty-page'));
  assert.equal(result.videos, 2);
  assert.equal(result.sourceTotal, 5);
  assert.equal(result.warnings.find((warning) => warning.code === 'source-total-mismatch')?.difference, 3);
});

test('a total that moves mid-sweep is followed, and every move is a warning', async () => {
  const totals = { 1: 3, 2: 4 };
  const rows = { 1: [named('a', 1), named('b', 2)], 2: [named('c', 3), named('d', 4)] };
  const fetchPage = async ({ pageNo }) => ({ items: rows[pageNo], total: totals[pageNo] });

  const result = await buildMaterialIndexFromApi({ fetchPage, pageSize: 2, videoTypes: [1], throttleMs: 0, now: NOW });

  const changed = result.warnings.filter((warning) => warning.code === 'total-changed');
  assert.equal(changed.length, 1);
  assert.deepEqual([changed[0].previous, changed[0].total, changed[0].pageNo], [3, 4, 2]);
  assert.equal(result.pages.perType[0].stopped, 'reached-total', 'the new total is what the sweep stops at');
  assert.equal(result.videos, 4);
  assert.equal(result.sourceTotal, 4);
  assert.equal(result.warnings.some((warning) => warning.code === 'source-total-mismatch'), false);
});

test('the page cap stops a feed that always returns something new', async () => {
  let next = 0;
  const fetchPage = async () => {
    const items = [named(`v${next++}`, next), named(`v${next++}`, next)];
    return { items, total: 1000 };
  };

  const result = await buildMaterialIndexFromApi({ fetchPage, pageSize: 2, videoTypes: [1], maxPagesPerType: 2, throttleMs: 0, now: NOW });

  assert.equal(result.pages.fetched, 2);
  assert.equal(result.pages.perType[0].stopped, 'page-cap');
  assert.ok(result.warnings.some((warning) => warning.code === 'page-cap'));
  assert.equal(result.videos, 4);
});

test('a page that fails stops its own class and never the ones after it', async () => {
  const fetchPage = async ({ videoType, pageNo }) => {
    if (videoType === 0 && pageNo === 2) throw new Error('HTTP 502');
    return { items: [named(`${videoType}-${pageNo}-1`, pageNo), named(`${videoType}-${pageNo}-2`, pageNo)], total: 4 };
  };

  const result = await buildMaterialIndexFromApi({ fetchPage, pageSize: 2, videoTypes: [0, 1], throttleMs: 0, now: NOW });

  const failed = result.warnings.find((warning) => warning.code === 'page-failed');
  assert.ok(failed);
  assert.deepEqual([failed.videoType, failed.pageNo], [0, 2]);
  assert.match(failed.detail, /502/);
  assert.deepEqual(result.pages.perType.map((type) => [type.videoType, type.pages, type.stopped]), [
    [0, 1, 'page-failed'], [1, 2, 'reached-total'],
  ]);
  assert.equal(result.pages.perType[1].rows, 4, 'the second class was read whole');
});

test('a name the shape does not claim is counted unclassified, not dropped', async () => {
  const fetchPage = async () => ({ items: [named('a', 1), { videoId: 'b', name: '别的名字.mp4' }], total: 2 });

  const result = await buildMaterialIndexFromApi({ fetchPage, pageSize: 10, videoTypes: [1], throttleMs: 0, now: NOW });

  assert.equal(result.parsed, 1);
  assert.equal(result.unclassified, 1);
  assert.ok(result.warnings.some((warning) => warning.code === 'unclassified'));
  assert.deepEqual(result.index.unclassified, [{ videoId: 'b', name: '别的名字.mp4', md5: '', ...NO_CARD }]);
});

test('the supplier\'s own row shape decodes: an id object, an observation, a wrapped total', async () => {
  assert.deepEqual(rowOf({
    videoId: { value: 'v1', sourceType: 1, source: 'v1' },
    observation: { name: '20261106-柠檬宝藏茶200g罐-外包装 (46)', rawMd5: 'b1946ac92492d2347c6235b4d2611184' },
  }), {
    videoId: 'v1', name: '20261106-柠檬宝藏茶200g罐-外包装 (46)', md5: 'b1946ac92492d2347c6235b4d2611184', ...NO_CARD,
  });
  assert.equal(rowOf({ videoId: {} }), null);
  assert.equal(rowOf({ observation: { name: 'x' } }), null);
  assert.deepEqual(rowsFromPage([{ videoId: 'a', name: 'n' }, null, { name: 'no id' }]),
    [{ videoId: 'a', name: 'n', md5: '', ...NO_CARD }]);
  assert.equal(rowOf({ videoId: 'a', observation: { name: 'n', rawMd5: '' } }).md5, '', 'an empty rawMd5 is left empty');
  assert.equal(rowOf({ videoId: 'a', observation: { name: 'n', rawMd5: { sourceType: 'string', source: 'c0ffee' } } }).md5,
    'c0ffee', 'a wrapped literal is unwrapped');
  assert.equal(rowOf({ videoId: 'a', observation: { name: 'n', md5: 'short-name' } }).md5, 'short-name', 'the short name is read too');

  const collected = await collectMaterialRows({
    fetchPage: async () => ({ items: [named('a', 1)], total: { sourceType: 'number', source: '448' } }),
    pageSize: 10,
    videoTypes: [1],
  });
  assert.equal(collected.sourceTotal, 448, 'a wrapped total is read, not ignored');
  assert.equal(collected.types[0].total, 448);
  assert.equal(collected.types[0].stopped, 'short-page');
});

test('the index lands whole: bytes to index.json.tmp, renamed, then readable', async () => {
  const dir = join(tmp(), 'material-index');
  const fetchPage = async () => ({ items: [named('a', 1), named('b', 2), { videoId: 'z', name: '随便.mp4' }], total: 3 });
  const result = await buildMaterialIndexFromApi({ fetchPage, pageSize: 10, videoTypes: [1], throttleMs: 0, now: NOW });

  const written = await writeMaterialIndex(dir, result);

  assert.equal(written.file, materialIndexPath(dir));
  assert.equal(written.videos, 3);
  assert.equal(existsSync(`${written.file}.tmp`), false, 'the temporary name is gone');
  const back = readMaterialIndex(dir);
  assert.equal(back.schema, 'orange/material-index-build/1');
  assert.equal(back.generatedAt, NOW.toISOString());
  assert.deepEqual([back.videos, back.parsed, back.unclassified, back.sourceTotal], [3, 2, 1, 3]);
  assert.equal(back.index.batches[0].products[0].groups[0].entries.length, 2, 'ids and names both survive the round trip');
  assert.match(readFileSync(written.file, 'utf8'), /"schema": "orange\/material-index-build\/1"/);

  if (process.platform !== 'win32') {
    assert.equal(statSync(dir).mode & 0o777, 0o700, 'the directory is 0700');
    assert.equal(statSync(written.file).mode & 0o777, 0o600, 'the file is 0600');
  }
});

/* ── the file that lands: UTF-8 written here, read back, parsed, and only then renamed ────────────────────────────────
 *
 * The failure this pins is a real one: a 7.7 MB index rebuilt through a shell (`Set-Content`) came back with 「标品」
 * written as 「鏍囧搧」 and 「加冰块」 as 「鍔犲啺鍧?」 — still JSON, still 7.7 MB, and wrong. So the builder writes the
 * bytes itself, reads them back, parses them, and deletes its tmp when any of that fails.
 */

test('the landed file is UTF-8 written by the builder itself, and a Chinese name survives the round trip', async () => {
  const dir = join(tmp(), 'utf8');
  const rows = [
    { videoId: 'a', name: '标品-加冰块 (1)', rawMd5: 'aa11' },
    { videoId: 'b', name: '20261106-柠檬宝藏茶200g罐-外包装 (2)' },
  ];
  const result = await buildMaterialIndexFromApi({
    fetchPage: async () => ({ items: rows, total: rows.length }), pageSize: 10, videoTypes: [1], throttleMs: 0, now: NOW,
  });
  const written = await writeMaterialIndex(dir, result);

  const bytes = readFileSync(written.file);
  assert.deepEqual([...bytes.subarray(0, 5)], [0x7b, 0x0a, 0x20, 0x20, 0x22], 'it starts with `{` and no BOM');
  const text = readFileSync(written.file, 'utf8');
  assert.match(text, /标品-加冰块/, 'the name is the name it was given');
  assert.equal(text.includes('\uFFFD'), false, 'no replacement characters anywhere');
  assert.equal(/[鏍鍔鍧啺搧]/.test(text), false, 'and none of the GBK round-trip shapes');
  assert.deepEqual(JSON.parse(text).index.unclassified.map((row) => [row.name, row.md5]), [['标品-加冰块 (1)', 'aa11']]);
  assert.deepEqual(written.md5s, { entries: 2, withMd5: 1, missing: 1 }, 'the writer says how many entries carry a digest');
});

test('a build whose bytes would not come back unchanged is deleted, and the index already on disk is left alone', async () => {
  const dir = join(tmp(), 'refuse');
  const rows = [named('a', 1)];
  const good = await buildMaterialIndexFromApi({
    fetchPage: async () => ({ items: rows, total: 1 }), pageSize: 10, videoTypes: [1], throttleMs: 0, now: NOW,
  });
  await writeMaterialIndex(dir, good);
  const before = readFileSync(materialIndexPath(dir), 'utf8');

  /* what is serialised says `videos: 7`; what is verified afterwards says 8 — the self-check must catch that */
  let reads = 0;
  const shifty = {
    schema: 'orange/material-index-build/1',
    generatedAt: NOW.toISOString(),
    index: { batches: [] },
    get videos() { reads += 1; return reads === 1 ? 7 : 8; },
  };
  await assert.rejects(() => writeMaterialIndex(dir, shifty),
    (error) => /** @type {any} */ (error).code === 'index-verify-failed');
  assert.equal(existsSync(`${materialIndexPath(dir)}.tmp`), false, 'the tmp is gone, not left half-written');
  assert.equal(readFileSync(materialIndexPath(dir), 'utf8'), before, 'the previous index is untouched');

  /* and a tmp name that cannot be written fails the same way: no file, no rename, the old index still there */
  const blocked = join(tmp(), 'blocked');
  await writeMaterialIndex(blocked, good);
  const blockedBefore = readFileSync(materialIndexPath(blocked), 'utf8');
  mkdirSync(`${materialIndexPath(blocked)}.tmp`);
  await assert.rejects(() => writeMaterialIndex(blocked, good));
  assert.equal(readFileSync(materialIndexPath(blocked), 'utf8'), blockedBefore, 'still the index that was there');
});

test('an absent or unparseable file reads as no index, never as an empty one', async () => {  assert.equal(readMaterialIndex(join(tmp(), 'absent')), null);

  const broken = join(tmp(), 'broken');
  await writeMaterialIndex(broken, { schema: 'orange/material-index-build/1', index: { batches: [] } });
  assert.equal(readMaterialIndex(broken)?.schema, 'orange/material-index-build/1');
  writeFileSync(materialIndexPath(broken), '{ not json');
  assert.equal(readMaterialIndex(broken), null, 'bytes that do not parse are not an index');

  assert.equal(defaultIndexDir({ home: join(tmp(), 'home') }).endsWith(join('.openfilm-dev', 'material-index')), true);
});

test('the CLI dry-run reads the feed, prints the four counts and the first three of each batch, and lands nothing', async () => {
  const dir = join(tmp(), 'target');
  const rows = [
    named('a', 1), named('b', 2), named('c', 3), named('d', 4),
    { videoId: 'z', name: '随便.mp4' },
  ];
  const { fetchPage, asks } = oneClass(1, rows);
  const lines = [];

  const result = await runMaterialIndexBuild({
    fetchPage, dryRun: true, pageSize: 2, dir, home: tmp(), out: (line) => lines.push(line),
  });

  assert.equal(result.dryRun, true);
  assert.deepEqual([...new Set(asks.map((ask) => ask.videoType))], [0, 1, 2, 3, 4], 'every class is asked once');
  assert.equal(asks.length, 7, 'two full pages and the last, not-full one in class 1; one page each elsewhere');
  assert.equal(lines[0], 'videos/parsed/unclassified/sourceTotal: 5/4/1/5');
  assert.equal(lines[1], '20261106 共 4 条: 20261106-柠檬宝藏茶200g罐-外包装 (1) (a) | 20261106-柠檬宝藏茶200g罐-外包装 (2) (b) | 20261106-柠檬宝藏茶200g罐-外包装 (3) (c)');
  assert.equal(lines.at(-1), `dry-run: 未落盘（目标 ${dir}）`);
  assert.equal(existsSync(join(dir, 'index.json')), false, 'dry-run writes nothing');
});

test('the CLI lands the index when it is not a dry run, and the counts come from the file it wrote', async () => {
  const dir = join(tmp(), 'landed');
  const { fetchPage } = oneClass(1, [named('a', 1), named('b', 2)]);
  const lines = [];
  const logged = [];

  const result = await runMaterialIndexBuild({
    fetchPage, pageSize: PAGE_SIZE, dir, out: (line) => lines.push(line), log: (line) => logged.push(line),
  });

  assert.equal(result.written.file, join(dir, 'index.json'));
  assert.equal(readMaterialIndex(dir).videos, 2);
  assert.match(lines[1], /^index: .*index\.json$/);
  assert.match(logged[0], /material-index: .*index\.json \(\d+ B\)$/);
});

test('the CLI reads the dev Studio\'s run.json, and says which file is missing instead of guessing', async () => {
  const home = tmp();
  assert.throws(() => readRunFile({ home: join(home, 'nope') }),
    (error) => /** @type {any} */ (error).code === 'run-file-missing');

  mkdirSync(join(home, '.openfilm-dev'), { recursive: true });
  writeFileSync(join(home, '.openfilm-dev', 'run.json'), JSON.stringify({ pid: 1, origin: 'http://127.0.0.1:4747', key: 'k' }));
  const run = readRunFile({ home });
  assert.deepEqual([run.origin, run.key], ['http://127.0.0.1:4747', 'k']);
  assert.match(run.file, /run\.json$/);
});

test('the CLI\'s flags are the ones it documents, and a page size past the supplier\'s bound is refused', () => {
  assert.deepEqual(parseArgs(['--dry-run', '--json', '--dir', 'D:\\work\\idx', '--page-size', '50']), {
    dryRun: true, json: true, help: false, dir: 'D:\\work\\idx', pageSize: 50,
    scope: 'company', videoTypes: [0, 1, 2, 3, 4],
  });
  assert.deepEqual(parseArgs(['--scope', 'own', '--video-types', '4,2,2']).videoTypes, [4, 2], 'a repeated class is asked once');
  assert.throws(() => parseArgs(['--page-size', '101']), /1-100/);
  assert.throws(() => parseArgs(['--scope', 'mine']), /--scope/);
  assert.throws(() => parseArgs(['--video-types', '5']), /--video-types/);
  assert.throws(() => parseArgs(['--nope']), /不认识的参数/);
  assert.deepEqual(
    summaryLines({ videos: 0, parsed: 0, unclassified: 0, sourceTotal: 0, warnings: [], index: { batches: [] } }),
    ['videos/parsed/unclassified/sourceTotal: 0/0/0/0'],
  );
});

test('a dry-run of one class asks only that class', async () => {
  const rows = [named('a', 1), named('b', 2)];
  const { fetchPage, asks } = pager(rows, rows.length);

  const result = await runMaterialIndexBuild({
    fetchPage, dryRun: true, pageSize: 10, dir: tmp(), home: tmp(), videoTypes: [4], out: () => {},
  });

  assert.deepEqual(asks.map((ask) => ask.videoType), [4]);
  assert.equal(result.videos, 2);
});

/* ── what the supplier claims vs what it will serve ──────────────────────────────────────────────────────────────────
 *
 * The real feed: `videoType 1` claims 179 831 and clamps at 28 900 rows (every page past 288 repeats the one before),
 * so 150 931 rows cannot be paged at all. That is not a duplicate and not a failure — it is `unreachable`, and it has
 * its own field so a reader never has to subtract two unrelated totals to find it.
 */

test('the claim and what is served are two numbers, and every gap between them has a name', async () => {
  /* one class claims 6, serves 2, then answers an empty page: 4 rows exist that no page will ever show */
  const fetchPage = async ({ pageNo }) => (pageNo === 1
    ? { items: [named('a', 1), named('b', 2)], total: 6 }
    : { items: [], total: 6 });

  const result = await buildMaterialIndexFromApi({ fetchPage, pageSize: 2, videoTypes: [1], throttleMs: 0, now: NOW });

  assert.equal(result.sourceTotal, 6, 'the supplier claims 6');
  assert.equal(result.pageable, 2, 'and served 2');
  assert.equal(result.unreachable, 4, 'so 4 are unreachable');
  assert.equal(result.videos, 2);
  assert.equal(result.duplicates, 0, 'nothing was served twice');
  assert.deepEqual(result.index.reach, { sourceTotal: 6, pageable: 2, unreachable: 4 }, 'the tree carries the same three numbers');

  const said = result.warnings.find((warning) => warning.code === 'unreachable');
  assert.ok(said, 'the gap is said out loud, not left to arithmetic');
  assert.deepEqual([said.sourceTotal, said.pageable, said.unreachable], [6, 2, 4]);

  /* the identity that makes the numbers auditable: claim = held + served-twice + unreachable */
  assert.equal(result.sourceTotal, result.parsed + result.unclassified + result.duplicates + result.unreachable);
});

test('each class is held to its own claim, so one clamped class cannot inflate another', async () => {
  const pages = {
    0: { 1: { items: [named('a', 1), named('b', 2), named('c', 3)], total: 3 } },
    1: { 1: { items: [named('d', 1), named('e', 2)], total: 10 }, 2: { items: [named('d', 1), named('e', 2)], total: 10 } },
  };
  const fetchPage = async ({ videoType, pageNo }) => pages[videoType]?.[pageNo] ?? { items: [], total: 0 };

  const result = await buildMaterialIndexFromApi({ fetchPage, pageSize: 2, videoTypes: [0, 1], throttleMs: 0, now: NOW });

  assert.deepEqual(result.pages.perType.map((type) => [type.videoType, type.rows, type.total, type.pageable]), [
    [0, 3, 3, 3], [1, 4, 10, 4],
  ]);
  assert.equal(result.sourceTotal, 13, '3 + 10');
  assert.equal(result.pageable, 7, '3 served in class 0, 4 in class 1 (the repeat page served them twice)');
  assert.equal(result.videos, 5);
  assert.equal(result.duplicates, 2, 'the repeated page is a duplicate, not new material');
  assert.equal(result.unreachable, 6, '10 − 4');
});

test('a clean sweep serves exactly what it claims, so nothing is unreachable and nothing is a duplicate', async () => {
  const rows = [named('a', 1), named('b', 2), named('c', 3)];
  const result = await buildMaterialIndexFromApi({ fetchPage: pager(rows, 3).fetchPage, pageSize: 2, videoTypes: [1], throttleMs: 0, now: NOW });
  assert.deepEqual([result.sourceTotal, result.pageable, result.unreachable, result.duplicates], [3, 3, 0, 0]);
  assert.equal(result.warnings.some((warning) => warning.code === 'unreachable'), false);
});

/* ── pacing and the supplier's 429 ────────────────────────────────────────────────────────────────────────────────────
 *
 * Measured: ≈144 list requests/minute earns a 429, and 500 ms between pages (≈108/minute) does not. Both are properties
 * of the sweep, not of a caller, so they live here and the pause is injected in tests.
 */

test('the sweep is paced between pages — never before the first one — and 0 turns the pace off', async () => {
  const rows = [named('a', 1), named('b', 2), named('c', 3)];
  const slept = [];
  const sleep = async (ms) => { slept.push(ms); };

  const paced = await collectMaterialRows({ fetchPage: pager(rows, 3).fetchPage, pageSize: 2, videoTypes: [1], sleep });
  assert.equal(paced.fetched, 2);
  assert.deepEqual(slept, [DEFAULT_THROTTLE_MS], 'one pause: before page 2, and none before page 1');
  assert.equal(DEFAULT_THROTTLE_MS, 500);

  const unpaced = [];
  await collectMaterialRows({
    fetchPage: pager(rows, 3).fetchPage, pageSize: 2, videoTypes: [1], throttleMs: 0, sleep: async (ms) => { unpaced.push(ms); },
  });
  assert.deepEqual(unpaced, [], 'a test or a local fixture does not wait');
});

test('a 429 is backed off and the same page asked again, not read as the end of the class', async () => {
  let attempts = 0;
  const slept = [];
  const fetchPage = async ({ pageNo }) => {
    if (pageNo === 1) {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('供应商限流'), { code: 'provider-rate-limited', status: 429 });
      return { items: [named('a', 1)], total: 1 };
    }
    return { items: [], total: 1 };
  };

  const result = await buildMaterialIndexFromApi({
    fetchPage, pageSize: 10, videoTypes: [1], throttleMs: 0, now: NOW, sleep: async (ms) => { slept.push(ms); },
  });

  assert.equal(attempts, 2, 'the page was asked twice');
  assert.deepEqual(slept, [backoffMs(1)], 'the first backoff');
  assert.equal(result.videos, 1);
  assert.equal(result.pages.backedOff, 1);
  assert.deepEqual(result.pages.perType.map((type) => type.stopped), ['short-page'], 'the class was read, not abandoned');
  const retried = result.warnings.find((warning) => warning.code === 'rate-limited');
  assert.deepEqual([retried.pageNo, retried.attempt, retried.waitMs], [1, 1, 1000]);
  assert.equal(result.warnings.some((warning) => warning.code === 'page-failed'), false);
});

test('a class that stays rate-limited stops after its retries, saying how many it spent', async () => {
  const slept = [];
  let asked = 0;
  const fetchPage = async () => { asked += 1; throw Object.assign(new Error('HTTP 429'), { status: 429 }); };

  const result = await buildMaterialIndexFromApi({
    fetchPage, pageSize: 10, videoTypes: [1], throttleMs: 0, maxRetries: 3, now: NOW, sleep: async (ms) => { slept.push(ms); },
  });

  assert.equal(asked, 4, 'the page plus three retries');
  assert.deepEqual(slept, [1000, 2000, 4000], 'exponential, in order');
  assert.deepEqual(result.pages.perType.map((type) => type.stopped), ['page-failed']);
  assert.equal(result.warnings.find((warning) => warning.code === 'page-failed').attempts, 4);
});

test('only a rate limit is retried; a 502 is a failure the first time', () => {
  assert.equal(isRateLimited({ status: 429 }), true);
  assert.equal(isRateLimited({ code: 'provider-rate-limited' }), true);
  assert.equal(isRateLimited(new Error('GET … → HTTP 429: 供应商限流')), true);
  assert.equal(isRateLimited(new Error('HTTP 502')), false);
  assert.equal(isRateLimited({ status: 500 }), false);
  assert.equal(isRateLimited(null), false);
  assert.deepEqual([1, 2, 3, 9].map(backoffMs), [1000, 2000, 4000, 16000], 'and it is held under a ceiling');
});

/* ── reading the index that is already on disk ───────────────────────────────────────────────────────────────────────
 *
 * `index.json` takes ~11 minutes to build and 7.7 MB to hold; a reader that rebuilt it on every open would be unusable
 * (and would earn a 429). So the file is read first, and `generatedAt` + `staleAfterMs` (24 h) decide when it is too old
 * to trust.
 */

test('a landed index is read from disk until it is past 24 h, and only then swept again', async () => {
  const dir = join(tmp(), 'cached');
  const rows = [named('a', 1), named('b', 2)];
  const landed = await buildMaterialIndexFromApi({ fetchPage: pager(rows, 2).fetchPage, pageSize: 10, videoTypes: [1], throttleMs: 0, now: NOW });
  await writeMaterialIndex(dir, landed);

  let builds = 0;
  const build = async () => { builds += 1; return buildMaterialIndexFromApi({ fetchPage: pager(rows, 2).fetchPage, pageSize: 10, videoTypes: [1], throttleMs: 0, now: new Date('2026-11-17T00:00:00Z') }); };

  const fresh = await loadMaterialIndex(dir, { now: new Date(NOW.getTime() + 60 * 60 * 1000), build });
  assert.equal(fresh.fromCache, true);
  assert.equal(fresh.reason, 'fresh');
  assert.equal(builds, 0, 'a one-hour-old index is read, not rebuilt');
  assert.equal(fresh.result.videos, 2);

  const stale = await loadMaterialIndex(dir, { now: new Date(NOW.getTime() + 25 * 60 * 60 * 1000), build });
  assert.equal(stale.fromCache, false);
  assert.equal(stale.reason, 'stale');
  assert.equal(builds, 1, 'past its window it is swept once');
  assert.equal(readMaterialIndex(dir).generatedAt, '2026-11-17T00:00:00.000Z', 'and the new one is landed');

  const forced = await loadMaterialIndex(dir, { now: new Date('2026-11-17T00:10:00Z'), force: true, build });
  assert.equal(forced.reason, 'forced');
  assert.equal(builds, 2, 'a person asking for a new index is not a cache miss');

  const missing = join(tmp(), 'nothing');
  await assert.rejects(() => loadMaterialIndex(missing, { now: NOW }),
    (error) => error.code === 'index-missing', 'nothing on disk and nothing to build is said, not invented');
  const built = await loadMaterialIndex(missing, { now: NOW, build });
  assert.deepEqual([built.reason, built.fromCache], ['missing', false]);
});

test('the freshness window is the file\'s own, overridable, and an index that cannot say its age is stale', () => {
  assert.equal(STALE_AFTER_MS, 24 * 60 * 60 * 1000);
  const at = '2026-11-16T00:00:00.000Z';
  const now = new Date('2026-11-16T12:00:00Z');
  assert.equal(indexAgeMs({ generatedAt: at }, now), 12 * 60 * 60 * 1000);
  assert.equal(indexAgeMs({}, now), null, 'no generatedAt: nothing is claimed about its age');
  assert.equal(isIndexStale({ generatedAt: at }, { now }), false);
  assert.equal(isIndexStale({ generatedAt: at }, { now: new Date('2026-11-17T00:00:00Z') }), true);
  assert.equal(isIndexStale({ generatedAt: at, staleAfterMs: 1000 }, { now: new Date('2026-11-16T00:00:02Z') }), true,
    'a file with its own short window is stale sooner');
  assert.equal(isIndexStale({ generatedAt: at }, { now, staleAfterMs: 60 * 60 * 1000 }), true, 'a caller may ask for a shorter one');
  assert.equal(isIndexStale({}, { now }), true, 'an index that cannot say when it was built is not fresh');
  assert.equal(isIndexStale({ generatedAt: at, staleAfterMs: STALE_AFTER_MS }, { now }), false,
    'the 24 h the writer recorded is what a reader uses');
});

/* ── the card fields: the harvest keeps what the supplier's card says ──────────────────────────────────────────────────
 *
 * The bug this pins was measured: with only 「批次 + 产品 + 分组 + 名称」 in the text, 「柠檬宝藏茶 外包装」 answered
 * 「墨红玫瑰-外包装」 at 0.9768 — `外包装` is a shared token and the classification that says *which* tea was dropped
 * before it ever reached the document.
 */

test('rowOf reads the supplier\'s labels / duration / author / cover / categories off the observation', () => {
  const row = rowOf({
    videoId: { value: '130113153', sourceType: 'number', source: '130113153' },
    observation: {
      name: '20261109-油弃乌龙茶-外包装 (24)',
      rawMd5: { sourceType: 'string', source: '' },
      accountName: '周佳',
      duration: { sourceType: 'number', source: '101' },
      coverUrl: 'https://example.test/c.png',
      oneLevelVideoType: { id: { sourceType: 'number', source: '98418' }, name: '花草养生茶' },
      twoLevelVideoType: { id: { sourceType: 'number', source: '305971' }, name: '一根人参茶' },
      videoLabels: [{ name: '首发素材' }, { name: '屈屈' }],
    },
  });

  assert.deepEqual(row, {
    videoId: '130113153',
    name: '20261109-油弃乌龙茶-外包装 (24)',
    md5: '',
    labels: ['首发素材', '屈屈'],
    durationMs: 101_000,
    author: '周佳',
    coverUrl: 'https://example.test/c.png',
    oneLevel: '花草养生茶',
    twoLevel: '一根人参茶',
  });

  /* The same row in this module's own plain shape: `durationMs` is already milliseconds and is not multiplied again. */
  assert.equal(rowOf({ videoId: 'v', name: 'n', durationMs: 23_400, labels: ['茶'] }).durationMs, 23_400);
});

test('a build counts how many entries carry each card field, so a field that stopped being read is visible', async () => {
  const rows = [
    {
      videoId: 'a',
      name: '20261106-柠檬宝藏茶200g罐-外包装 (46)',
      labels: ['首发素材'],
      duration: 23,
      accountName: '周佳',
      coverUrl: 'https://example.test/a.png',
      oneLevel: '花草养生茶',
      twoLevel: '柠檬宝藏茶200g罐',
    },
    { videoId: 'b', name: '20261106-柠檬宝藏茶200g罐-外包装 (6)', oneLevel: '花草养生茶' },
    { videoId: 'c', name: '别的名字.mp4' },
  ];
  const result = await buildMaterialIndexFromApi({
    fetchPage: async () => ({ items: rows, total: rows.length }), pageSize: 10, videoTypes: [1], throttleMs: 0, now: NOW,
  });

  assert.deepEqual(countMetadata(result.index), {
    entries: 3, labels: 1, duration: 1, author: 1, coverUrl: 1, oneLevel: 2, twoLevel: 1, category: 2,
  });

  const dir = join(tmp(), 'metadata');
  const written = await writeMaterialIndex(dir, result);
  assert.deepEqual(written.metadata, countMetadata(result.index), 'the writer reports the same coverage a reader can recount');
  assert.equal(readMaterialIndex(dir).index.unclassified[0].labels.length, 0, 'an entry with no labels still carries an empty list');
});

