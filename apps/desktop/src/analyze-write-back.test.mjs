// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The data-plane write-back of one analysis: the runner's camelCase result becomes the two flat rows 007 reads
 * (`upsert_wiki_source`, then `upsert_wiki_summary`), or it does not. What is asserted here is exactly the part that
 * cannot be seen by reading the code twice: that every column of the flat row is the one 007 declared, that a vector
 * the column cannot hold writes **nothing at all**, and that a publication failure still leaves a usable analysis.
 *
 * The column shapes are not invented here — they are `docs/sql/002_schema.sql` (column types and CHECKs) and
 * `docs/sql/007_embedding_and_wiki.sql` §4/§5 (`p_row ->> '…'` reads, the 768-dim assertion, the 64-hex hash).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMBED_DIMS, embeddingOf, productionKind, runAnalyze, wikiRowsOf } from './analyze-service.mjs';
import { ANALYZER_VER } from '../../../packages/orangefilm/src/analyze-runner.mjs';
import { createIndexRpc } from './index-rpc.mjs';

/** A vector of the declared width, as the embedding endpoint answers with one. */
const vectorOf = (width = EMBED_DIMS) => Array.from({ length: width }, (_, index) => Number((index / width).toFixed(6)));

/** What `analyze-runner.mjs` returns (`runAnalysis`'s own shape), spelled as one fixture. */
const analysisOf = (over = {}) => ({
  ok: true,
  cached: false,
  summary: {
    oneLine: '一条测试素材',
    scenes: [{ at: 0, text: '第一帧' }, { at: 1, text: '第二帧' }],
    bestClip: { at: 0, until: 1 },
    tags: { category1: '小猫' },
    production: { frames: 2, seconds: 1, hasSpeech: false, hasText: true },
    confidence: 0.4567,
    risks: ['字幕有错字', { not: 'a string' }],
    hints: [],
    states: { scene: 'ok', ocr: 'ok', transcribe: 'not-configured', judge: 'degraded' },
    meta: { name: 'clip', accountName: '' },
  },
  videoMd: '# clip\n\n一条测试素材\n',
  embedding: { model: 'text-embedding-nomic-embed-text-v1.5', ver: 'analyze-runner-1', vector: vectorOf() },
  timings: { frames: 120, describe: 900, total: 1200 },
  ...over,
});

const project = () => {
  const root = mkdtempSync(join(tmpdir(), 'w6-project-'));
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'assets', 'a.mp4'), 'frames');
  return root;
};

/** A client that records the calls, in the order they were made. */
const recorder = (over = {}) => {
  const calls = [];
  return {
    calls,
    client: {
      async upsertWikiSource(row) {
        calls.push({ rpc: 'source', row });
        if (over.sourceFails) throw Object.assign(new Error('source refused'), { code: 'source-refused' });
      },
      async upsertWikiSummary(row) {
        calls.push({ rpc: 'summary', row });
        if (over.summaryFails) throw Object.assign(new Error('summary refused'), { code: 'summary-refused' });
      },
    },
  };
};

test('the summary row is flat, one column per name 007 reads: no nested summary, no camelCase', () => {
  const { summaryRow } = wikiRowsOf({ videoId: 'v1', analysis: analysisOf(), analyzerVer: 'analyze-runner-1' });

  assert.equal(summaryRow.video_id, 'v1', 'the key 007 takes from p_row ->> video_id: never null, never nesting');
  assert.equal(summaryRow.one_line, '一条测试素材');
  assert.deepEqual(summaryRow.scenes, [{ at: 0, text: '第一帧' }, { at: 1, text: '第二帧' }], 'a jsonb array, as the runner already has it');
  assert.deepEqual(summaryRow.best_clip, { at: 0, until: 1 });
  assert.deepEqual(summaryRow.risks, ['字幕有错字'], 'text[]: the strings, and nothing that is not a string');
  assert.equal(summaryRow.production, 'code', "the column's CHECK vocabulary (live|ai|code|mixed), not the runner's object");
  assert.equal(summaryRow.confidence, 0.457, 'numeric(4,3): three decimals, clamped to 0..1');
  assert.equal(summaryRow.status, 'candidate', 'automatic output is never trusted on the way in');
  assert.equal(summaryRow.analyzer_ver, 'analyze-runner-1');

  assert.equal('summary' in summaryRow, false, 'there is no `summary` parameter in the data plane');
  assert.equal('video_md' in summaryRow, false, 'the markdown belongs to the source row');
  assert.equal('bestClip' in summaryRow, false);
  assert.equal('oneLine' in summaryRow, false);
  assert.deepEqual(
    Object.keys(summaryRow).sort(),
    ['analyzer_ver', 'best_clip', 'confidence', 'embedding', 'embedding_model', 'embedding_ver', 'one_line', 'production', 'risks', 'scenes', 'status', 'video_id'],
  );

  assert.throws(
    () => wikiRowsOf({ videoId: 'v1', analysis: analysisOf() }),
    (error) => error.code === 'analyzer-ver-required',
    'the caller says which version produced these rows: wiki_source is keyed by it and 007 compares it as a guard',
  );
});

