// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The read-only material service (`apps/api`), as the window's second child process.
 *
 * It mirrors `studio-process.mjs`: one child, one `ready`/`failed` outcome, and a stop that is safe to call from
 * every exit path. The differences are the ones that matter here:
 *
 *  - the child is a plain Node process, not an Electron utility process, so there is no `postMessage`: the port it
 *    bound arrives on its own `[materials-api] ready … port=<n>` line, and a refusal arrives as
 *    `[materials-api] refusing: <code>` with a non-zero exit (apps/api/src/main.ts);
 *  - the port is never a constant: an explicit `port`, the isolated profile's when it names one, else `0` — the
 *    service binds an ephemeral port and the parent learns it from the ready line (no free-port race);
 *  - the shared secret is minted here (`randomBytes(32)`), handed over in the child's environment only, and never
 *    written to a log, an error or a message: every line this module emits goes through `redact()`.
 *
 * Nothing here imports Electron: it is a plain module so the tests can spawn a fixture instead of the real service.
 */
import { spawn as spawnChild } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The line the service prints once it listens (`apps/api/src/main.ts`). */
const READY = /\[materials-api\]\s+ready\b[^\n]*\bport=(\d{1,5})\b/;
/** The line it prints for a refusal it decided on, before leaving with a non-zero code. */
const REFUSING = /\[materials-api\]\s+refusing:\s*([A-Za-z0-9._-]+)/;

const DEFAULT_CHECKOUT = fileURLToPath(new URL('../../../', import.meta.url));
const DEFAULT_CREDENTIALS = ['.dev', 'zhishang', 'credentials.local.json'];
const DEFAULT_BINDINGS = ['.dev', 'zhishang', 'bindings.local.json'];
const DEFAULT_STAGING = ['.dev', 'staging'];
const SECRET_BYTES = 32;

/**
 * The checkout a packaged app reads its material service from: the unpacked half of the archive.
 * `apps/api` is unpacked because a plain `node` child cannot read inside an asar.
 * @param {string} resourcesPath `process.resourcesPath` of the running app
 */
export function packagedMaterialRoot(resourcesPath) {
  return join(resolve(resourcesPath), 'app.asar.unpacked');
}

/** The service's entry, always spelled out from a checkout root — never found through the working directory. */
export function materialServiceEntry(checkout) {
  return join(resolve(checkout), 'apps', 'api', 'src', 'main.ts');
}

/** The ignored binding file the service is told about, beside the credentials one. Path only; never read here. */
export function materialBindingsPath(checkout) {
  return join(resolve(checkout), ...DEFAULT_BINDINGS);
}

/**
 * Where the service stages what it fetches. It is a directory of its own (never the checkout root, never the
 * credentials folder): its contents are disposable, and the caller may put it on any writable volume it likes.
 * The default is the ignored `.dev/staging` of a source checkout.
 */
export function materialStagingPath(checkout) {
  return join(resolve(checkout), ...DEFAULT_STAGING);
}

/**
 * Make sure the staging directory exists before the service is asked to start: `apps/api` refuses to come up
 * without it (`staging-missing`) and refuses a path that is not a directory (`staging-not-directory`), and
 * neither refusal is something a person can act on from the window.
 * @param {string} staging
 * @param {(path: string, options: {recursive: boolean}) => unknown} [make] injected in tests
 */
export function ensureStagingDirectory(staging, make = (path, options) => mkdirSync(path, options)) {
  try {
    make(staging, { recursive: true });
  } catch (error) {
    throw new MaterialServiceError('staging-unavailable', '素材服务暂存目录不可用（staging-unavailable）：' + staging, { cause: error });
  }
  return staging;
}

/** A start that did not happen, said as a reason rather than a stack: the callers keep it to one line. */
export class MaterialServiceError extends Error {
  /**
   * @param {string} reason one of `spawn-failed`, `health-timeout`, `start-timeout`, `credentials-missing`,
   *   `staging-unavailable`, `port-in-use`, `refused:<code>`, `exited:<code>`
   * @param {string} message what a person can act on
   * @param {{cause?: unknown, detail?: string}} [extra]
   */
  constructor(reason, message, extra = {}) {
    super(message);
    this.name = 'MaterialServiceError';
    this.reason = reason;
    this.code = reason;
    if (extra.detail !== undefined) this.detail = extra.detail;
    if (extra.cause !== undefined) this.cause = extra.cause;
  }
}

