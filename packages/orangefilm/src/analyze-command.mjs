// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * `orangefilm analyze <media>`: the analysis pipeline from the command line.
 *
 * The work is the same code the app runs (`apps/desktop/src/analyze-service.mjs`, which itself calls
 * `analyze-runner.mjs`): this file only parses the command, decides its exit code, and prints either
 * a short human answer or one JSON object. Nothing is re-implemented here; when the service module is
 * not reachable (a packaged install that carries only the runner) a thin adapter with the same
 * contract is used instead — see `serviceOf`.
 *
 * The defaults are the measured ones: `--long-edge 512` (512 is ~4.1 s a frame on the machine this was
 * measured on; 1280 is ~20 s, and 179k clips × 12 frames is not a budget anyone has) and `--frames 6`.
 *
 * Exit codes, so a script can branch without reading prose:
 *   0  the analysis ran (whether or not it was published to an index)
 *   2  the command itself was wrong (no media, an unknown option, an out-of-range number)
 *   4  the analysis component is not installed (nothing was downloaded or written)
 *   5  the analysis ran and failed (frames-empty, analyzer-malformed, …): `code` says which
 *
 * `--json` prints `{ok, uploaded, cache, timings, states, summary}` and never an absolute media path:
 * the answer about a person's file travels (to a log, to an agent) without saying where it lives.
 *
 * `--video-id` is what makes a result publishable: the index is keyed by `(company_key, video_id)`, so a run with no
 * video id has nowhere to write and answers `video-id-required` — the 5 exit code, before any frame is read. Without
 * an index configured, a run with a video id is still local-only (exit 0, `uploaded: false`).
 */
import { isAbsolute } from 'node:path';

/** The defaults the measurements argue for: 512 px is ~4.1 s a frame, 1280 ~20 s. */
export const ANALYZE_DEFAULTS = Object.freeze({ frames: 6, longEdge: 512 });

/** The exit codes above, in one place. */
export const EXIT = Object.freeze({ ok: 0, usage: 2, componentMissing: 4, failed: 5 });

/**
 * The service the app uses, or — when a packaged install carries only the runner — a thin adapter
 * with the same contract. Both take `{project, media, workspace, options, runner}` and answer
 * `{ok, uploaded, reason?, cached?, cache?}`.
 */
async function serviceOf() {
  try {
    return await import('../../../apps/desktop/src/analyze-service.mjs');
  } catch {
    /* Only `runAnalysis` is present: same shape, no index to publish to. */
    return {
      analysisWorkspace: (/** @type {string} */ project) => `${project}/.orangefilm/analysis`,
      async runAnalyze({ project, media, workspace, videoId, options = {}, runner }) {
        if (!project) return { ok: false, uploaded: false, reason: 'project-required' };
        if (!media) return { ok: false, uploaded: false, reason: 'media-required' };
        /* the same contract as the service: the index is keyed by video_id, so a run without one has nowhere to go */
        if (typeof videoId !== 'string' || !videoId.trim()) return { ok: false, uploaded: false, reason: 'video-id-required' };
        const run = runner ?? (await import('./analyze-runner.mjs')).runAnalysis;
        let answer;
        try {
          answer = await run({ ...options, media, workspace: workspace ?? `${project}/.orangefilm/analysis` });
        } catch (error) {
          return { ok: false, uploaded: false, reason: /** @type {any} */ (error)?.code ?? 'analysis-failed' };
        }
        if (!answer?.ok) return { ok: false, uploaded: false, reason: answer?.code ?? 'analysis-failed', detail: answer };
        return { ok: true, uploaded: false, reason: 'not-configured', cached: answer.cached === true, cache: 'local', detail: answer };
      },
    };
  }
}

/** The component this needs: `rea-video`, installed on first use (packages/orangefilm/src/analyze.mjs). */
async function component() {
  return import('./analyze.mjs');
}

/**
 * `orangefilm analyze`, with the command's own options already parsed by the CLI.
 * @param {string[]} args the positional arguments after `analyze`
 * @param {{ project?: string, frames?: number, longEdge?: number, videoId?: string, json?: boolean }} opts
 * @param {string} [run] how this was invoked, for the messages
 * @returns {Promise<{ lines: string[], code?: number }>}
 */
