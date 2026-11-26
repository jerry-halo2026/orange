// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * Bootstrapping the index: the three answers a launcher gets, and the files that say them.
 *
 * The states pinned here are the ones the start path has to produce on a real machine: no index at all (sweep, then
 * `landed`), one past its 24 h window (serve the old data, replace it atomically when the sweep succeeds), and a sweep
 * that throws (say why, serve nothing, block nothing). No network is involved: the page reader is a stub and the writer
 * is `writeMaterialIndex`, the real one — so the file the tests assert on is the file the app would read.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { STALE_AFTER_MS, buildMaterialIndexFromApi, readMaterialIndex, writeMaterialIndex } from './material-index-build.mjs';
import {
  BOOTSTRAP_SCHEMA, BUILDING_MARKER, INDEX_STATES, MARKER_EXPIRES_MS, STATUS_FILE, bootstrapMaterialIndex,
  bootstrapPaths, bootstrapStatusLines, claimBuild, materialIndexBootstrapPlan, materialIndexStatus, processAlive,
  readBuildingMarker, readBuildOutcome, releaseBuild, runBootstrapBuild,
} from './material-index-bootstrap.mjs';
import {
  parseArgs, runMaterialIndexBootstrap, studioBuildFactory, waitForStudio,
} from '../scripts/material-index-bootstrap.mjs';

/* The test's clock is the machine's, at load: a build records `generatedAt: now`, and the state a launcher reads after
   it (bootstrapMaterialIndex re-reads the file with the real clock) is `landed` only while the two agree. A date fixed
   in the source drifts past the 24 h window as the calendar moves on, and turns a just-written index into a stale one. */
const NOW = new Date();
const LATER = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
const LONG_AGO = new Date(NOW.getTime() - 36 * 60 * 60 * 1000);
const tmp = () => mkdtempSync(join(tmpdir(), 'material-index-bootstrap-'));

const named = (id, sequence = 1) => ({ videoId: id, name: `20261106-柠檬宝藏茶200g罐-外包装 (${sequence})` });

/** A real build result, from a stub page reader: one class, `rows` in one page. */
async function resultOf(rows, now = NOW) {
  return buildMaterialIndexFromApi({
    fetchPage: async ({ videoType, pageNo, pageSize }) => (videoType === 1
      ? { items: rows.slice((pageNo - 1) * pageSize, pageNo * pageSize), total: rows.length }
      : { items: [], total: 0 }),
    pageSize: 100, videoTypes: [1], throttleMs: 0, now,
  });
}

const buildOf = (rows, now = NOW) => async () => resultOf(rows, now);

/** A build that waits for the test to let it finish, so "does not block" can be observed from the outside. */
function gatedBuild(rows) {
  /** @type {() => void} */
  let release = () => {};
  /** @type {(error: Error) => void} */
  let fail = () => {};
  const gate = new Promise((done, nope) => { release = () => done(null); fail = (error) => nope(error); });
  let started = false;
  const build = async (/** @type {any} */ hooks) => {
    started = true;
    hooks?.onPage?.({ videoType: 1, pageNo: 2, rows: 100, fresh: 100, total: 3 });
    await gate;
    return resultOf(rows);
  };
  return { build, release, fail, started: () => started };
}

const statusFile = (dir) => JSON.parse(readFileSync(bootstrapPaths(dir).status, 'utf8'));

/* ── 1. 缺失 → 自动构建 → landed ──────────────────────────────────────────────────────────────────────────────── */

