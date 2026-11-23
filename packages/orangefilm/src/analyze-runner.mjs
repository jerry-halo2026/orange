// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * One piece of media in, three things out: a card (`summary`), the graded evidence (`videoMd`) and a
 * vector (`embedding`). Everything that leaves this process is injected, so the pipeline can be run
 * against fakes in a test and against real services in the app — and so a missing service is a named
 * state rather than a crash.
 *
 * The rules below are not style choices; each came out of measuring the real thing:
 *
 * 1. **Warm up first.** The first `describe` call is the expensive one (26.8 s cold against 1.35 s
 *    per frame warm on this machine), so a small throwaway image is described once before the real
 *    frames, and its cost is reported apart: `timings.warmup` vs `timings.describe`. A report that
 *    folded them together would hide a 20× difference.
 * 2. **Frames are bounded.** `fps=1` over the first seconds, at most `maxFrames` (12) of them, each
 *    scaled down and encoded JPEG before it is sent — the vision endpoint is charged by the pixel, and
 *    4K stills bought nothing. The default extractor is Studio's own derivation (`studioFrames` below:
 *    the 640-wide JPEG Studio already caches per moment, and no cut pass, so `scene` says
 *    `not-supported`); `ffmpegFrames` is the fallback extractor that adds the cut pass of its own, and
 *    what a test injects in place of either.
 * 3. **Words come from OCR, not from the vision model.** A VLM asked to read a picture produces
 *    plausible brand names that were never there. Its reading of the text goes to `summary.hints`
 *    and nowhere else; `summary.tags`, the brand fields and `videoMd`'s authoritative sections take
 *    text only from `meta` or from OCR. When OCR is not available that is said out loud
 *    (`ocr: 'not-configured'`), never filled in by guesswork.
 * 4. **Names come from metadata.** `meta.name` / `meta.accountName` / `meta.category1|2` /
 *    `meta.labels` are the only sources for who the material is about.
 * 5. **The same input is answered once.** The cache key is `sha256(media) + ANALYZER_VER`, kept under
 *    `workspace`; a hit returns the stored result and makes **no** external call at all.
 * 6. **A failure is data.** Any injected step that throws ends the run with
 *    `{ ok: false, step, code, message }` — no stack, no half result.
 *
 * About the LM Studio endpoint in this environment: it listens on **1235**, not the default 1234,
 * serves `qwen2.5-vl-7b-instruct`, and its `image_url` accepts **base64 only** (a `webp` data URL is
 * mishandled there; png and jpeg are fine) — so `describe` sends base64 jpeg, and the default base
 * URL below says 1235.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Bumped whenever the pipeline's output changes shape: it is part of the cache key. */
/* `-2`: the frames now come from Studio's derivation (640-wide, cached, no cut pass) instead of this
   module's own ffmpeg run. The result's *shape* did not change, but its *content* does — different JPEGs,
   different moments, a different `states.scene` — and a cached card from `-1` would be an answer about
   frames that were never described under this extractor. The version is the only thing standing between a
   cache hit and that stale answer, so it moves. */
export const ANALYZER_VER = 'analyze-runner-2';

/** The defaults the measurements argue for. */
export const FRAME_DEFAULTS = Object.freeze({
  fps: 1,
  seconds: 60,
  maxFrames: 12,
  longEdge: 1280,
  quality: 85,
  scene: 0.3,
});

/** The vision endpoint this build talks to when nothing says otherwise (1235 here, not 1234). */
export const DEFAULT_VISION_BASE = 'http://127.0.0.1:1235';
/** The model it serves in this environment. */
export const DEFAULT_VISION_MODEL = 'qwen2.5-vl-7b-instruct';
/** The embedding endpoint (same server, LM Studio's OpenAI-compatible surface). */
export const DEFAULT_EMBED_MODEL = 'text-embedding-nomic-embed-text-v1.5';

