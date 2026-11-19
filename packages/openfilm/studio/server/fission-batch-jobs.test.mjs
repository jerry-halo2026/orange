// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// 批次注册表是"人能关窗再回来、agent 能跨轮接着问"的那块。启动即返回、进度落文件、只重出失败项。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { batchFile, batchProgress, listBatches, readBatch, retryBatch, startBatch } from './fission-batch-jobs.mjs';

function fixture() {
  const project = mkdtempSync(join(tmpdir(), 'batch-jobs-'));
  const assets = join(project, 'assets');
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, '包装 (m1).mp4'), 'stub');
  writeFileSync(join(assets, 'voice-S1.mp3'), 'stub');
  const plan = (id) => ({
    id,
    spec: { width: 1080, height: 1920, fps: 30 },
    segments: [{ id: 'S1', kind: 'speech', text: '一句话', audioSec: 2, voice: { file: join(assets, 'voice-S1.mp3') } }],
    shots: [{ segmentId: 'S1', mediaId: 'm1', startSec: 0, endSec: 2.2, speed: 1, shownSec: 2.15 }],
    bgm: null,
    elements: { transitions: [], stickers: [], text: [] },
  });
  return { project, assets, plan, enginePaths: { OutRoot: join(project, 'out'), TransitionsDir: join(project, 't') }, workRoot: join(project, '.film', 'fission', 'work') };
}

const fakeRun = (failIds = []) => async ({ root }) => {
  const id = String(root).split(/[\\/]/).pop();
  if (failIds.includes(id)) return { code: 1, files: [], message: '渲染失败（测试）' };
  const dir = join(root, 'workspace', 't1', 'a1', 'out', 'job1');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'ok.mp4');
  writeFileSync(file, 'r');
  return { code: 0, files: [file], message: '完成' };
};

const waitFor = async (project, id, predicate, timeoutMs = 3000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const batch = readBatch(project, id);
    if (batch && predicate(batch)) return batch;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('等不到批次状态');
};

test('startBatch：立刻返回 batchId，进度与结果落文件', async () => {
  const { project, assets, plan, enginePaths, workRoot } = fixture();
  const { batch } = startBatch({
    project, plans: [plan('p1'), plan('p2')], enginePaths, assetsRoot: assets, workRoot, run: fakeRun(),
  });
  assert.equal(batch.state, 'running');
  assert.ok(existsSync(batchFile(project, batch.id)), '状态文件已写');
  const done = await waitFor(project, batch.id, (state) => state.state !== 'running');
  assert.equal(done.ok, 2);
  assert.equal(done.state, 'completed');
  assert.match(done.verdict, /2 条全部完成/);
  assert.deepEqual(readdirSync(join(project, '.film', 'fission', 'out')).sort(), ['p1.mp4', 'p2.mp4']);
});

test('进度人话：跑到哪一条、完成几条、失败几条', async () => {
  const { project, assets, plan, enginePaths, workRoot } = fixture();
  const { batch } = startBatch({
    project, plans: [plan('p1')], enginePaths, assetsRoot: assets, workRoot, run: fakeRun(),
  });
  const done = await waitFor(project, batch.id, (state) => state.state !== 'running');
  assert.match(batchProgress(done), /1\/1 · 完成 1 · 失败 0/);
});

test('失败项留在结果里，retryBatch 只重跑它们', async () => {
  const { project, assets, plan, enginePaths, workRoot } = fixture();
  const first = startBatch({
    project, plans: [plan('p1'), plan('p2')], enginePaths, assetsRoot: assets, workRoot, run: fakeRun(['p2']),
  }).batch;
  const finished = await waitFor(project, first.id, (state) => state.state !== 'running');
  assert.equal(finished.failed, 1);
  assert.equal(finished.state, 'completed-with-failures');

  const retried = retryBatch({
    project, batchId: first.id, plans: [plan('p1'), plan('p2')], enginePaths, assetsRoot: assets, workRoot, run: fakeRun(),
  });
  assert.equal(retried.retried, 1, '只重出失败的那一条');
  const second = await waitFor(project, retried.batch.id, (state) => state.state !== 'running');
  assert.equal(second.ok, 1);
  assert.deepEqual(second.plans, ['p2']);
});

test('同一个 batchId 还在跑时再启动：返回原批次，不重开一个', async () => {
  const { project, assets, plan, enginePaths, workRoot } = fixture();
  const runner = async () => { await new Promise((resolve) => setTimeout(resolve, 80)); return { code: 1, files: [], message: '慢失败' }; };
  const first = startBatch({ project, plans: [plan('p1')], enginePaths, assetsRoot: assets, workRoot, run: runner, batchId: 'fixed' }).batch;
  const again = startBatch({ project, plans: [plan('p1')], enginePaths, assetsRoot: assets, workRoot, run: runner, batchId: 'fixed' }).batch;
  assert.equal(first.id, again.id);
  await waitFor(project, 'fixed', (state) => state.state !== 'running');
});

test('listBatches：新的在前；没有批次时是空数组', () => {
  const { project, assets, plan, enginePaths, workRoot } = fixture();
  assert.deepEqual(listBatches(project), []);
  startBatch({ project, plans: [plan('p1')], enginePaths, assetsRoot: assets, workRoot, run: fakeRun() });
  assert.equal(listBatches(project).length, 1);
});
