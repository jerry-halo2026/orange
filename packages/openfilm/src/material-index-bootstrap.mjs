// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * Bootstrapping the material index: nobody has to remember the CLI any more.
 *
 * `material-index-build.mjs` already knows how to fill the file and how to land it whole (tmp → verified → renamed).
 * What it never did was *start* on its own: a person had to run `material-index-build.mjs` after every 24 h window, and
 * a computer that never ran it served the smaller page walk from `GET /api/materials/index`'s 404 fallback. This file
 * adds the missing half — a start path that can be called by any launcher (the CLI, `pnpm dev:desktop`) and that
 * answers with a **state** while it works, instead of blocking whatever called it.
 *
 * # Three states, and where each one is read from
 *
 *  1. `absent` / `building` — no `index.json` yet. A build is claimed by writing `.building` (exclusive create, the
 *     claimant's pid and `startedAt` inside) and its progress goes to `status.json`. A caller returns at once; the
 *     reader shows `building` and then, as soon as the file lands, `landed` — no switch to code, because the switch is
 *     the file appearing.
 *  2. `stale` — the file is there but past its own `generatedAt + staleAfterMs` window. The **old data is served first**
 *     (`data`), the rebuild starts in the background, and only the atomic rename inside `writeMaterialIndex` replaces it.
 *     A failed rebuild therefore leaves the old data readable — that is the point of the order.
 *  3. `failed` — the build threw, or the write threw, and there is no index to serve. The reason is written to
 *     `status.json` (`outcome.code`, `outcome.message`, `outcome.warnings`) so a reader can say why instead of showing
 *     an empty tree. Nothing here is silent: `buildMaterialIndexFromApi`'s own warnings are carried into the same array.
 *
 * # What a launcher gets
 *
 * `bootstrapMaterialIndex()` decides (`materialIndexStatus()`), starts a build when one is needed, and returns
 * immediately when `background` is true: for a missing index that is `{action: 'building', state: 'building', data: null}`,
 * for a stale one `{action: 'building', state: 'stale', data: <the old file>}`. Await `rebuild` when you do want to wait
 * (`--wait` in the CLI). A second caller while one build is out does not start a second sweep: it sees the live marker
 * and reports `building`.
 *
 * The marker is a claim with an expiry (`MARKER_EXPIRES_MS`): a window that was killed mid-sweep leaves a `.building`
 * behind, and a later launch reclaims it — by the pid being gone, or by the claim being older than any real sweep.
 *
 * Everything that touches the file system takes an injectable seam (`read`, `pidAlive`, `write`, `now`) so the whole
 * state machine is testable without a network, a Studio, or a second process.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';

import { indexAgeMs, isIndexStale, materialIndexPath, readMaterialIndex } from './material-index-build.mjs';

/** The `status.json` schema: its own, because it is not the index and must never be read as one. */
export const BOOTSTRAP_SCHEMA = 'orange/material-index-status/1';

/** The claim file, beside `index.json`: present exactly while a build is running. */
export const BUILDING_MARKER = '.building';
/** The progress/outcome file beside `index.json`: what a reader polls while a build runs, and after one failed. */
export const STATUS_FILE = 'status.json';

/** A claim older than this is abandoned even if its pid looks alive (a recycled pid, a suspended laptop). */
export const MARKER_EXPIRES_MS = 30 * 60 * 1000;
/** A claim written before its child has a pid (the launcher's optimistic claim) is honoured this long. */
export const PENDING_GRACE_MS = 15 * 1000;
/** How often the progress file is rewritten while pages are arriving (a 790-page sweep must not hammer the disk). */
export const PROGRESS_EVERY_MS = 1500;

/** The five states a reader can be shown; nothing else is reported. */
export const INDEX_STATES = Object.freeze(['absent', 'building', 'landed', 'stale', 'failed']);

/** `index.json`, `.building` and `status.json` in one directory. */
export function bootstrapPaths(dir) {
  return {
    dir,
    file: materialIndexPath(dir),
    marker: join(dir, BUILDING_MARKER),
    status: join(dir, STATUS_FILE),
  };
}

/**
 * Whether a pid is a live process. `EPERM` means "alive, but not ours" — still alive, so another build is not started
 * over it.
 * @param {unknown} pid
 */
export function processAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  if (value === process.pid) return true;
  try { process.kill(value, 0); return true; }
  catch (error) { return String(/** @type {any} */ (error)?.code ?? '') === 'EPERM'; }
}

