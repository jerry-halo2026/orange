// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * One query, three routes: the vector answer, the lexical answer when the embedder is gone, and the landed index when
 * the database is gone — plus everything the answer must *not* do (invent a row, change a mode, dress a word search up
 * as a semantic one).
 *
 * No database, no LM Studio and no home directory: `embed`, `call` and `index` are the three seams `searchMaterials`
 * takes, so each degradation is one function that throws.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

/* 这条测试必须在空的 home 里跑：默认包目录与默认模型目录都在 shared home 下，
   机器上真的装了包/模型时，断言会读到它们（'pack' 而不是 'vector'、模型居然加载成功）。 */
process.env.OPENFILM_HOME = mkdtempSync(join(tmpdir(), 'material-search-home-'));
process.env.OPENFILM_SHARED_HOME = process.env.OPENFILM_HOME;

import {
  DEFAULT_EMBED_ENDPOINT, DEFAULT_EMBED_MODEL, EMBED_DIMS, INDEX_SCORES, MATERIAL_SEARCH_CAPS,
  MATERIAL_SEARCH_CAPS_CONTRACT, SEARCH_RPC, createEmbedder, createMaterialSearchService, createMediaSearchCall,
  defaultIndexLoader, dollarTag, indexRows, isEmbedding, isTenantKey, itemOf, limitOf, mediaSearchScript,
  normaliseFilters, parseMediaSearchOutput, searchIndex, searchMaterials,
} from './material-search.mjs';

/** A 768-dimension vector, deterministic, so a test can name the same one twice. */
const vector = (seed = 0.25) => Array.from({ length: EMBED_DIMS }, (_, index) => seed + index / 10_000);

/** The rows `media_search` returns (its column names, 012:401-413), two assets and one shot. */
const ROWS = [
  {
    media_key: 'v1', gran: 'asset', video_id: 'v1', shot_index: 0, name: '20261106-柠檬宝藏茶200g罐-外包装 (1)',
    batch: '20261106', product: '柠檬宝藏茶200g罐', gname: '外包装', duration_ms: 8400, score: 0.91, match_kind: 'vector',
  },
  {
    media_key: 'v2:3', gran: 'shot', video_id: 'v2', shot_index: 3, name: '墨红玫瑰-外包装 (8)',
    batch: null, product: null, gname: '外包装', duration_ms: null, score: 0.55, match_kind: 'ilike',
  },
];

/** An index in the shape `material-index.mjs` builds (the tree, not the envelope `readMaterialIndex` lands). */
const TREE = {
  schema: 'orange/material-index/1',
  totals: { videos: 4, parsed: 3, unclassified: 1 },
  batches: [{
    id: '20261106', name: '20261106', count: 3,
    products: [{
      id: '20261106-柠檬宝藏茶200g罐', name: '柠檬宝藏茶200g罐', count: 3,
      groups: [
        {
          id: '20261106-柠檬宝藏茶200g罐-外包装', name: '外包装', count: 2, videoIds: ['a', 'b'],
          entries: [
            { videoId: 'a', name: '20261106-柠檬宝藏茶200g罐-外包装 (1)', md5: '' },
            { videoId: 'b', name: '20261106-柠檬宝藏茶200g罐-外包装 (2)', md5: '' },
          ],
        },
        {
          id: '20261106-柠檬宝藏茶200g罐-茶干', name: '茶干', count: 1, videoIds: ['c'],
          entries: [{ videoId: 'c', name: '20261106-柠檬宝藏茶200g罐-茶干 (48)', md5: '' }],
        },
      ],
    }],
  }],
  unclassified: [{ videoId: 'd', name: '随便.mp4', md5: '' }],
};