export async function analyzeCommand(args, opts = {}, run = 'orangefilm') {
  // The command's own shape is checked before anything is loaded: a wrong command must not depend on
  // which modules this install happens to carry.
  if (!(args.find((arg) => !arg.startsWith('-')) ?? '')) {
    const { UsageError } = await import('./shared.mjs');
    throw new UsageError(`${run} analyze: which media? \`${run} analyze <media> [--project <dir>] [--frames 6] [--long-edge 512] [--video-id <id>] [--json]\``);
  }
  return analyzeCommandWith(await serviceOf(), args, opts, run);
}

/**
 * The command with its service given outright: what nalyzeCommand does once the service module is
 * loaded, and what a test drives with a fake one.
 * @param {any} service @param {string[]} args @param {any} [opts] @param {string} [run]
 */
export async function analyzeCommandWith(service, args, opts = {}, run = 'orangefilm') {
  const media = args.find((arg) => !arg.startsWith('-')) ?? '';
  if (!media) {
    const { UsageError } = await import('./shared.mjs');
    throw new UsageError(`${run} analyze: which media? \`${run} analyze <media> [--project <dir>] [--frames 6] [--long-edge 512] [--video-id <id>] [--json]\``);
  }
  if (isAbsolute(media) === false && media.startsWith('~')) {
    const { UsageError } = await import('./shared.mjs');
    throw new UsageError(`${run} analyze: give the media as a path, not a shell shortcut (${media})`);
  }

  const componentModule = await component();
  const where = opts.project || '.';
  if (!componentModule.installed()) {
    // 4: the component is not installed. **One structured JSON line on stderr and nothing on stdout**,
    // with or without `--json`: a caller that parses it must not have to know which flags were passed,
    // and a caller that pipes stdout gets an explicit empty answer rather than prose. The hint and the
    // Python requirement are fields of that line, not a second paragraph.
    const report = componentModule.missingReport();
    console.error(JSON.stringify(report));
    process.exitCode = EXIT.componentMissing;
    return { lines: [], code: EXIT.componentMissing };
  }

  const frames = opts.frames ?? ANALYZE_DEFAULTS.frames;
  const longEdge = opts.longEdge ?? ANALYZE_DEFAULTS.longEdge;
  const started = Date.now();
  const answer = await service.runAnalyze({
    project: where,
    media,
    videoId: typeof opts.videoId === 'string' ? opts.videoId.trim() : undefined,
    workspace: opts.project ? service.analysisWorkspace(where) : undefined,
    options: { frameOptions: { maxFrames: frames, longEdge } },
  });
  const detail = /** @type {any} */ (answer).detail ?? null;

  if (!answer.ok) {
    const code = answer.reason ?? 'analysis-failed';
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, uploaded: false, code, timings: detail?.timings ?? null, states: detail?.states ?? null, summary: null }));
    } else {
      console.error(`${run} analyze: ${code}`);
    }
    process.exitCode = EXIT.failed;
    return { lines: [], code: EXIT.failed };
  }

  if (opts.json) {
    // No path, absolute or otherwise: an answer about a person's media does not carry where it lives.
    const payload = {
      ok: true,
      uploaded: answer.uploaded === true,
      cache: answer.cache ?? 'local',
      timings: detail?.timings ?? null,
      states: detail?.states ?? null,
      summary: detail?.summary ?? null,
    };
    console.log(JSON.stringify(payload));
    process.exitCode = EXIT.ok;
    return { lines: [], code: EXIT.ok };
  }

  const summary = detail?.summary;
  const lines = [
    summary?.oneLine ? summary.oneLine : '分析完成',
    `  帧 ${summary?.production?.frames ?? '?'} · 判定 ${summary?.states?.judge ?? '?'} · 向量 ${summary?.states?.embed ?? '?'}`,
    `  发布 ${answer.uploaded ? '已上传索引' : `未上传（${answer.reason ?? 'not-configured'}）`} · 缓存 ${answer.cache ?? 'local'}`,
    `  用时 ${Math.round(((detail?.timings?.total ?? Date.now() - started) / 1000))} s`,
  ];
  process.exitCode = EXIT.ok;
  return { lines, code: EXIT.ok };
}