test('no index at all: a sweep runs, lands atomically, and the state becomes landed with the file\'s own numbers', async () => {
  const dir = join(tmp(), 'material-index');
  const absent = materialIndexStatus(dir, { now: NOW });
  assert.equal(absent.state, 'absent');
  assert.equal(absent.rebuilding, false);
  assert.deepEqual([...INDEX_STATES].includes(absent.state), true, 'only a documented state');
  assert.equal(materialIndexBootstrapPlan(dir, { now: NOW }).needed, true, 'a missing index is work to do');

  const rows = [named('a', 1), named('b', 2)];
  const outcome = await bootstrapMaterialIndex({
    dir, build: buildOf(rows), write: writeMaterialIndex, background: false, now: NOW,
  });

  assert.equal(outcome.action, 'built');
  assert.equal(outcome.state, 'landed');
  assert.equal(outcome.data.videos, 2, 'the caller is handed what landed, not a promise');
  assert.equal(outcome.failure, null);
  assert.equal(existsSync(bootstrapPaths(dir).marker), false, 'the claim is gone once the build is over');

  const landed = materialIndexStatus(dir, { now: NOW });
  assert.equal(landed.state, 'landed');
  assert.equal(landed.stale, false);
  assert.equal(landed.videos, 2);
  assert.equal(landed.rebuilding, false);
  assert.equal(landed.building, null);
  assert.equal(landed.generatedAt, NOW.toISOString());
  assert.deepEqual(landed.totals, { videos: 2, parsed: 2, unclassified: 0 });

  const recorded = statusFile(dir);
  assert.equal(recorded.schema, BOOTSTRAP_SCHEMA);
  assert.equal(recorded.outcome.state, 'landed');
  assert.equal(recorded.outcome.videos, 2);
  assert.equal(recorded.outcome.reason, 'missing');
  assert.equal(materialIndexBootstrapPlan(dir, { now: NOW }).needed, false, 'a landed index inside its window is not rebuilt');
});

test('a launcher does not wait for the sweep: the call returns while the build is still running, saying building', async () => {
  const dir = join(tmp(), 'material-index');
  const gate = gatedBuild([named('a', 1), named('b', 2)]);

  const started = Date.now();
  const outcome = await bootstrapMaterialIndex({
    dir, build: gate.build, write: writeMaterialIndex, background: true, now: NOW,
  });
  const tookMs = Date.now() - started;

  assert.equal(outcome.action, 'building');
  assert.equal(outcome.state, 'building', 'nothing to serve yet, and that is the state');
  assert.equal(outcome.data, null);
  assert.ok(tookMs < 1000, `returned in ${tookMs}ms, with the sweep still out`);
  assert.equal(existsSync(bootstrapPaths(dir).marker), true, 'the claim file is what a reader sees building by');

  const during = materialIndexStatus(dir, { now: NOW });
  assert.equal(during.state, 'building');
  assert.equal(during.rebuilding, true);
  assert.equal(during.building?.reason, 'missing');
  assert.equal(during.building?.progress?.pageNo, 2, 'the last page the sweep reported is in the status');
  assert.equal(statusFile(dir).outcome.state, 'building');

  gate.release();
  const finished = await outcome.rebuild;
  assert.equal(finished.ok, true);

  const after = materialIndexStatus(dir, { now: NOW });
  assert.equal(after.state, 'landed');
  assert.equal(after.videos, 2);
  assert.equal(after.rebuilding, false);
});

/* ── 2. 过期 → 先用旧数据，重建成功才替换 ─────────────────────────────────────────────────────────────────────── */