test('the vector route: the embedder answers, the RPC is asked with the vector, and the rows are mapped', async () => {
  /** @type {any[]} */
  const calls = [];
  const answer = await searchMaterials({
    query: '  柠檬宝藏茶 外包装  ',
    filters: { batch: '20261106', gname: '外包装', durationMaxMs: 9000, invented: 'dropped' },
    limit: 5,
    embed: async () => vector(),
    call: async (rpc, params) => { calls.push([rpc, params]); return ROWS; },
  });

  assert.equal(answer.mode, 'vector');
  assert.equal(answer.query, '柠檬宝藏茶 外包装', 'the query is trimmed once');
  assert.equal(answer.count, 2);
  assert.deepEqual(Object.keys(answer).sort(), ['count', 'items', 'mode', 'query'], 'the answer is exactly its contract');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], SEARCH_RPC);
  assert.equal(calls[0][1].p_query, '柠檬宝藏茶 外包装');
  assert.equal(calls[0][1].p_limit, 5);
  assert.equal(calls[0][1].p_embedding.length, EMBED_DIMS);
  assert.deepEqual(calls[0][1].p_filters, { batch: '20261106', gname: '外包装', durationMaxMs: 9000 }, 'only the keys the RPC reads');

  assert.deepEqual(answer.items[0], {
    mediaKey: 'v1', videoId: 'v1', name: '20261106-柠檬宝藏茶200g罐-外包装 (1)', batch: '20261106',
    product: '柠檬宝藏茶200g罐', gname: '外包装', durationMs: 8400, score: 0.91, matchKind: 'vector',
  });
  assert.equal(answer.items[1].mediaKey, 'v2:3', 'a shot key stays the media key the RPC gave');
  assert.equal(answer.items[1].durationMs, null);
});

test('degradation ①: an embedder that throws (or answers nothing) is the lexical route, said as such', async () => {
  /** @type {any[]} */
  const calls = [];
  const thrown = await searchMaterials({
    query: '茶汤特写',
    embed: async () => { throw new Error('ECONNREFUSED 127.0.0.1:1235'); },
    call: async (rpc, params) => { calls.push([rpc, params]); return [ROWS[1]]; },
  });
  assert.equal(thrown.mode, 'lexical');
  assert.equal(thrown.count, 1);
  assert.equal(calls[0][1].p_embedding, null, 'a dead embedder is a NULL vector, never a zero vector');

  /* not a vector at all is the same answer: 768 finite numbers, or nothing */
  const malformed = await searchMaterials({
    query: '茶汤特写',
    embed: async () => [0.1, 0.2],
    call: async () => [ROWS[1]],
  });
  assert.equal(malformed.mode, 'lexical');

  const absent = await searchMaterials({ query: '茶汤特写', call: async () => [], embed: null });
  assert.equal(absent.mode, 'lexical', 'nothing to embed with is the same route, not an error');
});

test('degradation ②: an RPC that throws falls back to the landed index names, and says mode index', async () => {
  const answer = await searchMaterials({
    query: '柠檬宝藏茶 外包装',
    embed: async () => vector(),
    call: async () => { throw Object.assign(new Error('function public.media_search(text, text, jsonb, vector, integer) does not exist'), { code: 'media-search-failed' }); },
    index: () => TREE,
  });
  assert.equal(answer.mode, 'index');
  assert.equal(answer.count, 2, 'both names carry 柠檬宝藏茶 and 外包装');
  assert.deepEqual(answer.items.map((item) => item.videoId), ['a', 'b']);
  assert.equal(answer.items[0].score, INDEX_SCORES.words, 'this module’s own score, not the database’s');
  assert.equal(answer.items[0].matchKind, 'index');
  assert.equal(answer.items[0].batch, '20261106');

  /* a prefix beats a mere containment, and a name with no match is not reported at all */
  const prefix = await searchMaterials({ query: '随便', call: null, index: () => TREE });
  assert.equal(prefix.mode, 'index');
  assert.deepEqual(prefix.items.map((item) => [item.videoId, item.score]), [['d', INDEX_SCORES.prefix]]);

  const nothing = await searchMaterials({ query: '不存在的画面', call: () => { throw new Error('down'); }, index: () => TREE });
  assert.deepEqual(nothing, { mode: 'index', query: '不存在的画面', count: 0, items: [] }, 'no match is no row');

  /* no index at all is also nothing — the fallback does not become a guess */
  const bare = await searchMaterials({ query: '柠檬', call: () => { throw new Error('down'); }, index: () => null });
  assert.deepEqual(bare.items, []);
});

test('degradation ③: an empty answer keeps its mode and invents no row', async () => {
  const semantic = await searchMaterials({ query: '没有这个画面', embed: async () => vector(), call: async () => [], index: () => TREE });
  assert.deepEqual(semantic, { mode: 'vector', query: '没有这个画面', count: 0, items: [] });

  const lexical = await searchMaterials({ query: '没有这个画面', embed: async () => { throw new Error('down'); }, call: async () => [] });
  assert.deepEqual(lexical, { mode: 'lexical', query: '没有这个画面', count: 0, items: [] });

  /* an empty query is not a search of everything */
  const blank = await searchMaterials({ query: '   ', embed: async () => vector(), call: async () => ROWS });
  assert.deepEqual(blank, { mode: 'lexical', query: '', count: 0, items: [] });
});