/** A refusal code from the service, as the parent's own word for it. */
export function reasonForRefusal(code) {
  if (code === 'port-unavailable') return 'port-in-use';
  return 'refused:' + code;
}

/**
 * What Studio needs in its own environment to build the material service it proxies to
 * (`materialsServiceFromEnv` in `studio/server/materials-proxy.mjs`): the loopback upstream and the shared
 * secret of the internal hop. This is the only place that names `MATERIALS_SECRET`; the window hands the pair
 * over as an environment and never spells the variable out itself.
 * @param {{origin: string, secret: string}} service a handle from {@link startMaterialService}
 * @returns {Record<string, string>}
 */
export function studioMaterialEnvironment(service) {
  const origin = typeof service?.origin === 'string' ? service.origin.trim() : '';
  const secret = typeof service?.secret === 'string' ? service.secret : '';
  if (!origin || !secret) throw new MaterialServiceError('configuration-required', '素材服务未就绪，Studio 的素材库将保持未接通');
  return { MATERIALS_UPSTREAM: origin, MATERIALS_SECRET: secret };
}

/**
 * Start the material service, **then** Studio with the environment that lets it reach one.
 *
 * The order is the point: Studio composes its material routes once, when it is constructed, from
 * `MATERIALS_UPSTREAM`/`MATERIALS_SECRET` — a service started after Studio exists is a service Studio never hears
 * about, and its three routes answer 501 `material-service-unavailable` for the life of that Studio. A service that
 * could not start therefore only leaves the window without a library; Studio starts anyway.
 *
 * @param {{env: Record<string, string | undefined>, materials: () => Promise<{origin: string, secret: string} | null>,
 *          launch: (env: Record<string, string | undefined>) => Promise<unknown>}} options
 */
export async function startStudioBesideMaterials({ env, materials, launch }) {
  let service = null;
  try {
    service = await materials();
  } catch {
    /* startMaterialService already reports a reason; the window keeps working without a library */
    service = null;
  }
  const studioEnv = service ? { ...env, ...studioMaterialEnvironment(service) } : env;
  return launch(studioEnv);
}

/**
 * The child's environment: everything the service reads, and nothing it must not see twice.
 * `MATERIALS_SECRET` is passed here and nowhere else.
 * @param {{checkout?: string, credentials?: string, bindings?: string, staging?: string, secret?: string, port?: number, origins?: readonly string[],
 *          sessionMode?: string, env?: Record<string, string | undefined>}} options
 * @returns {Record<string, string>}
 */
export function materialServiceEnvironment(options = {}) {
  const checkout = resolve(options.checkout ?? DEFAULT_CHECKOUT);
  const credentials = resolve(options.credentials ?? join(checkout, ...DEFAULT_CREDENTIALS));
  const bindings = resolve(options.bindings ?? join(checkout, ...DEFAULT_BINDINGS));
  const staging = resolve(options.staging ?? join(checkout, ...DEFAULT_STAGING));
  const secret = options.secret ?? randomBytes(SECRET_BYTES).toString('hex');
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new MaterialServiceError('port-invalid', '素材服务端口不合法：' + String(port));
  return {
    ...baseEnvironment(options.env),
    MATERIALS_PORT: String(port),
    MATERIALS_SECRET: secret,
    MATERIALS_CREDENTIALS: credentials,
    /* the service refuses to start without it (`bindings-missing`), so it travels the same way the credentials do */
    MATERIALS_BINDINGS: bindings,
    /* the service stages what it fetches and refuses to come up without a directory to stage it in */
    MATERIALS_STAGING: staging,
    MATERIALS_ORIGINS: (options.origins ?? []).join(','),
    MATERIALS_SESSION_MODE: options.sessionMode ?? 'hmac',
  };
}

/** The environment the child inherits: the parent's, minus what would make it a second Electron. */
function baseEnvironment(env = process.env) {
  /** @type {Record<string, string>} */
  const inherited = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === 'string') inherited[key] = value;
  delete inherited.ELECTRON_RUN_AS_NODE;
  /* a child of Electron is still `electron`, not `node`, unless it is told to run as Node */
  if (process.versions.electron) inherited.ELECTRON_RUN_AS_NODE = '1';
  return inherited;
}

