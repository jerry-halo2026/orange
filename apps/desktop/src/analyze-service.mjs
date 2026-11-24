// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * `orangefilm analyze`, wired: the analyser runs in this process, its result is cached locally by the runner itself, and
 * the write-back to the index happens **only when a client is there and the upload works**. An index that is not
 * configured is a reason in the answer, never a failed analysis: the local result is still worth having.
 *
 * The write-back is the data plane of 007, not the runner's own shape. `upsert_wiki_summary` reads a **flat** row
 * (`video_id`, `one_line`, `scenes`, `best_clip`, `risks`, `production`, `confidence`, `status`, the three vector
 * columns, `analyzer_ver`) and `upsert_wiki_source` wants a markdown record plus a 64-hex `content_hash`; the runner
 * answers with camelCase objects (`summary.oneLine`, `embedding: {model, ver, vector}`). `wikiRowsOf` is that
 * translation, in one pure function, so the mapping can be read and tested without a database.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** Where an analysis of this project is kept when the caller names no workspace. */
export const analysisWorkspace = (project) => join(project, '.orangefilm', 'analysis');

/**
 * The width of `wiki_summary.embedding` — `docs/sql/embedding.json` → `dims: 768`, and the column is declared
 * `vector(768)` by 007 (HNSW needs the typmod). A vector of another width is refused here, before any request:
 * 007 would answer 22023 after the source row was already written.
 */
export const EMBED_DIMS = 768;

/**
 * What `wiki_summary.production` may say: 002 declares the column `text` with
 * `CHECK (production IN ('live', 'ai', 'code', 'mixed'))`. It is **not** jsonb — that is why the runner's
 * `production: {frames, seconds, hasSpeech, hasText}` cannot be written as it is (`p_row ->> 'production'` would hand
 * a whole object to that CHECK and the row would be refused). One kind has to be derived from the measurements.
 */
export const PRODUCTION_KINDS = Object.freeze(['live', 'ai', 'code', 'mixed']);

/** A non-empty trimmed string, or undefined: the database normalises `''` to NULL anyway, so say it once here. */
const nonEmpty = (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/** A finite number in `[0, 1]`, to the three decimals `numeric(4,3)` keeps; anything else is no confidence at all. */
function confidenceOf(value) {
  const number = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(number)) return null;
  return Math.round(Math.min(1, Math.max(0, number)) * 1000) / 1000;
}

/**
 * The one production kind the measurements support.
 *
 * The runner measures (`frames`, `seconds`, `hasSpeech`, `hasText`); the column takes a closed word. The rule is
 * deliberately the crudest one that uses only what was measured: no frames means nothing was on screen, so there is
 * no claim to make (`null`); a voice and written text together are `mixed`; a voice alone is `live`; written text and
 * nothing spoken is `code` (the picture was made of words); neither is `ai`. The result is an inference from
 * measurements, which is exactly why the summary is written with `status: 'candidate'` — a human moves it to
 * `trusted`, not this function.
 * @param {{frames?: number, seconds?: number, hasSpeech?: boolean, hasText?: boolean}|undefined} production
 * @returns {'live'|'ai'|'code'|'mixed'|null}
 */
export function productionKind(production) {
  const frames = Number(production?.frames ?? 0);
  if (!Number.isFinite(frames) || frames <= 0) return null;
  const speech = production?.hasSpeech === true;
  const words = production?.hasText === true;
  if (speech && words) return 'mixed';
  if (speech) return 'live';
  if (words) return 'code';
  return 'ai';
}

/**
 * The vector the column can take, as the text `pgvector` parses (`[0.1,0.2,…]`), or null when there is none to write.
 *
 * `null` (embedding not configured, or the endpoint said nothing) is a reason to omit the three columns, not a
 * failure. A vector of any other width throws `embed-dim-mismatch`: writing it can only end in 007's 22023.
 * @param {{model?: string, ver?: string, vector?: unknown}|null|undefined} embedding
 * @returns {{vector: string, model: string, ver: string}|null}
 */
export function embeddingOf(embedding) {
  if (embedding === null || embedding === undefined) return null;
  const vector = /** @type {any} */ (embedding)?.vector;
  const width = Array.isArray(vector) ? vector.length : Array.isArray(embedding) ? embedding.length : null;
  const values = Array.isArray(vector) ? vector : Array.isArray(embedding) ? embedding : null;
  if (!values) throw Object.assign(new Error('the embedding is not a vector'), { code: 'embed-dim-mismatch', width });
  if (values.length !== EMBED_DIMS) {
    throw Object.assign(new Error(`the embedding is ${values.length}-wide, the column is ${EMBED_DIMS}`), {
      code: 'embed-dim-mismatch',
      width: values.length,
    });
  }
  const numbers = values.map(Number);
  if (!numbers.every(Number.isFinite)) throw Object.assign(new Error('the embedding holds something that is not a number'), { code: 'embed-dim-mismatch', width: values.length });
  /* the three columns are all-or-nothing (002's wiki_summary_embedding_complete): a vector without the model it came
     from could not be explained later, so it is not written at all instead of written with a guessed model name */
  const model = nonEmpty(/** @type {any} */ (embedding)?.model);
  const ver = nonEmpty(/** @type {any} */ (embedding)?.ver);
  if (!model || !ver) return null;
  return { vector: '[' + numbers.join(',') + ']', model, ver };
}

/**
 * The two rows one analysis writes, flat as the RPCs read them.
 *
 * `summary` goes to `upsert_wiki_summary` (007 §4), `source` to `upsert_wiki_source` (007 §5) — the source row carries
 * `sha256(video_md)`, computed here because 007 states the hash is the caller's to give, and the pair is ordered: a
 * source can stand alone as evidence, a summary must not exist without it.
 * @param {{videoId: string, analysis: any, analyzerVer?: string}} input
 * @returns {{summaryRow: object, sourceRow: object}}
 */
