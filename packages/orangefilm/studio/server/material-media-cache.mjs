// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * The two caches that keep the material centre from paying for the same bytes twice, both on **this computer**:
 *
 *   <root>/covers/<sha256(url)[:32]>.<ext>   one supplier cover, named by the url it came from
 *   <root>/content/<md5>                     one downloaded video, named by its own md5
 *   <root>/content/<md5>.json                that file's identity (sha256, bytes, extension), written beside it
 *
 * `root` is the material cache root Studio already owns (`materials-cache-root.mjs`): in a dev Studio that is
 * `~/.openfilm-dev/material-cache`, and the two folders above sit beside the answers `materials-cache.mjs` keeps.
 * Nothing here is served to anyone but the loopback page: the server holds no media of its own, it holds a copy of
 * what the person already looked at, and a file the person already downloaded.
 *
 * Why a cover cache: the supplier's `coverUrl` is a public CDN address. Before this, every card that came into view
 * asked that CDN again — slow, and empty when the network was gone. A cover is now asked for once per url, written
 * whole or not at all (a temporary sibling renamed over it), readable only by this account (0600), and handed over
 * from disk afterwards.
 *
 * Why a content library: the index we land here carries the supplier's `rawMd5` for ~91% of the rows
 * (`material-index.mjs`). When a person downloads a material whose bytes are already in `content/`, the download is a
 * local copy — the supplier is not asked at all — and a material that *is* fetched leaves its bytes there, one copy
 * per md5. Both outcomes are written to the structured log (one JSON line, `hit` / `miss` with the md5 and the
 * bytes), so what was saved and what was spent can be reconciled later.
 *
 * The cover route is an http fetch of an address a page names, so it is fenced: an absolute http(s) url whose host is
 * the supplier's own (`sucaicloud.com` and its subdomains, plus anything `MATERIALS_COVER_HOSTS` adds) and nothing
 * else — no other scheme, no other host, no redirect followed (a redirect is the classic way past such a list). The
 * port is not part of that question: `URL#hostname` carries none, so `szy-…-sucaiwang.sucaicloud.com:9001` is judged
 * by its name alone. What the supplier answers is another matter: one of its nodes accepts the connection and then
 * resets the TLS handshake after five seconds, so a url that just failed is remembered for a minute
 * (`COVER_FAILURE_TTL_MS`) and answered from memory rather than asked again for every card — as a **204**: a host that
 * cannot be reached has no cover, and that is not a gateway error a page should paint red for every card.
 *
 * Room: both folders are budgets of their own, never one shared number. The content library gets 2 GB by default
 * (`ORANGE_MATERIAL_CACHE_MAX_BYTES`), the cover cache 512 MB (`ORANGE_MATERIAL_COVERS_MAX_BYTES`), so a library of
 * long videos cannot starve the cards of their images and a page of covers cannot crowd out a downloaded video. A
 * folder over its budget drops the **least recently used** file first — use is the file's own mtime, bumped on every
 * hit, the same rule `materials-cache.mjs` keeps, so eviction needs no side index that could drift from the files —
 * and every removal is one structured line (`evict`, the md5 or cover name, its bytes, and what the folder holds
 * after it). Two files are never taken: the one the sweep itself is protecting (the file just written) and any file
 * something is still reading (`pin()`, which `materials-proxy.mjs` holds around a content copy). A folder is also
 * trimmed when a run opens it, so lowering a number takes effect on the next start and not only on the next download.
 */

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { replaceFile, tempPath, writeAtomic } from './atomic.mjs';
import { HttpError } from './http.mjs';
import { defaultIndexDir, materialIndexPath, readMaterialIndex } from '../../src/material-index-build.mjs';

/** Where covers and content sit under the material cache root. */
export const COVERS_DIR = 'covers';
export const CONTENT_DIR = 'content';

/** A cover lives a week in the page's own cache: the same url is the same image, and the bytes beside it too. */
export const COVER_CACHE_CONTROL = 'public, max-age=604800';

/** A cover larger than this is not a cover; it is refused rather than written. */
export const COVER_MAX_BYTES = 8 * 1024 * 1024;