test('a stale index is served as it is, rebuilt behind it, and only replaced by the atomic rename that succeeds', async () => {
  const dir = join(tmp(), 'material-index');
  const old = await resultOf([named('a', 1), named('b', 2)], LONG_AGO);
  await writeMaterialIndex(dir, old);
  const before = readFileSync(bootstrapPaths(dir).file, 'utf8');

  const stale = materialIndexStatus(dir, { now: NOW });
  assert.equal(stale.state, 'stale', 'past generatedAt + staleAfterMs');
  assert.equal(stale.stale, true);
  assert.equal(stale.videos, 2);
  assert.ok((stale.ageMs ?? 0) >= STALE_AFTER_MS, `age ${stale.ageMs} is past the 24 h window`);
  assert.equal(materialIndexBootstrapPlan(dir, { now: NOW }).needed, true, 'stale is work to do');

  const gate = gatedBuild([named('a', 1), named('b', 2), named('c', 3)]);
  const outcome = await bootstrapMaterialIndex({
    dir, build: gate.build, write: writeMaterialIndex, background: true, now: NOW,
  });

  assert.equal(outcome.action, 'building');
  assert.equal(outcome.state, 'stale', 'the state stays stale while the old data is what a reader gets');
  assert.equal(outcome.data?.videos, 2, 'the old data is handed over first');
  assert.equal(outcome.reason, 'stale');
  assert.equal(readMaterialIndex(dir)?.videos, 2, 'and it is still on disk untouched while the sweep runs');
  assert.equal(readFileSync(bootstrapPaths(dir).file, 'utf8'), before, 'byte for byte, until the rename');

  const during = materialIndexStatus(dir, { now: NOW });
  assert.equal(during.state, 'stale');
  assert.equal(during.rebuilding, true, 'served and rebuilt at once');

  gate.release();
  const finished = await outcome.rebuild;
  assert.equal(finished.ok, true);

  const after = materialIndexStatus(dir, { now: NOW });
  assert.equal(after.state, 'landed', 'the replacement is the switch');
  assert.equal(after.videos, 3);
  assert.equal(after.generatedAt, NOW.toISOString());
  assert.equal(after.rebuilding, false);
  assert.equal(readMaterialIndex(dir)?.videos, 3);
});

test('a stale index is not rebuilt twice: a live claim makes the second launcher wait, not sweep', async () => {
  const dir = join(tmp(), 'material-index');
  await writeMaterialIndex(dir, await resultOf([named('a', 1)], LONG_AGO));

  const holder = { pid: 4242, now: NOW, pidAlive: () => true, reason: 'stale' };
  const claim = claimBuild(dir, holder);
  assert.equal(claim.claimed, true);

  const marker = readBuildingMarker(dir, { now: NOW, pidAlive: () => true });
  assert.equal(marker?.live, true);

  const status = materialIndexStatus(dir, { now: NOW, pidAlive: () => true });
  assert.equal(status.state, 'stale');
  assert.equal(status.rebuilding, true);
  assert.equal(status.building?.pid, 4242);

  const plan = materialIndexBootstrapPlan(dir, { now: NOW, pidAlive: () => true, status });
  assert.deepEqual([plan.needed, plan.reason], [false, 'busy'], 'someone else already owns the sweep');

  const second = claimBuild(dir, { ...holder, pid: 5151 });
  assert.deepEqual([second.claimed, second.holder?.pid], [false, 4242], 'the slot is not taken over from a live build');

  /* and a sweep asked for anyway is refused, not duplicated */
  const outcome = await bootstrapMaterialIndex({
    dir, build: async () => { throw new Error('must not run'); }, write: writeMaterialIndex,
    background: false, now: NOW, pidAlive: () => true,
  });
  assert.equal(outcome.action, 'none');
  assert.equal(outcome.reason, 'busy');
});

test('a claim whose process is gone — or one older than any sweep — is reclaimed instead of blocking every launch', async () => {
  const dir = join(tmp(), 'material-index');
  mkdirSync(dir, { recursive: true });
  writeFileSync(bootstrapPaths(dir).marker, JSON.stringify({ state: 'building', pid: 999_999, startedAt: LONG_AGO.toISOString(), reason: 'missing' }), 'utf8');
  assert.equal(readBuildingMarker(dir, { now: NOW, pidAlive: () => false })?.live, false);

  const reclaimed = claimBuild(dir, { now: NOW, pid: 777, pidAlive: () => false });
  assert.equal(reclaimed.claimed, true);
  assert.equal(reclaimed.reclaimed, true);
  assert.equal(readBuildingMarker(dir, { now: NOW, pidAlive: () => false })?.pid, 777);

  /* a live pid is not enough on its own: a claim 30 minutes old is a build nobody is still running */
  writeFileSync(bootstrapPaths(dir).marker, JSON.stringify({ state: 'building', pid: 778, startedAt: LONG_AGO.toISOString() }), 'utf8');
  const aged = readBuildingMarker(dir, { now: NOW, pidAlive: () => true });
  assert.equal(aged?.alive, true);
  assert.equal(aged?.expired, true);
  assert.equal(aged?.live, false);
  assert.ok((aged?.ageMs ?? 0) >= MARKER_EXPIRES_MS);

  releaseBuild(dir);
  assert.equal(existsSync(bootstrapPaths(dir).marker), false);
  assert.equal(processAlive(process.pid), true, 'this process is the one running the test');
  assert.equal(processAlive(0), false);
});

