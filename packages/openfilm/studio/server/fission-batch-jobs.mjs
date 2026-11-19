// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * 批次的"作业注册表"：agent 与人都通过它启动、看进度、重出失败项。
 *
 * # 为什么要有这一层
 *
 * 渲染一批 100 条要几分钟。如果每次都同步等，agent 的 tools/call 会被超时打断、界面也没法显示进度。
 * 所以：**启动就返回 batchId，进度写进文件**（`<project>/.film/fission/batches/<id>.json`）。
 *
 * 写文件而不是只放内存，有两个实在的好处：
 * - 人关掉窗口再打开，进度还在（界面只是读这个文件）；
 * - agent 一轮调用启动、下一轮带着 `batchId` 来问，跨轮也能接上。
 *
 * # 并发与续跑
 *
 * 并发由 `runBatch` 控制（默认 2）；产物已存在的跳过。所以"再跑一次同一个 batchId"是安全的。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildBatch, batchVerdict, runBatch } from './fission-batch.mjs';

/** 批次状态目录。 @param {string} project */
export const batchesDir = (project) => join(project, '.film', 'fission', 'batches');

/** 一个 batch 的状态文件。 @param {string} project @param {string} batchId */
export const batchFile = (project, batchId) => join(batchesDir(project), `${batchId}.json`);

const stamp = () => new Date().toISOString();

/**
 * 读一个批次的状态；没有就是 null。
 * @param {string} project @param {string} batchId
 */
export function readBatch(project, batchId) {
  try {
    return JSON.parse(readFileSync(batchFile(project, batchId), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 列出工程里所有批次（新的在前）。
 * @param {string} project
 */
export function listBatches(project) {
  const dir = batchesDir(project);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readBatch(project, name.slice(0, -5)))
    .filter(Boolean)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

/**
 * 启动一个批次。**立刻返回**，渲染在后台继续。
 *
 * @param {{ project: string, plans: any[], enginePaths: Record<string, string>, assetsRoot: string,
 *   workRoot: string, concurrency?: number, batchId?: string,
 *   run?: (input: any) => Promise<any> }} options
 * @returns {{ batch: any }}
 */
export function startBatch({ project, plans, enginePaths, assetsRoot, workRoot, concurrency = 2, batchId, run }) {
  const id = String(batchId ?? `b${Date.now().toString(36)}`);
  const existing = readBatch(project, id);
  if (existing && existing.state === 'running') return { batch: existing };

  const { tasks, problems } = buildBatch(plans.map((plan) => ({ plan })), { project, assetsRoot, workRoot, enginePaths });
  const outDir = join(project, '.film', 'fission', 'out');
  /** @type {any} */
  const batch = {
    id,
    state: 'running',
    startedAt: stamp(),
    finishedAt: null,
    total: tasks.length,
    done: 0,
    ok: 0,
    failed: 0,
    skipped: 0,
    concurrency,
    outDir,
    plans: tasks.map((task) => task.planId),
    problems,
    events: [],
    results: [],
    verdict: '',
  };
  mkdirSync(batchesDir(project), { recursive: true });
  const save = () => writeFileSync(batchFile(project, id), JSON.stringify(batch, null, 1), 'utf8');
  save();

  /* 后台跑：不 await，调用方立刻拿到 batchId */
  void (async () => {
    try {
      const summary = await runBatch({
        tasks,
        project,
        enginePaths,
        concurrency,
        ...(run ? { run } : {}),
        outDir,
        onEvent: (event) => {
          batch.done = event.done;
          batch.events.push({ at: stamp(), planId: event.planId, ok: event.ok, message: event.message });
          if (batch.events.length > 500) batch.events.splice(0, batch.events.length - 500);
          save();
        },
      });
      batch.ok = summary.ok;
      batch.failed = summary.failed;
      batch.skipped = summary.skipped;
      batch.results = summary.results;
      batch.state = summary.failed ? 'completed-with-failures' : 'completed';
      batch.verdict = batchVerdict(summary);
    } catch (error) {
      batch.state = 'failed';
      batch.verdict = `批次崩了：${String(error?.message ?? error)}`;
    } finally {
      batch.finishedAt = stamp();
      save();
    }
  })();

  return { batch };
}

/**
 * 只重出失败的那些（人点"只重出失败的"、agent 说"再试一次"都走这里）。
 * @param {{ project: string, batchId: string, plans: any[], enginePaths: Record<string, string>,
 *   assetsRoot: string, workRoot: string, concurrency?: number, run?: (input: any) => Promise<any> }} options
 */
export function retryBatch({ project, batchId, plans, enginePaths, assetsRoot, workRoot, concurrency = 2, run }) {
  const previous = readBatch(project, batchId);
  if (!previous) throw new Error(`没有这个批次：${batchId}`);
  const failedIds = new Set((previous.results ?? []).filter((entry) => !entry.ok).map((entry) => entry.planId));
  if (!failedIds.size) return { batch: previous, retried: 0 };
  const subset = plans.filter((plan) => failedIds.has(plan.id));
  const { batch } = startBatch({
    project,
    plans: subset,
    enginePaths,
    assetsRoot,
    workRoot,
    concurrency,
    batchId: `${batchId}-retry${Date.now().toString(36)}`,
    ...(run ? { run } : {}),
  });
  return { batch, retried: subset.length };
}

/**
 * 一句人话的进度（界面与 agent 都用）："12/100 · 完成 10 · 失败 2 · 正在 xqg-013"。
 * @param {any} batch
 */
export function batchProgress(batch) {
  if (!batch) return '没有这个批次';
  const last = batch.events?.at(-1);
  const tail = batch.state === 'running'
    ? (last ? `正在 ${last.planId}` : '准备中')
    : (batch.verdict || '已结束');
  return `${batch.done}/${batch.total} · 完成 ${batch.ok} · 失败 ${batch.failed}${batch.skipped ? ` · 跳过 ${batch.skipped}` : ''} · ${tail}`;
}