/** Every line this module emits, with the secret taken out of it — the child may echo back what it was given. */
export function redact(line, secret) {
  const text = String(line ?? '');
  if (!secret) return text;
  return text.split(secret).join('[redacted]');
}

/** Wait for `promise` at most `ms`; `null` when it did not settle in time. */
function within(promise, ms) {
  return new Promise((resolveWithin) => {
    const timer = setTimeout(() => resolveWithin(null), ms);
    promise.then((value) => { clearTimeout(timer); resolveWithin(value); }, () => { clearTimeout(timer); resolveWithin(null); });
  });
}

/**
 * Start the material service and wait until it answers `/health`.
 *
 * Resolves with `{ origin, secret, port, stop(), kill() }`; rejects with a {@link MaterialServiceError} that carries
 * `reason` (`spawn-failed`, `health-timeout`, `start-timeout`, `credentials-missing`, `port-in-use`, `refused:<code>`,
 * `exited:<code>`) and a one-line message — never a bare stack, never the secret.
 *
 * @param {{checkout?: string, entry?: string, credentials?: string, bindings?: string, staging?: string, port?: number, origins?: readonly string[],
 *          sessionMode?: string, secret?: string, command?: string, args?: readonly string[],
 *          env?: Record<string, string | undefined>, log?: (line: string) => void, fetch?: typeof fetch,
 *          spawn?: typeof spawnChild, exists?: (path: string) => boolean, makeDirectory?: (path: string, options: {recursive: boolean}) => unknown,
 *          healthTimeoutMs?: number, healthPollMs?: number, stopTimeoutMs?: number, killTimeoutMs?: number}} [options]
 * @returns {Promise<{origin: string, secret: string, port: number, env: Record<string, string>, stop: () => Promise<{exited: boolean, code: number | null}>, kill: () => void, child: import('node:child_process').ChildProcess}>}
 */
