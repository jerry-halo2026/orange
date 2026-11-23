// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * W5-A: the three pieces wired — the retrieval client into the MCP tools, the take path through the editor's own
 * import, the analyser into the local cache and (only when it is there) the index. What is asserted here is the part
 * that would rot silently: that "nothing configured" is an answer rather than a crash, and that the logs stay clean.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filmHtml } from '../../../packages/openfilm/src/film-doc.mjs';
import { createOpenFilmMcpServer, toolCallLine } from './orangefilm-mcp.mjs';
import { createIndexRpc, readIndexConfig } from './index-rpc.mjs';
import { analysisWorkspace, runAnalyze } from './analyze-service.mjs';

const project = () => {
  const root = mkdtempSync(join(tmpdir(), 'w5-project-'));
  writeFileSync(join(root, 'film.html'), filmHtml({ stage: { w: 1920, h: 1080 }, tracks: [{ clips: [{ id: 'a', src: 'assets/a.mp4' }] }] }));
  mkdirSync(join(root, 'assets'), { recursive: true });
  return root;
};
const home = (allowed) => {
  const directory = mkdtempSync(join(tmpdir(), 'w5-home-'));
  mkdirSync(join(directory, '.openfilm-dev'), { recursive: true });
  if (allowed) writeFileSync(join(directory, '.openfilm-dev', 'mcp-write.json'), JSON.stringify({ version: 1, allowWrite: true, projects: [allowed] }));
  return directory;
};
const call = async (server, name, args) => (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).result;

test('with no index configured, all four read tools answer not-configured and none of them throws', async () => {
  const previous = { ...process.env };
  for (const key of ['OPENFILM_INDEX_URL', 'OPENFILM_INDEX_SESSION', 'OPENFILM_INDEX_COMPANY']) delete process.env[key];
  try {
    assert.equal(readIndexConfig({}), null);
    assert.equal(await createIndexRpc(), null, 'no configuration, no client');
    const server = createOpenFilmMcpServer({ surface: 'compat', cwd: project(), home: home(null), log: () => {} });
    for (const [name, args] of [['materials.search', { query: 'kitten' }], ['wiki.video', { videoId: 'v1' }], ['wiki.timeline', { videoId: 'v1' }], ['wiki.shot', { videoId: 'v1', index: 0 }]]) {
      const result = await call(server, name, args);
      assert.equal(result.isError ?? false, false, name + ' is not a failure, it is an answer');
      assert.equal(result.structuredContent.code, 'not-configured');
    }
  } finally {
    process.env = previous;
  }
});

test('an injected index answers search with its own shape, and the log line counts the hits', async () => {
  const lines = [];
  const client = {
    async search({ query }) {
      return { hits: [{ video_id: 'v1', name: query, score: 0.9 }], count: 1, transport: 'index-client' };
    },
    async wikiVideo() { return { wiki: { video_id: 'v1' } }; },
    async wikiTimeline() { return { wiki: { shots: 3 } }; },
    async wikiShot() { return { wiki: { index: 0 } }; },
  };
  const server = createOpenFilmMcpServer({ surface: 'compat', cwd: project(), home: home(null), indexClient: () => client, log: (line) => lines.push(line) });
  const found = await call(server, 'materials.search', { query: 'kitten', limit: 5 });
  assert.equal(found.structuredContent.ok, true);
  assert.equal(found.structuredContent.hits.length, 1);
  assert.equal(found.structuredContent.transport, 'index-client');
  assert.equal(JSON.parse(lines.at(-1)).tool, 'materials.search');
  assert.equal(JSON.parse(lines.at(-1)).hits, 1, 'the log says how many came back');
  assert.equal((await call(server, 'wiki.shot', { videoId: 'v1', index: 0 })).structuredContent.ok, true);
});

test('taking a material lands it in assets/ through the editor\'s import, and answers its clip tag', async () => {
  const root = project();
  const source = join(mkdtempSync(join(tmpdir(), 'w5-src-')), 'clip.mp4');
  writeFileSync(source, 'bytes');
  const server = createOpenFilmMcpServer({ surface: 'compat', cwd: root, home: home(root), takeMaterial: async () => ({ source, name: 'clip.mp4' }), log: () => {} });
  const taken = await call(server, 'materials.take', { videoId: 'v1' });
  assert.equal(taken.isError ?? false, false);
  assert.equal(taken.structuredContent.path, 'assets/clip.mp4');
  assert.equal(readFileSync(join(root, 'assets', 'clip.mp4'), 'utf8'), 'bytes');
  assert.match(taken.structuredContent.clipTag, /src="assets\/clip\.mp4"/);
});