/** A step that is not installed is not an error: it is a named state. */
export class NotConfigured extends Error {
  /** @param {string} what */
  constructor(what) {
    super(`${what} is not configured`);
    this.name = 'NotConfigured';
    this.code = 'not-configured';
  }
}

/** One 1×1 grey JPEG: enough to make the server load its model, small enough to cost nothing. */
const WARMUP_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AmwA/9k=',
  'base64',
);

/** @param {unknown} value */
const text = (value) => (typeof value === 'string' ? value.trim() : '');
/** @param {number} ms */
const secs = (ms) => Math.round(ms) / 1000;

/**
 * The identity of the input, for the cache key: a file's bytes, or a URL as itself (a remote file has
 * no bytes here until it is fetched, and fetching it just to hash it would defeat the cache).
 * @param {{ path?: string, url?: string }} media
 */
export function mediaDigest(media) {
  if (media?.path) {
    if (!existsSync(media.path)) throw Object.assign(new Error(`no such media: ${media.path}`), { code: 'media-missing' });
    return createHash('sha256').update(readFileSync(media.path)).digest('hex');
  }
  if (media?.url) return createHash('sha256').update(`url:${media.url}`).digest('hex');
  throw Object.assign(new Error('analysis needs a media path or URL'), { code: 'media-missing' });
}

/** Where a finished analysis is kept: `workspace/analysis/<digest>-<ver>.json`. */
export const cachePath = (/** @type {string} */ workspace, /** @type {string} */ digest, /** @type {string} */ ver = ANALYZER_VER) =>
  join(workspace, 'analysis', `${digest}-${ver}.json`);

/**
 * The extractor this module used to run by default, kept as the fallback and as the pinned subject of the
 * frame tests: one frame a second for the first `seconds`, plus frames where the picture cuts (scene > 0.3),
 * then scales each to a long edge of `longEdge` and writes JPEG q`quality`. Tests inject their own.
 * @param {{ media: { path?: string, url?: string }, fps?: number, seconds?: number, maxFrames?: number, longEdge?: number, quality?: number,
 *   scene?: number, spawn?: Function, readdir?: (dir: string) => string[], read?: (file: string) => Buffer, mkdtemp?: () => string }} ask
 * @returns {Promise<{ at: number, jpeg: Buffer, width: number, height: number }[]>}
 */
