#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * The material index, started by whoever is launching Studio or the desktop app — not by a person remembering to.
 *
 *   node packages/openfilm/scripts/material-index-bootstrap.mjs --status     # what a reader would be shown
 *   node packages/openfilm/scripts/material-index-bootstrap.mjs --detach      # start a background sweep, return now
 *   node packages/openfilm/scripts/material-index-bootstrap.mjs --wait        # sweep in this process, print the outcome
 *   node packages/openfilm/scripts/material-index-bootstrap.mjs --wait --force
 *   node packages/openfilm/scripts/material-index-bootstrap.mjs --status --json --dir D:\\work\\idx
 *
 * `--detach` is the launcher's flag: it decides from the state alone (`materialIndexBootstrapPlan`), spawns a detached
 * child that runs `--wait`, and exits 0 immediately. Nothing the child does can stop the window from opening; the child
 * records its progress and its failure in `<dir>/status.json` and `<dir>/.building` (see `material-index-bootstrap.mjs`).
 *
 * `--wait` is the sweep: it reads the dev Studio's `run.json` (`origin`, `key`), waits for it to appear — a desktop launch
 * starts Studio and this at the same time, so the first read can be too early — and then fills the index through the same
 * `/api/materials/list` pages the manual CLI uses. Throttle and 429 backoff stay where they are
 * (`material-index-build.mjs`): this file adds no pacing of its own, it only passes `--throttle-ms` through.
 *
 * A failed sweep prints the reason and the warnings and exits 1 — the launcher ignores that code, so a broken build never
 * becomes a broken launch, but CI or a person still sees it.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_THROTTLE_MS, MATERIAL_VIDEO_TYPES, PAGE_SIZE, buildMaterialIndexFromApi, defaultIndexDir, writeMaterialIndex,
} from '../src/material-index-build.mjs';
import {
  BOOTSTRAP_SCHEMA, INDEX_STATES, bootstrapMaterialIndex, bootstrapStatusLines, materialIndexStatus,
  materialIndexBootstrapPlan,
} from '../src/material-index-bootstrap.mjs';
import { fetchPageFromStudio, readRunFile } from './material-index-build.mjs';

/** The modes, exactly: a read, a foreground sweep, a detached one. */
export const BOOTSTRAP_MODES = Object.freeze(['status', 'wait', 'detach']);

/** How long a foreground sweep waits for the Studio's `run.json` before it gives up (`--studio-timeout`). */
export const DEFAULT_STUDIO_TIMEOUT_MS = 120_000;

/**
 * `--status`, `--wait`, `--detach`, `--force`, `--dir`, `--json`, `--quiet`, `--studio-timeout`, `--throttle-ms`,
 * `--help`. A flag that needs a value eats the next word.
 */
export function parseArgs(argv = []) {
  const parsed = {
    mode: /** @type {'status'|'wait'|'detach'} */ ('status'),
    force: false,
    json: false,
    quiet: false,
    help: false,
    dir: null,
    studioTimeoutMs: DEFAULT_STUDIO_TIMEOUT_MS,
    throttleMs: DEFAULT_THROTTLE_MS,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = String(argv[index]);
    if (arg === '--status') parsed.mode = 'status';
    else if (arg === '--wait') parsed.mode = 'wait';
    else if (arg === '--detach') parsed.mode = 'detach';
    else if (arg === '--force') parsed.force = true;
    else if (arg === '--json') parsed.json = true;
    else if (arg === '--quiet') parsed.quiet = true;
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--dir') {
      const dir = String(argv[++index] ?? '').trim();
      if (!dir) throw new Error('--dir 需要一个目录');
      parsed.dir = dir;
    } else if (arg === '--studio-timeout') {
      const ms = Number(argv[++index]);
      if (!Number.isFinite(ms) || ms < 0) throw new Error('--studio-timeout 需要毫秒数（0 = 不等）');
      parsed.studioTimeoutMs = Math.trunc(ms);
    } else if (arg === '--throttle-ms') {
      const ms = Number(argv[++index]);
      if (!Number.isFinite(ms) || ms < 0) throw new Error('--throttle-ms 需要毫秒数（0 = 不等待）');
      parsed.throttleMs = Math.trunc(ms);
    } else throw new Error(`不认识的参数：${arg}`);
  }
  return parsed;
}