/** A small JSON file, or `null` for missing / unparseable / not-an-object. Never throws: these are status reads. */
function readJsonFile(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? /** @type {any} */ (parsed) : null;
  } catch { return null; }
}

const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** Rename over the target, retrying while Windows says the file is busy (Defender, the indexer, OneDrive). */
async function replaceFile(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { return await rename(from, to); }
    catch (error) {
      const code = String(/** @type {any} */ (error)?.code ?? '');
      if (process.platform !== 'win32' || !BUSY.has(code) || attempt >= 8) throw error;
      await new Promise((done) => setTimeout(done, 20 * 2 ** attempt));
    }
  }
}

/**
 * The build claim, as it is on disk, with the two questions a caller asks of it: is it *live* (a sweep is running now),
 * and is it *abandoned* (a claim whose owner is gone, or one older than any sweep).
 *
 * @param {string} dir
 * @param {{now?: Date, pidAlive?: (pid: unknown) => boolean}} [options]
 */
export function readBuildingMarker(dir, { now = new Date(), pidAlive = processAlive } = {}) {
  const { marker } = bootstrapPaths(dir);
  const raw = readJsonFile(marker);
  if (!raw) return null;
  const startedAt = typeof raw.startedAt === 'string' ? raw.startedAt : null;
  const at = Date.parse(String(startedAt ?? ''));
  const ageMs = Number.isFinite(at) ? Math.max(0, now.getTime() - at) : null;
  const pid = Number.isInteger(raw.pid) ? Number(raw.pid) : null;
  /* No pid yet: the launcher claimed the marker and is about to hand it to a child — live for a grace period only. */
  const alive = pid === null ? (ageMs === null || ageMs < PENDING_GRACE_MS) : Boolean(pidAlive(pid));
  const expired = ageMs !== null && ageMs >= MARKER_EXPIRES_MS;
  return {
    pid,
    startedAt,
    reason: typeof raw.reason === 'string' ? raw.reason : null,
    ageMs,
    alive,
    expired,
    live: alive && !expired,
  };
}

/**
 * Claim the one build slot: create `.building` exclusively (`wx`), so two launchers cannot both sweep the supplier.
 *
 * A claim whose owner is gone is taken over (the marker is removed, then created again) — that is how a killed window
 * stops blocking every later launch. The second read after a failed exclusive create is what makes the difference
 * between "someone is building" and "someone died building".
 *
 * @param {string} dir
 * @param {{now?: Date, pid?: number | null, reason?: string, pidAlive?: (pid: unknown) => boolean}} [options]
 */
export function claimBuild(dir, { now = new Date(), pid = process.pid, reason = 'missing', pidAlive = processAlive } = {}) {
  const { marker } = bootstrapPaths(dir);
  try { mkdirSync(dir, { recursive: true }); } catch { /* an unwritable dir fails the build below, loudly */ }
  const text = `${JSON.stringify({ state: 'building', pid: Number.isInteger(pid) ? pid : null, startedAt: now.toISOString(), reason }, null, 2)}\n`;
  try {
    writeFileSync(marker, text, { encoding: 'utf8', flag: 'wx' });
    return { claimed: true, reclaimed: false, holder: null };
  } catch (error) {
    if (String(/** @type {any} */ (error)?.code ?? '') !== 'EEXIST') throw error;
  }
  const holder = readBuildingMarker(dir, { now, pidAlive });
  if (holder?.live) return { claimed: false, reclaimed: false, holder };
  /* the previous owner is gone (or the claim is past its expiry): take the slot over */
  try { rmSync(marker, { force: true }); } catch { /* it may have vanished between the two reads */ }
  try {
    writeFileSync(marker, text, { encoding: 'utf8', flag: 'wx' });
    return { claimed: true, reclaimed: true, holder: null };
  } catch (error) {
    return { claimed: false, reclaimed: false, holder: readBuildingMarker(dir, { now, pidAlive }) ?? holder };
  }
}

/** Drop the claim: the build is over, whichever way it went. */
export function releaseBuild(dir) {
  try { rmSync(bootstrapPaths(dir).marker, { force: true }); return true; } catch { return false; }
}

/** The last build's outcome as `status.json` recorded it (`state: 'building' | 'landed' | 'failed'`), or `null`. */
export function readBuildOutcome(dir) {
  const status = readJsonFile(bootstrapPaths(dir).status);
  const outcome = status?.outcome;
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) return null;
  return /** @type {any} */ (outcome);
}

/**
 * Merge `patch` into `status.json`, atomically (tmp → rename), so a poller never reads half a progress record.
 * A status file that cannot be written never fails a build: it is the report, not the work.
 */