export function wikiRowsOf({ videoId, analysis, analyzerVer }) {
  const summary = analysis?.summary ?? {};
  const videoMd = typeof analysis?.videoMd === 'string' ? analysis.videoMd : '';
  const ver = nonEmpty(analyzerVer) ?? nonEmpty(analysis?.analyzerVer);
  /* Both tables are keyed by the version that produced them (wiki_source's primary key holds it, and it is the guard
     `upsert_wiki_summary` compares). A version invented here would be a different row under a different name, so the
     caller has to say it: the runner owns the constant, not this module. */
  if (!ver) throw Object.assign(new Error('analyzerVer is required'), { code: 'analyzer-ver-required' });

  const summaryRow = {
    video_id: videoId,
    one_line: nonEmpty(summary.oneLine) ?? null,
    scenes: Array.isArray(summary.scenes) ? summary.scenes : [],
    best_clip: summary.bestClip ?? null,
    /* `risks` is `text[]` in the column and 007 reads it with jsonb_array_elements_text: strings only */
    risks: Array.isArray(summary.risks) ? summary.risks.filter((risk) => typeof risk === 'string') : [],
    production: productionKind(summary.production),
    confidence: confidenceOf(summary.confidence),
    status: 'candidate',
  };
  /* Throws `embed-dim-mismatch` before anything is written; a null embedding simply leaves the three columns out. */
  const embedding = embeddingOf(analysis?.embedding);
  if (embedding) {
    summaryRow.embedding = embedding.vector;
    summaryRow.embedding_model = embedding.model;
    summaryRow.embedding_ver = embedding.ver;
  }
  summaryRow.analyzer_ver = ver;

  const sourceRow = {
    video_id: videoId,
    video_md: videoMd,
    evidence: { analyzer_ver: ver, states: summary.states ?? null, timings: analysis?.timings ?? null },
    analyzer_ver: ver,
    content_hash: createHash('sha256').update(videoMd, 'utf8').digest('hex'),
  };

  return { summaryRow, sourceRow };
}

/**
 * Run the analyser and try to publish what it found.
 *
 * `videoId` is required: the data plane is keyed by `(company_key, video_id)`, so an analysis with no video behind it
 * has nowhere to go and is refused before any frame is read.
 *
 * @param {{project: string, media: string, workspace?: string, videoId: string, options?: object,
 *          analyzerVer?: string, runner?: (options: object) => Promise<object>, rpc?: object | null,
 *          rpcFor?: () => Promise<object | null>}} input
 * @returns {Promise<{ok: boolean, uploaded: boolean, reason?: string, cached?: boolean, cache?: string, detail?: object}>}
 */
export async function runAnalyze({ project, media, workspace, videoId, options = {}, analyzerVer, runner, rpc, rpcFor }) {
  if (typeof project !== 'string' || !project) return { ok: false, uploaded: false, reason: 'project-required' };
  if (typeof media !== 'string' || !media) return { ok: false, uploaded: false, reason: 'media-required' };
  const id = nonEmpty(videoId);
  if (!id) return { ok: false, uploaded: false, reason: 'video-id-required' };

  const target = workspace ?? analysisWorkspace(project);
  /* the runner also owns the version stamped on both rows: one import, one source of truth */
  const runnerModule = await import('../../../packages/orangefilm/src/analyze-runner.mjs');
  const run = runner ?? runnerModule.runAnalysis;
  let analysis;
  try {
    analysis = await run({ ...options, media, workspace: target });
  } catch (error) {
    /* the runner's own failures are outcomes; a thrown one is still not allowed to reach the agent as a stack */
    return { ok: false, uploaded: false, reason: error?.code ?? 'analysis-failed' };
  }
  if (!analysis?.ok) return { ok: false, uploaded: false, reason: analysis?.code ?? 'analysis-failed', cache: analysis?.cached === true ? 'hit' : undefined };

  const cached = analysis.cached === true;
  const ver = nonEmpty(analyzerVer) ?? nonEmpty(analysis.analyzerVer) ?? runnerModule.ANALYZER_VER;

  let rows;
  try {
    rows = wikiRowsOf({ videoId: id, analysis, analyzerVer: ver });
  } catch (error) {
    /* a vector the column cannot hold is not a failed analysis: nothing is written, the local result stands */
    return { ok: true, uploaded: false, reason: error?.code ?? 'mapping-failed', cached, cache: 'local', detail: analysis };
  }

  const client = rpc === undefined ? await (rpcFor?.() ?? Promise.resolve(null)) : rpc;
  if (!client?.upsertWikiSource || !client?.upsertWikiSummary) {
    return { ok: true, uploaded: false, reason: 'not-configured', cached, cache: 'local', detail: analysis };
  }
  /* source first: evidence without a summary is a record, a summary without its source is a claim with no provenance */
  try {
    await client.upsertWikiSource(rows.sourceRow);
  } catch (error) {
    return { ok: true, uploaded: false, reason: error?.code ?? 'upload-failed', cached, cache: 'local', detail: analysis };
  }
  try {
    await client.upsertWikiSummary(rows.summaryRow);
  } catch (error) {
    /* the analysis stands; only its publication did not */
    return { ok: true, uploaded: false, reason: error?.code ?? 'upload-failed', cached, cache: 'local', detail: analysis };
  }
  return { ok: true, uploaded: true, cached, cache: 'local+remote', detail: analysis };
}