test('the limits are the contract’s: 10 unless asked, 50 at the most, never zero', () => {
  assert.deepEqual(MATERIAL_SEARCH_CAPS, { limit: 50, defaultLimit: 10 });
  assert.deepEqual(MATERIAL_SEARCH_CAPS_CONTRACT, { rows: 50, defaultRows: 10 });
  assert.equal(limitOf(undefined), 10);
  assert.equal(limitOf(3), 3);
  assert.equal(limitOf('7'), 7);
  assert.equal(limitOf(1_000), 50);
  assert.equal(limitOf(0), 10);
  assert.equal(limitOf(-4), 10);
  assert.equal(limitOf('nonsense'), 10);
});

test('the limit the caller asks for is the limit the RPC gets, and the answer is cut to it', async () => {
  /** @type {any[]} */
  const calls = [];
  const call = async (rpc, params) => { calls.push(params); return Array.from({ length: 60 }, (_, index) => ({ ...ROWS[0], media_key: `v${index}` })); };
  await searchMaterials({ query: '茶', call, embed: async () => vector() });
  assert.equal(calls[0].p_limit, 10, 'the default is ten rows');
  const many = await searchMaterials({ query: '茶', call, embed: async () => vector(), limit: 10_000 });
  assert.equal(calls[1].p_limit, 50, 'never more than fifty');
  assert.equal(many.items.length, 50, 'and the answer carries no more than that');
});

test('the filters are the five the RPC reads, and a value it cannot use is dropped', () => {
  assert.deepEqual(normaliseFilters({ batch: ' 20261106 ', product: '', gname: '外包装', durationMaxMs: '9000', sourceKind: 'cloud', extra: 'x' }), {
    batch: '20261106', gname: '外包装', durationMaxMs: 9000, sourceKind: 'cloud',
  });
  assert.deepEqual(normaliseFilters(null), {});
  assert.deepEqual(normaliseFilters({ durationMaxMs: 12.7 }), { durationMaxMs: 12 });
  assert.deepEqual(normaliseFilters({ durationMaxMs: -1 }), {});
});

test('the index branch scopes a collection through materialIds, so it agrees with material.items', () => {
  const inGroup = searchIndex({ landed: TREE, query: '柠檬宝藏茶', filters: { product: '20261106-柠檬宝藏茶200g罐', gname: '茶干' } });
  assert.deepEqual(inGroup.map((item) => item.videoId), ['c']);
  const wholeProduct = searchIndex({ landed: TREE, query: '柠檬宝藏茶', filters: { product: '20261106-柠檬宝藏茶200g罐' } });
  assert.deepEqual([...wholeProduct.map((item) => item.videoId)].sort(), ['a', 'b', 'c'], 'the whole collection, in this module’s order');
  const nothing = searchIndex({ landed: TREE, query: '柠檬宝藏茶', filters: { product: '20990101-没有这个合集' } });
  assert.deepEqual(nothing, [], 'a collection the index does not know matches nothing');
  assert.deepEqual(searchIndex({ landed: TREE, query: '随便', filters: { batch: '20261106' } }), [], 'an unclassified row has no batch to match');
});

test('indexRows reads both an envelope and a tree, and keeps every row once', () => {
  assert.deepEqual(indexRows(TREE).map((row) => row.videoId), ['a', 'b', 'c', 'd']);
  assert.deepEqual(indexRows({ index: TREE }).map((row) => row.videoId), ['a', 'b', 'c', 'd']);
  assert.deepEqual(indexRows(null), []);
  const old = { batches: [{ id: 'b', products: [{ id: 'p', name: 'p', groups: [{ id: 'g', name: '外包装', videoIds: ['x', 'y'] }] }] }] };
  assert.deepEqual(indexRows(old).map((row) => [row.videoId, row.name]), [['x', ''], ['y', '']], 'an index without entries still yields its ids');
});

