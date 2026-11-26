// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The one action that costs money: taking a supplier material into the open project's `assets/`.
 *
 * `POST /api/materials/raw` is the Studio origin's route (contract §8: the page never holds the supplier token). The
 * body is the one id a card has **and its supplier class** (`{videoId, videoType?}`, the route defaults 1): the upstream
 * locates the author's grant by that class, so a card that knows it always sends it. The answer names what landed.
 * Failures are classified here, once, so the library can say "not connected", "not allowed", "timed out",
 * "too large or not this type" or "failed" instead of showing nothing at all.
 *
 * Nothing in this module is called by looking: only the card's use/download button reaches it — or the drop of that card
 * on a timeline track, which is the same download with the clip it becomes waiting on it (`lib/clip-download`) — and the
 * controller refuses a second click while the first is unanswered.
 */
import {deniedDownloads} from './denied.ts';

/** The frozen route: a same-origin Studio route, never the supplier's. */
export const RAW_USE_ROUTE = '/api/materials/raw';

/**
 * What one download answered (contract §9): where it landed in Saved, whether the library already had it (and so no
 * supplier download was spent), and the bytes' identity. `landed` is the `saved/…` path, never a project path.
 */
export type RawUseResult = {
  readonly landed: string;
  /** True when the library already had this video: the route did not call the supplier, so nothing was counted. */
  readonly reused: boolean;
  readonly sha256: string | null;
  readonly bytes: number | null;
};

/** The four things a person can be told, without opening a network trace. */
export type UseFailureKind = 'auth' | 'unavailable' | 'forbidden' | 'timeout' | 'unsupported' | 'failed';
export type UseFailure = Error & {readonly status: number; readonly code: string; readonly kind: UseFailureKind};

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

const asFailure = (status: number, code: string, kind: UseFailureKind, message: string): UseFailure =>
  Object.assign(new Error(message), {status, code, kind});

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * The status and code decide the class; the caller never guesses from a message.
 * `raw-too-large` / `raw-type-not-allowed` are their own sentence: retrying them unchanged cannot help.
 *
 * `project-not-found` is "not connected", not "failed": a download no longer lands in a project, so a server that still
 * asks for one is on the older contract. Saying "failed" would hide that mismatch behind a generic sentence.
 */
export function useFailureKindOf(status: number, code: string): UseFailureKind {
  /* No session first: a 401 (or the server's `authentication-required`, even on a 403) is something the person can
     act on — sign in — and must never be shown as a generic failure. */
  if (status === 401 || code === 'authentication-required') return 'auth';
  if (status === 501 || code === 'material-service-unavailable') return 'unavailable';
  if (code === 'project-not-found') return 'unavailable';
  if (status === 413 || code === 'raw-too-large' || status === 422 || code === 'raw-type-not-allowed') return 'unsupported';
  if (status === 403 || code === 'authorization-denied' || code === 'raw-host-not-allowed'
    || code === 'origin-rejected') return 'forbidden';
  if (status === 504 || status === 408 || code === 'provider-timeout' || code === 'material-upstream-timeout') return 'timeout';
  return 'failed';
}

/** What kind of failure an error is, whether it came from this module or a host handler of its own. */
export function useFailureKind(error: unknown): UseFailureKind {
  const candidate = error as (Partial<UseFailure> & {body?: unknown}) | null;
  if (candidate && typeof candidate === 'object') {
    if (candidate.kind === 'auth' || candidate.kind === 'unavailable' || candidate.kind === 'forbidden'
      || candidate.kind === 'timeout' || candidate.kind === 'unsupported' || candidate.kind === 'failed') return candidate.kind;
    const body = candidate.body;
    const fromBody = body && typeof body === 'object' ? (body as {code?: unknown}).code : undefined;
    const code = typeof candidate.code === 'string' ? candidate.code : typeof fromBody === 'string' ? fromBody : '';
    if (typeof candidate.status === 'number') return useFailureKindOf(candidate.status, code);
    if (code) return useFailureKindOf(0, code);
  }
  return 'failed';
}

/**
 * The landing a 200 answer names. The frozen contract (§9) answers `{landed: 'saved/…', reused, sha256, bytes}`; a
 * server from before that contract answered a list of project paths — read here too, so the page keeps working across
 * the deployment window instead of calling every download "unconfirmed". Anything else is not a landing.
 */
function landedOf(value: unknown): string | null {
  if (typeof value === 'string') return value.startsWith('saved/') && !value.split('/').some(part => part === '' || part === '.' || part === '..') ? value : null;
  if (!Array.isArray(value) || value.length === 0) return null;
  const first = value[0];
  if (typeof first === 'string') return first ? first : null;
  if (isRecord(first) && typeof first.path === 'string' && first.path) return first.path;
  return null;
}

