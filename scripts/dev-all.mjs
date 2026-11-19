#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * `pnpm dev:all` —— 一条命令，从「什么都没有」到「能登录能用」。
 *
 * 七步，按依赖顺序，每一步都自己打印一行，失败就在那一步停下并**非零退出**（绝不半启动：窗口只在第 7 步才派生）：
 *
 *   1. 环境     解析 `.dev/auth-runtime.json`（缺省回落到 `packages/openfilm/src/auth-environment.mjs` 的
 *               `LOCAL_DOCKER`，并提示一句）；把 `ORANGE_AUTH_CONFIG_FILE` / `ORANGE_FISSION_CONFIG_FILE`
 *               导给后面所有子进程。publishableKey 永不打印。
 *   2. 依赖服务 本地 Postgres（compose 服务 `db`，容器 `orange-w1-db`，`127.0.0.1:55432`）：先探 `select 1`；
 *               没就绪且 compose 文件在 → `docker compose ... up -d`，再等到 `select 1` 通过（默认 60s）。
 *   3. 迁移     `node infra/migrate.mjs --target local`，**按 migrate 自己的退出码传播**，不再往下。
 *   4. 校验     `node infra/verify.mjs --json`：9 项全过才继续；否则列出 FAIL 的检查项并退出 2。
 *   5. 索引     派发已提交的 `material-index-bootstrap.mjs --detach`（detached、不阻塞、失败也不影响启动），
 *               并把 `--status` 打出来。
 *   6. 单例     `.dev/dev.pid` 指向活进程 / `~/.openfilm-dev/run.json` 的 Studio 能应答 `/api/health` →
 *               打印「已在运行：origin …」并 exit 0，不另起第二个 Studio；死 pid 顺手清掉。
 *   7. 起应用   派生 `pnpm dev:desktop`，写 `.dev/dev.pid`（pid/origin/environmentId/startedAt），
 *               等到 Studio 的 `run.json` 出现 origin 且 `/api/health` 通过就把它打出来，退出时删 pid 文件。
 *
 * 退出码：0 成功（含「已在运行」与用户正常关窗）；1 环境/配置错误；2 依赖服务或校验未就绪；
 *         3 迁移失败且 migrate 自己没给码（正常时直接传播 1/2）。第 7 步的码就是应用的码。
 *
 * 每个函数都接受注入（`run` / `spawnFn` / `probe` / `now` / `sleep`），所以 `node --test scripts/dev-all.test.mjs`
 * 能在不碰 docker、不开窗的前提下验证「未就绪退出 2」「已有实例不重起」「迁移失败即停」。
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

import { LOCAL_DOCKER, environmentProblems } from '../packages/openfilm/src/auth-environment.mjs';
import { startMaterialIndexBootstrap } from './dev-desktop.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 退出码：只有 0 是成功，其余各自有语义（见文件头）。 */
export const EXIT = Object.freeze({ ok: 0, config: 1, services: 2, migrateUnknown: 3 });

/** 依赖服务的身份，与 `infra/docker-compose.yml` / `infra/verify.mjs` 一致。 */
export const DB_CONTAINER = 'orange-w1-db';
export const DB_PORT = 55432;
export const SERVICES_TIMEOUT_MS = 60_000;
/** 等窗口的 Studio 写出 `run.json` 的上限：第一次启动要 build shell + 起 Electron。 */
export const STUDIO_TIMEOUT_MS = 180_000;

/** 写集内的路径，集中在这里，测试才能指向夹具。 */
export const PATHS = Object.freeze({
  authRuntime: (root = ROOT) => join(root, '.dev', 'auth-runtime.json'),
  fissionRuntime: (root = ROOT) => join(root, '.dev', 'fission-runtime', 'runtime.repo.json'),
  devPid: (root = ROOT) => join(root, '.dev', 'dev.pid'),
  compose: (root = ROOT) => join(root, 'infra', 'docker-compose.yml'),
  migrate: (root = ROOT) => join(root, 'infra', 'migrate.mjs'),
  verify: (root = ROOT) => join(root, 'infra', 'verify.mjs'),
  bootstrap: (root = ROOT) => join(root, 'packages', 'openfilm', 'scripts', 'material-index-bootstrap.mjs'),
});