export async function writeBuildStatus(dir, patch) {
  const paths = bootstrapPaths(dir);
  const before = readJsonFile(paths.status) ?? {};
  const next = { ...before, ...patch, schema: BOOTSTRAP_SCHEMA, dir, file: paths.file, updatedAt: new Date().toISOString() };
  const text = `${JSON.stringify(next, null, 2)}\n`;
  const tmp = `${paths.status}.tmp`;
  try {
    try { mkdirSync(dir, { recursive: true }); } catch { /* the same directory the index lands in */ }
    writeFileSync(tmp, text, 'utf8');
    await replaceFile(tmp, paths.status);
  } catch {
    try { rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
  }
  return next;
}

/**
 * What a reader is shown, without building anything. This is the contract the UI polls (and the CLI's `--status`):
 *
 *  - `state` is exactly one of {@link INDEX_STATES}; `landed` means "the file is here and inside its window";
 *  - `rebuilding` is true while a sweep runs, whatever `state` says — a stale index is served *and* rebuilt;
 *  - `building.progress` is the last page the sweep reported (`videoType`, `pageNo`, `rows`, `fresh`);
 *  - `failed` is the reason, with `warnings`, when there is no index to serve;
 *  - `warnings` are the landed build's own (`buildMaterialIndexFromApi`'s), so the API's `warnings` and this agree.
 *
 * @param {string} dir
 * @param {{now?: Date, pidAlive?: (pid: unknown) => boolean, read?: (path: string, encoding: 'utf8') => string}} [options]
 */
export function materialIndexStatus(dir, { now = new Date(), pidAlive = processAlive, read } = {}) {
  const landed = readMaterialIndex(dir, read ? /** @type {any} */ ({ read }) : undefined);
  const stale = landed ? isIndexStale(landed, { now }) : false;
  const marker = readBuildingMarker(dir, { now, pidAlive });
  const outcome = readBuildOutcome(dir);
  const live = Boolean(marker?.live);
  const state = landed
    ? (stale ? 'stale' : 'landed')
    : live ? 'building' : outcome?.state === 'failed' ? 'failed' : 'absent';
  const failed = outcome?.state === 'failed'
    ? {
      at: typeof outcome.at === 'string' ? outcome.at : null,
      code: typeof outcome.code === 'string' ? outcome.code : 'build-failed',
      message: typeof outcome.message === 'string' ? outcome.message : '素材索引构建失败',
      warnings: Array.isArray(outcome.warnings) ? outcome.warnings : [],
    }
    : null;
  return {
    schema: BOOTSTRAP_SCHEMA,
    dir,
    file: materialIndexPath(dir),
    state,
    rebuilding: live,
    building: live && marker
      ? {
        pid: marker.pid,
        startedAt: marker.startedAt,
        ageMs: marker.ageMs,
        reason: marker.reason,
        progress: outcome?.state === 'building' && outcome.progress ? outcome.progress : null,
      }
      : null,
    generatedAt: landed?.generatedAt ?? null,
    ageMs: landed ? indexAgeMs(landed, now) : null,
    staleAfterMs: Number(landed?.staleAfterMs) > 0 ? Number(landed?.staleAfterMs) : null,
    stale,
    videos: typeof landed?.videos === 'number' ? landed.videos : null,
    totals: landed?.index?.totals ?? null,
    warnings: Array.isArray(landed?.warnings) ? landed.warnings : [],
    failed,
    checkedAt: now.toISOString(),
  };
}

/**
 * Whether a start path has work to do, and why — the question `--detach` asks before spawning anything.
 * `busy` is not work: another process holds the claim.
 * @param {string} dir
 * @param {{now?: Date, force?: boolean, pidAlive?: (pid: unknown) => boolean, status?: ReturnType<typeof materialIndexStatus>}} [options]
 */
export function materialIndexBootstrapPlan(dir, { now = new Date(), force = false, pidAlive = processAlive, status } = {}) {
  const state = status ?? materialIndexStatus(dir, { now, pidAlive });
  const reason = state.rebuilding && !force
    ? 'busy'
    : force ? 'forced' : state.state === 'landed' ? 'fresh' : state.state === 'stale' ? 'stale' : state.state === 'failed' ? 'failed' : 'missing';
  return {
    needed: reason !== 'fresh' && reason !== 'busy',
    reason,
    state: state.state,
    stale: state.stale,
    rebuilding: state.rebuilding,
  };
}

/**
 * Run one build under the claim, and record it.
 *
 * Claims **synchronously** (so a poller sees `building` the moment this is called), then:
 *
 *  - `build({onPage})` — the sweep, throttled by its own builder; every page it reports updates `status.json`
 *    (throttled by `progressEveryMs`, and always at the start, at the first page and at the end);
 *  - `write(dir, result)` — the atomic landing (`writeMaterialIndex`); only after it returns does the claim drop and the
 *    state become `landed`;
 *  - on any throw, the claim drops anyway and `status.json` gets `state: 'failed'` with the code, the message and the
 *    `warnings` seen so far — plus one `build-failed` entry naming the failure. The previous `index.json` is untouched
 *    (the writer guarantees it), so a stale read stays possible.
 *
 * Never throws for a build failure: it returns `{ok: false, error, failure}`. A caller that must exit non-zero decides
 * that itself.
 *
 * @param {{
 *   dir: string,
 *   build: (hooks: {onPage: (read: any) => void}) => Promise<any>,
 *   write: (dir: string, result: any) => Promise<any>,
 *   now?: Date,
 *   pid?: number | null,
 *   reason?: string,
 *   pidAlive?: (pid: unknown) => boolean,
 *   progressEveryMs?: number,
 * }} options
 */
export function runBootstrapBuild({
  dir, build, write, now = new Date(), pid = process.pid, reason = 'missing',
  pidAlive = processAlive, progressEveryMs = PROGRESS_EVERY_MS,
} = /** @type {any} */ ({})) {
  if (typeof build !== 'function') throw new TypeError('runBootstrapBuild needs a build function');
  if (typeof write !== 'function') throw new TypeError('runBootstrapBuild needs a write function');

  const claim = claimBuild(dir, { now, pid, reason, pidAlive });
  if (!claim.claimed) return Promise.resolve({ ok: false, busy: true, holder: claim.holder, failure: null, written: null });

  const startedAt = now.toISOString();
  const began = Date.now();
  /** @type {any[]} */
  let warnings = [];
  /** @type {any} */
  let progress = null;
  let lastWrite = 0;
  let lastResult = null;

  const record = (extra = {}) => writeBuildStatus(dir, {
    state: 'building',
    outcome: { state: 'building', at: startedAt, reason, pid: Number.isInteger(pid) ? pid : null, startedAt, progress, warnings, ...extra },
  });

  const onPage = (/** @type {any} */ page) => {
    progress = {
      videoType: Number.isFinite(page?.videoType) ? page.videoType : null,
      pageNo: Number.isFinite(page?.pageNo) ? page.pageNo : null,
      rows: Number.isFinite(page?.rows) ? page.rows : null,
      fresh: Number.isFinite(page?.fresh) ? page.fresh : null,
      total: Number.isFinite(page?.total) ? page.total : null,
      elapsedMs: Date.now() - began,
      at: new Date().toISOString(),
    };
    const at = Date.now();
    if (lastWrite !== 0 && at - lastWrite < progressEveryMs) return;
    lastWrite = at;
    /* the progress file is a report: an unwritable one is not a failed sweep */
    void record();
  };

  void record();

  return (async () => {
    try {
      const result = await build({ onPage });
      lastResult = result;
      warnings = Array.isArray(result?.warnings) ? result.warnings : [];
      const written = await write(dir, result);
      releaseBuild(dir);
      const at = new Date().toISOString();
      await writeBuildStatus(dir, {
        state: 'landed',
        outcome: {
          state: 'landed', at, reason, pid: Number.isInteger(pid) ? pid : null,
          startedAt, finishedAt: at, elapsedMs: Date.now() - began,
          generatedAt: result?.generatedAt ?? null,
          videos: typeof result?.videos === 'number' ? result.videos : null,
          file: written?.file ?? materialIndexPath(dir),
          bytes: written?.bytes ?? null,
          warnings,
        },
      });
      return { ok: true, busy: false, written, result, warnings, failure: null };
    } catch (error) {
      const at = new Date().toISOString();
      const failure = {
        at,
        code: String(/** @type {any} */ (error)?.code ?? 'build-failed'),
        message: String(/** @type {any} */ (error)?.message ?? error),
        elapsedMs: Date.now() - began,
        warnings: [
          ...warnings,
          ...(Array.isArray(/** @type {any} */ (error)?.warnings) ? /** @type {any} */ (error).warnings : []),
          { code: 'build-failed', at, message: String(/** @type {any} */ (error)?.message ?? error) },
        ],
      };
      releaseBuild(dir);
      await writeBuildStatus(dir, { state: 'failed', outcome: { state: 'failed', reason, pid: Number.isInteger(pid) ? pid : null, startedAt, ...failure } });
      return { ok: false, busy: false, error, failure, written: null, warnings, result: lastResult };
    }
  })();
}

/**
 * The start path: look, decide, and build only when there is something to build.
 *
 * Three answers, and the difference between them is what "does not block" means:
 *
 *  - `{action: 'none', reason: 'fresh'}` — the file is inside its window; `data` is it.
 *  - `{action: 'building', state: 'building', data: null}` — there was no index. The sweep runs in the background
 *    (`background: true`) and `rebuild` resolves with its outcome; the caller returns now.
 *  - `{action: 'building', state: 'stale', data: <old file>}` — the index is past its window: **the old data is handed
 *    over first**, and the rebuild replaces the file only when it succeeds (atomically, inside the writer).
 *
 * With `background: false` the rebuild is awaited and `action` becomes `built` or `failed`.
 *
 * @param {{
 *   dir: string,
 *   build: (hooks: {onPage: (read: any) => void}) => Promise<any>,
 *   write: (dir: string, result: any) => Promise<any>,
 *   now?: Date,
 *   force?: boolean,
 *   background?: boolean,
 *   pid?: number | null,
 *   pidAlive?: (pid: unknown) => boolean,
 *   progressEveryMs?: number,
 * }} options
 */
export async function bootstrapMaterialIndex({
  dir, build, write, now = new Date(), force = false, background = true, pid = process.pid,
  pidAlive = processAlive, progressEveryMs = PROGRESS_EVERY_MS,
} = /** @type {any} */ ({})) {
  const status = materialIndexStatus(dir, { now, pidAlive });
  const plan = materialIndexBootstrapPlan(dir, { now, force, pidAlive, status });
  const landed = readMaterialIndex(dir);
  const served = landed ?? null;

  if (!plan.needed) {
    return {
      action: 'none', reason: plan.reason, state: status.state, stale: status.stale,
      data: served, status, rebuild: null, written: null, failure: null,
    };
  }
  if (typeof build !== 'function' || typeof write !== 'function') {
    throw new TypeError('bootstrapMaterialIndex needs a build and a write function when the index is missing or stale');
  }

  /* `failed` says why the *plan* decided to build (the last one failed); the marker says it is a retry */
  const reason = plan.reason === 'failed' ? 'retry' : plan.reason;
  const rebuild = runBootstrapBuild({ dir, build, write, now, pid, reason, pidAlive, progressEveryMs });
  if (background) {
    return {
      action: 'building',
      reason,
      state: landed ? (plan.stale ? 'stale' : 'landed') : 'building',
      stale: Boolean(landed && plan.stale),
      data: served,
      status,
      rebuild,
      written: null,
      failure: null,
    };
  }
  const outcome = await rebuild;
  const after = materialIndexStatus(dir, { now: new Date(), pidAlive });
  return {
    action: outcome.ok ? 'built' : outcome.busy ? 'building' : 'failed',
    reason: plan.reason,
    state: after.state,
    stale: after.stale,
    data: readMaterialIndex(dir) ?? served,
    status: after,
    rebuild: null,
    written: outcome.written ?? null,
    failure: outcome.failure ?? null,
  };
}

/** One Chinese line per fact a person reads at the top of the view (the CLI prints these; a reader may too). */
export function bootstrapStatusLines(status) {
  const lines = [];
  const word = {
    absent: '没有素材索引', building: '素材索引正在构建', landed: '素材索引已就绪', stale: '素材索引已过期', failed: '素材索引构建失败',
  }[status.state] ?? status.state;
  lines.push(`${word}（${status.state}）: ${status.file}`);
  if (status.generatedAt) lines.push(`generatedAt: ${status.generatedAt}（${Math.round((status.ageMs ?? 0) / 60000)} 分钟前）`);
  if (status.building) {
    const progress = status.building.progress;
    lines.push(`building: pid ${status.building.pid ?? '—'}，起于 ${status.building.startedAt ?? '—'}${progress ? `，已读 videoType ${progress.videoType} 第 ${progress.pageNo} 页（${progress.fresh} 新）` : ''}`);
  }
  if (status.failed) {
    lines.push(`failed: ${status.failed.code} — ${status.failed.message}`);
    for (const warning of status.failed.warnings) lines.push(`warning ${warning.code}: ${warning.message ?? ''}`);
  }
  for (const warning of status.warnings) lines.push(`warning ${warning.code}: ${warning.message ?? ''}`);
  return lines;
}