function resultOf(body: unknown): RawUseResult | null {
  if (!isRecord(body)) return null;
  const landed = landedOf(body.landed);
  if (!landed) return null;
  const sha256 = typeof body.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(body.sha256) ? body.sha256 : null;
  const bytes = typeof body.bytes === 'number' && Number.isSafeInteger(body.bytes) && body.bytes >= 0 ? body.bytes : null;
  return {landed, reused: body.reused === true, sha256, bytes};
}

/**
 * The least a download needs to know about a card: its id, and its supplier class when one is known. A row taken from a
 * card carries both; a material dragged from the centre onto a track carries the same two and nothing else (there is no
 * card in the drag, only what to fetch).
 */
export type MaterialUseInput = {readonly videoId: string; readonly videoType?: number | null; readonly name?: string | null; readonly title?: string | null};

export type MaterialUseOptions = {
  /** Injected in tests; defaults to the platform's `fetch` (same origin, so the session cookie travels). */
  readonly fetch?: Fetcher;
  readonly route?: string;
  /** A download can be slow; the ceiling only exists so the button cannot hang forever. */
  readonly timeoutMs?: number;
};

/**
 * The handler a host hands to the library. It resolves with what landed and rejects with a {@link UseFailure};
 * it never fetches anything until it is called.
 */
export function createMaterialUse(options: MaterialUseOptions = {}): (card: MaterialUseInput) => Promise<RawUseResult> {
  const fetcher: Fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const route = options.route ?? RAW_USE_ROUTE;
  const timeoutMs = options.timeoutMs ?? 180_000;
  return async function useMaterial(card) {
    const videoId = card?.videoId;
    if (typeof videoId !== 'string' || !videoId) throw asFailure(400, 'invalid-video-id', 'failed', '素材缺少可下载的标识，未发出请求。');
    /* The card's own supplier class travels with the id: the upstream needs it to find the author's grant. A card
       without one lets the route use its default (1) rather than guessing here.
       No project travels with it: the download lands in the library, and the list the person sees is not tied to the
       project the server happened to open last (the mismatch that used to land a file in project A and refresh B). */
    const videoType = card.videoType;
    /* A refusal this session already met: no request at all, whichever surface asks (the card is disabled, but a retry
       path or a second host must not slip through). */
    if (deniedDownloads.has(videoId)) throw asFailure(403, 'authorization-denied', 'forbidden', '该素材在本会话被判定为无权下载，未发出请求。');
    const payload: {videoId: string; videoType?: number} = typeof videoType === 'number' && Number.isInteger(videoType) && videoType >= 0 && videoType <= 4
      ? {videoId, videoType}
      : {videoId};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetcher(route, {
          method: 'POST',
          headers: {'content-type': 'application/json', accept: 'application/json'},
          body: JSON.stringify(payload),
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
          signal: controller.signal,
        });
      } catch (error) {
        const timedOut = controller.signal.aborted || (error as {name?: string} | null)?.name === 'AbortError';
        throw timedOut
          ? asFailure(504, 'provider-timeout', 'timeout', '下载超时，本次结果不作数。')
          : asFailure(503, 'material-service-unreachable', 'unavailable', '下载服务没有响应，本次没有取到文件。');
      }
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const code = isRecord(body) && typeof body.code === 'string' ? body.code : 'internal-error';
        const message = isRecord(body) && typeof body.message === 'string' ? body.message : '下载失败（' + response.status + '），本次结果不作数。';
        const kind = useFailureKindOf(response.status, code);
        /* A refusal is about the identity, not this moment: remember the video so no surface asks for it again. */
        if (kind === 'forbidden') deniedDownloads.add(videoId, code);
        throw asFailure(response.status, code, kind, message);
      }
      const parsed = resultOf(body);
      if (!parsed) throw asFailure(502, 'provider-response-unconfirmed', 'failed', '下载结果无法确认，本次不作数。');
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Where "this costs a download" was already said; once per session is enough. */
export const SPEND_NOTICE_KEY = 'orangefilm.material-use.spend-notice';
export type NoticeStorage = {getItem(key: string): string | null; setItem(key: string, value: string): void};

/**
 * The one-time sentence before the first use/download. It is a banner, not a dialog: the person can read it and click
 * when ready. After the first use it is never shown again in this session (nothing is stored outside the session).
 */
export function createSpendNotice(storage: NoticeStorage | null | undefined) {
  const read = (): boolean => {
    if (!storage) return true;
    try {
      return storage.getItem(SPEND_NOTICE_KEY) !== '1';
    } catch {
      return true;
    }
  };
  return {
    shouldShow: read,
    dismiss(): void {
      if (!storage) return;
      try {
        storage.setItem(SPEND_NOTICE_KEY, '1');
      } catch {
        /* a storage that refuses writes only means the sentence comes back next time */
      }
    },
  };
}
