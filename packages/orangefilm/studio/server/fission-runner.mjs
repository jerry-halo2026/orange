// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * 跑一次 Fission job：唯一执行器（画布混剪、批量、MCP 共用）。
 *
 * 它负责四件在现有代码里被做错或做漏的事（依据 docs/execution/2026-11-19-mix-engine-spike.md 与运行契约审计）：
 *
 *   1. **每次运行一个全新的 attempt**。引擎要求 `work/out/cache` 全空，旧实现固定 `t1/a1` 且复用同一目录，
 *      重试必抛未捕获的 IOException（进程以崩溃码退出）。
 *   2. **按 `report.json` 判定成败**，而不是 `readdir` 取第一个 mp4：`Count>1` 时旧实现会丢产物，
 *      半截文件也会被当成成功；`StopReason`/`EditPlanPath` 要有。
 *   3. **超时杀整棵进程树**：旧实现只 `child.kill()`，ffmpeg 会变孤儿继续写目录。Windows 用 `taskkill /T`，
 *      POSIX 用 `detached` 进程组 + `SIGTERM→(3s)→SIGKILL`。
 *   4. **失败可归因**：退出码、stderr 的 `[Fission:<CODE>]`、报告缺失三类分开说。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { explainFissionFailure } from './fission-plan.mjs';
import { readConfiguredRuntime } from './fission-run.mjs';

/** 引擎要求 paths 文件恰好这几个键；WorkRoot/OutRoot 写进去会被判 CFG_ARGS。 */
export const PATH_KEYS = ['FFmpeg', 'FFprobe', 'TransitionsDir', 'AssetsRoot', 'LocalAssetsRoot'];

export class FissionRunError extends Error {
  /** @param {string} code @param {string} message @param {Record<string, unknown>} [details] */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'FissionRunError';
    this.code = code;
    this.details = details;
  }
}

/**
 * 规范路径：`realpathSync.native` 消掉 macOS 的 `/var → /private/var` 与 Windows 的 8.3 短名
 * （Fission 拒收短名，只回一句 CFG_ARGS）；解析不了就原样返回，交给存在性检查报。
 * @param {string} path
 */
export function canonicalPath(path) {
  try { return realpathSync.native(path); } catch { return path; }
}

/** 该 attempt 的写根：`<root>/workspace/<task>/<attempt>`。 */
export const attemptDir = (/** @type {string} */ root, /** @type {string} */ task, /** @type {string} */ attempt) =>
  join(root, 'workspace', task, attempt);

/** 引擎要求 attempt 是全空的新目录；不新鲜就当场说清，不让 CLI 崩。 */
export function assertFresh(/** @type {string} */ root, task, attempt) {
  const at = attemptDir(root, task, attempt);
  for (const sub of ['work', 'out', 'cache']) {
    if (existsSync(join(at, sub))) {
      throw new FissionRunError('attempt-not-fresh', `${at}/${sub} 已存在：每次渲染要用新的 attempt（或先清理）`);
    }
  }
  return at;
}

/** 生成一个合法且难撞的 attempt 名（小写字母数字与连字符）。 */
export function freshAttempt(/** @type {string} */ label = 'a') {
  const safe = String(label).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'a';
  /* 同一毫秒内也会调用两次：时间戳之外再加一段随机，保证每次都是新 attempt。 */
  const tail = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  return `${safe}-${tail}`.slice(0, 40).replace(/-$/, '');
}

/** 写 `--paths` 与 `--job` 两份文件：只挑 5 个只读键，全部规范成长名。 */
export function writeRunFiles(/** @type {string} */ root, /** @type {Record<string, string>} */ enginePaths, job) {
  for (const key of PATH_KEYS) {
    if (typeof enginePaths[key] !== 'string' || !enginePaths[key]) {
      throw new FissionRunError('engine-paths', `缺少 ${key}（渲染器配置不完整）`);
    }
  }
  mkdirSync(root, { recursive: true });
  const pathsFile = join(root, 'engine-paths.json');
  const jobFile = join(root, 'job.json');
  const paths = Object.fromEntries(PATH_KEYS.map((key) => [key, canonicalPath(enginePaths[key])]));
  writeFileSync(pathsFile, `${JSON.stringify(paths, null, 1)}\n`, 'utf8');
  writeFileSync(jobFile, `${JSON.stringify(job, null, 1)}\n`, 'utf8');
  return { pathsFile: canonicalPath(pathsFile), jobFile: canonicalPath(jobFile), paths };
}

