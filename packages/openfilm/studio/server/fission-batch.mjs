// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * 批量渲染：100 份 plan → 100 次 Fission job。
 *
 * # 为什么是"100 次 job"而不是"一次 job 的 Count=100"
 *
 * Fission 的批量是**同一个声音骨架 × 素材池随机重组**（`Count` × `AudioUses` × `PickRule`）。
 * 我们的 100 条每一条都有自己的文案、配音、字幕与镜头顺序 —— 那不是一个 job 能表达的。
 * 所以：**一条 plan 一个 job（Count=1）**，批量由这一层循环。
 *
 * # 三件必须做对的事
 *
 * 1. **并发要有上限**：每个 job 内部已经在跑 ffmpeg（`Threads`），外面再开 8 个就是互相抢 CPU，
 *    实测在纯 CPU 编码的机器上 2 个并发最稳。
 * 2. **可续跑**：产物已经存在就跳过。100 条跑到第 60 条崩了，不该从第 1 条重来。
 * 3. **只重出受影响的那几条**：失败项与"改过文案的那几条"各自重出，其余不动 —— 这是人用批量时最想要的行为。
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { jobFromPlan, stagePlanForFission } from './fission-plan.mjs';
import { runFission } from './fission-run.mjs';

/**
 * 把一份份 plan 变成"待渲染的任务"（staging + job），不启动渲染。
 * @param {{ plan: any }[]} items @param {{ project: string, assetsRoot: string, workRoot: string, enginePaths: Record<string, string> }} where
 * @returns {{ tasks: { planId: string, job: any, staged: any, problems: string[], notes: string[] }[], problems: string[] }}
 */
export function buildBatch(items, where) {
  /** @type {any[]} */
  const tasks = [];
  /** @type {string[]} */
  const problems = [];
  for (const item of items) {
    const plan = item.plan;
    const { staged, problems: planProblems, notes } = stagePlanForFission(plan, where);
    const { job, notes: jobNotes } = jobFromPlan(plan, staged, { enginePaths: where.enginePaths });
    for (const line of planProblems) problems.push(`${plan.id}: ${line}`);
    /* 缺素材/缺配音的那条不进队列：拿不齐输入的 job 跑起来只会浪费一次编码 */
    const usable = planProblems.length === 0;
    tasks.push({ planId: plan.id, job, staged, problems: planProblems, notes: [...notes, ...jobNotes], usable });
  }
  return { tasks, problems };
}

/**
 * 跑一批任务：有并发上限、可续跑、失败只记在失败项上。
 *
 * `run` 是注入的（默认 `runFission`）：单测不启动 dotnet，也不必等真实编码。
 *
 * @template T
 * @param {{ tasks: any[], project: string, enginePaths: Record<string, string>, concurrency?: number,
 *   run?: (input: { job: any, enginePaths: Record<string, string>, root: string }) => Promise<{ code: number, files: string[], message: string, stderr?: string }>,
 *   outDir?: string, onEvent?: (event: { planId: string, ok: boolean, message: string, done: number, total: number, file?: string }) => void,
 *   skipExisting?: boolean }} options
 * @returns {Promise<{ results: { planId: string, ok: boolean, file: string | null, message: string, skipped: boolean }[],
 *   ok: number, failed: number, skipped: number }>}
 */
export async function runBatch({
  tasks, project, enginePaths, concurrency = 2, run = runFission, outDir, onEvent = () => {}, skipExisting = true,
}) {
  const finalDir = outDir ?? join(project, '.film', 'fission', 'out');
  mkdirSync(finalDir, { recursive: true });
  const limit = Math.max(1, Math.trunc(concurrency));
  const queue = tasks.filter((task) => task.usable !== false);
  const skippedTasks = tasks.filter((task) => task.usable === false);

  /** @type {any[]} */
  const results = skippedTasks.map((task) => ({
    planId: task.planId, ok: false, file: null, skipped: false,
    message: `没有排队：${task.problems.slice(0, 2).join('；')}`,
  }));
  let done = 0;
  const total = tasks.length;

  /** @type {any[]} */
  const pending = [];
  for (const task of queue) {
    const final = join(finalDir, `${task.planId}.mp4`);
    if (skipExisting && existsSync(final) && statSync(final).size > 1024) {
      done += 1;
      results.push({ planId: task.planId, ok: true, file: final, skipped: true, message: '已有产物，跳过' });
      onEvent({ planId: task.planId, ok: true, message: '已有产物，跳过', done, total, file: final });
      continue;
    }
    pending.push(task);
  }

  let cursor = 0;
  /** 一条 worker 循环：取一个任务、跑完、写下一条 —— 并发是"同时几个 worker"，不是"一次全部发起"。 */
  const worker = async () => {
    while (cursor < pending.length) {
      const index = cursor;
      cursor += 1;
      const task = pending[index];
      const root = join(project, '.film', 'fission', 'jobs', task.planId);
      mkdirSync(root, { recursive: true });
      let outcome;
      try {
        outcome = await run({ job: task.job, enginePaths, root });
      } catch (error) {
        outcome = { code: 1, files: [], message: String(error?.message ?? error) };
      }
      const produced = (outcome.files ?? [])[0] ?? null;
      let final = null;
      if (outcome.code === 0 && produced && existsSync(produced)) {
        final = join(finalDir, `${task.planId}.mp4`);
        try { copyFileSync(produced, final); } catch { final = null; }
      }
      const ok = Boolean(final);
      done += 1;
      results.push({ planId: task.planId, ok, file: final, skipped: false, message: ok ? `完成：${basename(final ?? '')}` : outcome.message });
      onEvent({ planId: task.planId, ok, message: ok ? '完成' : outcome.message, done, total, ...(final ? { file: final } : {}) });
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, pending.length)) }, () => worker()));
  return {
    results,
    ok: results.filter((entry) => entry.ok).length,
    failed: results.filter((entry) => !entry.ok).length,
    skipped: results.filter((entry) => entry.skipped).length,
  };
}

/**
 * 只重出失败/改过的那些：给 batch 结果与"要重出的 planId 列表"，返回子任务集。
 * @param {any[]} tasks @param {string[]} planIds
 */
export function retryTasks(tasks, planIds) {
  const wanted = new Set(planIds);
  return tasks.filter((task) => wanted.has(task.planId)).map((task) => ({ ...task, usable: true }));
}

/**
 * 一句人话的批次结论（Fission 界面与 agent 回报都用它）。
 * @param {{ ok: number, failed: number, skipped: number, results: any[] }} summary
 */
export function batchVerdict(summary) {
  const failed = summary.results.filter((entry) => !entry.ok);
  if (!failed.length) return `${summary.ok} 条全部完成${summary.skipped ? `（其中 ${summary.skipped} 条是已有的）` : ''}`;
  const first = failed[0];
  return `${summary.ok} 条完成、${summary.failed} 条失败${summary.skipped ? `、${summary.skipped} 条跳过` : ''}；先是 ${first.planId}：${first.message}`;
}