/* ── 3. 构建失败 → 写 warnings、说原因、不阻塞 ───────────────────────────────────────────────────────────────── */

test('a sweep that throws leaves the reason and its warnings in status.json, serves nothing, and never throws at the caller', async () => {
  const dir = join(tmp(), 'material-index');
  const boom = Object.assign(new Error('供应商连续 429，退避 4 次后仍失败'), { code: 'provider-rate-limited' });

  const outcome = await bootstrapMaterialIndex({
    dir, build: async () => { throw boom; }, write: writeMaterialIndex, background: false, now: NOW,
  });

  assert.equal(outcome.action, 'failed');
  assert.equal(outcome.failure?.code, 'provider-rate-limited');
  assert.equal(outcome.data, null, 'no index is invented');
  assert.equal(existsSync(bootstrapPaths(dir).file), false);
  assert.equal(existsSync(bootstrapPaths(dir).marker), false, 'a failed build does not keep the slot');

  const failed = materialIndexStatus(dir, { now: NOW });
  assert.equal(failed.state, 'failed');
  assert.match(failed.failed?.message ?? '', /429/);
  assert.equal(failed.failed?.warnings.at(-1)?.code, 'build-failed');
  assert.deepEqual(bootstrapStatusLines(failed).some((line) => /429/.test(line)), true, 'the view has a sentence with the reason in it');
});

test('a write that refuses the bytes keeps the old index readable, and its warnings say both what the sweep saw and what failed', async () => {
  const dir = join(tmp(), 'material-index');
  await writeMaterialIndex(dir, await resultOf([named('a', 1), named('b', 2)], LONG_AGO));
  const before = readFileSync(bootstrapPaths(dir).file, 'utf8');

  const write = async () => { throw Object.assign(new Error('素材索引自校验失败'), { code: 'index-verify-failed' }); };
  const outcome = await bootstrapMaterialIndex({
    dir, build: buildOf([named('a', 1), named('b', 2), named('c', 3)]), write, background: false, now: NOW,
  });

  assert.equal(outcome.action, 'failed');
  assert.equal(readFileSync(bootstrapPaths(dir).file, 'utf8'), before, 'the old index is untouched by a failed replace');
  assert.equal(readMaterialIndex(dir)?.videos, 2);

  const after = materialIndexStatus(dir, { now: NOW });
  assert.equal(after.state, 'stale', 'what a reader gets is still the old data, and it is marked stale');
  assert.equal(after.failed?.code, 'index-verify-failed');
  assert.equal(after.rebuilding, false);
  assert.deepEqual(after.failed?.warnings.map((warning) => warning.code), ['build-failed'], 'the failure is an entry, not a silence');
});

test('the build\'s own warnings travel into the landed record, so the failure and the successful build are read the same way', async () => {
  const dir = join(tmp(), 'material-index');
  const outcome = await runBootstrapBuild({
    dir, now: NOW,
    build: async () => ({
      ...(await resultOf([named('a', 1)])),
      warnings: [{ code: 'unreachable', message: '供应商声称 230030 条，实际只能翻到 79099 条：150931 条不可达' }],
    }),
    write: writeMaterialIndex,
  });
  assert.equal(outcome.ok, true);
  assert.deepEqual(readBuildOutcome(dir)?.warnings.map((warning) => warning.code), ['unreachable']);
  assert.match(bootstrapStatusLines(materialIndexStatus(dir, { now: NOW })).join('\n'), /150931/);
});