/**
 * 读一份 `report.json`（PascalCase）：只认报告，不靠目录猜。
 * @param {string} outRoot `…/out`
 */
export function readJobReport(/** @type {string} */ outRoot) {
  if (!existsSync(outRoot)) throw new FissionRunError('report-missing', `没有输出目录：${outRoot}`);
  /** @type {string[]} */
  const withReport = [];
  for (const name of readdirSync(outRoot)) {
    const dir = join(outRoot, name);
    if (existsSync(join(dir, 'report.json'))) withReport.push(dir);
  }
  if (withReport.length !== 1) {
    throw new FissionRunError('report-missing', withReport.length ? `输出目录不唯一（${withReport.length} 份 report.json）` : '没有 report.json：渲染没有走到收尾');
  }
  const jobDir = withReport[0];
  /** @type {any} */
  let report;
  try { report = JSON.parse(readFileSync(join(jobDir, 'report.json'), 'utf8')); }
  catch (error) { throw new FissionRunError('report-invalid', `report.json 读不出：${String(/** @type {any} */ (error)?.message ?? error)}`); }
  const outputs = Array.isArray(report.Outputs) ? report.Outputs : [];
  for (const output of outputs) {
    if (typeof output?.Path !== 'string' || !output.Path.startsWith(jobDir)) {
      throw new FissionRunError('report-invalid', `产物路径不在输出目录内：${String(output?.Path)}`);
    }
  }
  return {
    jobDir,
    stopReason: String(report.StopReason ?? ''),
    succeeded: Number(report.Succeeded ?? 0),
    failed: Number(report.Failed ?? 0),
    outputs: outputs.map((/** @type {any} */ o) => ({ index: o.Index, path: o.Path, title: o.Title, durationSec: o.DurationSec, editPlanPath: o.EditPlanPath ?? null })),
    failures: Array.isArray(report.Failures) ? report.Failures : [],
    consumeLog: Array.isArray(report.ConsumeLog) ? report.ConsumeLog : [],
    report,
  };
}

/**
 * 跑一次。返回结构化结果，不抛渲染失败（`code !== 0` 也是一种结果）；只有前置检查会抛 `FissionRunError`。
 *
 * @param {{ job: any, enginePaths: Record<string, string>, root: string, task?: string, attempt?: string,
 *   dotnet?: string, dll?: string, timeoutMs?: number, onLine?: (line: string) => void }} options
 */