test('one psql line is one search: tenant first, every value dollar-quoted, the vector as a vector', () => {
  const script = mediaSearchScript({
    tenant: 'tenant-a', query: "外包装 (1) 's", filters: { batch: '20261106' }, embedding: vector(0.5), limit: 4,
  });
  assert.match(script, /^set app\.company_key = \$q\$tenant-a\$q\$;/);
  assert.match(script, /public\.media_search\(\$q\$tenant-a\$q\$, \$q\$外包装 \(1\) 's\$q\$/);
  assert.match(script, /\$q\$\{"batch":"20261106"\}\$q\$::jsonb/, 'the filters travel as JSON');
  assert.match(script, /::vector\(768\)/);
  assert.match(script, /, 4\)\) t;\n$/, 'the limit is the RPC’s own argument');
  assert.equal(script.includes("''"), false, 'nothing is escaped by doubling a quote: it is dollar-quoted');

  const lexical = mediaSearchScript({ tenant: 'tenant-a', query: '茶', embedding: null });
  assert.match(lexical, /public\.media_search\(\$q\$tenant-a\$q\$, \$q\$茶\$q\$, \$q\$\{\}\$q\$::jsonb, null, 10\)/);

  /* a name that itself contains the chosen tag gets the next tag, not a broken query */
  assert.equal(dollarTag('a $q$ b'), 'q1');
  const tricky = mediaSearchScript({ tenant: 'tenant-a', query: 'x $q$ y' });
  assert.match(tricky, /\$q1\$x \$q\$ y\$q1\$/);

  assert.equal(isTenantKey('tenant-a'), true);
  assert.equal(isTenantKey('tenant a; drop table media_doc'), false);
  assert.throws(() => mediaSearchScript({ tenant: 'tenant a' }), (error) => error.code === 'tenant-invalid');
});

test('the answer of one psql run is parsed, and anything that is not rows is named', () => {
  assert.deepEqual(parseMediaSearchOutput('[]\n'), []);
  assert.deepEqual(parseMediaSearchOutput('[{"media_key":"v1"}]\r\n'), [{ media_key: 'v1' }]);
  assert.deepEqual(parseMediaSearchOutput('SET\n[{"media_key":"v1"}]\n'), [{ media_key: 'v1' }], 'the SET echo is not the answer');
});

test('psql output that is not a list of rows is a failure, never an empty library', () => {
  for (const [text, code] of [['', 'media-search-empty-answer'], ['SET\n', 'media-search-empty-answer'], ['null', 'media-search-empty-answer'], ['{not json}', 'media-search-unreadable'], ['{"rows":"nope"}', 'media-search-unreadable']]) {
    assert.throws(() => parseMediaSearchOutput(text), (error) => error.code === code, JSON.stringify(text));
  }
});

test('createMediaSearchCall asks one psql session and returns the rows; a failed session is named', async () => {
  /** @type {string[]} */
  const scripts = [];
  const call = createMediaSearchCall({
    tenant: 'tenant-a',
    psql: async (script) => { scripts.push(script); return { code: 0, stdout: `${JSON.stringify(ROWS)}\n`, stderr: '' }; },
  });
  const rows = await call(SEARCH_RPC, { p_query: '茶', p_filters: {}, p_embedding: null, p_limit: 2 });
  assert.equal(rows.length, 2);
  assert.equal(scripts.length, 1);
  assert.match(scripts[0], /set app\.company_key/);

  const failing = createMediaSearchCall({
    tenant: 'tenant-a',
    psql: async () => ({ code: 1, stdout: '', stderr: 'ERROR:  function public.media_search does not exist' }),
  });
  await assert.rejects(
    () => failing(SEARCH_RPC, { p_query: '茶' }),
    (error) => error.code === 'media-search-failed' && /does not exist/.test(error.message),
  );
  await assert.rejects(() => call('search_materials', {}), (error) => error.code === 'unknown-rpc');
});