test('a background failure does not block the launch, and does not become an unhandled rejection either', async () => {
  const dir = join(tmp(), 'material-index');
  const started = Date.now();
  const outcome = await bootstrapMaterialIndex({
    dir, build: async () => { throw new Error('run.json 不在'); }, write: writeMaterialIndex, background: true, now: NOW,
  });
  assert.ok(Date.now() - started < 1000, 'the launcher returned at once');
  assert.equal(outcome.action, 'building');
  const small = await outcome.rebuild;
  assert.equal(small.ok, false);
  assert.equal(materialIndexStatus(dir, { now: NOW }).state, 'failed');
  assert.match(statusFile(dir).outcome.message, /run\.json/);
});

/* ── 4. the status contract, and the CLI that drives it ─────────────────────────────────────────────────────── */

test('the status is a plain JSON contract: schema, state one of five, and the fields the view prints', async () => {
  const dir = join(tmp(), 'material-index');
  const status = materialIndexStatus(dir, { now: NOW });
  assert.deepEqual(Object.keys(status).sort(), [
    'ageMs', 'building', 'checkedAt', 'dir', 'failed', 'file', 'generatedAt', 'rebuilding', 'schema', 'stale',
    'staleAfterMs', 'state', 'totals', 'videos', 'warnings',
  ]);
  assert.equal(status.schema, BOOTSTRAP_SCHEMA);
  assert.equal(status.file, join(dir, 'index.json'));
  assert.equal(status.state, 'absent');
});

test('the CLI reads the state, sweeps when told to, and exits 1 with the reason when a sweep fails', async () => {
  const dir = join(tmp(), 'cli');
  const lines = [];
  const errors = [];
  const rows = [named('a', 1), named('b', 2)];
  /* The page reader the real CLI would take from the Studio, stubbed: one class with rows, the rest empty. */
  const fetchPage = async ({ videoType, pageNo, pageSize }) => (videoType === 1
    ? { items: rows.slice((pageNo - 1) * pageSize, pageNo * pageSize), total: rows.length }
    : { items: [], total: 0 });

  const statusCode = await runMaterialIndexBootstrap({
    argv: ['--status'], dir, out: (line) => lines.push(line), log: (line) => errors.push(line), now: NOW,
  });
  assert.equal(statusCode, 0, 'a status read is never a failure');
  assert.equal(lines[0], 'state: absent');
  assert.match(lines[1], /没有素材索引（absent）/);

  const buildCode = await runMaterialIndexBootstrap({
    argv: ['--wait', '--dir', dir, '--throttle-ms', '0'], home: tmp(), fetchPage, write: writeMaterialIndex,
    out: (line) => lines.push(line), log: (line) => errors.push(line), now: NOW,
  });
  assert.equal(buildCode, 0);
  assert.equal(readMaterialIndex(dir)?.videos, 2);
  assert.match(lines.join('\n'), /状态: |素材索引已就绪（landed）/);

  const fresh = await runMaterialIndexBootstrap({
    argv: ['--status', '--json'], dir, out: (line) => lines.push(line), now: NOW,
  });
  assert.equal(fresh, 0);
  const printed = JSON.parse(lines.at(-1) ?? '{}');
  assert.equal(printed.state, 'landed');
  assert.equal(printed.videos, 2);

  /* a sweep that fails: exit 1, the reason on stderr, nothing landed over the old file */
  const failing = await runMaterialIndexBootstrap({
    argv: ['--wait', '--dir', dir, '--force'],
    build: async () => { throw Object.assign(new Error('供应商 429'), { code: 'provider-rate-limited' }); },
    write: writeMaterialIndex, out: (line) => lines.push(line), log: (line) => errors.push(line), now: NOW,
  });
  assert.equal(failing, 1);
  assert.match(errors.join('\n'), /构建失败（provider-rate-limited）：供应商 429/);
  assert.equal(readMaterialIndex(dir)?.videos, 2, 'the index that was there is still the index');
});

