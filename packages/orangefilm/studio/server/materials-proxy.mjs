// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * The material centre's data plane: the provider is asked from here, never from the page, and its
 * token never leaves this process.
 *
 * Identity has one source: the Studio's branded session (`auth.assertActive()`, the same seam
 * `fission-local-routes.mjs` uses). Nothing a page sends can name a principal — a request that
 * carries any `x-materials-*` header is refused before anything else happens. For every upstream
 * read this module signs a short-lived delegation:
 *
 *   canonical = "v1\n" + <x-materials-principal>\n + <METHOD>\n + <path>\n + <query without "?">
 *   x-materials-principal = base64url(JSON {environmentId, subjectId, instanceId, epoch, exp})
 *   x-materials-signature = lower-hex HMAC-SHA256(MATERIALS_SECRET, canonical)
 *
 * `exp` is Unix seconds, a minute ahead: the delegation outlives one read and no more. Path and
 * query are signed together, from the bytes actually sent, so a tampered path or a swapped query
 * cannot pass.
 *
 * Reading, in one place:
 *  - `list` / `facets` / `labels` forward the page's query to the provider unchanged (the provider's
 *    semantics are not rewritten here) and keep the answer on disk under its query signature; list
 *    answers live 15 minutes, the catalogue's vocabulary 24 hours. A stale answer is still handed
 *    over at once — one background revalidation follows, and a failed one leaves the old answer be.
 *  - `cover` is fetched only when a page asks for that one cover. Nothing here walks a list, warms
 *    the next page, or pulls images pre-emptively: the only upstream reads are the ones a request
 *    caused.
 *  - `coverByUrl` (`GET /api/materials/cover?url=…`) is the same rule for the supplier's own CDN
 *    address: one url, fetched once, kept under `<material-cache>/covers` (`material-media-cache.mjs`),
 *    handed over from disk after that. Only the supplier's hosts are fetched, and no redirect is
 *    followed.
 *  - `raw` asks the provider to stage one video, then lands it in Saved. Before it asks, it looks the
 *    video's md5 up in the index this computer landed: when the bytes are already in the local content
 *    library (`<material-cache>/content/<md5>`), the download is a copy and the provider is not called.
 *    A video that *is* fetched leaves its bytes there, one copy per md5. Either way one structured line
 *    is logged (`hit` / `miss`, with the md5 and the bytes). No media is kept by the server: the
 *    content library is a local copy of what this computer already downloaded.
 *
 * Failures keep a name the page can act on: `material-upstream-timeout` (15 s),
 * `material-upstream-unreachable`, `material-upstream-invalid`, `material-upstream-status`. The
 * provider's own refusals (a 403 `authorization-denied` included) are passed through untouched —
 * **except** the ones that say "not now": the provider answers 503 `provider-unconfirmed`
 * (供应商结果未知) for a share of requests when it cannot confirm its own read, so such an answer
 * (and a 429/502/504, and a connection that failed at once) is asked again a few times with a short
 * pause (`RETRY_DELAYS_MS`) before it becomes the page's. What the page gets is the last answer, so
 * a provider that is genuinely down is still named by its own status and code.
 *
 * The same question asked twice at once — a page drawing its cards and its list from one query — is
 * asked upstream once (`askOnce`), which is also what keeps a burst of cards from being a burst of
 * provider reads.
 */
import { createHash, createHmac } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { HttpError, json, readJson } from './http.mjs';
import { createContentStore, createCoverStore, createDigestIndex, createNameIndex, COVER_CACHE_CONTROL, writeJsonLine } from './material-media-cache.mjs';
import { DICTIONARY_TTL_MS, META_TTL_MS } from './materials-cache.mjs';
import { libraryRoot } from './saved.mjs';
import { createPackNames } from '../../src/material-pack.mjs';
import { DEFAULT_PACK_DIR } from '../../src/material-search.mjs';
import { memoryFile, rememberSteward, rememberedSteward } from './cloud-steward-memory.mjs';

/** Answers that describe one page of the catalogue, and answers that describe its vocabulary. */
const TTL = { list: META_TTL_MS, facets: DICTIONARY_TTL_MS, labels: DICTIONARY_TTL_MS };
/** The provider's path for one route (list, facets, labels, cover). @param {string} route */
const upstreamPath = (route) => `/api/materials/${route}`;
/** Saved's flat cloud folder, and its dot folder of sidecars (a dot name is never listed). */
const CLOUD_DIR = '云素材';
const CLOUD_META = '.meta';
/** A provider id has to survive as one file name: no separators, no Windows-hostile characters. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The material's name as a file name, or null when there is nothing usable.
 *
 * Windows is the strict one: `\ / : * ? " < > |` and control characters are refused, a name may not end in a dot or a
 * space, and `CON`/`NUL`-style device names cannot be used at all. Length is capped so `<name> (<id>)<ext>` stays
 * inside the 255-byte limit even when the name is Chinese (three bytes each).
 *
 * @param {unknown} name
 * @returns {string | null}
 */