test('production is the measured kind: no frames makes no claim, and the rest follow the evidence', () => {
  assert.equal(productionKind(undefined), null);
  assert.equal(productionKind({ frames: 0, hasSpeech: true, hasText: true }), null, 'nothing on screen is nothing to classify');
  assert.equal(productionKind({ frames: 3, hasSpeech: true, hasText: true }), 'mixed');
  assert.equal(productionKind({ frames: 3, hasSpeech: true, hasText: false }), 'live');
  assert.equal(productionKind({ frames: 3, hasSpeech: false, hasText: true }), 'code');
  assert.equal(productionKind({ frames: 3, hasSpeech: false, hasText: false }), 'ai');
  const { summaryRow } = wikiRowsOf({ videoId: 'v1', analysis: analysisOf({ summary: { ...analysisOf().summary, production: { frames: 0 } } }), analyzerVer: 'analyze-runner-1' });
  assert.equal(summaryRow.production, null, 'a null is allowed by the column; a made-up word is not');
});

test('the embedding is written as the vector text pgvector parses, or the three columns are not written at all', () => {
  const { summaryRow } = wikiRowsOf({ videoId: 'v1', analysis: analysisOf(), analyzerVer: 'analyze-runner-1' });
  assert.equal(typeof summaryRow.embedding, 'string', 'p_row ->> embedding hands pgvector a text, not a JSON object');
  assert.equal(summaryRow.embedding[0], '[');
  assert.equal(summaryRow.embedding.at(-1), ']');
  const numbers = summaryRow.embedding.slice(1, -1).split(',');
  assert.equal(numbers.length, EMBED_DIMS);
  assert.equal(numbers.length, 768, 'docs/sql/embedding.json says 768');
  assert.ok(numbers.every((value) => Number.isFinite(Number(value))));
  assert.equal(summaryRow.embedding_model, 'text-embedding-nomic-embed-text-v1.5');
  assert.equal(summaryRow.embedding_ver, 'analyze-runner-1');

  const without = wikiRowsOf({ videoId: 'v1', analysis: analysisOf({ embedding: null }), analyzerVer: 'analyze-runner-1' }).summaryRow;
  assert.equal('embedding' in without, false, 'all three or none (002 wiki_summary_embedding_complete)');
  assert.equal('embedding_model' in without, false);
  assert.equal('embedding_ver' in without, false);
  assert.equal(without.one_line, '一条测试素材', 'and everything else is written as usual');
  assert.equal(without.status, 'candidate');

  assert.equal(embeddingOf(null), null);
  assert.equal(embeddingOf(undefined), null);
});

test('a 767 or a 769 vector is refused by name, and refuses before anything is written', async () => {
  for (const width of [767, 769]) {
    assert.throws(
      () => wikiRowsOf({ videoId: 'v1', analysis: analysisOf({ embedding: { model: 'm', ver: 'v', vector: vectorOf(width) } }), analyzerVer: 'analyze-runner-1' }),
      (error) => error.code === 'embed-dim-mismatch' && error.width === width,
      width + ' wide is a vector the column cannot hold',
    );

    const { calls, client } = recorder();
    const answer = await runAnalyze({ project: project(), media: 'a.mp4', videoId: 'v1', runner: async () => analysisOf({ embedding: { model: 'm', ver: 'v', vector: vectorOf(width) } }), rpc: client });
    assert.equal(answer.ok, true, 'the analysis stands: only its publication did not');
    assert.equal(answer.uploaded, false);
    assert.equal(answer.reason, 'embed-dim-mismatch');
    assert.equal(answer.cache, 'local');
    assert.deepEqual(calls, [], 'zero writes: not the summary, and not the source either');
  }
});

test('the source is written before the summary, and its hash is sha256 of the markdown', async () => {
  const analysis = analysisOf();
  const { sourceRow } = wikiRowsOf({ videoId: 'v1', analysis, analyzerVer: 'analyze-runner-1' });
  assert.equal(sourceRow.video_md, analysis.videoMd);
  assert.equal(sourceRow.video_id, 'v1');
  assert.equal(sourceRow.analyzer_ver, 'analyze-runner-1');
  assert.equal(sourceRow.content_hash, createHash('sha256').update(analysis.videoMd, 'utf8').digest('hex'));
  assert.match(sourceRow.content_hash, /^[0-9a-f]{64}$/, '002 wiki_source_content_hash_hex: 64 lowercase hex');
  assert.deepEqual(sourceRow.evidence, { analyzer_ver: 'analyze-runner-1', states: analysis.summary.states, timings: analysis.timings });

  const { calls, client } = recorder();
  const answer = await runAnalyze({ project: project(), media: 'a.mp4', videoId: 'v1', runner: async () => analysis, rpc: client });
  assert.equal(answer.ok, true);
  assert.equal(answer.uploaded, true);
  assert.equal(answer.cache, 'local+remote');
  assert.deepEqual(calls.map((call) => call.rpc), ['source', 'summary'], 'evidence first: a summary never exists without its source');
  assert.equal(calls[0].row.content_hash, sourceRow.content_hash);
  assert.equal(calls[1].row.video_id, 'v1');
  assert.equal(calls[1].row.analyzer_ver, calls[0].row.analyzer_ver, 'one version on both rows');
  assert.equal(calls[1].row.analyzer_ver, ANALYZER_VER, "the runner's own constant, imported rather than retyped in this module");
  assert.equal(answer.detail.summary.oneLine, '一条测试素材', 'the local result travels with the answer');
});