/**
 * How long a cover url that just failed is not asked again.
 *
 * Measured here: `szy-cfzx-sucaiwang.sucaicloud.com:9001` accepts the connection and then resets the TLS
 * handshake after five seconds, on 443 and on plain http too, while a sibling host (`szy-hlcxy-…`) answers
 * the same bytes in 65 ms. Nothing this end can fix that, but a grid of forty cards asked that dead url
 * forty times: forty five-second stalls and forty lines in the log, for one answer. A failure is remembered
 * for a minute instead — the same status and code come back at once, without the network — and the next try
 * after that asks the supplier again, because a node that is back should not stay refused. That status is
 * **204** (`material-cover-unreachable` / `material-cover-timeout`): a host that cannot be reached has no cover,
 * which is not a 502 the page would draw as a failed picture.
 */
export const COVER_FAILURE_TTL_MS = 60_000;

/** Room for the content library: 2 GB, unless the operator says otherwise. */
export const DEFAULT_CONTENT_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;

/** Room for the supplier's covers: 512 MB, budgeted apart from the content library. */
export const DEFAULT_COVERS_LIMIT_BYTES = 512 * 1024 * 1024;

/** The operator's override for the content library's budget (bytes). */
export const CONTENT_LIMIT_ENV = 'ORANGE_MATERIAL_CACHE_MAX_BYTES';

/** The operator's override for the cover cache's budget (bytes). */
export const COVERS_LIMIT_ENV = 'ORANGE_MATERIAL_COVERS_MAX_BYTES';

/** A byte budget: a positive whole count, else the fallback. @param {unknown} value @param {number} fallback */
const budgetOf = (value, fallback) => {
  const asked = Number(String(value ?? '').trim());
  return Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : fallback;
};

/** The content library's budget, in bytes. @param {NodeJS.ProcessEnv} [env] */
export const contentCacheLimit = (env = process.env) => budgetOf(env?.[CONTENT_LIMIT_ENV], DEFAULT_CONTENT_LIMIT_BYTES);

/** The cover cache's budget, in bytes: its own number, never the content library's. @param {NodeJS.ProcessEnv} [env] */
export const coverCacheLimit = (env = process.env) => budgetOf(env?.[COVERS_LIMIT_ENV], DEFAULT_COVERS_LIMIT_BYTES);

/** Mark a file as used now, so the next sweep sees this as the newest. Nothing to keep warm is not a failure. */
const touchFile = (/** @type {string} */ path, /** @type {number} */ at) => {
  try { const stamp = new Date(at); utimesSync(path, stamp, stamp); } catch { /* gone meanwhile: nothing to keep warm */ }
};

/**
 * One folder under one byte budget.
 *
 * `entries()` is the whole folder, oldest use first: a hit bumps the file's own mtime, so the order here *is* the
 * order of use and eviction needs no side index that could drift from the files.
 *
 * `evict()` takes the oldest files until the folder fits. A name passed as `keep` (the file this sweep just wrote)
 * and every name somebody `pin()`ed (a copy a request is reading right now) are skipped — the budget is a reason to
 * drop the least useful copy, never a reason to pull a file out from under a reader.
 *
 * @param {{dir: string, isName: (name: string) => boolean, limitBytes: number, now: () => number,
 *   note: (fields: Record<string, unknown>) => void, event: string, fieldsOf: (name: string) => Record<string, unknown>,
 *   onEvict?: (name: string) => void}} options
 */
