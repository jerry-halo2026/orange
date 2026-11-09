// @ts-check
/**
 * A film from a public GitHub repository, over plain https: no git needed. GitHub's API names the commit and lists
 * the folder's files with their sizes, so the size of the whole is known before the first byte comes; the files then
 * come from GitHub's raw file host at that commit, a few at a time, each written as it streams in.
 *
 * When the API cannot help (a private repository, its hourly limit for this address used up, a listing too long to be
 * whole), it throws a FetchError with code 'use-git', before anything is downloaded: the caller fetches with git.
 */
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { isProxy } from 'node:util/types';
import { FetchError } from './fetch-error.mjs';

/**
 * Node-only capabilities, scoped to one call/manager. These keep the original native signatures and real resources.
 * @typedef {{ spawn?: typeof import('node:child_process').spawn, fetch?: typeof globalThis.fetch,
 *   fs?: Partial<Pick<typeof import('node:fs/promises'), 'mkdir' | 'readdir' | 'lstat' | 'rename' | 'rm'>>,
 *   createWriteStream?: typeof import('node:fs').createWriteStream }} TrustedNode
 */

/** Snapshot only own data functions: validation must not invoke a capability getter. @param {unknown} value @returns {TrustedNode} */
function trustedFunctions(value) {
  if (value === undefined) return Object.freeze(Object.create(null));
  /** @param {unknown} object @param {string[]} names @param {boolean} [nested] @returns {Record<string, unknown>} */
  const copy = (object, names, nested = false) => {
    if (object === null || typeof object !== 'object' || isProxy(object) || ![null, Object.prototype].includes(Object.getPrototypeOf(object))) {
      throw new TypeError('trustedNode must contain only own function capabilities.');
    }
    /** @type {Record<string, unknown>} */
    const result = Object.create(null);
    for (const key of Reflect.ownKeys(object)) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (typeof key !== 'string' || !names.includes(key) || !descriptor || !('value' in descriptor)) {
        throw new TypeError('Unknown or accessor trustedNode capability.');
      }
      if (!nested && key === 'fs') result[key] = copy(descriptor.value, ['mkdir', 'readdir', 'lstat', 'rename', 'rm'], true);
      else {
        if (typeof descriptor.value !== 'function') throw new TypeError('trustedNode capabilities must be functions.');
        result[key] = descriptor.value;
      }
    }
    return Object.freeze(result);
  };
  return /** @type {TrustedNode} */ (copy(value, ['spawn', 'fetch', 'fs', 'createWriteStream']));
}

export const GITHUB_API = 'https://api.github.com';
export const GITHUB_RAW = 'https://raw.githubusercontent.com';
/* files downloading at once */
const PARALLEL = 4;
/* tries at each file, and the wait before the second (doubled for each after) */
const TRIES = 5;
const RETRY_MS = 500;
/* the starts of a folder's address tried as a branch's name (a branch may have slashes in its name) */
const MAX_REF_PARTS = 6;

/**
 * @typedef {{ api?: string, raw?: string }} GitHubHosts where the API and the raw files are (a test's own server)
 * @typedef {{ path: string, size: number }} RemoteFile `path`: in the folder, with slashes
 * @typedef {{ commit: string, folder: string[], files: RemoteFile[], total: number }} RemoteListing
 */

const encodePath = (/** @type {string[]} */ parts) => parts.map(encodeURIComponent).join('/');

/** Whether GitHub refused because this address used up its hourly calls. @param {Response} res */
const limited = (res) => res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0');

/** Wait `ms`, or less when `signal` stops it. @param {number} ms @param {AbortSignal} [signal] */
const pause = (ms, signal) => new Promise((done) => {
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', finish);
    done(undefined);
  };
  const timer = setTimeout(finish, ms);
  signal?.addEventListener('abort', finish, { once: true });
  if (signal?.aborted) finish();
});

/**
 * Ask GitHub. A connection that fails is tried again, a little later each time; failing every time, it is said as a
 * network failure. @param {string} url
 * @param {{ signal?: AbortSignal, accept?: string, trustedNode?: TrustedNode }} options @returns {Promise<Response>}
 */