test('a publication failure is a reason, not a failed analysis: ok stays true and nothing local is lost', async () => {
  const summaryFails = recorder({ summaryFails: true });
  const half = await runAnalyze({ project: project(), media: 'a.mp4', videoId: 'v1', runner: async () => analysisOf(), rpc: summaryFails.client });
  assert.equal(half.ok, true);
  assert.equal(half.uploaded, false);
  assert.equal(half.reason, 'summary-refused');
  assert.equal(half.cache, 'local');
  assert.deepEqual(half.detail.summary.scenes.length, 2);
  assert.deepEqual(summaryFails.calls.map((call) => call.rpc), ['source', 'summary']);

  const sourceFails = recorder({ sourceFails: true });
  const none = await runAnalyze({ project: project(), media: 'a.mp4', videoId: 'v1', runner: async () => analysisOf(), rpc: sourceFails.client });
  assert.equal(none.ok, true);
  assert.equal(none.uploaded, false);
  assert.equal(none.reason, 'source-refused');
  assert.deepEqual(sourceFails.calls.map((call) => call.rpc), ['source'], 'no source, no summary: the claim has no provenance');

  const halfClient = await runAnalyze({ project: project(), media: 'a.mp4', videoId: 'v1', runner: async () => analysisOf(), rpc: { upsertWikiSummary: async () => {} } });
  assert.equal(halfClient.uploaded, false);
  assert.equal(halfClient.reason, 'not-configured', 'a client that cannot write both rows writes none');
  assert.equal(halfClient.ok, true);
});

test('no videoId, no work and no write: the data plane is keyed by (tenant, video_id)', async () => {
  for (const videoId of [undefined, null, '', '   ']) {
    let ran = 0;
    const { calls, client } = recorder();
    const answer = await runAnalyze({ project: project(), media: 'a.mp4', videoId, runner: async () => { ran += 1; return analysisOf(); }, rpc: client });
    assert.deepEqual(answer, { ok: false, uploaded: false, reason: 'video-id-required' });
    assert.equal(ran, 0, 'not even the frames: an analysis with nowhere to go is not run');
    assert.deepEqual(calls, []);
  }
});

test('the index client sends upsert_wiki_source, and invents no analyzer_ver on the summary', async () => {
  const b64 = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const jwt = [b64({ alg: 'ES256' }), b64({ sub: 'user-1', app_metadata: { company_key: 'company-a' } }), 'sig'].join('.');
  const calls = [];
  const rpc = await createIndexRpc({
    config: { baseUrl: 'https://db.fixture.test', jwt },
    fetch: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return Response.json(null);
    },
  });

  const sourceRow = wikiRowsOf({ videoId: 'v1', analysis: analysisOf(), analyzerVer: 'analyze-runner-1' }).sourceRow;
  assert.equal((await rpc.upsertWikiSource(sourceRow)).uploaded, true);
  assert.equal(calls.at(-1).url, 'https://db.fixture.test/rest/v1/rpc/upsert_wiki_source');
  assert.deepEqual(calls.at(-1).body, { p_company_key: 'company-a', p_row: sourceRow });

  const { summaryRow } = wikiRowsOf({ videoId: 'v1', analysis: analysisOf(), analyzerVer: 'analyze-runner-1' });
  await rpc.upsertWikiSummary(summaryRow);
  assert.equal(calls.at(-1).url, 'https://db.fixture.test/rest/v1/rpc/upsert_wiki_summary');
  assert.deepEqual(calls.at(-1).body.p_row, summaryRow);
  assert.equal(calls.at(-1).body.p_row.analyzer_ver, 'analyze-runner-1', 'the caller’s version, verbatim');

  /* and it stays missing when the caller gave none: 007 owns its own fallback ('v0'), this module does not guess */
  await rpc.upsertWikiSummary({ video_id: 'v1', one_line: 'x' });
  assert.equal('analyzer_ver' in calls.at(-1).body.p_row, false);
  assert.equal('company_key' in calls.at(-1).body.p_row, false, 'the tenant is never a row field either');
});