export async function ffmpegFrames({
  media, fps = FRAME_DEFAULTS.fps, seconds = FRAME_DEFAULTS.seconds, maxFrames = FRAME_DEFAULTS.maxFrames,
  longEdge = FRAME_DEFAULTS.longEdge, quality = FRAME_DEFAULTS.quality, scene = FRAME_DEFAULTS.scene,
  spawn = null, readdir = null, read = null, mkdtemp = null,
}) {
  const source = media?.path ?? media?.url;
  if (!source) throw Object.assign(new Error('no media'), { code: 'media-missing' });
  const { spawnSync } = spawn ? { spawnSync: null } : await import('node:child_process');
  const run = spawn ?? spawnSync;
  const fs = await import('node:fs');
  const list = readdir ?? fs.readdirSync;
  const bytes = read ?? fs.readFileSync;
  const temp = mkdtemp ?? (() => fs.mkdtempSync(join(tmpdir(), 'analyze-frames-')));

  const dir = temp();
  const passes = framesPasses(source, { fps, seconds, maxFrames, longEdge, quality, scene }, dir);

  // Pass 1 — the steady one-a-second frames. No `select` here: at 1 fps neighbouring frames differ by
  // far less than the scene threshold, so a `select` bolted on would quietly drop every frame.
  const steady = run('ffmpeg', passes.steady, { encoding: 'utf8' });
  framesFailure(steady, 'frames');

  // Pass 2 — the cuts, on the original frame rate (a run of their own), with `-fps_mode vfr` keeping
  // only the selected frames. ffmpeg 9 dropped `-vsync`, so a build that refuses `-fps_mode` is asked
  // once more with the old spelling.
  const attempt = (/** @type {string[]} */ args) => run('ffmpeg', args, { encoding: 'utf8' });
  let cuts = attempt(passes.scene);
  if (/Unrecognized option 'fps_mode'|Unrecognized option: fps_mode|Option not found[\s\S]{0,200}?fps_mode/i.test(String(cuts?.stderr ?? ''))) {
    cuts = attempt(passes.sceneLegacy);
  }
  // A scene pass that fails once the steady frames are in hand must not take the whole run down: those
  // frames are enough to describe the material, so the state says `failed` and the run carries on.
  const sceneOk = !cuts?.error && cuts?.status === 0;

  const steadyFrames = list(dir).filter((name) => /^f\d+\.jpg$/.test(name)).sort().map((name, index) => ({
    at: index / fps, jpeg: bytes(join(dir, name)), width: longEdge, height: longEdge,
  }));
  const cutTimes = sceneOk ? ptsTimes(String(cuts?.stderr ?? '')) : [];
  const cutFrames = sceneOk ? list(dir).filter((name) => /^s\d+\.jpg$/.test(name)).sort().map((name, index) => ({
    at: cutTimes[index] ?? 0, jpeg: bytes(join(dir, name)), width: longEdge, height: longEdge,
  })) : [];

  const merged = mergeFrames([...steadyFrames, ...cutFrames]).slice(0, maxFrames);
  if (!merged.length) {
    throw Object.assign(new Error('ffmpeg produced no frames: the media may be shorter than one second, or unreadable'), { code: 'frames-empty' });
  }
  return { frames: merged, scene: sceneOk ? 'ok' : 'failed' };
}

/**
 * The default extractor: Studio's own derivation, through the desktop adapter
 * (`apps/desktop/src/derived-frames.mjs`), which composes `studio/server/derived.mjs`'s `probe` and `frame`
 * into the `{ frames, scene }` this pipeline asks for. Imported when a run needs it rather than at load, so
 * the pipeline still loads — and a test's injected `frames` still runs — without the app's side of the tree.
 *
 * It answers `scene: 'not-supported'`, which is the truth: derived.mjs has no cut detection. `ffmpegFrames`
 * above is the extractor that does have one, kept exported as the fallback for a caller that wants it — and
 * it is what a media that is a URL rather than a file gets, because there is no file for Studio to derive
 * from and that is not a failure.
 * @param {Parameters<typeof ffmpegFrames>[0]} ask
 */
export async function studioFrames(ask) {
  if (!ask?.media?.path) return ffmpegFrames(ask);
  const { derivedFrames } = await import('../../../apps/desktop/src/derived-frames.mjs');
  return derivedFrames(ask);
}

/**
 * The two ffmpeg argument lists, as data: a test can read them without running ffmpeg.
 *
 * - `-pix_fmt yuvj420p` is not cosmetic. ffmpeg 9's mjpeg encoder refuses a non-full-range YUV
 *   (`Non full-range YUV is non-standard…` → `ff_frame_thread_encoder_init failed` → exit **-22**);
 *   the full-range pixel format is what makes the JPEG output work.
 * - `fps` and `select='gt(scene,…)'` must not share a pass: after `fps=1` adjacent frames are a
 *   second apart and their difference is usually below the threshold, so the pass yields **0 frames
 *   and still exits 0** — a silent failure. Each pass therefore runs on its own, and `-vsync vfr`
 *   keeps only the frames the scene pass selected.
 * @param {string} source
 * @param {{ fps: number, seconds: number, maxFrames: number, longEdge: number, quality: number, scene: number }} ask
 * @param {string} outDir
 */