async function request(url, { signal, accept, trustedNode }) {
  for (let tries = 1; ; tries++) {
    if (signal?.aborted) throw signal.reason;
    try {
      return await (trustedNode?.fetch ?? fetch)(url, { signal, headers: { accept: accept ?? 'application/vnd.github+json', 'user-agent': 'OpenFilm-Studio' } });
    } catch (e) {
      if (signal?.aborted) throw e;
      if (tries >= TRIES) throw new FetchError('Could not reach GitHub: check your internet connection.', 502, 'network');
      await pause(RETRY_MS * 2 ** (tries - 1), signal);
    }
  }
}

/** Original cancellation errors stay private to the actual transfer owner. @type {WeakMap<Error, unknown[]>} */
const incompleteCleanup = new WeakMap();

/** Internal Node-only brand bridge: no paths or recovery facts cross this seam.
 * @param {unknown} error @returns {error is FetchError}
 */
export function hasIncompleteCleanup(error) {
  return incompleteCleanup.has(/** @type {Error} */ (error));
}

/** @param {unknown} cause */
function cleanupFailure(cause) {
  const failure = new FetchError('The response could not finish closing.', 500, 'failed');
  incompleteCleanup.set(failure, [cause]);
  return failure;
}

/** An unused error body is still an acquired transfer. @param {Response} response */
async function retireResponse(response) {
  if (!response.body) return;
  let reader;
  try { reader = response.body.getReader(); }
  catch (cause) { throw cleanupFailure(cause); }
  let readFailed = false;
  const closed = reader.closed.catch(() => { readFailed = true; });
  try {
    /* Observe this owned reader's existing terminal state BEFORE invoking cancellation.
       An already-errored stream needs no underlying cancel; a new cancel rejection is fatal. */
    await Promise.resolve();
    if (readFailed) return;
    try { await reader.cancel(); }
    catch (cause) {
      /* A queued read error can precede cancel while its closed observer is still pending.
         Underlying cancel rejection closes normally; only a read error rejects reader.closed. */
      await closed;
      if (!readFailed) throw cleanupFailure(cause);
    }
  } finally { await closed; reader.releaseLock(); }
}

/** Own one actual web reader: Node's adapter otherwise hides an underlying cancel rejection.
 * Bytes still pass through the original fromWeb/count/pipeline/file stream unchanged.
 * @param {Response} response
 */
function ownedResponseBody(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new TypeError('The response has no body.');
  let retiring = false, released = false, readFailed = false;
  /** @type {unknown} */
  let readFailure;
  /* Observe an already-errored body even when cancellation arrives before the first pull. */
  const closed = reader.closed.catch(error => { readFailed = true; readFailure = error; });
  /** @type {Promise<void>} */
  let reading = Promise.resolve();
  /** @type {Promise<void> | undefined} */
  let cancellation;
  const release = () => { if (!released) { released = true; reader.releaseLock(); } };
  const stream = new ReadableStream({
    pull(controller) {
      reading = (async () => {
        try {
          const { value, done } = await reader.read();
          if (retiring) return;
          if (done) { release(); controller.close(); }
          else controller.enqueue(value);
        } catch (error) {
          readFailed = true; readFailure = error;
          if (!retiring) { controller.error(error); release(); }
        }
      })();
      return reading;
    },
    cancel(reason) {
      retiring = true;
      cancellation = (async () => {
        try { await reader.cancel(reason); }
        catch (cause) {
          await reading;
          await closed;
          /* Cancelling an already-errored reader repeats its read error, not a cleanup failure. */
          throw readFailed && cause === readFailure ? cause : cleanupFailure(cause);
        } finally { await reading; release(); }
      })();
      return cancellation;
    },
  }, { highWaterMark: 0 });
  return { stream, async drain() { await reading; await cancellation; await closed; } };
}

/**
 * The commit `tree` points at, and the folder in it: the shortest start of `tree` that GitHub knows as a branch, a
 * tag or a commit (null `tree`: the default branch, the whole repository). A file's address means its folder.
 * @param {{ owner: string, repo: string }} at @param {string[] | null} tree @param {boolean} blob
 * @param {{ signal?: AbortSignal, hosts?: GitHubHosts, trustedNode?: TrustedNode }} [options]
 * @returns {Promise<{ commit: string, folder: string[] }>}
 */