test('--detach spawns one detached sweep and returns at once; with a fresh index it spawns nothing', async () => {
  const dir = join(tmp(), 'detach');
  /** @type {any[]} */
  const spawns = [];
  const spawnFn = (/** @type {string} */ command, /** @type {string[]} */ args, /** @type {any} */ options) => {
    spawns.push({ command, args, options });
    return { pid: 4321, on: () => {}, unref: () => {} };
  };
  const errors = [];

  const code = await runMaterialIndexBootstrap({
    argv: ['--detach', '--dir', dir], spawnFn, execPath: 'node.exe', script: 'bootstrap.mjs',
    log: (line) => errors.push(line), now: NOW,
  });
  assert.equal(code, 0, 'the launcher is not held up');
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args.slice(0, 4), ['bootstrap.mjs', '--wait', '--dir', dir]);
  assert.equal(spawns[0].options.detached, true);
  assert.equal(spawns[0].options.stdio, 'ignore');
  assert.match(errors[0], /已派生后台构建（missing/);

  await writeMaterialIndex(dir, await resultOf([named('a', 1)]));
  const again = await runMaterialIndexBootstrap({ argv: ['--detach', '--dir', dir], spawnFn, log: () => {}, now: NOW });
  assert.equal(again, 0);
  assert.equal(spawns.length, 1, 'a fresh index starts no sweep at all');
});

test('the CLI\'s flags are the ones it documents, and a flag it does not know is refused', () => {
  assert.deepEqual(parseArgs([]), {
    mode: 'status', force: false, json: false, quiet: false, help: false, dir: null, studioTimeoutMs: 120_000, throttleMs: 500,
  });
  assert.equal(parseArgs(['--detach']).mode, 'detach');
  assert.equal(parseArgs(['--wait', '--force']).force, true);
  assert.equal(parseArgs(['--status', '--json', '--dir', 'D:\\work\\idx']).dir, 'D:\\work\\idx');
  assert.throws(() => parseArgs(['--dir']), /需要一个目录/);
  assert.throws(() => parseArgs(['--studio-timeout', 'soon']), /毫秒数/);
  assert.throws(() => parseArgs(['--nope']), /不认识的参数/);
});

test('a foreground sweep waits for the Studio\'s run.json to appear instead of failing on the first read', async () => {
  const home = tmp();
  mkdirSync(join(home, '.orangefilm-dev'), { recursive: true });
  const file = join(home, '.orangefilm-dev', 'run.json');
  let clock = 0;
  const sleep = async (ms) => { clock += ms; if (clock >= 1000) writeFileSync(file, JSON.stringify({ pid: 1, origin: 'http://127.0.0.1:4848', key: 'k' }), 'utf8'); };

  const run = await waitForStudio({ home, timeoutMs: 5000, pollMs: 500, sleep, now: () => clock });
  assert.deepEqual([run.origin, run.key], ['http://127.0.0.1:4848', 'k'], 'the second read found it');

  await assert.rejects(
    () => waitForStudio({ home: join(home, 'nowhere'), timeoutMs: 1000, pollMs: 500, sleep, now: () => clock }),
    (error) => /** @type {any} */ (error).code === 'studio-not-ready',
  );
});

test('the build factory hands the sweep\'s page reports to the progress file and its result to the writer', async () => {
  const dir = join(tmp(), 'factory');
  const rows = [named('a', 1), named('b', 2)];
  const fetchPage = async ({ videoType, pageNo, pageSize }) => (videoType === 1
    ? { items: rows.slice((pageNo - 1) * pageSize, pageNo * pageSize), total: rows.length }
    : { items: [], total: 0 });
  const pages = [];
  const build = studioBuildFactory({ fetchPage, throttleMs: 0 });
  const result = await build({ onPage: (page) => pages.push(page) });
  assert.equal(result.videos, 2);
  assert.deepEqual(pages.map((page) => page.pageNo), [1], 'one page of rows, and it was reported');

  const outcome = await runBootstrapBuild({ dir, build: studioBuildFactory({ fetchPage, throttleMs: 0 }), write: writeMaterialIndex, now: NOW });
  assert.equal(outcome.ok, true);
  assert.equal(readMaterialIndex(dir)?.videos, 2);
  assert.equal(readBuildOutcome(dir)?.state, 'landed');
});