export function framesPasses(source, { fps, seconds, maxFrames, longEdge, quality, scene }, outDir) {
  const scale = `scale='if(gt(iw,ih),min(${longEdge},iw),-2)':'if(gt(iw,ih),-2,min(${longEdge},ih))'`;
  const encode = ['-pix_fmt', 'yuvj420p', '-q:v', String(Math.max(2, Math.round(31 - quality / 3)))];
  return {
    steady: ['-hide_banner', '-loglevel', 'error', '-i', source, '-vf', `fps=${fps},trim=duration=${seconds},${scale}`,
      ...encode, '-frames:v', String(maxFrames), join(outDir, 'f%03d.jpg')],
    scene: ['-hide_banner', '-loglevel', 'info', '-i', source, '-vf', `select='gt(scene\\,${scene})',${scale}`,
      '-fps_mode', 'vfr', ...encode, '-frames:v', String(maxFrames), join(outDir, 's%03d.jpg')],
    /* ffmpeg 9 removed `-vsync` outright ("Unrecognized option 'vsync'"): `-fps_mode vfr` is the
       current spelling and comes first. A build too old to know `-fps_mode` is asked once more with
       `-vsync` — one downgrade, never the other way round, because the new spelling is the one that
       will keep working. */
    sceneLegacy: ['-hide_banner', '-loglevel', 'info', '-i', source, '-vf', `select='gt(scene\\,${scene})',${scale}`,
      '-vsync', 'vfr', ...encode, '-frames:v', String(maxFrames), join(outDir, 's%03d.jpg')],
  };
}

/** `pts_time:3.2` from the scene pass's log: where each selected frame is in the film. */
export function ptsTimes(/** @type {string} */ log) {
  return [...log.matchAll(/pts_time:([\d.]+)/g)].map((match) => Number(match[1])).filter((value) => Number.isFinite(value));
}

/** The same moment from two passes is one frame. */
export function mergeFrames(/** @type {{ at: number, jpeg: Buffer }[]} */ frames) {
  const sorted = [...frames].sort((a, b) => a.at - b.at);
  /** @type {{ at: number, jpeg: Buffer }[]} */
  const kept = [];
  for (const frame of sorted) {
    if (!kept.length || Math.abs(kept[kept.length - 1].at - frame.at) >= 0.5) kept.push(frame);
  }
  return kept;
}

/**
 * ffmpeg's failures, made actionable. A non-zero exit and a *silent* empty run are different
 * problems and must not be reported as the same thing.
 * @param {{ status?: number | null, stderr?: string, error?: Error }} result @param {string} pass
 * @returns {void}
 */
export function framesFailure(result, pass) {
  const said = String(result?.stderr ?? '');
  if (result?.error) throw Object.assign(new Error('ffmpeg is not available for frame extraction'), { code: 'not-configured' });
  if (/Non full-range|full-range YUV|strict_std_compliance/i.test(said) || result?.status === -22) {
    // The actionable half: say what the encoder wants, not just that it failed.
    throw Object.assign(new Error('ffmpeg’s mjpeg encoder requires full-range YUV: pass -pix_fmt yuvj420p (see framesPasses)'), {
      code: 'frames-encoder-range', pass, said: said.slice(-500),
    });
  }
  if (result?.status !== 0) {
    throw Object.assign(new Error(`ffmpeg could not extract the ${pass} frames: ${said.trim().split('\n').slice(-1)[0] || 'no output'}`), {
      code: 'frames-failed', pass, said: said.slice(-500),
    });
  }
}

/**
 * Vision description through LM Studio's OpenAI-compatible chat endpoint (base64 jpeg only: its
 * `image_url` mishandles webp). `not-configured` when nothing answers there.
 * @param {{ baseUrl?: string, model?: string, fetch?: typeof fetch }} [options]
 */