export function safeName(name) {
  const text = typeof name === 'string' ? name.trim() : '';
  if (!text) return null;
  let clean = text
    /* eslint-disable-next-line no-control-regex -- control characters are exactly what must go */
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '／')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (!clean) return null;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(clean)) clean = `_${clean}`;
  /* 60 characters: Chinese takes three bytes each, and the id, brackets and extension need room under 255 bytes. */
  const capped = Array.from(clean).slice(0, 60).join('').replace(/[.\s]+$/g, '');
  return capped || null;
}

/**
 * The provider's statuses that mean "not now" *for this request*: worth asking again before the page is told.
 *
 * A 429 is deliberately not one of them. It is the supplier's own quota (`provider-rate-limited`, 供应商限流),
 * the page has words for it (`ui/src/lib/material-center/wiki.ts` maps 429 to 「有限流」), and asking again a few
 * hundred milliseconds later is exactly what would keep it tripped — measured here: three bursts of twenty
 * queries turned every answer into 429 while the retries were counting 429 as retryable.
 */
const TRANSIENT_STATUSES = new Set([502, 503, 504]);
/** A read that could not be made at all (`failed()`): the same "not now", from the socket rather than the body. */
const TRANSIENT_READ_FAILURES = new Set([502, 504]);
/**
 * How long to wait before each further try, and how many provider reads may be in flight at once.
 *
 * The supplier's `provider-unconfirmed` is not a plain rate limit — it also fails reads made one after another —
 * but it fails *more* of them when a page's twenty cards ask at the same moment (measured here: 10 of 20 in a
 * burst against 4 of 10 in a row). Two more tries, and a ceiling of four reads at a time, leave a burst with one
 * attempt's answer rather than twenty.
 */
const RETRY_DELAYS_MS = [150, 400, 900];
/** How many provider reads this process keeps in flight at once. */
const PROVIDER_READS_AT_ONCE = 4;

/** How long a signed principal may be replayed: long enough for one read, no longer. */
const PRINCIPAL_TTL_SEC = 60;
/** The one signature format the provider verifies. */
const SIGNATURE_VERSION = 'v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @param {unknown} value */
const base64url = (value) => Buffer.from(String(value), 'utf8').toString('base64url');

/** The request's own path and query, exactly as sent (no re-encoding through `URL`). @param {string | undefined} rawUrl */
const splitUrl = (rawUrl) => {
  const raw = typeof rawUrl === 'string' && rawUrl.startsWith('/') ? rawUrl : `/${rawUrl ?? ''}`;
  const mark = raw.indexOf('?');
  return mark < 0 ? { path: raw, query: '' } : { path: raw.slice(0, mark), query: raw.slice(mark + 1) };
};

/** @param {string | undefined | null} value */
const trimmed = (value) => (typeof value === 'string' && value.trim() ? value.trim().replace(/\/+$/, '') : null);

/** A page may never name the material principal: those headers are the server's alone. @param {Record<string, unknown> | undefined} headers */
export const pageNamedMaterialHeaders = (headers) => Object.keys(headers ?? {}).some(name => name.toLowerCase().startsWith('x-materials-'));

/**
 * @param {{ upstream?: string | null, secret?: string | null, cache?: import('./materials-cache.mjs').MaterialsCache | null,
 *   auth?: { assertActive?: () => unknown } | null,
 *   savedRoot?: () => Promise<string>,
 *   removeStaged?: (path: string) => Promise<void>,
 *   covers?: ReturnType<typeof createCoverStore> | null,
 *   contents?: ReturnType<typeof createContentStore> | null,
 *   digests?: ReturnType<typeof createDigestIndex> | null,
 *   names?: { nameOf?: (videoId: string) => string | null } | null,
 *   stewardMemory?: string | null,
 *   log?: (line: string) => void,
 *   fetchImpl?: typeof fetch, timeoutMs?: number, now?: () => number,
 *   retryDelays?: readonly number[], sleep?: (ms: number) => Promise<unknown>, maxConcurrent?: number }} options
 *   `covers` keeps the supplier's images on this computer, `contents` the videos it already downloaded,
 *   `digests` answers the supplier's md5 for one video id from the index landed here. All three are
 *   optional so this module stays testable with a plain object; nothing is fetched without them.
 *   `names` answers a material's display name for one video id (vector pack first, landed index second) and
 *   `stewardMemory` is the file the remembered cloud-steward account lives in — both optional for the same reason.
 *   `retryDelays` is how long to wait before each further try at a provider answer that said "not now"
 *   (`RETRY_DELAYS_MS`); `sleep` is injectable so a test does not wait. `maxConcurrent` is how many provider
 *   reads may be in flight at once (`PROVIDER_READS_AT_ONCE`).
 */