export async function resolveCommit(at, tree, blob, { signal, hosts = {}, trustedNode } = {}) {
  trustedNode = trustedFunctions(trustedNode);
  const base = `${hosts.api ?? GITHUB_API}/repos/${encodeURIComponent(at.owner)}/${encodeURIComponent(at.repo)}/commits/`;
  const tries = tree ? Array.from({ length: Math.min(tree.length, MAX_REF_PARTS) }, (_, i) => i + 1) : [0];
  for (const n of tries) {
    const ref = tree ? tree.slice(0, n) : ['HEAD'];
    const res = await request(base + encodePath(ref), { signal, accept: 'application/vnd.github.sha', trustedNode });
    if (res.ok) {
      const commit = (await res.text()).trim();
      if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new FetchError('GitHub answered with something that is not a commit.', 502, 'failed');
      const folder = tree ? tree.slice(n) : [];
      return { commit, folder: blob ? folder.slice(0, -1) : folder };
    }
    await retireResponse(res);
    /* not to be seen (private, or no such repository), or no more calls this hour: git may still get it */
    if (res.status === 404 || res.status === 401 || limited(res)) throw new FetchError('GitHub’s API cannot list it.', 409, 'use-git');
    /* 422: no such branch or tag; try a longer start */
    if (res.status !== 422) throw new FetchError(`GitHub answered ${res.status}.`, 502, 'failed');
  }
  throw new FetchError(`There is no branch or tag “${tree?.[0] ?? 'HEAD'}” in that repository.`, 404, 'ref');
}

/**
 * The files of `folder` at `commit`, with their sizes. Links and submodules are left out.
 * @param {{ owner: string, repo: string }} at @param {string} commit @param {string[]} folder
 * @param {{ signal?: AbortSignal, hosts?: GitHubHosts, trustedNode?: TrustedNode }} [options]
 * @returns {Promise<RemoteFile[]>}
 */
export async function listFiles(at, commit, folder, { signal, hosts = {}, trustedNode } = {}) {
  trustedNode = trustedFunctions(trustedNode);
  const treeish = folder.length ? `${commit}:${folder.join('/')}` : commit;
  const url = `${hosts.api ?? GITHUB_API}/repos/${encodeURIComponent(at.owner)}/${encodeURIComponent(at.repo)}/git/trees/${encodeURIComponent(treeish)}?recursive=1`;
  const res = await request(url, { signal, trustedNode });
  if (!res.ok) await retireResponse(res);
  if (res.status === 404) throw new FetchError(`There is no folder “${folder.join('/')}” in that repository.`, 404, 'no-folder');
  if (res.status === 401 || limited(res)) throw new FetchError('GitHub’s API cannot list it.', 409, 'use-git');
  if (!res.ok) throw new FetchError(`GitHub answered ${res.status}.`, 502, 'failed');
  const body = /** @type {{ truncated?: boolean, tree?: { path?: unknown, type?: unknown, mode?: unknown, size?: unknown }[] }} */ (await res.json());
  if (body.truncated || !Array.isArray(body.tree)) throw new FetchError('GitHub’s listing is not whole.', 409, 'use-git');
  /** @type {RemoteFile[]} */
  const files = [];
  for (const entry of body.tree) {
    if (entry.type !== 'blob' || entry.mode === '120000' || typeof entry.path !== 'string') continue;
    const parts = entry.path.split('/');
    if (parts.some((p) => !p || p === '.' || p === '..' || p.includes('\\'))) continue;
    files.push({ path: entry.path, size: typeof entry.size === 'number' && entry.size > 0 ? entry.size : 0 });
  }
  return files;
}

/**
 * Download `files` (of `folder` at `commit`) into `dir`, a few at a time; `onBytes` hears each piece as it comes.
 * @param {{ owner: string, repo: string }} at @param {string} commit @param {string[]} folder @param {RemoteFile[]} files
 * @param {{ dir: string, signal?: AbortSignal, hosts?: GitHubHosts, trustedNode?: TrustedNode, onBytes?: (n: number) => void }} options
 */