/**
 * The dev Studio's `run.json` as soon as it is there (a desktop launch writes it after the window is up), or a
 * `studio-not-ready` error naming the wait that expired. Polled, because the launch and this script start together.
 *
 * @param {{home?: string, timeoutMs?: number, pollMs?: number, read?: (path: string, encoding: string) => string,
 *   sleep?: (ms: number) => Promise<unknown>, now?: () => number}} [options]
 */
export async function waitForStudio({
  home, timeoutMs = DEFAULT_STUDIO_TIMEOUT_MS, pollMs = 500, read = /** @type {any} */ (readFileSync),
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)), now = () => Date.now(),
} = /** @type {any} */ ({})) {
  const startedAt = now();
  const deadline = startedAt + Math.max(0, timeoutMs);
  for (;;) {
    try { return readRunFile({ home, read }); }
    catch (error) {
      const code = String(/** @type {any} */ (error)?.code ?? '');
      if (code !== 'run-file-missing' || now() >= deadline) {
        if (code === 'run-file-missing' && timeoutMs > 0) {
          throw Object.assign(new Error(`等了 ${Math.round((deadline - startedAt) / 1000)} 秒，dev Studio 的 run.json 仍未出现（${String(/** @type {any} */ (error)?.message ?? error)}）`), {
            code: 'studio-not-ready',
          });
        }
        throw error;
      }
    }
    await sleep(pollMs);
  }
}

/**
 * The sweep this CLI runs: the Studio's pages, in the shape `runBootstrapBuild` expects (`build({onPage})`).
 * `fetchPage` is injectable so a test drives the whole path with a stub and no Studio at all.
 *
 * @param {{home?: string, scope?: string, pageSize?: number, throttleMs?: number, videoTypes?: readonly number[],
 *   fetchPage?: Function | null, studioTimeoutMs?: number}} [options]
 */
export function studioBuildFactory({
  home, scope = 'company', pageSize = PAGE_SIZE, throttleMs = DEFAULT_THROTTLE_MS,
  videoTypes = MATERIAL_VIDEO_TYPES, fetchPage = null, studioTimeoutMs = DEFAULT_STUDIO_TIMEOUT_MS,
} = {}) {
  return async (/** @type {{onPage: (read: any) => void}} */ hooks) => {
    const read = fetchPage ?? fetchPageFromStudio({ ...(await waitForStudio({ home, timeoutMs: studioTimeoutMs })), scope });
    return buildMaterialIndexFromApi({
      fetchPage: read, pageSize, throttleMs, videoTypes, onPage: hooks?.onPage ?? null,
    });
  };
}

/**
 * The whole CLI as a function, so a test can drive it: `--status` prints the state, `--detach` spawns a detached
 * `--wait` child and returns 0 at once, `--wait` sweeps and returns 0 (or 1 with the reason printed).
 *
 * @param {{
 *   argv?: string[],
 *   home?: string,
 *   dir?: string | null,
 *   out?: (line: string) => void,
 *   log?: (line: string) => void,
 *   fetchPage?: Function | null,
 *   build?: ((hooks: {onPage: (read: any) => void}) => Promise<any>) | null,
 *   write?: (dir: string, result: any) => Promise<any>,
 *   spawnFn?: typeof spawn,
 *   execPath?: string,
 *   script?: string,
 *   env?: NodeJS.ProcessEnv,
 *   now?: Date,
 *   pid?: number | null,
 *   pidAlive?: (pid: unknown) => boolean,
 * }} [options]
 */