export function createMaterialsService({ upstream, secret = null, cache = null, auth = null, savedRoot = libraryRoot, removeStaged = (/** @type {string} */ path) => rm(path, { force: true }), covers = null, contents = null, digests = null, names = null, stewardMemory = null, log = (line) => process.stderr.write(line), fetchImpl = globalThis.fetch, timeoutMs = 15_000, now = Date.now, retryDelays = RETRY_DELAYS_MS, sleep = (/** @type {number} */ ms) => new Promise((done) => setTimeout(done, ms)), maxConcurrent = PROVIDER_READS_AT_ONCE }) {
  const base = trimmed(upstream);
  if (!base || !/^https?:\/\//i.test(base)) throw new TypeError('a material service needs an http(s) upstream');
  if (!trimmed(secret)) throw new TypeError('a material service needs MATERIALS_SECRET to sign a principal');
  if (typeof fetchImpl !== 'function') throw new TypeError('a material service needs fetch');
  const key = /** @type {string} */ (trimmed(secret));

  /** One structured line per cache event (`hit` / `miss`), so what was saved can be counted later. */
  const note = writeJsonLine(log);

  /** Requests already being revalidated, so one stale answer is asked about once. @type {Map<string, Promise<void>>} */
  const inFlight = new Map();
  /** Reads in flight, by route and query: the same question asked twice at once is asked upstream once. @type {Map<string, Promise<{status: number, body: any, cacheable: boolean}>>} */
  const reading = new Map();

  /**
   * A ceiling on how many provider reads this process has in flight: a page's grid asks for a page of cards at
   * once, and the supplier confirms fewer of many simultaneous reads than of reads made a few at a time. A slot is
   * handed to the next waiter rather than released and re-taken, so a new caller cannot slip past the ceiling.
   * @type {Array<() => void>}
   */
  const waitingForSlot = [];
  let readsInFlight = 0;
  const cap = Math.max(1, Math.floor(Number(maxConcurrent)) || PROVIDER_READS_AT_ONCE);
  /** @template T @param {() => Promise<T>} run @returns {Promise<T>} */
  const limited = async (run) => {
    if (readsInFlight >= cap) await new Promise((/** @type {any} */ slot) => waitingForSlot.push(slot));
    else readsInFlight += 1;
    try { return await run(); } finally {
      const next = waitingForSlot.shift();
      if (next) next(); else readsInFlight -= 1;
    }
  };

  /** @returns {never} */
  const denied = () => { throw new HttpError(403, 'Sign in is required.', { code: 'authentication-required' }); };

  /** The session that names the principal, or a refusal. No session, no upstream read. */
  const evidence = () => {
    if (!auth || typeof auth.assertActive !== 'function') denied();
    /** @type {any} */
    let active;
    try { active = auth.assertActive(); } catch { denied(); }
    const environmentId = active?.environmentId, subjectId = active?.subjectId, instanceId = active?.instanceId, epoch = active?.epoch;
    if (typeof environmentId !== 'string' || !environmentId.trim() || /\s/.test(environmentId)) denied();
    if (typeof subjectId !== 'string' || !UUID.test(subjectId)) denied();
    if (typeof instanceId !== 'string' || !UUID.test(instanceId)) denied();
    if (!Number.isSafeInteger(epoch) || epoch <= 0) denied();
    return { environmentId, subjectId, instanceId, epoch };
  };

  /**
   * The signed delegation for exactly this request.
   * @param {'GET' | 'POST' | 'DELETE'} method @param {string} path @param {string} query
   */
  const sign = (method, path, query) => {
    const { environmentId, subjectId, instanceId, epoch } = evidence();
    const exp = Math.floor(now() / 1000) + PRINCIPAL_TTL_SEC;
    const principal = base64url(JSON.stringify({ environmentId, subjectId, instanceId, epoch, exp }));
    const canonical = `${SIGNATURE_VERSION}\n${principal}\n${method.toUpperCase()}\n${path}\n${query}`;
    const signature = createHmac('sha256', key).update(canonical, 'utf8').digest('hex');
    return { principal, signature, canonical };
  };

  /** @param {unknown} error @returns {HttpError} */
  const failed = (error) => {
    const name = /** @type {{ name?: string }} */ (error)?.name;
    if (name === 'AbortError' || name === 'TimeoutError') return new HttpError(504, 'The material provider did not answer in time.', { code: 'material-upstream-timeout' });
    return new HttpError(502, 'The material provider could not be reached.', { code: 'material-upstream-unreachable' });
  };

  /** @param {string} path @param {string} query */
  const ask = async (path, query) => {
    const signed = sign('GET', path, query);
    return fetchImpl(`${base}${path}${query ? `?${query}` : ''}`, {
      method: 'GET',
      headers: { accept: 'application/json', 'x-materials-secret': key, 'x-materials-principal': signed.principal, 'x-materials-signature': signed.signature },
      signal: AbortSignal.timeout(timeoutMs),
    });
  };

  /** The provider's answer, as it stands: status and body both, so nothing is rewritten. @param {string} route @param {string} query */
  const readOnce = async (route, query) => {
    let response;
    try { response = await limited(() => ask(upstreamPath(route), query)); } catch (error) { throw failed(error); }
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      // The provider's own semantics stay the page's: same status, same body, nothing cached.
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = { code: 'material-upstream-body', message: text.slice(0, 2000) }; }
      return { status: response.status, body, cacheable: false };
    }
    let body;
    try { body = JSON.parse(text); } catch { throw new HttpError(502, 'The material provider answered with something that is not JSON.', { code: 'material-upstream-invalid' }); }
    return { status: response.status, body, cacheable: true };
  };

  /**
   * One read, with the provider's "not now" asked again.
   *
   * The provider answers `503 {code: 'provider-unconfirmed'}` (供应商结果未知) for a share of reads when it
   * cannot confirm its own result — measured here at roughly two in five, and at every other read of a
   * twenty-request burst. Passed straight through, that made a page's card list flicker to "读取失败"
   * with nothing wrong at this end. A 429/502/503/504 — and a read that failed at the socket, which is
   * the same "not now" from the other direction — is therefore asked again after `retryDelays`, and the
   * page is told the *last* answer: a provider that is really down still surfaces with its own status
   * and code.
   * @param {'list'|'facets'|'labels'} route @param {string} query
   */
  const read = async (route, query) => {
    /** @type {readonly number[]} */
    const delays = Array.isArray(retryDelays) ? retryDelays : [];
    for (let attempt = 0; ; attempt += 1) {
      const lastTry = attempt >= delays.length;
      try {
        const answer = await readOnce(route, query);
        if (lastTry || !TRANSIENT_STATUSES.has(answer.status)) return answer;
      } catch (error) {
        if (lastTry || !(error instanceof HttpError) || !TRANSIENT_READ_FAILURES.has(error.status)) throw error;
      }
      await sleep(Number(delays[attempt]) || 0);
    }
  };

  /**
   * The read for one page request, shared with any identical one already in flight: a page that asks for
   * the same query from two places (a list and its count, two cards of one batch) costs the provider one
   * read, not two — which is also what keeps a burst of them from being a burst of "not now".
   * @param {'list'|'facets'|'labels'} route @param {string} query
   */
  const askOnce = (route, query) => {
    const name = `${route}\u0000${query}`;
    const running = reading.get(name);
    if (running) return running;
    const shared = read(route, query).finally(() => { reading.delete(name); });
    reading.set(name, shared);
    return shared;
  };

  /**
   * One provider call whose answer is passed through exactly: status and body, nothing rewritten and
   * nothing cached. The routes that are not catalogue reads (the account binding) use this.
   * @param {'GET' | 'POST' | 'DELETE'} method @param {string} path @param {unknown} [payload]
   */
  const forward = async (method, path, payload) => {
    const signed = sign(method, path, '');
    /** @type {Response} */
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          accept: 'application/json', 'x-materials-secret': key, 'x-materials-principal': signed.principal,
          'x-materials-signature': signed.signature, ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) { throw failed(error); }
    const text = await response.text().catch(() => '');
    /** @type {any} */
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { code: 'material-upstream-body', message: text.slice(0, 2000) }; }
    return { status: response.status, body };
  };

  /** The query as cache-key parameters; a repeated name is refused rather than resolved. @param {string} query */  const paramsOf = (query) => {
    /** @type {Record<string, string | string[]>} */
    const params = {};
    for (const [name, value] of new URLSearchParams(query)) {
      if (Object.hasOwn(params, name)) throw new HttpError(400, 'A material query names the same parameter twice.', { code: 'material-query-ambiguous' });
      params[name] = value;
    }
    return params;
  };

  /** One background revalidation of a stale answer; a failure keeps the old one. */
  const revalidate = (/** @type {'list'|'facets'|'labels'} */ route, /** @type {Record<string, string | string[]>} */ params, /** @type {string} */ query) => {
    const name = `${route}\u0000${JSON.stringify(params)}`;
    const running = inFlight.get(name);
    if (running) return running;
    const task = (async () => {
      try {
        const answer = await read(route, query);
        if (answer.cacheable && cache) await cache.writeMeta(route, params, answer.body, TTL[route], answer.status);
      } catch { /* stale stays until the provider answers again */ }
    })().finally(() => { inFlight.delete(name); });
    inFlight.set(name, task);
    return task;
  };

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {'list'|'facets'|'labels'} route */
  const serveRead = async (req, res, route) => {
    evidence();  // no session: refuse here, before the cache and before the network
    const { query } = splitUrl(req.url);
    const params = paramsOf(query);
    const cached = cache ? await cache.readMeta(route, params) : null;
    if (cached && !cached.stale) { json(res, cached.status, cached.body); return; }
    if (cached) {
      json(res, cached.status, cached.body);
      void revalidate(route, params, query);
      return;
    }
    const answer = await askOnce(route, query);
    if (answer.cacheable && cache && answer.status >= 200 && answer.status < 300) await cache.writeMeta(route, params, answer.body, TTL[route], answer.status);
    json(res, answer.status, answer.body);
  };

  /** A staged file the provider left behind after a failed landing: try to take it away, never fail the response on it. */
  const discardStaged = async (/** @type {string} */ path) => {
    try { await removeStaged(path); }
    catch (error) { console.error(`[materials] staged raw file left behind: ${path} (${/** @type {any} */ (error)?.code ?? 'error'})`); }
  };

  /** What the library already knows about one landed video (its sidecar, else the file itself). */
  const knownOf = async (/** @type {string} */ cloud, /** @type {string} */ id, /** @type {string} */ file) => {
    try {
      const meta = JSON.parse(await readFile(join(cloud, CLOUD_META, `${id}.json`), 'utf8'));
      if (meta && typeof meta.sha256 === 'string' && Number.isSafeInteger(meta.bytes)) return { sha256: meta.sha256, bytes: meta.bytes };
    } catch { /* no sidecar: read the file instead */ }
    const bytes = await readFile(file);
    return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  };

  /**
   * Land the staged file in Saved, with its sidecar in `.meta/` — the flat cloud folder, never a bundle, never a
   * sidecar next to the media. The bytes are checked against the provider's hash before the sidecar says the copy is
   * good.
   *
   * **The name is the material's own, with the id kept**: `茉莉飘雪礼盒款120g／盒（万山A款） (100403411).mp4`. Naming the
   * file `<videoId>.mp4` turned the cloud folder into a wall of numbers — the person browses it in Finder or Explorer
   * and cannot tell one 外包装 from another. The id stays last, so a lookup is still exact (and the sidecar records the
   * whole name, which is what the reuse check reads).
   *
   * The sidecar is version 2: subjectId is the signed-in person (honest about what it is), and
   * providerAccountKey is the provider's own account for the material — null until the provider
   * starts naming one (v1 wrote a single ccountKey, which conflated the two).
   */
  /** 记住的云管家账号存在哪个文件（测试注入临时路径，生产是 sharedHome()/cloud-steward.json）。 */
  const stewardFile = stewardMemory ?? memoryFile();
  /* `displayName` is optional and nullable: the caller has a name for some materials and not for others. */
  /**
   * @param {{ cloud: string, id: string, staged: any, videoType: number, subjectId: string | null,
   *   displayName?: string | null }} landed
   * @returns {Promise<{name: string, sha256: string, bytes: number, md5: string}>} the name it landed under, and
   *   the identity of the bytes that landed (the md5 is the content library's own key)
   */
  const landSaved = async ({ cloud, id, staged, videoType, subjectId, displayName = null }) => {
    const extension = (extname(String(staged.name ?? staged.path)) || '.mp4').toLowerCase();
    if (!/^\.[a-z0-9]{1,5}$/.test(extension)) throw new Error('unusable extension');
    await mkdir(join(cloud, CLOUD_META), { recursive: true });
    const readable = safeName(displayName);
    /* 有素材名时用「素材名 (id)」：可辨认，也不会与同名的另一条互相覆盖。 */
    const plain = readable ? `${readable} (${id})${extension}` : `${id}${extension}`;
    const name = plain;
    const target = join(cloud, name);
    await copyFile(staged.path, target);
    const bytes = await readFile(target);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== staged.sha256) {
      await rm(target, { force: true });
      throw new Error('the staged copy does not match the provider hash');
    }
    const md5 = createHash('md5').update(bytes).digest('hex');
    await writeFile(join(cloud, CLOUD_META, `${id}.json`), JSON.stringify({
      version: 2, videoId: id, name, videoType, sha256: staged.sha256, bytes: bytes.length,
      subjectId, providerAccountKey: null, takenAt: new Date(now()).toISOString(),
    }) + '\n');
    return { name, sha256, bytes: bytes.length, md5 };
  };

  /** The provider's answer to a raw read, as it stands. */
  const answerOf = async (/** @type {Response} */ response) => {
    const text = await response.text().catch(() => '');
    /** @type {any} */
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: response.status, body, ok: response.ok };
  };

  return {
    list: (/** @type {any} */ req, /** @type {any} */ res) => serveRead(req, res, 'list'),
    facets: (/** @type {any} */ req, /** @type {any} */ res) => serveRead(req, res, 'facets'),
    labels: (/** @type {any} */ req, /** @type {any} */ res) => serveRead(req, res, 'labels'),
    /**
     * The provider account this installation is bound to: read it, bind one, or unbind it. The proxy
     * forwards and the provider decides what a binding means — its own 400/401/403/501 travel back
     * unchanged, because a page has to be able to name what went wrong.
     * @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res
     */
    binding: async (req, res) => {
      const active = evidence();  // no session: refuse here, before the provider
      const method = String(req.method ?? '').toUpperCase();
      if (method === 'POST') {
        const body = await readJson(req, 8 * 1024);
        const value = /** @type {any} */ (body);
        const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
        if (keys.length !== 1 || keys[0] !== 'account' || typeof value.account !== 'string'
          || !value.account.trim() || value.account.length > 64) {
          throw new HttpError(422, 'A binding names one account.', { code: 'invalid-query' });
        }
        const answer = await forward('POST', upstreamPath('binding'), { account: value.account });
        /* Bound once, remembered: the provider keeps it for this subject, and so does this computer (cloud-steward-memory). */
        if (answer.status >= 200 && answer.status < 300) {
          try { rememberSteward(active?.subjectId ?? null, value.account, { file: stewardFile }); } catch { /* a hint that cannot be written is not a failed binding */ }
        }
        json(res, answer.status, answer.body ?? {});
        return;
      }
      if (method === 'GET') {
        const answer = await forward('GET', upstreamPath('binding'));
        const bound = /** @type {any} */ (answer.body)?.binding;
        if (answer.status >= 200 && answer.status < 300 && !bound) {
          /* The provider does not know this person — offer back the account they bound before, once. A claim that fails
             (renamed account, no longer theirs) drops the hint and leaves them unbound, exactly as before. */
          const remembered = rememberedSteward(active?.subjectId ?? null, { file: stewardFile });
          if (remembered) {
            const claimed = await forward('POST', upstreamPath('binding'), { account: remembered });
            if (claimed.status >= 200 && claimed.status < 300 && /** @type {any} */ (claimed.body)?.binding) {
              json(res, claimed.status, claimed.body ?? {});
              return;
            }
            try { rememberSteward(active?.subjectId ?? null, null, { file: stewardFile }); } catch { /* best effort */ }
          }
        }
        json(res, answer.status, answer.body ?? {});
        return;
      }
      if (method === 'DELETE') {
        const answer = await forward('DELETE', upstreamPath('binding'));
        if (answer.status >= 200 && answer.status < 300) {
          try { rememberSteward(active?.subjectId ?? null, null, { file: stewardFile }); } catch { /* best effort */ }
        }
        json(res, answer.status, answer.body ?? {});
        return;
      }
      throw new HttpError(405, 'A binding is read, made or removed.', { code: 'method-not-allowed' });
    },
    /**
     * Ask the provider to stage one video's bytes, then land that file in Saved as `<videoId>.<ext>`
     * with its `.meta/<videoId>.json` sidecar — the flat cloud folder the library already lists.
     * The provider's own `query/raw` is asked only when nothing for that id is in the library yet,
     * so pressing "use" twice costs nothing and keeps one copy.
     *
     * Before that: the index landed here names this video's md5, and `<material-cache>/content/<md5>`
     * may already hold those bytes. When it does, the download is a **local copy** — the provider is
     * not asked at all — and when it does not, the fetched file is kept there (one copy per md5) so
     * the next download of the same bytes costs nothing. Both outcomes are one structured log line.
     * @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res
     */
    raw: async (req, res) => {
      const active = evidence();  // no session: refuse here, before the provider and before any write
      const body = await readJson(req, 16 * 1024);
      const videoId = /** @type {any} */ (body)?.videoId;
      if (typeof videoId !== 'string' || !SAFE_ID.test(videoId.trim())) {
        throw new HttpError(422, 'A raw read needs one video id.', { code: 'invalid-query' });
      }
      // The caller's video type, when it gave one: forwarded as it is, never invented here (the
      // provider defaults to 1 when the field is absent).
      const rawType = /** @type {any} */ (body)?.videoType;
      const hasType = rawType !== undefined && rawType !== null;
      if (hasType && (!Number.isInteger(rawType) || rawType < 0 || rawType > 4)) {
        throw new HttpError(422, 'A raw read takes a video type from 0 to 4.', { code: 'invalid-query' });
      }
      const id = videoId.trim();
      const videoType = hasType ? rawType : 1;
      const subjectId = active?.subjectId ?? null;
      /* 文件叫什么：素材自己那一行名字（索引里就有），没有才退回 id —— 云素材文件夹不能是一墙数字 */
      const displayName = (typeof body?.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 200) : '')
        || (typeof names?.nameOf === 'function' ? names.nameOf(id) : null);
      const cloud = join(await savedRoot(), CLOUD_DIR);
      // One id, one copy: a library that already has this video costs the provider nothing.
      // The sidecar records the landed name (it is the material's own now, not `<id>.mp4`), so it is read first; the
      // scan is the fallback for a library landed before the sidecar carried a name.
      let already = null;
      try {
        const meta = JSON.parse(await readFile(join(cloud, CLOUD_META, `${id}.json`), 'utf8'));
        const named = typeof meta?.name === 'string' ? meta.name : '';
        if (named && (await stat(join(cloud, named)).catch(() => null))?.isFile()) already = named;
      } catch { already = null; }
      if (!already) {
        already = (await readdir(cloud).catch(() => []))
          .find((name) => !name.startsWith('.') && (name.startsWith(`${id}.`) || name.endsWith(` (${id})${extname(name)}`)));
      }
      if (already) {
        const known = await knownOf(cloud, id, join(cloud, already));
        json(res, 200, { landed: `saved/${CLOUD_DIR}/${already}`, reused: true, sha256: known.sha256, bytes: known.bytes });
        return;
      }

      /* The bytes first. The md5 is the supplier's own (`rawMd5` in the landed index) and is only ever read
         from that file: a page naming a digest could otherwise name someone else's bytes. */
      const md5 = typeof digests?.md5Of === 'function' ? digests.md5Of(id) : null;
      const library = contents;
      const held = md5 && library ? library.open(md5) : null;
      if (held && library && md5) {
        /** @type {{ name: string, sha256: string, bytes: number, md5: string }} */
        let copy;
        /* The bytes are read (and copied) for as long as this promise runs: the library's sweep must not take them
           out from under the copy just because the budget is tight. */
        const release = typeof library.pin === 'function' ? library.pin(md5) : () => {};
        try {
          copy = await landSaved({ cloud, id, staged: { path: held.path, sha256: held.sha256, name: `${id}${held.ext}` }, videoType, subjectId, displayName });
        } catch {
          /* The copy this computer had is not the bytes it said: forget it and ask the provider instead. */
          library.forget(md5);
          copy = /** @type {any} */ (null);
        } finally { release(); }
        if (copy) {
          note({ at: new Date(now()).toISOString(), event: 'material-content', result: 'hit', md5, bytes: copy.bytes, videoId: id, stored: 'already' });
          json(res, 200, { landed: `saved/${CLOUD_DIR}/${copy.name}`, reused: false, sha256: copy.sha256, bytes: copy.bytes, cache: 'hit' });
          return;
        }
        note({ at: new Date(now()).toISOString(), event: 'material-content', result: 'miss', md5, bytes: held.bytes, videoId: id, reason: 'local-copy-unusable' });
      }

      const asked = hasType ? { videoId: id, videoType: rawType } : { videoId: id };
      const signed = sign('POST', upstreamPath('raw'), '');
      /** @type {Response} */
      let response;
      try {
        response = await fetchImpl(`${base}${upstreamPath('raw')}`, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json', 'x-materials-secret': key, 'x-materials-principal': signed.principal, 'x-materials-signature': signed.signature },
          body: JSON.stringify(asked),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) { throw failed(error); }
      const answer = await answerOf(response);
      if (!answer.ok) {
        // The provider names what went wrong (authorization-denied, invalid-query, raw-host-not-allowed,
        // staging-write-failed, a timeout); the page gets that status and that body, unchanged.
        const code = answer.body && typeof answer.body === 'object' && typeof answer.body.code === 'string' ? answer.body.code : 'material-upstream-status';
        json(res, answer.status, answer.body ?? { code });
        return;
      }
      const staged = /** @type {any} */ (answer.body);
      if (!staged || typeof staged.path !== 'string' || !staged.path || typeof staged.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(staged.sha256)
        || !Number.isSafeInteger(staged.bytes) || staged.bytes < 0) {
        throw new HttpError(502, 'The provider answered with an unusable staged file.', { code: 'material-upstream-invalid' });
      }
      /** @type {{ name: string, sha256: string, bytes: number, md5: string }} */
      let landed;
      try {
        landed = await landSaved({ cloud, id, staged, videoType, subjectId, displayName });
      } catch {
        await discardStaged(staged.path);
        // No path, no provider URL, no token: the page only learns that the copy failed.
        throw new HttpError(500, 'The staged material could not be saved.', { code: 'material-raw-land-failed' });
      }
      // Landed: the staging copy has done its job.
      await discardStaged(staged.path);
      /* The same bytes will be asked for again — another material, another project, another day. One copy per md5. */
      const stored = contents
        ? await contents.put({ md5: landed.md5, source: join(cloud, landed.name), sha256: landed.sha256, bytes: landed.bytes, ext: extname(landed.name).toLowerCase() }).catch(() => null)
        : null;
      if (contents) {
        /* Only a run with a content library has something to reconcile, so only that run logs the miss. */
        note({ at: new Date(now()).toISOString(), event: 'material-content', result: 'miss', md5: landed.md5, bytes: landed.bytes, videoId: id, stored: stored ? 'written' : 'unavailable' });
        if (md5 && md5 !== landed.md5) {
          /* The supplier's index and the supplier's bytes disagree: worth a line, since a hit is keyed by that md5. */
          note({ at: new Date(now()).toISOString(), event: 'material-content', result: 'md5-mismatch', md5: landed.md5, expected: md5, bytes: landed.bytes, videoId: id });
        }
      }
      json(res, 200, { landed: `saved/${CLOUD_DIR}/${landed.name}`, reused: false, sha256: landed.sha256, bytes: landed.bytes });
    },
    /**
     * One cover, by the supplier's own url: from this computer's cover cache when it is there, else fetched once and
     * written whole (`material-media-cache.mjs`). Only the supplier's hosts are fetched; a redirect is not followed.
     *
     * A supplier host that cannot be reached is answered **204 No Content**, not 502: there is no image, which is not a
     * gateway error — an `<img>` on a dead node draws its placeholder and the page's console stays quiet. Everything
     * else keeps its status (400 for a url that is not one, 403 for another host, 502 for a refusal, a redirect or an
     * answer too large to be a cover), because those are answers about *this* request rather than about the network.
     * @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res
     */
    coverByUrl: async (req, res) => {
      evidence();  // no session: refuse here, before the cache and before the network
      if (!covers) throw new HttpError(501, 'This installation keeps no cover cache.', { code: 'material-cover-unavailable' });
      const { query } = splitUrl(req.url);
      /** @type {string[]} */
      let asked;
      try { asked = new URLSearchParams(query).getAll('url'); }
      catch { throw new HttpError(400, 'The cover query is not readable.', { code: 'material-cover-url-invalid' }); }
      if (!asked.length || !asked[0].trim()) throw new HttpError(400, 'A cover read names one url.', { code: 'material-cover-url-missing' });
      if (asked.length > 1) throw new HttpError(400, 'A cover read names one url, not two.', { code: 'material-cover-url-ambiguous' });
      /** @type {{bytes: Buffer, contentType: string, hit: boolean, ms: number, name: string}} */
      let image;
      try { image = await covers.get(asked[0].trim()); }
      catch (error) {
        /* No image where there is no image to have: a 204 with no body, which is the same answer a film with no
           poster gets. The store's negative cache answered already (a remembered url is not asked again for a
           minute), so a grid of cards on a dead node costs one stall and one line, not forty. */
        if (error instanceof HttpError && error.status === 204) { res.writeHead(204, { 'cache-control': 'no-store' }); res.end(); return; }
        throw error;
      }
      res.writeHead(200, {
        'content-type': image.contentType,
        'content-length': String(image.bytes.length),
        'cache-control': COVER_CACHE_CONTROL,
        /* Which of the two answered, said out loud: a person (or a test) can see a hit without reading the log. */
        'x-cover-cache': image.hit ? 'hit' : 'miss',
      });
      res.end(image.bytes);
    },
    /**
     * One cover, asked for by name. On disk? Hand it over without touching the network.
     * @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {string} name
     */
    cover: async (req, res, name) => {
      evidence();
      const cached = cache ? await cache.readCover(name) : null;
      if (cached) {
        res.writeHead(200, { 'content-type': cached.contentType, 'content-length': String(cached.bytes.length), 'cache-control': 'immutable, max-age=31536000' });
        res.end(cached.bytes);
        return;
      }
      const { query } = splitUrl(req.url);
      let response;
      try { response = await ask(`${upstreamPath('cover')}/${name}`, query); } catch (error) { throw failed(error); }
      if (response.status === 404) throw new HttpError(404, 'The provider has no such cover.', { code: 'material-cover-missing' });
      if (!response.ok) throw new HttpError(502, 'The provider refused that cover.', { code: 'material-upstream-status', upstreamStatus: response.status });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.length) throw new HttpError(502, 'The provider answered with an empty cover.', { code: 'material-upstream-invalid' });
      const contentType = (response.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim() || 'application/octet-stream';
      if (cache) await cache.writeCover(name, bytes, contentType);
      res.writeHead(200, { 'content-type': contentType, 'content-length': String(bytes.length), 'cache-control': 'immutable, max-age=31536000' });
      res.end(Buffer.from(bytes));
    },
    /** Forget every cached answer and cover. */
    clear: async (/** @type {any} */ _req, /** @type {any} */ res) => {
      if (!cache) throw new HttpError(503, 'This installation has no material cache.', { code: 'material-cache-unavailable' });
      await cache.clear();
      json(res, 200, { cleared: true, at: now() });
    },
    /**
     * How much room the two media folders are using, against their own budgets: `{content, covers}`, each
     * `{bytes, files, limit}` (`material-media-cache.mjs`). A folder this installation does not keep is `null`.
     * @param {import('node:http').IncomingMessage} _req @param {import('node:http').ServerResponse} res
     */
    cacheStats: async (_req, res) => {
      /** @param {{stats?: () => {bytes: number, files: number, limit: number}} | null} store */
      const of = (store) => (store && typeof store.stats === 'function' ? store.stats() : null);
      json(res, 200, { content: of(contents), covers: of(covers) });
    },
  };
}