test('the embedder is one POST with the model this machine runs, and a wrong answer is a throw', async () => {
  /** @type {any[]} */
  const sent = [];
  const embed = createEmbedder({
    endpoint: DEFAULT_EMBED_ENDPOINT,
    model: DEFAULT_EMBED_MODEL,
    fetchImpl: async (url, init) => {
      sent.push([url, JSON.parse(init.body)]);
      return { ok: true, status: 200, json: async () => ({ data: [{ embedding: vector(0.1) }] }) };
    },
  });
  const got = await embed('柠檬宝藏茶');
  assert.equal(got.length, EMBED_DIMS);
  assert.equal(sent[0][0], DEFAULT_EMBED_ENDPOINT);
  assert.deepEqual(sent[0][1], { model: DEFAULT_EMBED_MODEL, input: '柠檬宝藏茶' });

  const wrongDims = createEmbedder({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ embedding: [1, 2, 3] }] }) }) });
  await assert.rejects(() => wrongDims('x'), (error) => error.code === 'embed-invalid');
  const refused = createEmbedder({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
  await assert.rejects(() => refused('x'), (error) => error.code === 'embed-failed');
  assert.equal(isEmbedding(vector()), true);
  assert.equal(isEmbedding([1, 2]), false);
  assert.equal(isEmbedding(Array.from({ length: EMBED_DIMS }, () => Number.NaN)), false);
});

test('itemOf keeps the nine fields and drops anything that is not a row', () => {
  assert.equal(itemOf(null), null);
  assert.equal(itemOf({}), null);
  assert.deepEqual(itemOf({ video_id: 'v9', name: 'n' }), {
    mediaKey: 'v9', videoId: 'v9', name: 'n', batch: null, product: null, gname: null, durationMs: null, score: null, matchKind: 'unknown',
  });
});

test('the service is null without a tenant and without local data, and a tenant builds it', async () => {
  assert.equal(createMaterialSearchService({ env: {}, packDir: '' }), null);
  assert.equal(createMaterialSearchService({ env: { OPENFILM_MEDIA_TENANT: '  ' }, packDir: '' }), null);
  assert.equal(createMaterialSearchService({ env: { OPENFILM_MEDIA_TENANT: 'not a key' }, packDir: '' }), null, 'a tenant is a token');

  /** @type {string[]} */
  const scripts = [];
  const service = createMaterialSearchService({
    /* 这条测的是 HTTP 那条路的降级：默认已经是本地模型（离线可用），所以显式选 service */
    env: { OPENFILM_MEDIA_TENANT: 'tenant-a', OPENFILM_EMBED_MODE: 'service', OPENFILM_EMBED_ENDPOINT: 'http://embed.invalid/v1/embeddings' },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ embedding: vector() }] }) }),
    psql: async (script) => { scripts.push(script); return { code: 0, stdout: `${JSON.stringify(ROWS)}\n`, stderr: '' }; },
    index: () => TREE,
  });
  assert.ok(service);
  assert.equal(service.tenant, 'tenant-a');
  const answer = await service.search({ query: '茶', limit: 2 });
  assert.equal(answer.mode, 'vector');
  assert.equal(answer.count, 2);
  assert.equal(scripts.length, 1);

  /* the same service with a dead embedder is the lexical route; with a dead RPC, the index */
  const lexical = createMaterialSearchService({
    env: { OPENFILM_MEDIA_TENANT: 'tenant-a', OPENFILM_EMBED_MODE: 'service', OPENFILM_EMBED_ENDPOINT: 'http://127.0.0.1:1/v1/embeddings' },
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    psql: async () => ({ code: 0, stdout: `${JSON.stringify(ROWS)}\n`, stderr: '' }),
    index: () => TREE,
  });
  assert.equal((await lexical.search({ query: '茶' })).mode, 'lexical');

  const indexed = createMaterialSearchService({
    env: { OPENFILM_MEDIA_TENANT: 'tenant-a', OPENFILM_EMBED_MODE: 'service' },
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    psql: async () => ({ code: 1, stdout: '', stderr: 'ERROR:  relation "public.media_doc" does not exist' }),
    index: () => TREE,
  });
  const fallback = await indexed.search({ query: '随便' });
  assert.equal(fallback.mode, 'index');
  assert.deepEqual(fallback.items.map((item) => item.videoId), ['d']);
});

test('the default index loader reads the landed file it is pointed at, and nothing when there is none', () => {
  assert.equal(typeof defaultIndexLoader({ dir: '/definitely/not/there' }), 'function');
  assert.equal(defaultIndexLoader({ dir: '/definitely/not/there' })(), null);
});

// ---------------------------------------------------------------------------
// 查询向量缓存：一次 8B 嵌入 300–800 ms，一次向量检索只要 8.5 ms —— 缓存的是贵的那个
// ---------------------------------------------------------------------------
const vectorOf = (fill) => Array.from({ length: EMBED_DIMS }, () => fill);
function countingFetch() {
  const calls = [];
  const impl = async (url, options) => {
    calls.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => ({ data: [{ embedding: vectorOf(calls.length / 100) }] }) };
  };
  impl.calls = calls;
  return impl;
}