export async function downloadFiles(at, commit, folder, files, { dir, signal, hosts = {}, onBytes = () => {}, trustedNode }) {
  trustedNode = trustedFunctions(trustedNode);
  const base = `${hosts.raw ?? GITHUB_RAW}/${encodeURIComponent(at.owner)}/${encodeURIComponent(at.repo)}/${commit}/`;
  /* the biggest first, so the last to finish are small; one that fails stops the others */
  const queue = [...files].sort((a, b) => b.size - a.size);
  const control = new AbortController();
  const stopAll = () => control.abort();
  if (signal?.aborted) stopAll();
  signal?.addEventListener('abort', stopAll, { once: true });
  let failed = false;
  /** @type {unknown} */
  let failure;
  /** Cleanup failures are independent of the first ordinary worker failure. @type {FetchError[]} */
  const cleanupFailures = [];
  /** One try at a file, counting only the bytes past `counted` (what an earlier try already told). */
  const attempt = async (/** @type {RemoteFile} */ file, /** @type {string} */ to, /** @type {{ counted: number }} */ told) => {
    const res = await request(base + encodePath([...folder, ...file.path.split('/')]), { signal: control.signal, accept: '*/*', trustedNode });
    if (!res.ok || !res.body) {
      await retireResponse(res);
      const error = new FetchError(`GitHub did not send “${file.path}” (${res.status}).`, 502, 'failed');
      throw res.status === 429 || res.status >= 500 ? Object.assign(error, { again: true }) : error;
    }
    /** Acquire the writer before locking the web body; a setup throw owns its unused response. */
    let fileStream;
    try { fileStream = (trustedNode.createWriteStream ?? createWriteStream)(to); }
    catch (error) { await retireResponse(res); throw error; }
    let body;
    try { body = ownedResponseBody(res); }
    catch (error) {
      const closed = finished(fileStream, { cleanup: true }).catch(() => {});
      fileStream.destroy();
      await closed;
      await retireResponse(res);
      throw error;
    }
    let got = 0;
    let callbackFailed = false;
    /** @type {unknown} */
    let callbackFailure;
    const count = new Transform({
      transform(chunk, _, done) {
        try {
          got += chunk.length;
          if (got > told.counted) { onBytes(got - told.counted); told.counted = got; }
        } catch (error) {
          callbackFailed = true;
          callbackFailure = error;
          done(error instanceof Error ? error : new Error('Download progress callback failed.'));
          return;
        }
        done(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(/** @type {import('node:stream/web').ReadableStream} */ (body.stream)), count, fileStream, { signal: control.signal });
    } catch (e) {
      if (callbackFailed) throw callbackFailure;
      if (control.signal.aborted) throw e;
      throw Object.assign(new FetchError('The download broke off: check your internet connection.', 502, 'network'), { again: true });
    } finally { await body.drain(); }
  };
  const one = async (/** @type {RemoteFile} */ file) => {
    const to = join(dir, ...file.path.split('/'));
    const inside = relative(dir, to);
    if (!inside || inside.split(sep)[0] === '..' || isAbsolute(inside)) throw new FetchError(`“${file.path}” is not a path in the folder.`, 422, 'failed');
    await (trustedNode.fs?.mkdir ?? mkdir)(dirname(to), { recursive: true });
    /* a connection that drops is tried again, a little later each time, from the start of the file */
    const told = { counted: 0 };
    for (let tries = 1; ; tries++) {
      try {
        await attempt(file, to, told);
        return;
      } catch (e) {
        if (control.signal.aborted || !(/** @type {any} */ (e)?.again) || tries >= TRIES) throw e;
        await pause(RETRY_MS * 2 ** (tries - 1), control.signal);
      }
    }
  };
  const worker = async () => {
    for (let file = queue.shift(); file && !control.signal.aborted; file = queue.shift()) {
      try {
        await one(file);
      } catch (e) {
        if (hasIncompleteCleanup(e)) cleanupFailures.push(e);
        else if (!failed) { failed = true; failure = e; }
        stopAll();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker));
  signal?.removeEventListener('abort', stopAll);
  if (cleanupFailures.length) throw cleanupFailure({ cleanupFailures, operationFailure: failure });
  if (failed) throw failure;
}
