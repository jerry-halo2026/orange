// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// 批量渲染的坑都在"并发、续跑、只重跑坏的"这三件事上。用假 runner 把每条路径钉住。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { batchVerdict, buildBatch, retryTasks, runBatch } from './fission-batch.mjs';

/** 一个工程 + 两份 plan（各一句台词、一条素材、一段配音）。 */
function fixture() {
  const project = mkdtempSync(join(tmpdir(), 'batch-'));
  const assets = join(project, 'assets');
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, '包装_93 (m1).mp4'), 'stub');
  writeFileSync(join(assets, 'voice-S1.mp3'), 'stub');
  const plan = (id) => ({
    id,
    spec: { width: 1080, height: 1920, fps: 30 },
    segments: [{ id: 'S1', kind: 'speech', text: '一句话', audioSec: 2, voice: { file: join(assets, 'voice-S1.mp3') } }],
    shots: [{ segmentId: 'S1', mediaId: 'm1', startSec: 0, endSec: 2.2, speed: 1, shownSec: 2.15 }],
    bgm: null,
    elements: { transitions: [], stickers: [], text: [] },
  });
  const enginePaths = { OutRoot: join(project, 'out'), TransitionsDir: join(project, 'transitions') };
  return { project, assets, plan, enginePaths, workRoot: join(project, '.film', 'fission', 'work') };
}

test('buildBatch：每条 plan 一个任务；缺素材的那条不排队但要说原因', () => {
  const { project, assets, plan, enginePaths, workRoot } = fixture();
  const broken = plan('p-broken');
  broken.shots[0].mediaId = 'missing-id';
  const { tasks, problems } = buildBatch(
    [{ plan: plan('p1') }, { plan: plan('p2') }, { plan: broken }],
    { project, assetsRoot: assets, workRoot, enginePaths },
  );
  assert.equal(tasks.length, 3);
  assert.equal(tasks.filter((task) => task.usable).length, 2);
  assert.ok(problems.some((line) => line.includes('missing-id')));
});

test('runBatch：全部成功时把产物收到 out/<planId>.mp4', async () => {
  const { project, assets, plan, enginePaths, workRoot } = fixture();
  const { tasks } = buildBatch([{ plan: plan('p1') }, { plan: plan('p2') }], { project, assetsRoot: assets, workRoot, enginePaths });
  /** 假 runner：写一个产物文件就返回 */
  const run = async ({ job, root }) => {
    const dir = join(root, 'workspace', 't1', 'a1', 'out', 'job1');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, '01_S1.mp4');
    writeFileSync(file, 'rendered');
    return { code: 0, files: [file], message: '完成' };
  };
  const summary = await runBatch({ tasks, project, enginePaths, run, concurrency: 2 });
  assert.equal(summary.ok, 2);
  assert.equal(summary.failed, 0);
  const out = readdirSync(join(project, '.film', 'fission', 'out')).sort();
  assert.deepEqual(out, ['p1.mp4', 'p2.mp4']);
});

test('runBatch：并发有上限（同时最多 2 个在跑）', async () => {
  const { project, assets, plan, enginePaths, workRoot } = fixture();
  const plans = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ plan: plan(`p-${id}`) }));
  const { tasks } = buildBatch(plans, { project, assetsRoot: assets, workRoot, enginePaths });
  let active = 0;
  let peak = 0;
  const run = async ({ job, root }) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active -= 1;
    const dir = join(root, 'workspace', 't1', 'a1', 'out', 'job1');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'x.mp4');
    writeFileSync(file, 'r');
    return { code: 0, files: [file], message: '完成' };
  };
  const summary = await runBatch({ tasks, project, enginePaths, run, concurrency: 2 });
  assert.equal(summary.ok, 5);
  assert.ok(peak <= 2, `峰值并发 ${peak}`);
});

test('runBatch：已有产物就跳过（续跑不重做）', async () => {
  const { project, assets, plan, enginePaths, workRoot } = fixture();
  const { tasks } = buildBatch([{ plan: plan('p1') }], { project, assetsRoot: assets, workRoot, enginePaths });
  mkdirSync(join(project, '.film', 'fission', 'out'), { recursive: true });
  writeFileSync(join(project, '.film', 'fission', 'out', 'p1.mp4'), 'x'.repeat(2048));
  let called = 0;
  const summary = await runBatch({ tasks, project, enginePaths, run: async () => { called += 1; return { code: 0, files: [], message: '' }; } });
  assert.equal(called, 0, '不该再跑一次');
  assert.equal(summary.skipped, 1);
  assert.equal(summary.ok, 1);
});

test('runBatch：失败如实记在失败项上，并给一句人话', async () => {
  const { project, assets, plan, enginePaths, workRoot } = fixture();
  const { tasks } = buildBatch([{ plan: plan('p1') }, { plan: plan('p2') }], { project, assetsRoot: assets, workRoot, enginePaths });
  const run = async ({ root }) => {
    if (root.includes('p1')) return { code: 1, files: [], message: '找不到 ffmpeg：app 自带的那份没下下来' };
    const dir = join(root, 'workspace', 't1', 'a1', 'out', 'job1');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'ok.mp4');
    writeFileSync(file, 'r');
    return { code: 0, files: [file], message: '完成' };
  };
  const summary = await runBatch({ tasks, project, enginePaths, run, concurrency: 1 });
  assert.equal(summary.ok, 1);
  assert.equal(summary.failed, 1);
  assert.match(batchVerdict(summary), /1 条完成、1 条失败.*找不到 ffmpeg/);
  assert.ok(existsSync(join(project, '.film', 'fission', 'out', 'p2.mp4')));
});

test('retryTasks：只挑出要重出的那几条（失败的、改了文案的）', async () => {
  const { project, assets, plan, enginePaths, workRoot } = fixture();
  const { tasks } = buildBatch(['a', 'b', 'c'].map((id) => ({ plan: plan(`p-${id}`) })), { project, assetsRoot: assets, workRoot, enginePaths });
  const retry = retryTasks(tasks, ['p-b']);
  assert.deepEqual(retry.map((task) => task.planId), ['p-b']);
});