test('createEmbedder 缓存同一个 model+query：第二次不再请求端点', async () => {
  const fetchImpl = countingFetch();
  const embed = createEmbedder({ fetchImpl, model: 'm', endpoint: 'http://127.0.0.1:1/v1/embeddings' });

  const first = await embed('柠檬宝藏茶 外包装');
  const second = await embed('柠檬宝藏茶 外包装');
  assert.equal(fetchImpl.calls.length, 1, '同一句话只该付一次嵌入的钱');
  assert.deepEqual(second, first);

  await embed('另一句话');
  assert.equal(fetchImpl.calls.length, 2);
});

test('缓存按模型隔离：换模型就是另一个向量空间，不能复用', async () => {
  const fetchImpl = countingFetch();
  const a = createEmbedder({ fetchImpl, model: 'model-a', endpoint: 'http://127.0.0.1:1/v1/embeddings' });
  const b = createEmbedder({ fetchImpl, model: 'model-b', endpoint: 'http://127.0.0.1:1/v1/embeddings' });

  await a('同一句话');
  await b('同一句话');
  assert.equal(fetchImpl.calls.length, 2);
  assert.deepEqual(fetchImpl.calls.map((call) => call.model), ['model-a', 'model-b']);
});

test('cacheSize=0 关掉缓存（排障时用：每次都要真的打端点）', async () => {
  const fetchImpl = countingFetch();
  const embed = createEmbedder({ fetchImpl, model: 'm', endpoint: 'http://127.0.0.1:1/v1/embeddings', cacheSize: 0 });
  await embed('x');
  await embed('x');
  assert.equal(fetchImpl.calls.length, 2);
});

// ---------------------------------------------------------------------------
// 本地嵌入器（客户端那条路）：离线、768 维、只加载一次
// ---------------------------------------------------------------------------
test('createLocalEmbedder：模型目录不存在时是 embed-unavailable，不是崩', async () => {
  const { createLocalEmbedder } = await import('./material-search.mjs');
  const embed = createLocalEmbedder({ modelDir: join(tmpdir(), 'no-such-model-dir-' + Date.now()) });
  await assert.rejects(() => embed('小青柑'), (error) => {
    assert.equal(error.code, 'embed-unavailable');
    return true;
  });
});

test('createMaterialSearchService：默认走本地模型，OPENFILM_EMBED_MODE=service 才回 HTTP', async () => {
  const { createMaterialSearchService } = await import('./material-search.mjs');
  const local = createMaterialSearchService({ env: { OPENFILM_MEDIA_TENANT: 'tenant-a' } });
  assert.equal(typeof local.embed, 'function', '本地那条也要给一个 embed');
  const remote = createMaterialSearchService({ env: { OPENFILM_MEDIA_TENANT: 'tenant-a', OPENFILM_EMBED_MODE: 'service' } });
  assert.equal(typeof remote.embed, 'function');
});

// ---------------------------------------------------------------------------
// 客户端那条路的接线：有包就先用包，包坏了才落到 RPC/索引
// ---------------------------------------------------------------------------
test('searchMaterials：没有数据库时 packSearch 给了答案就用它', async () => {
  const { searchMaterials } = await import('./material-search.mjs');
  const answer = await searchMaterials({
    query: '小青柑', limit: 2,
    embed: async () => new Array(EMBED_DIMS).fill(0.1),
    packSearch: async () => ({ mode: 'pack', query: '小青柑', count: 1, items: [{ mediaKey: 'k-1', score: 0.9 }] }),
  });
  assert.equal(answer.mode, 'pack');
  assert.equal(answer.count, 1);
});

test('searchMaterials：包抛错（坏包/维度不符）不吞掉检索，落到 RPC', async () => {
  const { searchMaterials } = await import('./material-search.mjs');
  const answer = await searchMaterials({
    query: '小青柑', limit: 2,
    embed: async () => new Array(EMBED_DIMS).fill(0.1),
    call: async () => [{ media_key: 'k-2', video_id: 'v-2', score: 0.5 }],
    packSearch: async () => { throw Object.assign(new Error('pack-dims'), { code: 'pack-dims' }); },
  });
  assert.equal(answer.mode, 'vector');
  assert.equal(answer.items.length, 1);
});