/** 某一步自己失败：`step` 是第几步，`code` 是进程该退的码。 */
export class StepError extends Error {
  /** @param {number} step @param {string} message @param {number} [code] */
  constructor(step, message, code = EXIT.config) {
    super(message);
    this.name = 'StepError';
    this.step = step;
    this.code = code;
  }
}

const firstLine = (text) => String(text ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] ?? '';
const lastLine = (text) => String(text ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop() ?? '';
const wait = (/** @type {number} */ ms) => new Promise((done) => setTimeout(done, ms));
const samePath = (a, b) => resolve(String(a)).toLowerCase() === resolve(String(b)).toLowerCase();

// ---------------------------------------------------------------------------
// 子进程
// ---------------------------------------------------------------------------
/**
 * 跑一条命令并收走输出（不抛出）。迁移之外的步骤都用它，因为它们的输出要自己排版。
 * @param {string} command @param {string[]} args
 * @param {{env?: NodeJS.ProcessEnv, cwd?: string, timeoutMs?: number}} [options]
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
export function captureRun(command, args, { env = process.env, cwd = ROOT, timeoutMs = 15 * 60 * 1000 } = {}) {
  return new Promise((done) => {
    execFile(command, args, { cwd, env, windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs }, (error, stdout, stderr) => {
      const code = error ? (typeof (/** @type {any} */ (error).code) === 'number' ? (/** @type {any} */ (error).code) : 1) : 0;
      done({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/**
 * 跑一条命令，输出直接进本进程的终端（迁移用它：migrate 自己的行就是要给人看的证据）。
 * @param {string} command @param {string[]} args
 * @param {{env?: NodeJS.ProcessEnv, cwd?: string, shell?: boolean}} [options]
 * @returns {Promise<{code: number, error?: string}>}
 */
export function inheritRun(command, args, { env = process.env, cwd = ROOT, shell = false } = {}) {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit', shell });
    child.once('exit', (code, signal) => done({ code: typeof code === 'number' ? code : signal ? 1 : 0 }));
    child.once('error', (error) => done({ code: 1, error: String(/** @type {any} */ (error)?.message ?? error) }));
  });
}

// ---------------------------------------------------------------------------
// 1. 环境
// ---------------------------------------------------------------------------
/** 给窗口看的环境描述：只报身份与「两个键在不在」，**不打印** authOrigin / publishableKey（运行配置不出仓库）。 */
export function describeEnvironment(environment) {
  const origin = typeof environment?.authOrigin === 'string' && environment.authOrigin.trim() ? 'authOrigin 已配置' : 'authOrigin 缺失';
  const key = typeof environment?.publishableKey === 'string' && environment.publishableKey.trim() ? 'publishableKey 已配置' : 'publishableKey 缺失';
  return `${environment?.environmentId ?? '(缺 environmentId)'}（${origin}、${key}，都不打印）`;
}

/**
 * `.dev/auth-runtime.json`（或显式 `ORANGE_AUTH_CONFIG_FILE`）→ `{environment}`；文件不存在就用本地默认并提示。
 * 字段校验复用 `auth-environment.mjs` 的 `environmentProblems`：空串也算缺，规则只有一处。
 * @param {{root?: string, env?: NodeJS.ProcessEnv, exists?: typeof existsSync, readFile?: typeof readFileSync}} [options]
 */
export function resolveAuthRuntime({ root = ROOT, env = process.env, exists = existsSync, readFile = readFileSync } = {}) {
  const override = String(env?.ORANGE_AUTH_CONFIG_FILE ?? '').trim();
  const file = override ? resolve(override) : PATHS.authRuntime(root);
  if (!exists(file)) {
    return {
      source: /** @type {'local-default'} */ ('local-default'),
      file: null,
      environment: { ...LOCAL_DOCKER },
      note: `没有 ${file}：使用 auth-environment.mjs 的本地默认 ${describeEnvironment(LOCAL_DOCKER)}。要签进托管环境就把三键写进该文件。`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(String(readFile(file, 'utf8')));
  } catch {
    throw new StepError(1, `${file} 不是合法 JSON，环境无法确定`);
  }
  const problems = environmentProblems(parsed);
  if (problems.length) throw new StepError(1, `${file} 缺字段或取值无效：${problems.join(', ')}`);
  return { source: /** @type {'file'} */ ('file'), file, environment: { ...parsed }, note: null };
}

/**
 * 子进程环境：把 `.dev/auth-runtime.json`（绝对路径）与 `.dev/fission-runtime/runtime.repo.json` 导出去。
 * 文件不存在就保留调用者原有的值，不凭空造一个指向不存在文件的路径。
 * @param {NodeJS.ProcessEnv} base
 * @param {{root?: string, auth?: {file?: string|null}|null, exists?: typeof existsSync}} [options]
 */
export function childEnvironment(base = process.env, { root = ROOT, auth = null, exists = existsSync } = {}) {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...base };
  const authFile = auth?.file ?? (exists(PATHS.authRuntime(root)) ? PATHS.authRuntime(root) : null);
  if (authFile) env.ORANGE_AUTH_CONFIG_FILE = resolve(authFile);
  const fission = PATHS.fissionRuntime(root);
  if (exists(fission)) env.ORANGE_FISSION_CONFIG_FILE = resolve(fission);
  return env;
}