export async function runFissionJob({
  job, enginePaths, root, task = 't1', attempt = freshAttempt(), dotnet, dll, timeoutMs = 30 * 60_000, onLine = () => {},
}) {
  for (const value of [task, attempt]) {
    if (!/^(?!-)[a-z0-9-]{1,40}(?<!-)$/.test(value)) throw new FissionRunError('identity', `task/attempt 只能是小写字母数字与连字符、首尾不为 '-'：${value}`);
  }
  const canonicalRoot = (() => { mkdirSync(root, { recursive: true }); return canonicalPath(root); })();
  assertFresh(canonicalRoot, task, attempt);
  const { pathsFile, jobFile } = writeRunFiles(canonicalRoot, enginePaths, job);
  /* 安装后的应用把随包 host/CLI 写在 `ORANGE_FISSION_CONFIG_FILE` 里：用它，别按当前工作目录猜。 */
  const configured = readConfiguredRuntime();
  const dotnetExe = String(dotnet ?? '').trim() || configured.dotnet || 'dotnet';
  const cli = String(dll ?? '').trim() || process.env.FISSION_CLI_DLL?.trim() || configured.cli || join(process.cwd(), 'workers', 'fission', 'src', 'Fission.Cli', 'bin', 'Debug', 'net10.0', 'Fission.Cli.dll');
  const args = ['run', '--paths', pathsFile, '--workspace', join(canonicalRoot, 'workspace'), '--task', task, '--attempt', attempt, '--job', jobFile];

  /** @type {import('node:child_process').ChildProcess} */
  const child = spawn(dotnetExe, [cli, ...args], {
    windowsHide: true,
    /* POSIX 要让子进程自成进程组，超时才杀得掉它拉起的 ffmpeg 子孙（见 killTree）；Windows 用 taskkill /T。 */
    detached: process.platform !== 'win32',
    env: { ...process.env, FISSION_ENGINE_PATHS: pathsFile },
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
  child.stdout?.on('data', (chunk) => { const text = String(chunk); stdout += text; onLine(text); });
  child.stderr?.on('data', (chunk) => { const text = String(chunk); stderr += text; onLine(text); });
  const code = await new Promise((done) => {
    child.on('close', (value) => done(value ?? -1));
    child.on('error', (error) => { stderr += String(/** @type {any} */ (error)?.message ?? error); done(-1); });
  });
  clearTimeout(timer);

  const outRoot = join(canonicalRoot, 'workspace', task, attempt, 'out');
  /** @type {any} */
  let report = null;
  let message;
  try {
    report = readJobReport(outRoot);
    message = code === 0 && report.succeeded > 0
      ? `完成 ${report.succeeded} 条${report.failed ? `、失败 ${report.failed} 条` : ''}（${report.stopReason}）`
      : `${report.succeeded} 条完成、${report.failed} 条失败（${report.stopReason}）${report.failures[0] ? `；先是 ${report.failures[0].Code}：${report.failures[0].Message}` : ''}`;
  } catch (error) {
    message = timedOut
      ? `超过 ${Math.round(timeoutMs / 1000)} 秒没有结束，已终止（可能已计费的上游调用不会重试）`
      : explainFissionFailure({ code, stderr, outDir: outRoot });
    if (error instanceof FissionRunError && error.code === 'report-invalid') message = error.message;
  }

  return { code, timedOut, attempt, outDir: outRoot, stdout, stderr, report, message };
}

/** SIGTERM 到 SIGKILL 之间的宽限期：让 ffmpeg 把半截文件收尾，但不必等更久。 */
export const KILL_GRACE_MS = 3000;

/**
 * 杀掉整棵进程树。
 *
 * Windows：`taskkill /PID <pid> /T /F`（`/T` 才连子孙）。
 * POSIX：子进程是用 `detached: true` 起的，于是它是一个进程组，`kill(-pid)` 才打到它拉起的 ffmpeg；
 * **先 SIGTERM 让它收尾，宽限 `KILL_GRACE_MS` 后再 SIGKILL**。只 `child.kill()` 会留下孤儿 ffmpeg 继续写 out 目录，
 * 下一次 attempt 就撞引擎的"必须全空"。
 *
 * `kill / later / platform / spawnImpl` 是为了可测：断言调用顺序不必真的发信号。
 *
 * @param {{ pid?: number | undefined, kill?: (signal?: any) => unknown } | null | undefined} child
 * @param {{ graceMs?: number, kill?: (pid: number, signal: string) => unknown,
 *   later?: (fn: () => void, ms: number) => any, platform?: string, spawnImpl?: typeof spawn }} [options]
 * @returns {any} 之后的 SIGKILL 定时器（没有进程组时为 null）
 */
export function killTree(child, options = {}) {
  const {
    graceMs = KILL_GRACE_MS,
    kill = (/** @type {number} */ pid, /** @type {string} */ signal) => process.kill(pid, signal),
    later = (/** @type {() => void} */ fn, /** @type {number} */ ms) => setTimeout(fn, ms),
    platform = process.platform,
    spawnImpl = spawn,
  } = options;
  const pid = Number(child?.pid ?? 0);
  if (!pid) return null;
  if (platform === 'win32') {
    spawnImpl('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return null;
  }
  let inGroup = true;
  try { kill(-pid, 'SIGTERM'); }
  catch {
    /* 没有进程组可用（调用方没 detached，或进程已消失）：退化成单进程 TERM */
    inGroup = false;
    try { child?.kill?.('SIGTERM'); } catch { /* already gone */ }
  }
  const timer = later(() => {
    if (inGroup) {
      try { kill(-pid, 'SIGKILL'); return; }
      catch { /* 组没了就试单进程 */ }
    }
    try { child?.kill?.('SIGKILL'); } catch { /* already gone */ }
  }, graceMs);
  /* 宽限期不该拖住进程退出（服务端常驻，等 3 秒只是白等） */
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
}

/**
 * 一次 attempt 的收尾：成功可保留；失败/超时改名留证据，避免下次撞"必须全空"。
 * @param {string} root @param {{ task?: string, attempt: string, keep?: boolean }} options
 */
export function finishAttempt(root, { task = 't1', attempt, keep = false }) {
  const at = attemptDir(root, task, attempt);
  if (!existsSync(at)) return null;
  if (keep) return at;
  const trashed = `${at}-failed-${Date.now().toString(36)}`;
  try { renameSync(at, trashed); return trashed; } catch { try { rmSync(at, { recursive: true, force: true }); } catch { /* leave it */ } return null; }
}