/**
 * The service the Studio server attaches, or null when this installation has not been given one:
 * an upstream to read from, the shared secret to sign with, and an owned cache root (the isolated
 * profile's, never the project).
 *
 * `mediaRoot` is that cache root: the cover cache (`covers/`) and the content library (`content/`) are
 * two folders beside the answers the cache already keeps. Without it nothing is kept — and without an
 * upstream there is no catalogue to draw covers for anyway.
 * @param {{ cache?: import('./materials-cache.mjs').MaterialsCache | null, auth?: { assertActive?: () => unknown } | null,
 *   env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch, mediaRoot?: string | null, log?: (line: string) => void }} [options]
 */
export function materialsServiceFromEnv({ cache = null, auth = null, env = process.env, fetchImpl, mediaRoot = null, log } = {}) {
  const upstream = trimmed(env.MATERIALS_UPSTREAM);
  const secret = trimmed(env.MATERIALS_SECRET);
  if (!upstream || !secret || !cache) return null;
  const root = trimmed(mediaRoot);
  /* 名字优先从**向量包**取（`names.tsv`，随客户端下发的那一份）；包里没有才退回落地索引。
     下载命名要的是"这一条叫什么"—— 索引一旦和语料不是同一快照就查不到，文件只好退回数字名。 */
  const packDir = trimmed(env.OPENFILM_MATERIAL_PACK) || DEFAULT_PACK_DIR();
  const packNames = packDir ? createPackNames(packDir) : null;
  return createMaterialsService({
    upstream, secret, cache, auth,
    /* Two budgets, both the operator's to set: `ORANGE_MATERIAL_CACHE_MAX_BYTES` for the content library,
       `ORANGE_MATERIAL_COVERS_MAX_BYTES` for the covers (`material-media-cache.mjs`). The same log as the hit/miss
       lines, so what a sweep took is readable beside what a look cost. */
    covers: root ? createCoverStore({ root, ...(env ? { env } : {}), ...(log ? { log } : {}) }) : null,
    contents: root ? createContentStore({ root, ...(env ? { env } : {}), ...(log ? { log } : {}) }) : null,
    digests: root ? createDigestIndex() : null,
    names: packNames ?? (root ? createNameIndex() : null),
    ...(log ? { log } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}