// ---------------------------------------------------------------------------
// 2. 依赖服务
// ---------------------------------------------------------------------------
/** 端口探活：`127.0.0.1:55432` 真的在听才算通。 */
export function tcpProbe({ host = '127.0.0.1', port = DB_PORT, timeoutMs = 1000 } = {}) {
  return new Promise((done) => {
    const socket = net.connect({ host, port });
    /** @param {boolean} ok */
    const finish = (ok) => { socket.destroy(); done(ok); };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * 等 `orange-w1-db` 真的能答 `select 1`（兼探端口）。没起来就先 `docker compose up -d`，然后等到 `timeoutMs`。
 * 返回 `{ok:true, note}` 或 `{ok:false, reason}`——调用方负责打「依赖服务未就绪：…」并退出 2。
 * @param {{root?: string, run?: typeof captureRun, probe?: typeof tcpProbe, timeoutMs?: number,
 *   sleep?: (ms: number) => Promise<unknown>, now?: () => number, log?: (line: string) => void,
 *   port?: number, exists?: typeof existsSync}} [options]
 */
export async function ensureDependencyServices({
  root = ROOT, run = captureRun, probe = tcpProbe, timeoutMs = SERVICES_TIMEOUT_MS, sleep = wait,
  now = () => Date.now(), log = console.log, port = DB_PORT, exists = existsSync,
} = {}) {
  const compose = PATHS.compose(root);
  const docker = await run('docker', ['version', '--format', '{{.Server.Version}}']);
  if (docker.code !== 0) {
    return { ok: false, reason: `Docker 引擎不可用（docker version 失败）：${firstLine(docker.stderr || docker.stdout) || '无输出'}` };
  }

  const psql = () => run('docker', [
    'compose', '-f', compose, 'exec', '-T', 'db',
    'psql', '-U', 'postgres', '-d', 'orange', '-v', 'ON_ERROR_STOP=1', '-At', '-c', 'select 1',
  ]);
  const ready = async () => {
    const r = await psql();
    if (r.code !== 0 || lastLine(r.stdout) !== '1') return false;
    return probe({ port });
  };

  if (await ready()) return { ok: true, note: `${DB_CONTAINER} 已在运行，select 1 与 127.0.0.1:${port} 都通` };

  const state = await run('docker', ['inspect', '-f', '{{.State.Status}}', DB_CONTAINER]);
  const status = state.code === 0 ? lastLine(state.stdout) || '(空)' : '(容器不存在)';
  log(`  ${DB_CONTAINER} 状态 ${status}：尝试 docker compose up -d`);
  if (!exists(compose)) return { ok: false, reason: `容器未就绪，且没有 ${compose} 可以起它` };

  const up = await run('docker', ['compose', '-f', compose, 'up', '-d']);
  if (up.code !== 0) return { ok: false, reason: `docker compose up -d 失败：${firstLine(up.stderr || up.stdout) || `exit ${up.code}`}` };

  const startedAt = now();
  while (now() - startedAt < timeoutMs) {
    if (await ready()) {
      const seconds = ((now() - startedAt) / 1000).toFixed(1);
      return { ok: true, note: `${DB_CONTAINER} 已就绪（compose up -d 后 ${seconds}s 内通过 select 1）` };
    }
    await sleep(1000);
  }
  return { ok: false, reason: `${(timeoutMs / 1000).toFixed(0)}s 内没有等到 ${DB_CONTAINER} 应答 select 1（127.0.0.1:${port}）` };
}

// ---------------------------------------------------------------------------
// 3. 迁移
// ---------------------------------------------------------------------------
/** `node infra/migrate.mjs --target local`；退出码原样返回（1 失败/漂移，2 配置或环境错误）。 */
export async function runMigrations({ root = ROOT, env = process.env, run = inheritRun, exists = existsSync } = {}) {
  const file = PATHS.migrate(root);
  if (!exists(file)) return { code: EXIT.services, reason: `没有 ${file}` };
  const result = await run(process.execPath, [file, '--target', 'local'], { env, cwd: root });
  return { code: result.code };
}

// ---------------------------------------------------------------------------
// 4. 校验
// ---------------------------------------------------------------------------
/**
 * `node infra/verify.mjs --json`：机器可读的一行在 stdout，人看的在 stderr。返回 `{code, report, failed}`。
 * @param {{root?: string, env?: NodeJS.ProcessEnv, run?: typeof captureRun, exists?: typeof existsSync}} [options]
 */
export async function runVerify({ root = ROOT, env = process.env, run = captureRun, exists = existsSync } = {}) {
  const file = PATHS.verify(root);
  if (!exists(file)) return { code: EXIT.services, report: null, failed: [], reason: `没有 ${file}` };
  const result = await run(process.execPath, [file, '--json'], { env, cwd: root });
  /** @type {any} */
  let report = null;
  try { report = JSON.parse(lastLine(result.stdout)); } catch { report = null; }
  const checks = Array.isArray(report?.checks) ? report.checks : [];
  const failed = checks.filter((check) => !check?.ok);
  return { code: result.code, report, failed };
}

// ---------------------------------------------------------------------------
// 5. 素材索引
// ---------------------------------------------------------------------------
/** `material-index-bootstrap.mjs --status` 的一行行输出（失败只作提示）。 */
export function indexStatus({ root = ROOT, env = process.env, run = captureRun } = {}) {
  return run(process.execPath, [PATHS.bootstrap(root), '--status'], { env, cwd: root });
}

// ---------------------------------------------------------------------------
// 6. 单例
// ---------------------------------------------------------------------------
/** Studio 的 home：dev flavour 的 `~/.openfilm-dev`（`flavor.mjs`），显式 `OPENFILM_HOME` 优先。 */
export function studioHome(env = process.env) {
  const explicit = String(env?.OPENFILM_HOME ?? '').trim();
  return explicit ? resolve(explicit) : join(homedir(), '.openfilm-dev');
}

/** `.dev/dev.pid` 的内容；不存在返回 null，坏文件返回 `{invalid:true}`。 */
export function readDevPid({ root = ROOT, exists = existsSync, readFile = readFileSync } = {}) {
  const file = PATHS.devPid(root);
  if (!exists(file)) return null;
  /** @type {any} */
  let parsed;
  try { parsed = JSON.parse(String(readFile(file, 'utf8'))); } catch { return { invalid: true, file }; }
  const pid = Number(parsed?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return { invalid: true, file };
  return { invalid: false, file, pid, record: parsed };
}

/** 进程是否还活着：`kill(pid, 0)`（EPERM 也算活着）。 */
export function pidAlive(pid, kill = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { kill(pid, 0); return true; } catch (error) { return /** @type {any} */ (error)?.code === 'EPERM'; }
}

/** `GET <origin>/api/health` 必须是 `product: 'openfilm-studio'`——端口上坐着别的东西不算「已在运行」。 */
export async function probeStudio(origin, { fetchImpl = fetch, timeoutMs = 1500 } = {}) {
  const base = String(origin ?? '').trim().replace(/\/+$/, '');
  if (!base) return { ok: false, reason: '没有 origin 可探' };
  const url = `${base}/api/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response?.ok) return { ok: false, reason: `${url} -> HTTP ${response?.status ?? '(无响应)'}` };
    const body = /** @type {any} */ (await response.json());
    if (body?.product !== 'openfilm-studio') return { ok: false, reason: `${url} 不是 openfilm-studio（product=${body?.product ?? '(缺)'}）` };
    return { ok: true, origin: base, home: body?.home ?? null };
  } catch (error) {
    const reason = /** @type {any} */ (error)?.name === 'AbortError' ? '超时' : String(/** @type {any} */ (error)?.message ?? error);
    return { ok: false, reason: `${url} 不可达：${reason}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Studio 写的 `run.json`（`{pid, origin, filmOrigin, key}`）；没有就 null。key 不打印。 */
export function readRunFile({ home = studioHome(), exists = existsSync, readFile = readFileSync } = {}) {
  const file = join(home, 'run.json');
  if (!exists(file)) return null;
  try { return { ...JSON.parse(String(readFile(file, 'utf8'))), file }; } catch { return null; }
}

/**
 * 已有实例？两条证据：`.dev/dev.pid` 的活进程，或 `~/.openfilm-dev/run.json` 的 Studio 能答 `/api/health`。
 * 死 pid / 坏 pid 文件顺手清掉。返回 `{running, origin, pid, how}` 或 `{running:false, cleaned}`。
 * @param {{root?: string, env?: NodeJS.ProcessEnv, readPid?: typeof readDevPid, alive?: typeof pidAlive,
 *   probe?: typeof probeStudio, runFile?: typeof readRunFile, log?: (line: string) => void,
 *   clear?: typeof clearDevPid}} [options]
 */
export async function detectExistingInstance({
  root = ROOT, env = process.env, readPid = readDevPid, alive = pidAlive, probe = probeStudio,
  runFile = readRunFile, log = console.log, clear = clearDevPid,
} = {}) {
  let cleaned = false;
  const record = readPid({ root });
  if (record?.invalid) {
    clear({ root });
    cleaned = true;
    log('  .dev/dev.pid 内容无效：已清理');
  } else if (record) {
    if (alive(record.pid)) {
      const home = studioHome(env);
      const fallbackOrigin = record.record?.origin || runFile({ home })?.origin || `http://127.0.0.1:4757`;
      const health = await probe(fallbackOrigin);
      if (health.ok) return { running: true, how: 'pid', origin: health.origin, pid: record.pid, cleaned };
      // 进程活着但端口探不到：仍算「已在运行」——另起一个只会争同一个 Studio 端口。
      return { running: true, how: 'pid-unreachable', origin: fallbackOrigin, pid: record.pid, cleaned, note: health.reason };
    }
    clear({ root });
    cleaned = true;
    log(`  .dev/dev.pid 指向死进程 ${record.pid}：已清理`);
  }

  const home = studioHome(env);
  const run = runFile({ home });
  if (run?.origin) {
    const health = await probe(run.origin);
    if (health.ok) return { running: true, how: 'studio', origin: health.origin, pid: run.pid ?? null, cleaned };
  }
  return { running: false, cleaned };
}

/** 写 `.dev/dev.pid`：`{pid, origin, environmentId, startedAt}`。 */
export function writeDevPid({ root = ROOT, pid, origin = null, environmentId = null, startedAt = new Date().toISOString() },
  { writeFile = writeFileSync, mkdir = mkdirSync } = {}) {
  const file = PATHS.devPid(root);
  mkdir(dirname(file), { recursive: true });
  writeFile(file, `${JSON.stringify({ pid, origin, environmentId, startedAt }, null, 2)}\n`, 'utf8');
  return file;
}

/** 删 `.dev/dev.pid`；`pid` 给定时只有它还是文件里的主人时才删（不删别人的）。 */
export function clearDevPid({ root = ROOT, pid = null },
  { readFile = readFileSync, exists = existsSync, remove = unlinkSync, log = () => {} } = {}) {
  const file = PATHS.devPid(root);
  if (!exists(file)) return false;
  try {
    const parsed = JSON.parse(String(readFile(file, 'utf8')));
    if (pid !== null && Number(parsed?.pid) !== Number(pid)) return false;
  } catch { /* 坏文件本身就该清掉 */ }
  try { remove(file); log(`  已清理 ${file}`); return true; } catch { return false; }
}

// ---------------------------------------------------------------------------
// 7. 起应用
// ---------------------------------------------------------------------------
/**
 * 派生 `pnpm dev:desktop`（stdio 继承，Ctrl+C 能到达）。返回 `{child, exit}`；`exit` 是应用的退出码。
 * @param {{root?: string, env?: NodeJS.ProcessEnv, spawnFn?: typeof spawn}} [options]
 */
export function startApp({ root = ROOT, env = process.env, spawnFn = spawn } = {}) {
  const child = spawnFn('pnpm', ['dev:desktop'], { cwd: root, stdio: 'inherit', env, shell: process.platform === 'win32' });
  const exit = new Promise((/** @type {(code: number) => void} */ done) => {
    child.once('exit', (code, signal) => done(typeof code === 'number' ? code : signal ? 1 : 0));
    child.once('error', (error) => {
      console.error(`  启动 pnpm dev:desktop 失败：${String(/** @type {any} */ (error)?.message ?? error)}`);
      done(1);
    });
  });
  return { child, exit };
}

/**
 * 等 Studio 写出 `run.json` 的 origin 且 `/api/health` 通过（窗口真的起来了），最多 `timeoutMs`。
 * @param {{home?: string, timeoutMs?: number, pollMs?: number, readRun?: typeof readRunFile,
 *   probe?: typeof probeStudio, sleep?: (ms: number) => Promise<unknown>, now?: () => number}} [options]
 */
export async function watchStudioOrigin({
  home = studioHome(), timeoutMs = STUDIO_TIMEOUT_MS, pollMs = 500, readRun = readRunFile,
  probe = probeStudio, sleep = wait, now = () => Date.now(),
} = {}) {
  const startedAt = now();
  while (now() - startedAt < timeoutMs) {
    const run = readRun({ home });
    if (run?.origin) {
      const health = await probe(run.origin);
      if (health.ok) return { ok: true, origin: health.origin, pid: run.pid ?? null, filmOrigin: run.filmOrigin ?? null };
    }
    await sleep(pollMs);
  }
  return { ok: false, reason: `${(timeoutMs / 1000).toFixed(0)}s 内没有等到 ${join(home, 'run.json')} 的 origin 通过 /api/health` };
}

// ---------------------------------------------------------------------------
// 编排
// ---------------------------------------------------------------------------
/**
 * 七步，一步一停。返回进程退出码；任何一步失败都在那一步返回，第 7 步之前不派生任何窗口。
 * @param {{root?: string, env?: NodeJS.ProcessEnv, log?: (line: string) => void,
 *   warn?: (line: string) => void, error?: (line: string) => void, deps?: Record<string, Function>}} [options]
 */
export async function devAll({
  root = ROOT, env = process.env, log = console.log, warn = console.warn, error = console.error, deps = {},
} = {}) {
  const step = (/** @type {number} */ index, /** @type {string} */ label) => log(`[${index}/7] ${label}`);

  // 1 —— 环境
  step(1, '环境（.dev/auth-runtime.json + 子进程环境变量）');
  /** @type {ReturnType<typeof resolveAuthRuntime>} */
  let auth;
  try {
    auth = (deps.resolveAuth ?? resolveAuthRuntime)({ root, env });
  } catch (error_) {
    const failure = /** @type {StepError} */ (error_);
    error(`第 1 步（环境）失败：${failure?.message ?? String(error_)}`);
    return typeof failure?.code === 'number' ? failure.code : EXIT.config;
  }
  log(`  环境：${describeEnvironment(auth.environment)}${auth.source === 'file' ? `（来源 ${auth.file}）` : '（本地默认）'}`);
  if (auth.note) warn(`  提示：${auth.note}`);
  const childEnv = (deps.childEnv ?? childEnvironment)(process.env, { root, auth });
  log(`  ORANGE_AUTH_CONFIG_FILE=${childEnv.ORANGE_AUTH_CONFIG_FILE ?? '(未设置)'}`);
  log(`  ORANGE_FISSION_CONFIG_FILE=${childEnv.ORANGE_FISSION_CONFIG_FILE ?? '(未设置)'}`);

  // 2 —— 依赖服务
  step(2, `依赖服务（${DB_CONTAINER} @ 127.0.0.1:${DB_PORT}）`);
  const services = await (deps.ensureServices ?? ensureDependencyServices)({ root, log, env: childEnv });
  if (!services.ok) {
    error(`依赖服务未就绪：${services.reason}`);
    error('  按顺序做：docker compose -f infra/docker-compose.yml up -d，等 (healthy) 后重跑 pnpm dev:all');
    return EXIT.services;
  }
  log(`  ${services.note}`);

  // 3 —— 迁移
  step(3, '迁移（node infra/migrate.mjs --target local）');
  const migration = await (deps.migrate ?? runMigrations)({ root, env: childEnv });
  if (migration.code !== 0) {
    error(`迁移失败（exit ${migration.code}）：按迁移自己的码停下，不启动应用`);
    return migration.code;
  }
  log('  迁移通过');

  // 4 —— 校验
  step(4, '校验（node infra/verify.mjs）');
  const verification = await (deps.verify ?? runVerify)({ root, env: childEnv });
  const checks = Array.isArray(verification.report?.checks) ? verification.report.checks : [];
  if (checks.length) {
    const passed = checks.filter((/** @type {any} */ check) => check.ok).length;
    for (const c of verification.report.notes ?? []) log(`  ${c.level} ${c.detail}`);
    log(`  verify ${passed}/${checks.length}`);
  }
  if (verification.code !== 0 || verification.failed?.length) {
    const named = (verification.failed ?? []).map((/** @type {any} */ check) => `FAIL ${check.id}：${check.detail}`);
    for (const line of named) error(`  ${line}`);
    error(`校验失败（exit ${verification.code}）${named.length ? `：${named.length} 项未通过` : ''}，不启动应用`);
    return EXIT.services;
  }
  log('  9 项检查全过');

  // 5 —— 素材索引（detached，不阻塞；它失败也不影响启动）
  step(5, '素材索引（material-index-bootstrap，detached）');
  const bootstrap = (deps.startIndex ?? startMaterialIndexBootstrap)();
  if (bootstrap.spawned) log(`  已派发自举（detached，pid ${bootstrap.pid ?? '?'}），不等它`);
  else warn(`  自举没能启动（${bootstrap.error ?? 'unknown'}），不影响应用启动`);
  const status = await (deps.indexStatus ?? indexStatus)({ root, env: childEnv });
  const statusLines = String(status.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (statusLines.length) for (const line of statusLines) log(`  索引：${line}`);
  else warn(`  索引状态读不出来（exit ${status.code}）：${firstLine(status.stderr) || '无输出'}`);

  // 6 —— 单例
  step(6, '单例检查（.dev/dev.pid 与 Studio /api/health）');
  const existing = await (deps.detectExisting ?? detectExistingInstance)({ root, env: childEnv, log });
  if (existing.running) {
    log(`已在运行：origin ${existing.origin}（pid ${existing.pid ?? '?'}，证据 ${existing.how}），不另起`);
    if (existing.note) warn(`  注意：进程活着但端口没探到（${existing.note}）`);
    return EXIT.ok;
  }

  // 7 —— 起应用
  step(7, '启动应用（pnpm dev:desktop）');
  const app = (deps.startApp ?? startApp)({ root, env: childEnv });
  const appPid = Number(app.child?.pid) || null;
  const startedAt = new Date().toISOString();
  writeDevPid({ root, pid: appPid ?? process.pid, origin: null, environmentId: auth.environment.environmentId, startedAt });
  log(`  已写 .dev/dev.pid（pid ${appPid ?? '?'}，environmentId ${auth.environment.environmentId}）`);
  const cleanup = () => { try { clearDevPid({ root, pid: appPid }); } catch { /* 退出路径上不再抛 */ } };
  process.once('exit', cleanup);

  const window = await (deps.watchStudio ?? watchStudioOrigin)({ home: studioHome(childEnv) });
  if (window.ok) {
    writeDevPid({ root, pid: appPid ?? process.pid, origin: window.origin, environmentId: auth.environment.environmentId, startedAt });
    log(`  窗口：origin ${window.origin}${window.filmOrigin ? ` / film ${window.filmOrigin}` : ''}`);
    log(`  能登录能用：${describeEnvironment(auth.environment)}`);
  } else {
    warn(`  窗口 origin 没能确认：${window.reason}（应用进程仍在跑，继续等它退出）`);
  }

  const code = await app.exit;
  clearDevPid({ root, pid: appPid });
  log(`应用已退出（exit ${code}），pid 文件已清理`);
  return code;
}

const isMain = () => {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return samePath(fileURLToPath(import.meta.url), entry); } catch { return false; }
};

if (isMain()) process.exitCode = await devAll();