export async function startMaterialService(options = {}) {
  const checkout = resolve(options.checkout ?? DEFAULT_CHECKOUT);
  const entry = resolve(options.entry ?? materialServiceEntry(checkout));
  const credentials = resolve(options.credentials ?? join(checkout, ...DEFAULT_CREDENTIALS));
  const bindings = resolve(options.bindings ?? join(checkout, ...DEFAULT_BINDINGS));
  const staging = resolve(options.staging ?? join(checkout, ...DEFAULT_STAGING));
  const healthTimeoutMs = options.healthTimeoutMs ?? 10_000;
  const healthPollMs = options.healthPollMs ?? 50;
  const stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
  const killTimeoutMs = options.killTimeoutMs ?? 2_000;
  const secret = options.secret ?? randomBytes(SECRET_BYTES).toString('hex');
  const log = (line) => { const clean = redact(line, secret).replace(/\s+$/, ''); if (clean) options.log?.(clean + '\n'); };
  const exists = options.exists ?? ((path) => { try { return statSync(path).isFile(); } catch { return false; } });
  const spawn = options.spawn ?? spawnChild;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  if (!exists(credentials)) {
    throw new MaterialServiceError('credentials-missing', '素材服务缺少凭据文件（credentials-missing）：' + credentials);
  }
  if (!exists(entry)) {
    throw new MaterialServiceError('spawn-failed', '素材服务入口不存在（spawn-failed）：' + entry);
  }
  /* the service will not start without a staging directory, and a person cannot act on that refusal from the window */
  ensureStagingDirectory(staging, options.makeDirectory);

  const env = materialServiceEnvironment({ checkout, credentials, bindings, staging, secret, port: options.port ?? 0, origins: options.origins ?? [], env: options.env });
  const command = options.command ?? process.execPath;
  const args = [...(options.args ?? [entry])];

  let child;
  try {
    child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } catch (error) {
    throw new MaterialServiceError('spawn-failed', '素材服务无法启动：' + command, { cause: error });
  }

  let exited = false;
  /** @type {number | null} */
  let exitCode = null;
  const exitWaiters = [];
  const whenExited = new Promise((settle) => exitWaiters.push(settle));

  child.on('exit', (code, signal) => {
    exited = true;
    exitCode = typeof code === 'number' ? code : null;
    for (const settle of exitWaiters.splice(0)) settle({ code: exitCode, signal: signal ?? null });
  });
  child.on('error', (error) => {
    /* a spawn that never became a process lands here too; the waiters still need an answer */
    exited = true;
    for (const settle of exitWaiters.splice(0)) settle({ code: null, signal: null, error });
  });

  let stopped = null;
  const stop = () => {
    if (stopped) return stopped;
    stopped = (async () => {
      if (exited) return { exited: true, code: exitCode };
      try { child.stdin?.end(); } catch { /* the pipe is already gone */ }
      const closed = await within(whenExited, stopTimeoutMs);
      if (closed) return { exited: true, code: exitCode };
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      if (await within(whenExited, killTimeoutMs)) return { exited: true, code: exitCode };
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      await within(whenExited, killTimeoutMs);
      return { exited, code: exitCode };
    })();
    return stopped;
  };
  const kill = () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };

  /** @type {{code: number | null, signal: string | null, error?: Error} | null} */
  let ended = null;
  child.once('exit', (code, signal) => { ended = { code: typeof code === 'number' ? code : null, signal: signal ?? null }; });
  child.once('error', (error) => { ended = { code: null, signal: null, error }; });

  /** Lines the child prints, read until the port is known or the child refuses. */
  let bound = null;
  let refusal = null;
  let pending = '';
  const onLine = (line) => {
    log(line);
    if (bound !== null || refusal !== null) return;
    const refusing = REFUSING.exec(line);
    if (refusing) { refusal = refusing[1]; return; }
    const ready = READY.exec(line);
    if (ready) bound = Number(ready[1]);
  };
  child.stdout?.on('data', (chunk) => {
    pending += String(chunk);
    let at;
    while ((at = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, at); pending = pending.slice(at + 1); onLine(line); }
  });
  child.stderr?.on('data', (chunk) => {
    pending += String(chunk);
    let at;
    while ((at = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, at); pending = pending.slice(at + 1); onLine(line); }
  });

  const started = await new Promise((settle) => {
    const asked = Date.now();
    /* one self-clearing poll: every branch below leaves no timer behind, so a failed start cannot keep the app up */
    const poll = setInterval(() => {
      if (refusal !== null) { clearInterval(poll); settle({ refused: refusal }); return; }
      if (bound !== null) { clearInterval(poll); settle({ bound }); return; }
      if (exited) { clearInterval(poll); settle({ ended }); return; }
      if (Date.now() - asked >= healthTimeoutMs) { clearInterval(poll); settle(null); }
    }, 10);
  });

  if (!started) { await stop(); throw new MaterialServiceError('start-timeout', '素材服务在 ' + healthTimeoutMs + ' ms 内既未就绪也未退出（start-timeout）'); }
  if (started.refused) { await stop(); throw new MaterialServiceError(reasonForRefusal(started.refused), '素材服务拒绝启动：' + reasonForRefusal(started.refused)); }
  if (started.ended) {
    await stop();
    if (started.ended.error) {
      throw new MaterialServiceError('spawn-failed', '素材服务无法启动：' + command, { cause: started.ended.error });
    }
    const code = started.ended.code;
    const reason = 'exited:' + (code === null ? 'signal' : String(code));
    throw new MaterialServiceError(reason, '素材服务启动时退出（' + reason + '）', { cause: started.ended.error });
  }

  const port = started.bound;
  const origin = 'http://127.0.0.1:' + port;

  /** `/health` is the service's own word that it is listening; the ready line alone is not enough. */
  const deadline = Date.now() + healthTimeoutMs;
  for (;;) {
    let healthy = false;
    try {
      const response = await fetchImpl(origin + '/health', { cache: 'no-store', signal: AbortSignal.timeout(Math.max(250, Math.min(2_000, healthTimeoutMs))) });
      const body = await response.json().catch(() => null);
      healthy = response.ok && body?.ok === true && typeof body.version === 'string';
    } catch { healthy = false; }
    if (healthy) break;
    if (exited) { const reason = 'exited:' + (exitCode === null ? 'signal' : String(exitCode)); await stop(); throw new MaterialServiceError(reason, '素材服务在就绪后退出（' + reason + '）'); }
    if (Date.now() >= deadline) { await stop(); throw new MaterialServiceError('health-timeout', '素材服务在 ' + healthTimeoutMs + ' ms 内未通过 /health 检查（health-timeout）'); }
    await new Promise((done) => setTimeout(done, healthPollMs));
  }

  return Object.freeze({ origin, secret, port, env: Object.freeze({ ...env }), stop, kill, child });
}