export async function runMaterialIndexBootstrap({
  argv = [], home, dir = null, out = (line) => console.log(line), log = (line) => console.error(line),
  fetchPage = null, build = null, write = writeMaterialIndex, spawnFn = spawn,
  execPath = process.execPath, script = fileURLToPath(import.meta.url), env = process.env,
  now = new Date(), pid = process.pid, pidAlive,
} = /** @type {any} */ ({})) {
  const args = parseArgs(argv);
  const target = args.dir ?? dir ?? defaultIndexDir({ home });

  if (args.help) {
    out([
      '用法: node packages/openfilm/scripts/material-index-bootstrap.mjs [--status|--wait|--detach] [--force]',
      '      [--dir DIR] [--json] [--quiet] [--studio-timeout MS] [--throttle-ms MS]',
      '  --status  只读状态：absent / building / landed / stale / failed（默认）',
      '  --wait    在本进程内把索引建好，失败时打印原因并以 1 退出',
      '  --detach  需要时派生子进程去建，立即返回 0（启动器用这个）',
      '  --force   即使没过期也重建',
      `  --throttle-ms  翻页间隔，默认 ${DEFAULT_THROTTLE_MS}（本账号约 144 次/分钟开始 429）`,
    ].join('\n'));
    return 0;
  }

  if (args.mode === 'status') {
    const status = materialIndexStatus(target, pidAlive ? { now, pidAlive } : { now });
    if (args.json) out(JSON.stringify(status, null, 2));
    else for (const line of [`state: ${status.state}`].concat(bootstrapStatusLines(status))) out(line);
    /* a status read is never a failure: what it says is the answer */
    return 0;
  }

  if (args.mode === 'detach') {
    const status = materialIndexStatus(target, pidAlive ? { now, pidAlive } : { now });
    const plan = materialIndexBootstrapPlan(target, pidAlive ? { now, force: args.force, pidAlive, status } : { now, force: args.force, status });
    if (!plan.needed) {
      if (!args.quiet) log(`material-index: 不重建（${plan.reason}，state ${plan.state}）`);
      return 0;
    }
    const childArgs = [
      script, '--wait', '--dir', target,
      '--studio-timeout', String(args.studioTimeoutMs),
      '--throttle-ms', String(args.throttleMs),
    ];
    if (args.force) childArgs.push('--force');
    if (args.quiet) childArgs.push('--quiet');
    try {
      const child = spawnFn(execPath, childArgs, {
        detached: true, stdio: 'ignore', windowsHide: true, env, cwd: process.cwd(),
      });
      child?.on?.('error', () => { /* a child that cannot start must not throw into the launcher */ });
      child?.unref?.();
      if (!args.quiet) log(`material-index: 已派生后台构建（${plan.reason}，pid ${child?.pid ?? '—'}，目录 ${target}）`);
      return 0;
    } catch (error) {
      log(`material-index: 后台构建没能启动：${String(/** @type {any} */ (error)?.message ?? error)}`);
      return 1;
    }
  }

  /* --wait: the sweep, with the claim, the progress file and the failure record from the bootstrap module */
  const buildFn = build ?? studioBuildFactory({ home, fetchPage, throttleMs: args.throttleMs, studioTimeoutMs: args.studioTimeoutMs });
  const outcome = await bootstrapMaterialIndex({
    dir: target, build: buildFn, write, now, force: args.force, background: false,
    pid, ...(pidAlive ? { pidAlive } : {}),
  });

  if (args.json) {
    out(JSON.stringify({
      action: outcome.action, reason: outcome.reason, state: outcome.state, stale: outcome.stale,
      dir: target, bytes: outcome.written?.bytes ?? null, failure: outcome.failure, warnings: outcome.status?.warnings ?? [],
    }, null, 2));
  } else if (!args.quiet) {
    for (const line of bootstrapStatusLines(outcome.status)) out(line);
    if (outcome.action === 'built') out(`material-index: 已落盘 ${outcome.written?.file ?? target}（${outcome.written?.bytes ?? 0} B）`);
    else if (outcome.action === 'none' || outcome.action === 'building') out(`material-index: 不重建（${outcome.reason}）`);
  }

  if (outcome.action === 'failed') {
    const failure = outcome.failure;
    if (!args.json) {
      log(`material-index: 构建失败（${failure?.code ?? 'build-failed'}）：${failure?.message ?? ''}`);
      for (const warning of failure?.warnings ?? []) log(`warning ${warning.code}: ${warning.message ?? ''}`);
    }
    return 1;
  }
  return 0;
}

const isMain = () => {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return fileURLToPath(import.meta.url) === entry; } catch { return false; }
};

if (isMain()) {
  try {
    process.exitCode = await runMaterialIndexBootstrap({ argv: process.argv.slice(2), home: homedir() });
  } catch (error) {
    console.error(`material-index-bootstrap: ${String(/** @type {any} */ (error)?.message ?? error)}`);
    process.exitCode = 1;
  }
}

/** Re-exported for a caller that wants the whole contract without a second import. */
export { BOOTSTRAP_SCHEMA, INDEX_STATES };