export function lmStudioDescriber({ baseUrl = process.env.OPENFILM_VISION_URL ?? DEFAULT_VISION_BASE, model = process.env.OPENFILM_VISION_MODEL ?? DEFAULT_VISION_MODEL, fetch: fetchImpl = fetch } = {}) {
  return async (/** @type {{ jpeg: Buffer, at?: number, prompt?: string }} */ ask) => {
    const body = {
      model,
      temperature: 0,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: ask.prompt ?? 'Describe what happens in this frame in one sentence. Then list any on-screen text you think you see as "HINTS: …".' },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${ask.jpeg.toString('base64')}` } },
        ],
      }],
    };
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch {
      throw new NotConfigured('the vision endpoint');
    }
    if (!response.ok) throw Object.assign(new Error(`the vision endpoint answered ${response.status}`), { code: 'describe-failed' });
    const answer = await response.json();
    const said = text(answer?.choices?.[0]?.message?.content);
    const [description, ...rest] = said.split(/HINTS:/i);
    return { text: description.trim(), hints: text(rest.join(' ')) };
  };
}

/** Text embeddings through the same server. */
export function lmStudioEmbedder({ baseUrl = process.env.OPENFILM_VISION_URL ?? DEFAULT_VISION_BASE, model = process.env.OPENFILM_EMBED_MODEL ?? DEFAULT_EMBED_MODEL, fetch: fetchImpl = fetch } = {}) {
  return async (/** @type {string} */ input) => {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/v1/embeddings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, input }) });
    } catch {
      throw new NotConfigured('the embedding endpoint');
    }
    if (!response.ok) throw Object.assign(new Error(`the embedding endpoint answered ${response.status}`), { code: 'embed-failed' });
    const answer = await response.json();
    const vector = answer?.data?.[0]?.embedding;
    if (!Array.isArray(vector)) throw Object.assign(new Error('the embedding endpoint answered without a vector'), { code: 'embed-invalid' });
    return { model, ver: ANALYZER_VER, vector };
  };
}

/** OCR: a command when one is installed, `not-configured` otherwise. */
export function commandOcr({ command = process.env.OPENFILM_OCR_COMMAND ?? '' } = {}) {
  return async (/** @type {{ jpeg: Buffer }} */ ask) => {
    if (!command) throw new NotConfigured('OCR');
    const { spawnSync } = await import('node:child_process');
    const run = spawnSync(command, ['--image', '-'], { input: ask.jpeg, encoding: 'utf8' });
    if (run.error) throw new NotConfigured('OCR');
    if (run.status !== 0) throw Object.assign(new Error('OCR could not read this frame'), { code: 'ocr-failed' });
    return { text: (run.stdout ?? '').trim() };
  };
}

/** Speech: faster-whisper when it is installed, `not-configured` otherwise. */
export function fasterWhisper({ command = process.env.OPENFILM_WHISPER_COMMAND ?? '' } = {}) {
  return async (/** @type {{ media: { path?: string, url?: string } }} */ ask) => {
    if (!command) throw new NotConfigured('speech transcription');
    const { spawnSync } = await import('node:child_process');
    const run = spawnSync(command, [ask.media?.path ?? ask.media?.url ?? ''], { encoding: 'utf8' });
    if (run.error) throw new NotConfigured('speech transcription');
    if (run.status !== 0) throw Object.assign(new Error('transcription failed'), { code: 'transcribe-failed' });
    return { text: (run.stdout ?? '').trim(), segments: [] };
  };
}

/** The decision maker (Jev): a key, or the VLM's own judgement as a weaker fallback. */
export function jevJudge({ key = process.env.OPENFILM_JEV_KEY ?? '', baseUrl = process.env.OPENFILM_JEV_URL ?? '' } = {}) {
  return async (/** @type {{ summary: any, frames: any[] }} */ ask) => {
    if (!key || !baseUrl) throw new NotConfigured('the decision model');
    const response = await fetch(`${baseUrl}/v1/judge`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ scenes: ask.frames.length }) });
    if (!response.ok) throw Object.assign(new Error(`the decision model answered ${response.status}`), { code: 'judge-failed' });
    return await response.json();
  };
}

/** A step timed on its own, so the report can say where the seconds went. */
const timer = (/** @type {() => number} */ now) => {
  const started = now();
  return () => now() - started;
};

/**
 * Run the pipeline. Every collaborator is injected; the defaults talk to this machine's services.
 *
 * @param {{
 *   media: { path?: string, url?: string },
 *   meta?: { name?: string, accountName?: string, category1?: string, category2?: string, labels?: string[] },
 *   frames?: any, describe?: any, ocr?: any, transcribe?: any, judge?: any, embed?: any,
 *   now?: () => number, workspace: string,
 *   frameOptions?: { fps?: number, seconds?: number, maxFrames?: number, longEdge?: number, quality?: number,
 *     root?: string },
 * }} options
 */
export async function runAnalysis(options) {
  const {
    media,
    meta = {},
    frames = studioFrames,
    describe = lmStudioDescriber(),
    ocr = commandOcr(),
    transcribe = fasterWhisper(),
    judge = jevJudge(),
    embed = lmStudioEmbedder(),
    now = Date.now,
    workspace,
    frameOptions = {},
  } = options;
  /** @type {any} */
  const timings = { frames: 0, describe: 0, ocr: 0, transcribe: 0, judge: 0, embed: 0, warmup: 0, total: 0 };
  const limits = { ...FRAME_DEFAULTS, ...frameOptions };
  const started = now();
  const finish = () => { timings.total = now() - started; return timings; };
  /** @param {string} step @param {any} error */
  const fail = (step, error) => ({
    ok: false,
    step,
    code: /** @type {any} */ (error)?.code ?? 'step-failed',
    message: /** @type {any} */ (error)?.message ?? `${step} failed`,
    timings: finish(),
  });

  // 5. the same input is answered from the cache, with no request at all
  let digest;
  try { digest = mediaDigest(media); } catch (error) { return fail('media', error); }
  mkdirSync(join(workspace, 'analysis'), { recursive: true });
  const cached = cachePath(workspace, digest);
  if (existsSync(cached)) {
    try {
      const stored = JSON.parse(readFileSync(cached, 'utf8'));
      if (stored?.analyzerVer === ANALYZER_VER && stored?.summary && typeof stored?.videoMd === 'string') {
        return { ok: true, cached: true, summary: stored.summary, videoMd: stored.videoMd, embedding: stored.embedding ?? null, timings };
      }
    } catch { /* a broken cache entry is simply not a hit */ }
  }

  // 2. frames
  // An extractor answers with the frames, and with how its scene pass went: `{ frames, scene }`.
  // A plain array is accepted too (a simple injected one), and counts as a scene pass that was fine.
  // `scene` may also be 'not-supported': the default extractor is Studio's derivation, which has no cut
  // pass. `frameOptions.root` (a project folder) is handed through to it, so a media path outside that
  // folder is refused by name instead of being derived as some other file.
  let picked = [];
  let sceneState = 'ok';
  try {
    const stop = timer(now);
    const answer = await frames({ media, ...limits, meta });
    timings.frames = stop();
    const list = Array.isArray(answer) ? answer : Array.isArray(answer?.frames) ? answer.frames : [];
    if (!Array.isArray(answer) && typeof answer?.scene === 'string') sceneState = answer.scene;
    picked = list.length > limits.maxFrames ? list.slice(0, limits.maxFrames) : list;
    // 3. an extractor that produced nothing is a failure, never an empty-but-successful run
    if (!picked.length) {
      throw Object.assign(new Error('no frames came out of this media: nothing to describe'), { code: 'frames-empty' });
    }
  } catch (error) {
    if (/** @type {any} */ (error)?.code === 'not-configured') return fail('frames', error);
    return fail('frames', error);
  }
  if (sceneState === 'failed') timings.sceneFailed = true;

  // 1. warm up once, before any real frame, and report it apart
  try {
    const stop = timer(now);
    await describe({ jpeg: WARMUP_JPEG, warmup: true, prompt: 'Warm up. Answer with one word.' });
    timings.warmup = stop();
  } catch (error) {
    return fail('warmup', error);
  }

  // vision: what happens in each frame (its text reading is a hint, never a fact)
  /** @type {{ at: number, text: string, hints: string }[]} */
  const scenes = [];
  const hints = [];
  try {
    const stop = timer(now);
    for (const frame of picked) {
      const said = await describe({ jpeg: frame.jpeg, at: frame.at });
      scenes.push({ at: frame.at ?? 0, text: text(said?.text) });
      if (text(said?.hints)) hints.push({ at: frame.at ?? 0, said: text(said?.hints) });
    }
    timings.describe = stop();
  } catch (error) {
    return fail('describe', error);
  }

  // 3. words come from OCR; when it is absent, say so and carry on
  let ocrState = 'not-configured';
  /** @type {{ at: number, text: string }[]} */
  const read = [];
  try {
    const stop = timer(now);
    for (const frame of picked) {
      const seen = await ocr({ jpeg: frame.jpeg, at: frame.at });
      const said = text(seen?.text);
      if (said) read.push({ at: frame.at ?? 0, text: said });
    }
    timings.ocr = stop();
    ocrState = read.length ? 'ok' : 'empty';
  } catch (error) {
    if (/** @type {any} */ (error)?.code !== 'not-configured') return fail('ocr', error);
  }

  // speech, when a transcriber is installed
  let speechState = 'not-configured';
  let transcript = '';
  try {
    const stop = timer(now);
    const said = await transcribe({ media });
    transcript = text(said?.text);
    timings.transcribe = stop();
    speechState = transcript ? 'ok' : 'empty';
  } catch (error) {
    if (/** @type {any} */ (error)?.code !== 'not-configured') return fail('transcribe', error);
  }

  // the decision: Jev when there is a key, the vision model's own ranking otherwise ('degraded')
  let judgeState = 'ok';
  let decision = null;
  try {
    const stop = timer(now);
    decision = await judge({ scenes, frames: picked, meta, transcript });
    timings.judge = stop();
  } catch (error) {
    if (/** @type {any} */ (error)?.code !== 'not-configured') return fail('judge', error);
    judgeState = 'degraded';
  }
  const confidence = Number.isFinite(decision?.confidence) ? Math.max(0, Math.min(1, decision.confidence)) : Math.min(0.9, 0.4 + scenes.length * 0.04);

  // 4. names come from metadata; OCR may add words, the vision model may not
  const tags = {
    ...(text(meta.category1) ? { category1: text(meta.category1) } : {}),
    ...(text(meta.category2) ? { category2: text(meta.category2) } : {}),
    ...(Array.isArray(meta.labels) && meta.labels.length ? { labels: meta.labels.filter((/** @type {unknown} */ l) => typeof l === 'string').slice(0, 20) } : {}),
    ...(read.length ? { ocrTokens: [...new Set(read.flatMap((line) => line.text.split(/[\s,，、|/]+/).filter((word) => word.length > 1)))].slice(0, 20) } : {}),
  };
  const name = text(meta.name) || text(meta.accountName) || '';
  const oneLine = decision?.oneLine
    ? text(decision.oneLine)
    : [name, scenes[0]?.text].filter(Boolean).join('：').slice(0, 200) || '未命名素材';

  const summary = {
    oneLine,
    scenes,
    bestClip: decision?.bestClip ?? (picked.length ? { at: picked[0].at ?? 0, until: picked[picked.length - 1].at ?? 0 } : null),
    tags,
    production: {
      frames: picked.length,
      seconds: picked.length ? Math.round(Number(picked[picked.length - 1].at ?? 0) - Number(picked[0].at ?? 0)) : 0,
      hasSpeech: Boolean(transcript),
      hasText: Boolean(read.length),
    },
    confidence,
    risks: Array.isArray(decision?.risks) ? decision.risks.slice(0, 10) : [],
    // what the vision model *thought* it read: kept, marked, and never used as a fact
    hints,
    states: { scene: sceneState, ocr: ocrState, transcribe: speechState, judge: judgeState },
    meta: { name, accountName: text(meta.accountName) },
  };

  const videoMd = renderVideoMd({ summary, scenes, read, transcript, picked, meta });

  // the vector of the card, for recall later
  let embedding = null;
  let embedState = 'ok';
  try {
    const stop = timer(now);
    const asked = [summary.oneLine, ...scenes.slice(0, 6).map((scene) => scene.text), read.slice(0, 4).map((line) => line.text).join(' ')].filter(Boolean).join('\n').slice(0, 6000);
    embedding = await embed(asked);
    timings.embed = stop();
  } catch (error) {
    if (/** @type {any} */ (error)?.code !== 'not-configured') return fail('embed', error);
    embedState = 'not-configured';
  }
  summary.states.embed = embedState;

  const total = finish();
  const result = { ok: true, cached: false, summary, videoMd, embedding, timings: total };
  try {
    writeFileSync(cached, JSON.stringify({ analyzerVer: ANALYZER_VER, at: new Date(now()).toISOString(), summary, videoMd, embedding }) + '\n');
  } catch { /* a cache that cannot be written must not fail the analysis */ }
  return result;
}

/**
 * The graded evidence: four layers, from the one-line card down to one shot, so a reader can stop at
 * whatever depth they needed. Card and the authoritative sections take their words from metadata and
 * OCR only; the vision model's reading of on-screen text stays in the summary's `hints`.
 * @param {{ summary: any, scenes: any[], read: { at: number, text: string }[], transcript: string, picked: any[], meta: any }} parts
 */
export function renderVideoMd({ summary, scenes, read, transcript, picked, meta }) {
  const clock = (/** @type {number} */ seconds) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
  const name = text(meta?.name) || text(summary?.meta?.name) || '未命名素材';
  const lines = [];
  lines.push('<!-- card -->');
  lines.push(`# ${name}`);
  lines.push('');
  lines.push(summary.oneLine);
  lines.push('');
  lines.push(`- 置信度：${summary.confidence.toFixed(2)}`);
  lines.push(`- 场景：${summary.production.frames} 帧 / ${summary.production.seconds} 秒`);
  lines.push(`- 状态：OCR ${summary.states.ocr}，语音 ${summary.states.transcribe}，判定 ${summary.states.judge}，向量 ${summary.states.embed}`);
  lines.push('');
  lines.push('<!-- overview -->');
  lines.push('## 概览');
  lines.push('');
  for (const [key, value] of Object.entries(summary.tags)) {
    lines.push(`- ${key}：${Array.isArray(value) ? value.join('、') : value}`);
  }
  if (!Object.keys(summary.tags).length) lines.push('- （元数据未提供品牌/分类）');
  if (transcript) lines.push(`- 语音（前 200 字）：${transcript.slice(0, 200)}`);
  if (summary.risks.length) lines.push(`- 风险：${summary.risks.join('；')}`);
  lines.push('');
  lines.push('<!-- timeline -->');
  lines.push('## 时间线');
  lines.push('');
  for (const scene of scenes) lines.push(`- ${clock(scene.at)} ${scene.text}`);
  if (!scenes.length) lines.push('- （没有可描述的帧）');
  lines.push('');
  lines.push('<!-- shot -->');
  lines.push('## 镜头');
  lines.push('');
  scenes.forEach((scene, index) => {
    const seen = read.filter((line) => Math.abs(line.at - scene.at) < 1).map((line) => line.text);
    lines.push(`### shot ${index + 1} · ${clock(scene.at)}`);
    lines.push('');
    lines.push(scene.text);
    if (seen.length) lines.push(`- 画面文字（OCR）：${seen.join(' / ')}`);
    lines.push('');
  });
  if (!scenes.length) lines.push('（没有帧可选）');
  return lines.join('\n');
}
