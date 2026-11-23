// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * The analyser's frames, taken from what Studio already works out from a media file: `derived.mjs`'s `probe`
 * (length and picture size) and `frame` (one JPEG at a moment, cached in the project's `.film/cache/`). The
 * pipeline in `packages/orangefilm/src/analyze-runner.mjs` asks an extractor for `{ frames, scene }`, where a
 * frame is `{ at (s), jpeg (Buffer), width, height }`; this module is that shape and nothing else.
 *
 * `derived.mjs` is not changed to make this work. It works on a **project root and a project-relative path**
 * (`source()` goes through `readable(root, rel)`, which refuses anything outside the project), while an
 * analyser is handed an absolute path. The split therefore happens here, and a path that leaves the root is
 * a named failure (`media-outside-project`) rather than a quiet fallback to another file or another extractor.
 *
 * Two honest limits, said rather than papered over:
 *
 * - **`scene` is `'not-supported'`.** `derived.mjs` has no scene detection. Reporting `'ok'` would claim a cut
 *   pass that never ran; `'failed'` would blame ffmpeg for something it was never asked to do. The runner
 *   stores whatever the extractor says in `summary.states.scene`.
 * - **A still has no length.** `probe` gives no `duration` for a picture, so it gets the single frame at 0.
 *
 * `inject` is for tests: `{ probe, frame }` of the same signature as `derived.mjs`'s, so a test runs the whole
 * adapter with no ffmpeg, no media and no cache directory. Given `inject`, `derived.mjs` is never imported.
 *
 * @typedef {{ duration?: number, width?: number, height?: number }} Probe
 * @typedef {(root: string, rel: string) => Promise<Probe>} ProbeFn
 * @typedef {(root: string, rel: string, ms: number, width: number) => Promise<Buffer>} FrameFn
 * @typedef {{ probe?: ProbeFn, frame?: FrameFn }} Tools
 */
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/** What this extractor can say about cuts: nothing, and it says exactly that. */
export const SCENE_STATE = 'not-supported';

/**
 * `derived.mjs`'s own clamp, mirrored: `frame` reduces the width it is given to 32…640, even, and reports no
 * size back, so the width a frame actually came out at has to be worked out here the same way. If that rule
 * ever changes on that side, this is the one line that has to follow it.
 * @param {number} width @returns {number}
 */
export const frameWidth = (width) => Math.max(32, Math.min(640, Math.round(width / 2) * 2 || 160));

/**
 * The times to take, in milliseconds, from a length and a rate.
 *
 * Monotonic, at most `maxFrames` of them, never at or past the end of the media (a frame exactly at the last
 * millisecond of a clip is a decoder's empty answer, not a picture), and inside the first `seconds`. A media
 * with no length — a still — gets the one frame at 0 rather than a guessed length.
 * @param {{ duration?: number, fps?: number, seconds?: number, maxFrames?: number }} ask
 * @returns {number[]} milliseconds from the start
 */
export function moments({ duration = NaN, fps = 1, seconds = 60, maxFrames = 12 } = {}) {
  const cap = Number.isFinite(maxFrames) && maxFrames > 0 ? Math.floor(maxFrames) : 0;
  if (!cap) return [];
  const rate = Number.isFinite(fps) && fps > 0 ? fps : 1;
  const span = Number.isFinite(seconds) && seconds > 0 ? seconds : 60;
  if (!(Number.isFinite(duration) && duration > 0)) return [0];
  const reach = Math.min(span, duration);
  const step = 1000 / rate;
  /** @type {number[]} */
  const out = [];
  for (let i = 0; i < cap; i++) {
    const ms = Math.round(i * step);
    if (i && ms / 1000 >= reach) break;
    out.push(ms);
  }
  return out;
}

/** A failure the caller can branch on: the runner stores `code` and reports no stack. */
function failure(/** @type {string} */ message, /** @type {string} */ code, /** @type {object} */ extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

/** `derived.mjs` throws `MediaError`s that carry an HTTP `status` and no `code`: name them for the runner. */
const CODE_BY_STATUS = /** @type {Record<number, string>} */ ({
  400: 'frames-failed',
  404: 'media-missing',
  422: 'frames-failed',
  501: 'not-configured',
});

/**
 * One step's failure, with a code the pipeline can act on: a missing file is `media-missing`, an absent ffmpeg
 * is `not-configured`, anything else is `frames-failed` — never a bare Error and never a half result. A step
 * that already carries a code keeps it.
 * @param {any} error @param {'probe' | 'frame'} step
 */
function coded(error, step) {
  if (typeof error?.code === 'string') return error;
  const code = CODE_BY_STATUS[Number(error?.status)] ?? 'frames-failed';
  const said = String(error?.message ?? '').trim() || `${step} produced nothing`;
  return Object.assign(new Error(said), { code, step, ...(error?.status ? { status: error.status } : {}) });
}

/**
 * The absolute path an analyser was handed, as `derived.mjs` wants it: a project root and a path inside it,
 * with forward slashes.
 *
 * Without a `root` the media's own folder is the root (the file's name is then the relative path: the split
 * is by construction, and nothing can be outside — there is nowhere else to be). With a `root`, the relative
 * path is what it is, and a media path that leaves that folder throws `media-outside-project` instead of being
 * read as something else. Both drive the same `source()` on the other side.
 * @param {{ path?: string, url?: string } | null | undefined} media @param {string | null} [root]
 * @returns {{ root: string, rel: string }}
 */
export function placeOf(media, root = null) {
  const path = typeof media?.path === 'string' ? media.path.trim() : '';
  if (!path) {
    const url = typeof media?.url === 'string' ? media.url.trim() : '';
    throw url
      ? failure(`the analyser takes a file on disk, and ${url} is a URL`, 'media-not-local', { url })
      : failure('analysis needs a media file', 'media-missing');
  }
  const abs = resolve(path);
  if (typeof root !== 'string' || !root) return { root: dirname(abs), rel: basename(abs) };
  const home = resolve(root);
  const rel = relative(home, abs);
  const parts = rel.split(sep);
  if (!rel || parts[0] === '..' || isAbsolute(rel)) {
    throw failure(`${path} is not a file inside ${home}`, 'media-outside-project', { root: home, abs });
  }
  return { root: home, rel: parts.join('/') };
}

/** The picture's height at the width it will come out at, from the size `probe` reports (already turned upright). */
function frameHeight(/** @type {Probe | null | undefined} */ info, /** @type {number} */ width) {
  const w = Number(info?.width);
  const h = Number(info?.height);
  if (!(w > 0 && h > 0)) return width;
  return Math.max(2, Math.round((width * h) / w / 2) * 2);
}

/** `derived.mjs` when a run needs it: imported here, so a test that injects its own never loads it. */
async function studioTools() {
  const module = await import('../../../packages/orangefilm/studio/server/derived.mjs');
  return { probe: module.probe, frame: module.frame };
}

/**
 * Frames for the analyser: `{ frames: [{ at, jpeg, width, height }], scene: 'not-supported' }`.
 *
 * `probe` once for the length, then one `frame` call per moment (`moments`) — the same order the timeline
 * asks for a thumbnail, so the analysis of a clip that Studio is already showing costs it no extra decode per
 * moment. The frame count never exceeds `maxFrames`; an extractor that ends with nothing to describe throws
 * `frames-empty`, which is the runner's own word for it, not an empty success.
 *
 * `longEdge` is honoured through `derived.mjs`'s clamp (640 at most): a frame of the analysis is a thumbnail,
 * not a 4K still. `quality` is not: `derived.mjs` fixes the JPEG quality of its cache, and re-encoding its
 * output here would cost a decode for no measured gain.
 * @param {{
 *   media?: { path?: string, url?: string } | null,
 *   root?: string | null,
 *   fps?: number, seconds?: number, maxFrames?: number, longEdge?: number,
 *   quality?: number, scene?: number,
 *   meta?: { name?: string } | null,
 *   inject?: Tools | null,
 * }} [ask]
 * @returns {Promise<{ frames: { at: number, jpeg: Buffer, width: number, height: number }[], scene: string }>}
 */
export async function derivedFrames(ask = {}) {
  const {
    media = null,
    root = null,
    fps = 1,
    seconds = 60,
    maxFrames = 12,
    longEdge = 1280,
    inject = null,
  } = ask;

  const at = placeOf(media, root);
  const tools = inject ?? await studioTools();
  if (typeof tools?.probe !== 'function' || typeof tools?.frame !== 'function') {
    throw failure('the injected probe and frame are needed together', 'derived-inject-invalid');
  }

  let info = null;
  try {
    info = await tools.probe(at.root, at.rel);
  } catch (error) {
    throw coded(error, 'probe');
  }

  const width = frameWidth(Number(longEdge) || 1280);
  const height = frameHeight(info, width);
  /** @type {{ at: number, jpeg: Buffer, width: number, height: number }[]} */
  const frames = [];
  for (const ms of moments({ duration: Number(info?.duration), fps, seconds, maxFrames })) {
    let jpeg;
    try {
      jpeg = await tools.frame(at.root, at.rel, ms, width);
    } catch (error) {
      throw coded(error, 'frame');
    }
    /* a moment ffmpeg answered with no bytes is no frame; the moments that did come back still count */
    if (Buffer.isBuffer(jpeg) && jpeg.length) frames.push({ at: ms / 1000, jpeg, width, height });
  }
  if (!frames.length) {
    throw failure('no frames came out of this media through Studio’s own extraction: it may be shorter than one moment, or unreadable', 'frames-empty', { rel: at.rel });
  }
  return { frames, scene: SCENE_STATE };
}