function folderBudget({ dir, isName, limitBytes, now, note, event, fieldsOf, onEvict }) {
  /** How many readers hold each name; a name with a count is not evicted. @type {Map<string, number>} */
  const pinned = new Map();

  /** Everything this folder holds, oldest use first. */
  const entries = () => {
    /** @type {string[]} */
    let names;
    try { names = readdirSync(dir); } catch { return []; }
    /** @type {{name: string, path: string, bytes: number, used: number}[]} */
    const found = [];
    for (const name of names) {
      /* A half-written file is not an entry: `writeAtomic` renames `.tmp` over the real name, and a sweep that took
         the temporary one would fail the write it was making room for. */
      if (name.endsWith('.tmp') || !isName(name)) continue;
      const path = join(dir, name);
      /** @type {import('node:fs').Stats} */
      let info;
      try { info = statSync(path); } catch { continue; }
      if (!info.isFile()) continue;
      found.push({ name, path, bytes: info.size, used: Math.max(Number(info.atimeMs) || 0, Number(info.mtimeMs) || 0) });
    }
    return found.sort((a, b) => a.used - b.used);
  };

  /** What the folder holds now, against its own budget: `{bytes, files, limit}`. */
  const stats = () => {
    const all = entries();
    return { bytes: all.reduce((sum, entry) => sum + entry.bytes, 0), files: all.length, limit: limitBytes };
  };

  /**
   * Keep one name out of eviction until the returned release is called (the release is idempotent).
   * @param {string} name
   */
  const pin = (name) => {
    pinned.set(name, (pinned.get(name) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (pinned.get(name) ?? 1) - 1;
      if (left > 0) pinned.set(name, left); else pinned.delete(name);
    };
  };

  /** Drop the least recently used files until the folder fits. @param {{keep?: string}} [options] */
  const evict = ({ keep = '' } = {}) => {
    const all = entries();
    let total = all.reduce((sum, entry) => sum + entry.bytes, 0);
    let evicted = 0;
    for (const entry of all) {
      if (total <= limitBytes) break;
      if (entry.name === keep || pinned.has(entry.name)) continue;
      /* A file a reader has open cannot be unlinked on every filesystem: it stays, and the next sweep tries again. */
      try { rmSync(entry.path, { force: true }); } catch { continue; }
      total -= entry.bytes;
      evicted += 1;
      if (onEvict) onEvict(entry.name);
      note({ at: new Date(now()).toISOString(), event, result: 'evict', ...fieldsOf(entry.name), bytes: entry.bytes, total, limit: limitBytes });
    }
    return { bytes: total, files: all.length - evicted, limit: limitBytes };
  };

  return { entries, stats, pin, evict, limit: limitBytes };
}

/** The supplier's own hosts: `szy-…-sucaiwang.sucaicloud.com`, and whatever else it serves covers from. */
export const COVER_HOSTS = Object.freeze(['sucaicloud.com']);

/** The suffix a host must carry to be asked for a cover, in addition to the supplier's own. @param {NodeJS.ProcessEnv} [env] */
export function coverHostSuffixes(env = process.env) {
  const extra = String(env?.MATERIALS_COVER_HOSTS ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase().replace(/^\.+/, ''))
    .filter(Boolean);
  return [...COVER_HOSTS, ...extra];
}

/**
 * Whether this host is the supplier's: the name itself, or a name under it. A lookalike (`sucaicloud.com.evil.test`)
 * is not, which is the whole point of comparing at a dot boundary.
 * @param {unknown} hostname @param {{env?: NodeJS.ProcessEnv}} [options]
 */
export function coverHostAllowed(hostname, { env = process.env } = {}) {
  const host = String(hostname ?? '').trim().toLowerCase().replace(/\.+$/, '');
  if (!host) return false;
  return coverHostSuffixes(env).some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** The content type a cover is answered with, and the extension it is stored under. */
const BY_CONTENT_TYPE = new Map([
  ['image/jpeg', '.jpg'], ['image/jpg', '.jpg'], ['image/pjpeg', '.jpg'], ['image/png', '.png'],
  ['image/webp', '.webp'], ['image/gif', '.gif'], ['image/avif', '.avif'], ['image/bmp', '.bmp'],
  ['image/x-icon', '.ico'], ['image/svg+xml', '.svg'], ['image/tiff', '.tiff'],
]);
const BY_EXTENSION = new Map([...BY_CONTENT_TYPE].map(([type, ext]) => [ext, type === 'image/jpg' || type === 'image/pjpeg' ? 'image/jpeg' : type]));
/** `image/jpeg; charset=…`, and nothing else. @param {unknown} value */
const baseType = (value) => String(value ?? '').split(';')[0].trim().toLowerCase();

/** The magic numbers a cover can start with, so a supplier that sends no content type still lands under a real one. @param {Uint8Array} bytes */
export function sniffCoverType(bytes) {
  /** @param {number} i */
  const at = (i) => bytes[i] ?? -1;
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png';
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return 'image/gif';
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45) return 'image/webp';
  if (at(0) === 0x42 && at(1) === 0x4d) return 'image/bmp';
  return 'application/octet-stream';
}

/**
 * The extension and content type a cover is stored and answered with: the supplier's own header first, the url's
 * extension second, the bytes themselves third. A stored file's extension is then enough to answer the next request.
 * @param {string | null | undefined} contentType @param {string} url @param {Uint8Array} [bytes]
 */
export function coverTypeOf(contentType, url, bytes) {
  const said = baseType(contentType);
  let ext = BY_CONTENT_TYPE.get(said) ?? '';
  if (!ext) {
    try {
      const named = extname(new URL(url).pathname).toLowerCase();
      if (BY_EXTENSION.has(named)) ext = named;
    } catch { /* not a url: no extension to read */ }
  }
  if (!ext && bytes && bytes.length) {
    const sniffed = sniffCoverType(bytes);
    ext = [...BY_EXTENSION].find(([, type]) => type === sniffed)?.[0] ?? '';
  }
  if (!ext) ext = '.bin';
  const type = BY_EXTENSION.get(ext) ?? (said.startsWith('image/') ? said : 'application/octet-stream');
  return { ext, contentType: type };
}

/** The name a cover is kept under: the url it came from, 32 hex digits of its sha256. @param {string} url */
export const coverCacheName = (url) => createHash('sha256').update(String(url), 'utf8').digest('hex').slice(0, 32);

/** A cover file name is those 32 hex digits and one extension, nothing else. @param {unknown} name */
export const isCoverCacheName = (name) => typeof name === 'string' && /^[a-f0-9]{32}\.[a-z0-9]{2,5}$/.test(name);

/** A content file is named by an md5, and an md5 is 32 hex digits. @param {unknown} md5 */
export const isContentName = (md5) => typeof md5 === 'string' && /^[a-f0-9]{32}$/.test(md5);

/** One JSON line per event, so a log file can be counted instead of read. */
export const writeJsonLine = (/** @type {(line: string) => void} */ sink) => (/** @type {Record<string, unknown>} */ fields) => {
  try { sink(`${JSON.stringify(fields)}\n`); } catch { /* a log that cannot be written changes no outcome */ }
};

/**
 * The cover cache: one file per supplier url, under `<root>/covers`.
 *
 * @param {{root?: string, fetchImpl?: typeof fetch, timeoutMs?: number, maxBytes?: number, env?: NodeJS.ProcessEnv,
 *   limitBytes?: number, now?: () => number, log?: (line: string) => void,
 *   allowedHost?: (hostname: unknown) => boolean, failureTtlMs?: number}} [options]
 *   `maxBytes` is how large one cover may be; `limitBytes` is how much the whole folder may hold
 *   (`ORANGE_MATERIAL_COVERS_MAX_BYTES`, 512 MB); `failureTtlMs` is how long a url that just failed is
 *   answered from memory instead of the network (`COVER_FAILURE_TTL_MS`).
 */
export function createCoverStore({
  root = '', fetchImpl = globalThis.fetch, timeoutMs = 20_000, maxBytes = COVER_MAX_BYTES,
  env = process.env, limitBytes = coverCacheLimit(env), now = Date.now,
  log = (line) => process.stderr.write(line), allowedHost, failureTtlMs = COVER_FAILURE_TTL_MS,
} = {}) {
  if (typeof root !== 'string' || !root) throw new TypeError('a cover store needs the material cache root');
  if (typeof fetchImpl !== 'function') throw new TypeError('a cover store needs fetch');
  const dir = join(root, COVERS_DIR);
  const allowed = allowedHost ?? ((hostname) => coverHostAllowed(hostname, { env }));
  const note = writeJsonLine(log);
  /** Url → what it answered a moment ago, so a dead one is not asked again for every card. @type {Map<string, {at: number, error: HttpError, host: string, name: string}>} */
  const failed = new Map();
  const budget = folderBudget({
    dir, isName: isCoverCacheName, limitBytes: budgetOf(limitBytes, coverCacheLimit(env)), now, note,
    event: 'material-cover', fieldsOf: (name) => ({ name }),
  });
  /* A folder an operator lowered the budget for is trimmed when this run opens it, not only on the next cover. */
  budget.evict();

  /** The file this url is already kept in, if it is. @param {string} name */
  const find = (name) => {
    /** @type {string[]} */
    let files;
    try { files = readdirSync(dir); } catch { return null; }
    for (const file of files) {
      if (file.endsWith('.tmp') || !file.startsWith(`${name}.`)) continue;
      if (!isCoverCacheName(file)) continue;
      const path = join(dir, file);
      try { if (!statSync(path).isFile()) continue; } catch { continue; }
      return { path, file, contentType: BY_EXTENSION.get(file.slice(name.length)) ?? 'application/octet-stream' };
    }
    return null;
  };

  /**
   * One cover: from disk when it is there, else fetched once and written whole.
   *
   * @param {string} url the supplier's own absolute http(s) url, as the page was given it
   * @returns {Promise<{bytes: Buffer, contentType: string, hit: boolean, ms: number, name: string}>}
   */
  async function getCover(url) {
    const started = now();
    const text = String(url ?? '').trim();
    /** @type {URL} */
    let target;
    try { target = new URL(text); } catch {
      throw new HttpError(400, 'The cover url is not a url.', { code: 'material-cover-url-invalid' });
    }
    if (!/^https?:$/.test(target.protocol)) {
      throw new HttpError(400, 'A cover is fetched over http or https, and nothing else.', { code: 'material-cover-url-invalid' });
    }
    if (!allowed(target.hostname)) {
      throw new HttpError(403, 'That host is not the material supplier.', { code: 'material-cover-host-refused', host: target.hostname });
    }
    const name = coverCacheName(text);
    /* Asked a moment ago and it failed: the same status and code, at once, without the network. A node that
       accepted the connection and then stalled for five seconds is not worth five seconds per card. */
    const remembered = failed.get(text);
    if (remembered && now() - remembered.at < failureTtlMs) {
      const ms = now() - started;
      note({ at: new Date(now()).toISOString(), event: 'material-cover', result: 'negative-hit', name, host: target.hostname, bytes: 0, ms, forMs: failureTtlMs });
      throw remembered.error;
    }
    const kept = find(name);
    /** @type {Buffer | null} */
    let keptBytes = null;
    /* Gone between the listing and the read is a miss, not an error: the bytes are fetched again below. */
    if (kept) { try { keptBytes = readFileSync(kept.path); } catch { keptBytes = null; } }
    if (kept && keptBytes) {
      const ms = now() - started;
      /* This url was used now: it is the last thing the next sweep would take. */
      touchFile(kept.path, now());
      note({ at: new Date(now()).toISOString(), event: 'material-cover', result: 'hit', name, host: target.hostname, bytes: keptBytes.length, ms, refetched: false });
      return { bytes: keptBytes, contentType: kept.contentType, hit: true, ms, name };
    }
    /**
     * Say what happened once (the structured line), remember it for a minute, and hand it to the caller: the
     * supplier's own refusals are not this computer's to fix, but asking it forty times a minute is.
     * @param {HttpError} error @param {string} result @param {Record<string, unknown>} [fields]
     * @returns {never}
     */
    const refuse = (error, result, fields = {}) => {
      note({ at: new Date(now()).toISOString(), event: 'material-cover', result, name, host: target.hostname, bytes: 0, ms: now() - started, ...fields });
      if (failureTtlMs > 0) failed.set(text, { at: now(), error, host: target.hostname, name });
      throw error;
    };
    /** @type {Response} */
    let response;
    try {
      response = await fetchImpl(text, {
        method: 'GET',
        headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8' },
        /* A redirect is how a whitelist is walked around: it is not followed, and the answer is a refusal. */
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = /** @type {{name?: string}} */ (error)?.name === 'TimeoutError' || /** @type {{name?: string}} */ (error)?.name === 'AbortError';
      /* A host that cannot be reached has **no image**, and that is not a gateway error: the node this module was
         measured against accepts the connection and then resets the TLS handshake, and a page of cards asking it drew
         forty red 502s in a browser console for one dead supplier. 204 is the answer this server already gives for a
         film with no picture (`pages.mjs`), so the card keeps its placeholder and nothing is painted as a failure.
         The negative cache above still applies: the same 204 comes back at once for a minute (`COVER_FAILURE_TTL_MS`). */
      return refuse(timedOut
        ? new HttpError(204, 'The supplier did not answer with that cover in time, so there is no cover to show.', { code: 'material-cover-timeout' })
        : /** @type {HttpError} */ (new HttpError(204, 'The supplier could not be reached for that cover, so there is no cover to show.', { code: 'material-cover-unreachable' })),
      timedOut ? 'timeout' : 'unreachable');
    }
    if (response.status >= 300 && response.status < 400) {
      return refuse(new HttpError(502, 'The cover url redirects somewhere else; it is not followed.', { code: 'material-cover-redirect-refused', upstreamStatus: response.status }), 'redirect-refused', { upstreamStatus: response.status });
    }
    if (!response.ok) {
      return refuse(new HttpError(502, 'The supplier refused that cover.', { code: 'material-cover-status', upstreamStatus: response.status }), 'status', { upstreamStatus: response.status });
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) {
      return refuse(new HttpError(502, 'The supplier answered with an empty cover.', { code: 'material-cover-invalid' }), 'empty');
    }
    if (bytes.length > maxBytes) {
      return refuse(new HttpError(502, 'That answer is too large to be a cover.', { code: 'material-cover-too-large', bytes: bytes.length }), 'too-large', { bytes: bytes.length });
    }
    const { ext, contentType } = coverTypeOf(response.headers?.get?.('content-type') ?? null, text, bytes);
    const file = `${name}${ext}`;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    /* Whole or not at all, readable by this account only: a half-written cover is never served as one. */
    await writeAtomic(join(dir, file), bytes, { mode: 0o600 });
    try { chmodSync(join(dir, file), 0o600); } catch { /* Windows: the mode is not a filesystem fact there */ }
    /* Room is made after the write, so the folder is never left over budget by a cover nobody may use yet; the cover
       just written is the one file the sweep will not take. */
    budget.evict({ keep: file });
    /* The url answered: whatever it said before is not what it says now. */
    failed.delete(text);
    note({ at: new Date(now()).toISOString(), event: 'material-cover', result: 'miss', name, host: target.hostname, bytes: bytes.length, ms: now() - started, refetched: true });
    return { bytes, contentType, hit: false, ms: now() - started, name };
  }

  /** What is on disk now, for tests and for a person asking. */
  const list = () => {
    try { return readdirSync(dir).filter((file) => isCoverCacheName(file)); } catch { return []; }
  };

  return {
    root, dir, get: getCover, list,
    /** The folder's budget, in bytes. */
    limit: budget.limit,
    /** `{bytes, files, limit}` for this folder alone. */
    stats: budget.stats,
    /** Keep one cover out of eviction while it is being read. @see folderBudget */
    pin: budget.pin,
    /** Make room now, at once (a person asked, or a test). */
    evict: budget.evict,
  };
}

/**
 * The content library: one file per md5, under `<root>/content`, with its identity in a sidecar beside it.
 *
 * Nothing here is a second source of truth for ownership: it is a copy of bytes this computer already downloaded, and
 * it is only ever read to save that same download.
 *
 * Room: the whole folder is one budget (`ORANGE_MATERIAL_CACHE_MAX_BYTES`, 2 GB), kept apart from `covers/`. Over it,
 * the least recently used copy goes first — a hit bumps the file's own mtime, so the order is the order of use — and a
 * copy some request is still reading (`pin`) or the one just written is never taken. The sidecar of an evicted copy is
 * removed with it (a sidecar is ~200 bytes of identity, counted with its own file, never on its own).
 *
 * @param {{root?: string, now?: () => number, log?: (line: string) => void, env?: NodeJS.ProcessEnv,
 *   limitBytes?: number}} [options]
 */
export function createContentStore({
  root = '', now = Date.now, log = (line) => process.stderr.write(line), env = process.env, limitBytes = contentCacheLimit(env),
} = {}) {
  if (typeof root !== 'string' || !root) throw new TypeError('a content store needs the material cache root');
  const dir = join(root, CONTENT_DIR);
  const note = writeJsonLine(log);

  /** @param {string} md5 */
  const pathOf = (md5) => join(dir, md5);
  /** @param {string} md5 */
  const sidecarOf = (md5) => join(dir, `${md5}.json`);

  const budget = folderBudget({
    dir, isName: isContentName, limitBytes: budgetOf(limitBytes, contentCacheLimit(env)), now, note,
    event: 'material-content', fieldsOf: (md5) => ({ md5 }),
    /* An identity without its bytes is not a copy of anything: it goes with the file it describes. */
    onEvict: (md5) => { try { rmSync(sidecarOf(md5), { force: true }); } catch { /* already gone */ } },
  });
  /* A library an operator lowered the budget for is trimmed when this run opens it, not only on the next download. */
  budget.evict();

  /**
   * What this md5 is on disk, when it really is a whole copy: the sidecar says which bytes, the file must still be
   * that size. Anything else is a miss, and the caller downloads again.
   * @param {string} md5
   * @returns {{path: string, md5: string, sha256: string, bytes: number, ext: string} | null}
   */
  function openContent(md5) {
    if (!isContentName(md5)) return null;
    /** @type {{sha256?: unknown, bytes?: unknown, ext?: unknown}} */
    let sidecar;
    try { sidecar = JSON.parse(readFileSync(sidecarOf(md5), 'utf8')); } catch { return null; }
    const path = pathOf(md5);
    /** @type {number} */
    let size;
    try { size = statSync(path).size; } catch { return null; }
    if (typeof sidecar.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sidecar.sha256)) return null;
    if (!Number.isSafeInteger(sidecar.bytes) || sidecar.bytes !== size) return null;
    const ext = typeof sidecar.ext === 'string' && /^\.[a-z0-9]{1,5}$/.test(sidecar.ext) ? sidecar.ext : '.mp4';
    return { path, md5, sha256: sidecar.sha256, bytes: size, ext };
  }

  return {
    root,
    dir,
    pathOf,
    /** The folder's budget, in bytes. */
    limit: budget.limit,
    /**
     * One whole copy, if it is still that copy. Reading it is using it, so the sweep sees it as the newest.
     * @param {string} md5
     */
    open(md5) {
      const entry = openContent(md5);
      if (entry) touchFile(entry.path, now());
      return entry;
    },
    /** Whether that md5 is here at all (a whole copy, not a leftover). A question is not a use. @param {string} md5 */
    has: (md5) => openContent(md5) !== null,
    /** `{bytes, files, limit}` for this folder alone. */
    stats: budget.stats,
    /** Keep one copy out of eviction while a request is reading it. @see folderBudget @param {string} md5 */
    pin: budget.pin,
    /** Make room now, at once (a person asked, or a test). */
    evict: budget.evict,
    /**
     * Forget one md5 — the copy turned out not to be the bytes its sidecar promised, so keeping it would only make
     * the next download fail the same way. The next fetch writes it again.
     * @param {string} md5
     */
    forget(md5) {
      if (!isContentName(md5)) return;
      note({ at: new Date(now()).toISOString(), event: 'material-content', result: 'forgotten', md5, bytes: 0 });
      try { rmSync(pathOf(md5), { force: true }); } catch { /* already gone */ }
      try { rmSync(sidecarOf(md5), { force: true }); } catch { /* already gone */ }
    },
    /**
     * Keep one copy of these bytes, under their own md5. A file already there stays: the bytes of an md5 are the
     * bytes of that md5, and a second write would only be a second chance to lose the first.
     * @param {{md5: string, source: string, sha256: string, bytes: number, ext: string}} entry
     */
    async put({ md5, source, sha256, bytes, ext }) {
      if (!isContentName(md5)) throw new TypeError('a content file is named by its md5 (32 hex digits)');
      if (typeof source !== 'string' || !source) throw new TypeError('a content file needs the bytes it copies');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = pathOf(md5);
      if (existsSync(sidecarOf(md5)) && existsSync(path)) {
        touchFile(path, now());  // already here, and being asked for now
        return { path, md5, sha256, bytes, ext, kept: true };
      }
      const tmp = tempPath(path);
      try {
        await copyFile(source, tmp);
        try { chmodSync(tmp, 0o600); } catch { /* Windows */ }
        await replaceFile(tmp, path);
      } catch (error) {
        note({ at: new Date(now()).toISOString(), event: 'material-content', result: 'store-failed', md5, bytes, error: String(/** @type {any} */ (error)?.code ?? 'error') });
        return null;
      }
      await writeAtomic(sidecarOf(md5), `${JSON.stringify({ version: 1, md5, sha256, bytes, ext, storedAt: new Date(now()).toISOString(), lastUsedAt: new Date(now()).toISOString() })}\n`, { mode: 0o600 });
      /* Room is made after the copy lands, so the library is never over its budget while a page waits for it; the copy
         just written is the one file the sweep will not take. */
      budget.evict({ keep: md5 });
      return { path, md5, sha256, bytes, ext, kept: false };
    },
    /** What the library holds now, for tests and for a person asking. */
    list() {
      /** @type {string[]} */
      let files;
      try { files = readdirSync(dir); } catch { return []; }
      return files.filter((file) => isContentName(file)).sort();
    },
  };
}

/**
 * What one of the two folders holds, against its own budget: `{bytes, files, limit}`.
 *
 * The read is the same one the stores make (`folderBudget`), so a self-check, a page or a person sees the number the
 * next write will decide on — not a second, drifting accounting of the same folder.
 *
 * @param {{root?: string, kind?: string, env?: NodeJS.ProcessEnv, limitBytes?: number, now?: () => number}} [options]
 *   `kind` is `content` (default) or `covers`; `limitBytes` overrides the budget the environment would give.
 */
export function materialCacheStats({ root = '', kind = CONTENT_DIR, env = process.env, limitBytes, now = Date.now } = {}) {
  if (typeof root !== 'string' || !root) throw new TypeError('material cache stats need the material cache root');
  const covers = kind === COVERS_DIR;
  const budget = folderBudget({
    dir: join(root, covers ? COVERS_DIR : CONTENT_DIR),
    isName: covers ? isCoverCacheName : isContentName,
    limitBytes: budgetOf(limitBytes, covers ? coverCacheLimit(env) : contentCacheLimit(env)),
    now, note: () => {}, event: '', fieldsOf: () => ({}),
  });
  return budget.stats();
}

/**
 * The supplier's md5 for one video id, read from the index this computer already landed
 * (`~/.openfilm-dev/material-index/index.json`, `material-index-build.mjs`): the digest the supplier itself put on the
 * row, so a download can ask "is this already here?" before it asks the supplier anything.
 *
 * The index is re-read when the file changes (a rebuild), never on every call: 78k rows are read once per build.
 *
 * @param {{dir?: string, read?: (dir: string) => any, stat?: typeof statSync}} [options]
 */
export function createDigestIndex({ dir = defaultIndexDir(), read = readMaterialIndex, stat = statSync } = {}) {
  /** @type {Map<string, string> | null} */
  let table = null;
  let stamp = '';
  const file = materialIndexPath(dir);
  /** @param {any} landed */
  const tableOf = (landed) => {
    /** @type {Map<string, string>} */
    const map = new Map();
    const add = (/** @type {any} */ entry) => {
      if (typeof entry?.videoId !== 'string' || !entry.videoId) return;
      const md5 = typeof entry.md5 === 'string' ? entry.md5.trim().toLowerCase() : '';
      if (!isContentName(md5)) return;
      map.set(entry.videoId, md5);
    };
    const tree = landed?.index;
    for (const batch of tree?.batches ?? []) {
      for (const product of batch?.products ?? []) {
        for (const group of product?.groups ?? []) for (const entry of group?.entries ?? []) add(entry);
      }
    }
    for (const entry of tree?.unclassified ?? []) add(entry);
    return map;
  };
  return {
    file,
    /** The digest the supplier carried for this material, or null when this computer does not know it. @param {string} videoId */
    md5Of(videoId) {
      if (typeof videoId !== 'string' || !videoId) return null;
      /** @type {string} */
      let current = '';
      try { const info = stat(file); current = `${info.mtimeMs}:${info.size}`; } catch { current = ''; }
      if (!current) return null;
      if (!table || stamp !== current) {
        /** @type {any} */
        let landed = null;
        try { landed = read(dir); } catch { landed = null; }
        table = landed ? tableOf(landed) : new Map();
        stamp = current;
      }
      return table.get(videoId) ?? null;
    },
    /** How many ids this index can answer for (0 until it is read). */
    size() { return table ? table.size : 0; },
  };
}

/**
 * The material's own name for one video id, read from the same landed index `createDigestIndex` reads.
 *
 * Why a download needs it: the bytes land in `saved/云素材/` — a folder the person browses in Finder or Explorer. Named
 * `<videoId>.mp4` every file is a number there, and the person cannot tell one 外包装 from another. The index already
 * carries the supplier's name for every row, so the file is named after it (with the id kept, so a lookup stays exact).
 *
 * @param {{dir?: string, read?: (dir: string) => any, stat?: typeof statSync}} [options]
 */
export function createNameIndex({ dir = defaultIndexDir(), read = readMaterialIndex, stat = statSync } = {}) {
  /** @type {Map<string, string> | null} */
  let table = null;
  let stamp = '';
  const file = materialIndexPath(dir);
  /** @param {any} landed */
  const tableOf = (landed) => {
    /** @type {Map<string, string>} */
    const map = new Map();
    const add = (/** @type {any} */ entry) => {
      if (typeof entry?.videoId !== 'string' || !entry.videoId) return;
      const name = typeof entry.name === 'string' ? entry.name.trim() : '';
      if (!name) return;
      map.set(entry.videoId, name);
    };
    const tree = landed?.index;
    for (const batch of tree?.batches ?? []) {
      for (const product of batch?.products ?? []) {
        for (const group of product?.groups ?? []) for (const entry of group?.entries ?? []) add(entry);
      }
    }
    for (const entry of tree?.unclassified ?? []) add(entry);
    return map;
  };
  return {
    file,
    /** The supplier's name for this material, or null when this computer does not know it. @param {string} videoId */
    nameOf(videoId) {
      if (typeof videoId !== 'string' || !videoId) return null;
      /** @type {string} */
      let current = '';
      try { const info = stat(file); current = `${info.mtimeMs}:${info.size}`; } catch { current = ''; }
      if (!current) return null;
      if (!table || stamp !== current) {
        /** @type {any} */
        let landed = null;
        try { landed = read(dir); } catch { landed = null; }
        table = landed ? tableOf(landed) : new Map();
        stamp = current;
      }
      return table.get(videoId) ?? null;
    },
    /** How many ids this index can answer for (0 until it is read). */
    size() { return table ? table.size : 0; },
  };
}