test('analyze keeps its result locally, and publishes it only when an index is there', async () => {
  const root = project();
  const media = join(root, 'assets', 'a.mp4');
  writeFileSync(media, 'frames');
  /* the runner's own shape, at the width the column declares: a vector of another width writes nothing at all */
  const vector = Array.from({ length: 768 }, (_, index) => index / 768);
  const runner = async ({ workspace }) => ({
    ok: true,
    summary: { oneLine: 'a', scenes: [], bestClip: null, risks: [], production: { frames: 1, seconds: 0, hasSpeech: false, hasText: true }, confidence: 0.5, states: { ocr: 'ok' } },
    videoMd: '# a',
    embedding: { model: 'fixture-embed', ver: 'analyze-runner-1', vector },
    timings: { total: 1 },
    workspace,
  });
  const videoId = 'v1';

  const local = await runAnalyze({ project: root, media, videoId, runner, rpc: null });
  assert.equal(local.ok, true);
  assert.equal(local.uploaded, false);
  assert.equal(local.reason, 'not-configured');
  assert.equal(local.cache, 'local');

  const calls = [];
  const published = await runAnalyze({
    project: root,
    media,
    videoId,
    runner,
    rpc: {
      upsertWikiSource: async (row) => { calls.push(['source', row]); },
      upsertWikiSummary: async (row) => { calls.push(['summary', row]); },
    },
  });
  assert.equal(published.uploaded, true);
  assert.equal(published.cache, 'local+remote');
  assert.deepEqual(calls.map(([rpc]) => rpc), ['source', 'summary'], 'the evidence is written before the claim');
  assert.equal(calls[1][1].one_line, 'a', 'the flat row 007 reads, not the runner’s own summary object');

  const failing = await runAnalyze({
    project: root,
    media,
    videoId,
    runner,
    rpc: { upsertWikiSource: async () => {}, upsertWikiSummary: async () => { throw Object.assign(new Error('nope'), { code: 'rpc-failed' }); } },
  });
  assert.equal(failing.ok, true, 'the analysis stands even when its publication does not');
  assert.equal(failing.uploaded, false);
  assert.equal(failing.reason, 'rpc-failed');

  const noVideo = await runAnalyze({ project: root, media, runner, rpc: null });
  assert.equal(noVideo.ok, false);
  assert.equal(noVideo.reason, 'video-id-required', 'the data plane is keyed by video_id: without one there is nowhere to write');

  const broken = await runAnalyze({ project: root, media, videoId, runner: async () => ({ ok: false, code: 'step-failed' }), rpc: null });
  assert.equal(broken.ok, false);
  assert.equal(broken.reason, 'step-failed');
  assert.equal(analysisWorkspace(root), join(root, '.openfilm', 'analysis'));
});

test('the tool log line never carries a whole path: not a media file, not the project, not a key', () => {
  const root = project();
  const line = toolCallLine('materials.take', 12, { structuredContent: { ok: true, path: join(root, 'assets', 'a.mp4'), clipId: 'a.mp4' } });
  const parsed = JSON.parse(line);
  assert.equal(parsed.path, 'a.mp4');
  assert.ok(!line.includes(root), 'the project path is not in the log');
  const look = toolCallLine('openfilm.look', 30, { structuredContent: { ok: true, path: 'C:\\work\\p\\looks\\0001.png' } });
  assert.ok(!look.includes('C:\\work'), 'a look is a file name, not a path');
  assert.deepEqual(Object.keys(JSON.parse(toolCallLine('x', 1, { structuredContent: {} }))), ['tool', 'ms']);
});

test('a configured index goes through the one client: token in the header, tenant in p_company_key only', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: { ...init.headers }, body: JSON.parse(String(init.body)) });
    if (String(url).endsWith('/search_materials')) return Response.json([{ video_id: 'v1', name: 'kitten', score: 1, labels: [] }]);
    return Response.json({ video_id: 'v1', shot: 1 });
  };
  const b64 = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const jwt = [b64({ alg: 'ES256' }), b64({ sub: 'user-1', app_metadata: { company_key: 'company-a' } }), 'sig'].join('.');
  const config = readIndexConfig({ OPENFILM_INDEX_URL: 'https://db.fixture.test/', OPENFILM_INDEX_SESSION: jwt, OPENFILM_INDEX_COMPANY: ' ' });
  assert.deepEqual(config, { baseUrl: 'https://db.fixture.test', jwt }, 'a trailing slash is normalised, and the company setting is not read at all');

  const rpc = await createIndexRpc({ config, fetch: fetchImpl });
  assert.equal(rpc.readonly.transport, 'index-client');
  const found = await rpc.search({ query: 'kitten', limit: 5 });
  assert.equal(found.count, 1);
  assert.equal(found.hits[0].video_id, 'v1');
  assert.equal((await rpc.wikiShot({ videoId: 'v1', index: 2 })).wiki.shot, 1);
  assert.equal((await rpc.wikiTimeline({ videoId: 'v1', range: [0, 12] })).transport, 'index-client');

  for (const call of calls) {
    assert.equal(call.headers.authorization, 'Bearer ' + jwt, 'the session is the credential, verbatim');
    assert.deepEqual(Object.keys(call.headers).sort(), ['accept', 'authorization', 'content-type']);
    assert.equal(call.body.p_company_key, 'company-a', 'the tenant is the token claim');
    assert.equal('company_key' in call.body, false);
    assert.equal('tenant' in call.body, false);
  }
  assert.deepEqual(calls.map((call) => call.url.split('/').pop()), ['search_materials', 'wiki_shot', 'wiki_timeline']);

  const failing = await createIndexRpc({ config, fetch: async () => new Response('nope', { status: 503 }) });
  await assert.rejects(() => failing.wikiVideo({ videoId: 'v1' }), (error) => error.code === 'rpc-failed' && error.status === 503);
});
