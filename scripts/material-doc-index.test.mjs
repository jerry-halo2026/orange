// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * `scripts/material-doc-index.mjs` —— 文本 → 载荷 → 批次写入，全部用桩。不连真库、不连真端点。
 *
 * 为什么桩在这一层：这条流水线的三个接缝各自会静默出错，而真库跑一次 78 874 行要十几分钟，
 * 出错时你能看到的只是"少了 3 行"。
 *   1. 文本（`mediaDocRow`）→ 载荷：多一个键、少一个键都不会报错（`upsert_media_doc` 忽略它不认识的键）；
 *   2. 载荷 → 语句：dollar-quote 与 JSON 里出现的引号/`$mdoc$` 决定语句是否还能解析；
 *   3. 语句 → 结果：psql 对失败的语句**不输出任何行**，"数量对不上"是唯一的失败信号。
 * 所以下面测的是这三处，不是"函数被调用了"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DEFAULT_ANALYZER_VER, mediaDocText } from '../packages/orangefilm/src/material-doc.mjs';
import {
  DEFAULT_BATCH,
  EMBED_DIMS,
  addFailure,
  buildPayload,
  collectEntries,
  defaultOptions,
  firstError,
  formatDuration,
  makeEmbedder,
  mapPool,
  parsePsqlOutput,
  readExcludeFile,
  readLiveDigests,
  readProgressFile,
  backendOf,
  maskUrl,
  psqlCommandFor,
  writeProgressFile,
  runBackfill,
  textDigest,
  toPsqlScript,
  toVectorLiteral,
  writeBatch,
} from './material-doc-index.mjs';

const TEA = '20261106-柠檬宝藏茶200g罐-外包装 (46)';
const OIL = '20261109-油弃乌龙茶-茶干 (12)';
const vector = (fill = 0.5) => Array.from({ length: EMBED_DIMS }, () => fill);

/** 一个两层的索引（外层 build 信封 + `index` 树），和 `~/.openfilm-dev/material-index/index.json` 同形状。 */
function fixtureIndex() {
  return {
    schema: 'orange/material-index-build/1',
    videos: 5,
    parsed: 3,
    unclassified: 2,
    index: {
      schema: 'orange/material-index/1',
      totals: { videos: 5, parsed: 3, unclassified: 2 },
      batches: [{
        id: '20261106',
        name: '20261106',
        count: 3,
        products: [{
          id: '20261106-柠檬宝藏茶200g罐',
          name: '柠檬宝藏茶200g罐',
          count: 3,
          groups: [{
            id: '20261106-柠檬宝藏茶200g罐-外包装',
            name: '外包装',
            count: 3,
            videoIds: ['v1', 'v2', 'v3'],
            entries: [
              { videoId: 'v1', name: TEA, md5: 'aa' },
              { videoId: 'v2', name: TEA, md5: 'bb' },
              { videoId: 'v1', name: TEA, md5: 'aa' },     // duplicate id：同一主键，只该算一条
            ],
          }],
        }],
      }],
      unclassified: [
        { videoId: 'u1', name: OIL, md5: '' },
        { videoId: '', name: '没有身份的条目', md5: '' },   // 没有 videoId 就没有 media_key（012:81）
      ],
    },
  };
}

function stubPsql({ answered = (payload) => ({ ok: true, mediaKey: payload.media_key, written: true }), failKeys = new Set() } = {}) {
  const calls = [];
  const psql = async (script) => {
    calls.push(script);
    const bodies = [...script.matchAll(/\$mdoc\d*\$(\{.*?\})\$mdoc\d*\$/g)].map((match) => JSON.parse(match[1]));
    const lines = [];
    for (const body of bodies) {
      if (failKeys.has(body.media_key)) continue;             // psql 对失败的语句不输出任何行
      lines.push(JSON.stringify(answered(body)));
    }
    return { code: 0, stdout: lines.join('\n') + (lines.length ? '\n' : ''), stderr: '' };
  };
  psql.calls = calls;
  return psql;
}

function options(overrides = {}) {
  return { ...defaultOptions(), batch: 2, concurrency: 2, ...overrides };
}

// ---------------------------------------------------------------------------
// 索引 → 条目
// ---------------------------------------------------------------------------
test('collectEntries 吃外层 build 信封与裸树两种形状，并去重/跳过无身份条目', () => {
  const wrapped = collectEntries(fixtureIndex());
  assert.equal(wrapped.entries.length, 3, 'v1/v2/u1（v1 重复一次、空 videoId 一条）');
  assert.deepEqual(wrapped.entries.map((entry) => entry.videoId), ['v1', 'v2', 'u1']);
  assert.equal(wrapped.skipped.duplicateId, 1);
  assert.equal(wrapped.skipped.noIdentity, 1);
  assert.equal(wrapped.total, 5, 'totals.videos 是索引自己的账，不是"本次能用几条"');

  /* 裸树：桩测试和手工样本都是这个形状。 */
  const bare = collectEntries(fixtureIndex().index);
  assert.deepEqual(bare.entries.map((entry) => entry.videoId), ['v1', 'v2', 'u1']);
});

test('collectEntries 的 group 只有 videoIds 时退化成 id（计数说出来，不假装有名字）', () => {
  const index = { batches: [{ products: [{ groups: [{ videoIds: ['a', 'b'] }] }] }], unclassified: [] };
  const collected = collectEntries(index);
  assert.deepEqual(collected.entries.map((entry) => entry.videoId), ['a', 'b']);
  assert.equal(collected.skipped.idOnly, 2);
  /* 只有 id 的条目照样能出一条可检索的文档（mediaDocText 的兜底就是 id）。 */
  assert.equal(buildPayload(collected.entries[0]).text, 'asset:a');
});

// ---------------------------------------------------------------------------
// 条目 → 载荷
// ---------------------------------------------------------------------------
test('buildPayload 的 text 就是 mediaDocText，载荷不多不少是 RPC 要的那 14 个键', () => {
  const entry = { videoId: 'v1', name: TEA, md5: 'aa' };
  const payload = buildPayload(entry);

  assert.equal(payload.text, mediaDocText(entry));
  assert.equal(payload.text, '柠檬宝藏茶200g罐 外包装 20261106-柠檬宝藏茶200g罐-外包装');
  assert.equal(payload.gran, 'asset');
  assert.equal(payload.shot_index, 0, '013：asset 行 shot_index 恒 0（NOT NULL，且在主键里）');
  assert.equal(payload.source_kind, 'cloud');
  assert.equal(payload.analyzer_ver, DEFAULT_ANALYZER_VER);
  assert.equal(payload.media_key, 'v1');
  assert.equal(payload.video_id, 'v1');
  assert.equal(Object.keys(payload).length, 14);
  /* 没有向量就不该有向量键：`--dry-run` 的载荷要能被一眼认出"没算过"。 */
  assert.equal('embedding' in payload, false);
  assert.equal('embedding_ver' in payload, false);
});

test('buildPayload 给向量时补上 embedding_ver（012:260 没有它就是 23514）', () => {
  const payload = buildPayload({ videoId: 'v1', name: TEA }, {
    analyzerVer: 'card-meta-1', embeddingVer: 'nomic-embed-text-v1.5', embedding: vector(0.25),
  });
  assert.equal(payload.embedding_ver, 'nomic-embed-text-v1.5');
  assert.equal(typeof payload.embedding, 'string', '向量以文本进 JSON：(p_row ->> \'embedding\')::vector');
  assert.ok(payload.embedding.startsWith('[') && payload.embedding.endsWith(']'));
  assert.equal(payload.embedding.split(',').length, EMBED_DIMS);
});

test('toVectorLiteral 把维度与 NaN 挡在数据库之前', () => {
  assert.equal(toVectorLiteral([1, 2, 3], 3), '[1,2,3]');
  assert.throws(() => toVectorLiteral(new Array(767).fill(0)), /维度是 767/);
  assert.throws(() => toVectorLiteral([...new Array(767).fill(0), Number.NaN]), /非有限数/);
  assert.throws(() => toVectorLiteral('[]'), /不是数组/);
  assert.throws(() => buildPayload({ videoId: 'v1', name: TEA }, { embedding: vector(1).slice(1) }), /维度/);
});

// ---------------------------------------------------------------------------
// 载荷 → 语句
// ---------------------------------------------------------------------------
test('toPsqlScript 先设会话租户，再一行一条 upsert（不是一条语句塞全部）', () => {
  const payloads = [
    buildPayload({ videoId: 'v1', name: TEA }, { embedding: vector() }),
    buildPayload({ videoId: 'v2', name: OIL }, { embedding: vector() }),
  ];
  const script = toPsqlScript(payloads, 'tenant-a');
  const lines = script.trim().split('\n');

  assert.equal(lines[0], "set app.company_key = 'tenant-a';");
  assert.equal(lines.length, 3, 'SET + 两行 upsert');
  /* 一行一条语句：某一行 22023 只丢那一行，不会让整批回滚（语句级原子性）。 */
  assert.equal(lines.slice(1).filter((line) => line.startsWith('select public.upsert_media_doc(')).length, 2);
  assert.ok(lines[1].endsWith('::jsonb);'));
});

test('toPsqlScript 的 dollar-quote 标签与租户字面量都不可注入', () => {
  /* 载荷里真的出现 $mdoc$ 时要换标签，否则语句在第一个 $mdoc$ 处就被截断了（名字仍原样进文本）。
     注意断言的对象是**定界符**：名字里的 $mdoc$ 会原样留在 body 里，那是它该待的地方。 */
  const nasty = buildPayload({ videoId: 'v1', name: `名字里带 $mdoc$ 与 ' 引号 (1)` });
  const script = toPsqlScript([nasty], 'tenant-a');
  assert.ok(!script.includes('$mdoc${'), '默认标签不能当定界符');
  assert.match(script, /\$mdoc1\$/, '换成了下一个标签');

  /* 换标签之后语句仍然只有一条，且 body 能原样读回来：这才是"没被截断"的证据。 */
  const body = script.match(/\$mdoc1\$(\{.*\})\$mdoc1\$::jsonb\);/s);
  assert.ok(body, '找不到 dollar-quote 包起来的载荷');
  const parsed = JSON.parse(body[1]);
  assert.equal(parsed.media_key, 'v1');
  assert.ok(parsed.text.includes('$mdoc$'));

  const quoted = toPsqlScript([nasty], "o'brien");
  assert.ok(quoted.startsWith("set app.company_key = 'o''brien';"));
});

test('parsePsqlOutput 只认信封行：psql 的杂音不会变成一行结果', () => {
  const stdout = [
    'SET',
    '{"ok": true, "mediaKey": "v1", "written": true}',
    'NOTICE:  012: 提示',
    '',
    '{"ok": true, "mediaKey": "v2", "written": false}',
  ].join('\n');
  const { results, noise } = parsePsqlOutput(stdout);
  assert.deepEqual(results.map((result) => result.mediaKey), ['v1', 'v2']);
  assert.deepEqual(results.map((result) => result.written), [true, false]);
  assert.equal(noise.length, 2);
  assert.deepEqual(parsePsqlOutput('').results, []);

  assert.equal(firstError('docker : ERROR:  upsert_media_doc: media_key is required'), 'ERROR:  upsert_media_doc: media_key is required');
  assert.equal(firstError(''), '');
});

// ---------------------------------------------------------------------------
// 批次写入
// ---------------------------------------------------------------------------
test('writeBatch 一批一个会话，信封数对上就是全部成功', async () => {
  const psql = stubPsql();
  const payloads = ['v1', 'v2', 'v3'].map((videoId) => buildPayload({ videoId, name: TEA }));
  const { results, failures } = await writeBatch({ psql }, payloads, options());

  assert.equal(psql.calls.length, 1);
  assert.deepEqual(results.map((result) => result.mediaKey), ['v1', 'v2', 'v3']);
  assert.deepEqual(failures, []);
});

test('writeBatch 数量对不上就逐行重放，把失败落到具体 media_key', async () => {
  const psql = stubPsql({ failKeys: new Set(['v2']) });
  /* 让快路径的整批语句"少一行"（v2 失败），慢路径再逐行跑：v2 依然没有输出行。 */
  const payloads = ['v1', 'v2', 'v3'].map((videoId) => buildPayload({ videoId, name: TEA }));
  const { results, failures } = await writeBatch({ psql }, payloads, options());

  assert.equal(psql.calls.length, 1 + 3, '1 次快路径 + 3 次逐行');
  assert.deepEqual(results.map((result) => result.mediaKey), ['v1', 'v3']);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].mediaKey, 'v2');
});

test('writeBatch 在会话根本没起来时抛错（整批是环境问题，不是脏行）', async () => {
  const psql = async () => ({ code: 1, stdout: '', stderr: 'ERROR:  tenant-context-required' });
  await assert.rejects(
    () => writeBatch({ psql }, [buildPayload({ videoId: 'v1', name: TEA })], options()),
    /psql 会话失败.*tenant-context-required/,
  );
});

// ---------------------------------------------------------------------------
// 主循环（断点续跑 / 幂等 / 失败清单 / dry-run）
// ---------------------------------------------------------------------------
function stubDeps(overrides = {}) {
  const psql = stubPsql();
  const embedded = [];
  const writes = [];
  const logs = [];
  const done = new Set();
  const deps = {
    readIndex: () => fixtureIndex(),
    embed: async (text) => { embedded.push(text); return vector(embedded.length / 100); },
    psql,
    readProgress: () => ({ done: new Set(done), meta: null }),
    writeProgress: (set) => { done.clear(); for (const key of set) done.add(key); writes.push([...set].sort()); },
    log: (line) => logs.push(line),
    warn: () => {},
    now: () => Date.now(),
    ...overrides,
  };
  return { deps, psql, embedded, writes, logs, done: () => done };
}

test('runBackfill 按 --batch 切批、按顺序嵌入、每批落一次 progress', async () => {
  const { deps, psql, embedded, logs, done } = stubDeps();
  const summary = await runBackfill(options({ batch: 2 }), deps);

  assert.equal(summary.total, 3, 'v1/v2/u1；重复与空 id 不计');
  assert.equal(summary.written, 3);
  assert.equal(summary.unchanged, 0);
  assert.equal(psql.calls.length, 2, '3 条 / 每批 2 条 = 2 次 psql 会话');
  assert.equal(embedded.length, 2, 'v1/v2 的 text 逐字节相同 → 只嵌一次（同一段文本给两个向量，排序会抖）');
  assert.equal(summary.shared, 1, '共用向量的那一行要报出来，不能悄悄省掉');
  assert.equal(embedded[0], mediaDocText({ videoId: 'v1', name: TEA }), '嵌的是 text，不是名字');
  assert.deepEqual([...done()].sort(), ['u1', 'v1', 'v2']);
  /* 每批一行进度，带 done/total、速率与预计剩余时间。 */
  assert.ok(logs.some((line) => /done=2\/3 .*\/s eta=/.test(line)));
});

test('runBackfill 断点续跑：第二次跑不发嵌入、不发写库', async () => {
  const { deps, psql, embedded, done } = stubDeps();
  await runBackfill(options(), deps);
  assert.equal(psql.calls.length, 2);

  psql.calls.length = 0;
  embedded.length = 0;
  const second = await runBackfill(options(), deps);
  assert.equal(second.resumed.alreadyDone, 3);
  assert.equal(psql.calls.length, 0, '全部已完成 → 一个会话都不开');
  assert.equal(embedded.length, 0, '向量重算一次 20 ms，续跑不该付费');
  assert.equal(done().size, 3);
});

test('runBackfill --no-resume 会重写同一批，数据库回 written=false 就是幂等证据', async () => {
  /* 第二次写同样的 text + embedding_ver：RPC 的 ON CONFLICT … WHERE 不命中（012:302-304 / 013:302-304）。 */
  const psql = stubPsql({ answered: (payload) => ({ ok: true, mediaKey: payload.media_key, written: false }) });
  const { deps } = stubDeps({ psql });
  const summary = await runBackfill(options({ resume: false }), deps);

  assert.equal(psql.calls.length, 2, '仍然是 3 条 / 每批 2 条');
  assert.equal(summary.written, 0);
  assert.equal(summary.noop, 3, '写回去了，库没动 —— 这是幂等，不是"没处理"');
});

test('runBackfill 的失败清单按原因聚合，失败行不进 progress', async () => {
  const psql = stubPsql({ failKeys: new Set(['v2']) });
  /* 逐行重放时也要能给出 psql 的 ERROR 行，否则清单里只有"无输出"。 */
  const withStderr = async (script) => {
    const result = await psql(script);
    if (script.includes('"media_key":"v2"')) return { ...result, stderr: 'ERROR:  upsert_media_doc: embedding 维度是 768，契约要求 768' };
    return result;
  };
  const { deps, done } = stubDeps({ psql: withStderr });
  const summary = await runBackfill(options(), deps);

  assert.equal(summary.written, 2);
  assert.equal(summary.failures.size, 1);
  const [slot] = summary.failures.values();
  assert.match(slot.reason, /^db: /);
  assert.equal(slot.count, 1);
  assert.deepEqual(slot.samples, ['v2']);
  assert.equal(done().has('v2'), false, '失败的 media_key 不写进进度 → 下次重跑自然重试');
  assert.equal(done().size, 2);
});

test('runBackfill 嵌入失败按原因记账，且不让整批停', async () => {
  const { deps, done } = stubDeps({
    embed: async (text) => {
      if (text.includes('油弃乌龙茶')) throw new Error('嵌入请求失败（第 4 次）：The operation was aborted');
      return vector();
    },
  });
  const summary = await runBackfill(options(), deps);

  assert.equal(summary.written, 2);
  assert.equal(summary.failures.size, 1);
  const [slot] = summary.failures.values();
  assert.match(slot.reason, /^embed: .*aborted/);
  assert.deepEqual(slot.samples, ['u1']);
  assert.equal(done().has('u1'), false);
});

test('runBackfill --dry-run 不嵌入、不写库、不动 progress', async () => {
  const { deps, psql, embedded, writes } = stubDeps();
  const summary = await runBackfill(options({ dryRun: true, limit: 2 }), deps);

  assert.equal(summary.dryRun, true);
  assert.equal(summary.total, 2);
  assert.equal(summary.written, 0);
  assert.equal(psql.calls.length, 0);
  assert.equal(embedded.length, 0);
  assert.equal(writes.length, 0);
  assert.equal(summary.sampleTexts.length, 2, 'dry-run 的产出是"这批文档长什么样"');
  assert.equal(summary.sampleTexts[0].text, mediaDocText({ videoId: 'v1', name: TEA }));
});

test('runBackfill --limit 切的是候选集（先切片再按进度过滤），边界不随进度漂移', async () => {
  const { deps, done } = stubDeps();
  const first = await runBackfill(options({ limit: 1 }), deps);
  assert.deepEqual([...done()], ['v1']);
  assert.equal(first.total, 1);

  /* 第二次仍然指"索引里的前 1 条"，而不是"进度之后的下一条"。 */
  const second = await runBackfill(options({ limit: 1 }), deps);
  assert.equal(second.total, 1);
  assert.equal(second.resumed.alreadyDone, 1);
  assert.equal(second.resumed.pending, 0);
  assert.deepEqual([...done()], ['v1']);
});

// ---------------------------------------------------------------------------
// 嵌入端点
// ---------------------------------------------------------------------------
test('makeEmbedder 失败重试 3 次带退避，成功即返回 768 维', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts < 3) return { ok: false, status: 503, text: async () => 'busy' };
    return { ok: true, status: 200, json: async () => ({ data: [{ embedding: vector() }] }) };
  };
  const embed = makeEmbedder({ endpoint: 'http://127.0.0.1:1/v1/embeddings', model: 'm', fetchImpl, retries: 3 });
  const result = await embed('文本');
  assert.equal(attempts, 3);
  assert.equal(result.length, EMBED_DIMS);
});

test('makeEmbedder 重试用尽后抛出最后一次原因', async () => {
  let attempts = 0;
  const fetchImpl = async () => { attempts += 1; throw new Error('connect ECONNREFUSED'); };
  const embed = makeEmbedder({ endpoint: 'http://127.0.0.1:1/v1/embeddings', model: 'm', fetchImpl, retries: 2 });
  await assert.rejects(() => embed('文本'), /嵌入请求失败/);
  assert.equal(attempts, 3, 'retries=2 → 共 3 次尝试');
});

test('makeEmbedder 维度不是 768 直接抛（不重试：模型换错了重试只会重复同一个错）', async () => {
  let attempts = 0;
  const fetchImpl = async () => { attempts += 1; return { ok: true, status: 200, json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }) }; };
  const embed = makeEmbedder({ endpoint: 'http://127.0.0.1:1/v1/embeddings', model: 'text-embedding-3-small', fetchImpl, retries: 3 });
  await assert.rejects(() => embed('文本'), /返回 2 维，契约要求 768/);
  assert.equal(attempts, 1);
});

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
test('mapPool 保持输入顺序且不超过并发上限', async () => {
  let live = 0;
  let peak = 0;
  const out = await mapPool([1, 2, 3, 4, 5], 2, async (value) => {
    live += 1;
    peak = Math.max(peak, live);
    await new Promise((resolve) => { setTimeout(resolve, 1); });
    live -= 1;
    return value * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10]);
  assert.ok(peak <= 2, `并发峰值 ${peak} 超过上限 2`);
  assert.deepEqual(await mapPool([], 4, async () => 0), []);
});

test('formatDuration 与 addFailure 的输出形状（进度行与失败清单都靠它）', () => {
  assert.equal(formatDuration(42_000), '42s');
  assert.equal(formatDuration(90_000), '1m30s');
  assert.equal(formatDuration(3_720_000), '1h02m');
  assert.equal(formatDuration(Number.POSITIVE_INFINITY), '—');

  const bucket = new Map();
  for (let i = 0; i < 7; i++) addFailure(bucket, 'db: ERROR: x', `k${i}`);
  addFailure(bucket, 'embed: timeout', 'k7');
  assert.equal(bucket.size, 2);
  assert.equal(bucket.get('db: ERROR: x').count, 7);
  assert.equal(bucket.get('db: ERROR: x').samples.length, 5, '样例最多 5 个，78k 行跑完没人读 300 行同样的 ERROR');
  assert.deepEqual(bucket.get('embed: timeout').samples, ['k7']);
});

test('默认批大小落在题述的 200–500 区间', () => {
  assert.ok(DEFAULT_BATCH >= 200 && DEFAULT_BATCH <= 500);
});

// ---------------------------------------------------------------------------
// 只重算 text 变了的行（card-meta-2）
// ---------------------------------------------------------------------------
test('collectEntries 把六个卡片字段带到载荷：丢了它们，文本就退回只看名字', () => {
  const index = {
    batches: [{ products: [{ groups: [{ entries: [{
      videoId: 'v1',
      name: TEA,
      md5: '',
      labels: ['首发素材'],
      durationMs: 23400,
      author: '周佳',
      coverUrl: 'https://example.test/c.png',
      oneLevel: '花草养生茶',
      twoLevel: '柠檬宝藏茶',
    }] }] }] }],
    unclassified: [],
  };
  const [entry] = collectEntries(index).entries;
  assert.deepEqual(
    [entry.labels, entry.durationMs, entry.author, entry.coverUrl, entry.oneLevel, entry.twoLevel],
    [['首发素材'], 23400, '周佳', 'https://example.test/c.png', '花草养生茶', '柠檬宝藏茶'],
  );
  assert.match(buildPayload(entry).text, /^花草养生茶 柠檬宝藏茶 柠檬宝藏茶200g罐 外包装 首发素材 23.4s 周佳 /);

  /* 旧索引（`chore/vendor-0.3.2` 之前落盘的那份）没有这些键：给空值，文本退回「产品 + 分组 + 名称」，不崩也不编。 */
  const [old] = collectEntries({ batches: [{ products: [{ groups: [{ entries: [{ videoId: 'v2', name: TEA }] }] }] }] }).entries;
  assert.deepEqual([old.labels, old.durationMs, old.author, old.coverUrl, old.oneLevel, old.twoLevel],
    [[], null, '', '', '', '']);
});

test('textDigest 与 PostgreSQL 的 md5() 是同一个串（比对表靠这一点才成立）', () => {
  assert.equal(textDigest('abc'), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(textDigest(''), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(textDigest(mediaDocText({ videoId: 'v1', name: TEA })).length, 32);
});

test('readLiveDigests 读未取代行的 md5(text)，会话失败就抛（不把"读不到"当成"全变了"）', async () => {
  const calls = [];
  const psql = async (script) => {
    calls.push(script);
    return { code: 0, stderr: '', stdout: 'doc|v1|aaa\ndoc|v2|bbb\n\nSET\n' };
  };
  const digests = await readLiveDigests(psql, 'tenant-a');
  assert.deepEqual([...digests], [['v1', 'aaa'], ['v2', 'bbb']]);
  assert.match(calls[0], /^set app\.company_key = 'tenant-a';/);
  assert.match(calls[0], /where superseded_at is null/);

  await assert.rejects(
    () => readLiveDigests(async () => ({ code: 1, stdout: '', stderr: 'ERROR:  42501 permission denied' })),
    /读取库内 text 摘要失败.*42501/,
  );
});

test('runBackfill 只重算 text 变了的行：md5 相同的行不嵌入、不写库', async () => {
  const digests = new Map([
    ['v1', textDigest(mediaDocText({ videoId: 'v1', name: TEA }))],   // 与本次逐字节相同 → 跳过
    ['v2', 'ffffffffffffffffffffffffffffffff'],                      // 模板变了 → 重算
    /* u1 库内没有这行 → 重算 */
  ]);
  const { deps, psql, embedded } = stubDeps({ readDigests: () => digests });
  const summary = await runBackfill(options(), deps);

  assert.equal(summary.changed, 2);
  assert.equal(summary.unchanged, 1);
  assert.equal(summary.written, 2);
  assert.equal(embedded.length, 2, '没变的那条不付一次嵌入的钱（78k 行 × 20 ms ≈ 半小时）');
  assert.equal(psql.calls.join('\n').includes('"media_key":"v1"'), false, 'v1 一个字都没写');
});

test('runBackfill --all 关掉比对：库内摘要不参与，每一行都重算', async () => {
  const { deps, embedded } = stubDeps({ readDigests: () => new Map([['v1', 'whatever']]) });
  const summary = await runBackfill(options({ changedOnly: false }), deps);

  assert.equal(summary.changed, 3);
  assert.equal(summary.unchanged, 0);
  assert.equal(embedded.length, 2, 'v1/v2 同 text 共用一条向量；--all 不等于"同一段文本付两次"');
});

test('没有比对表（deps.readDigests 未提供）时按全部重算，并在日志里说出来', async () => {
  const { deps, embedded, logs } = stubDeps();
  const summary = await runBackfill(options(), deps);

  assert.equal(summary.changed, 3);
  assert.equal(summary.unchanged, 0);
  assert.equal(embedded.length, 2, 'v1/v2 同 text 共用一条向量');
  assert.ok(logs.some((line) => /没有库内摘要/.test(line)), '没比对就得说没比对，不能假装"没变"');
});

// ---------------------------------------------------------------------------
// 质量闸（--exclude-file）：不嵌入、不写库、不进 progress
// ---------------------------------------------------------------------------
const tempDir = mkdtempSync(path.join(tmpdir(), 'orange-exclude-'));

test('readExcludeFile 吃裸数组 / quarantined / mediaKeys 三种形状，文件不存在就抛', () => {
  const bare = path.join(tempDir, 'bare.json');
  writeFileSync(bare, JSON.stringify(['v1', ' v2 ', '']));
  assert.deepEqual([...readExcludeFile(bare)], ['v1', 'v2'], '空串不是 id，空白要去掉');

  const wrapped = path.join(tempDir, 'wrapped.json');
  writeFileSync(wrapped, JSON.stringify({ schema: 'orange/material-quality-plan/1', quarantined: ['x9'] }));
  assert.deepEqual([...readExcludeFile(wrapped)], ['x9']);

  const alias = path.join(tempDir, 'alias.json');
  writeFileSync(alias, JSON.stringify({ mediaKeys: ['y8'] }));
  assert.deepEqual([...readExcludeFile(alias)], ['y8']);

  /* BOM 是 PowerShell 写文件的默认产物，读不进去等于清单悄悄失效。 */
  const bom = path.join(tempDir, 'bom.json');
  writeFileSync(bom, '\uFEFF' + JSON.stringify({ excluded: ['z7'] }));
  assert.deepEqual([...readExcludeFile(bom)], ['z7']);

  assert.throws(() => readExcludeFile(path.join(tempDir, 'nope.json')), /隔离清单不存在/);
});

test('runBackfill --exclude-file：被闸掉的条目一条都不嵌入、不写库、不进 progress', async () => {
  const { deps, psql, embedded, done } = stubDeps({ readExcludes: () => new Set(['v2']) });
  const summary = await runBackfill(options({ excludeFile: 'quality.json' }), deps);

  assert.equal(summary.total, 2, '闸掉 v2 之后本次处理 2 条');
  assert.equal(summary.excluded, 1);
  assert.equal(summary.written, 2);
  assert.equal(embedded.length, 2, 'v1 与 u1 各嵌一次；v2 被闸掉，v1 的重复文本也就没人可共享');
  assert.deepEqual([...done()].sort(), ['u1', 'v1'], '被闸掉的不算"已完成"');
  assert.equal(psql.calls.join('\n').includes('"media_key":"v2"'), false, '闸掉的行一个字都不写库');
});

test('runBackfill 的质量闸先于 --limit：拿到的是第一条合格条目，不是"第一条再被闸掉"', async () => {
  const { deps, psql } = stubDeps({ readExcludes: () => new Set(['v1']) });
  const summary = await runBackfill(options({ excludeFile: 'quality.json', limit: 1 }), deps);

  assert.equal(summary.total, 1);
  assert.match(psql.calls[0], /"media_key":"v2"/, 'v1 被闸掉 → --limit 1 落在 v2 上');
});

test('同一段文本的共用向量失败不会连坐：撤掉 memo，下一行自己重试', async () => {
  let attempt = 0;
  const psql = stubPsql();
  const { deps } = stubDeps({
    psql,
    embed: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('LM Studio 502');
      return vector(0.4);
    },
  });
  /* batch=1：v1 与 v2 落在两个不同的批里，才看得出"失败后 memo 被撤掉"。 */
  const summary = await runBackfill(options({ batch: 1, concurrency: 1 }), deps);

  assert.equal(attempt, 3, 'v1 失败一次、v2 重试成功、u1 一次');
  assert.equal(summary.written, 2);
  assert.equal(summary.shared, 0, '第一条就把 memo 撤了，v2 是新嵌的，不是共用来的');
  assert.deepEqual([...summary.failures.keys()], ['embed: LM Studio 502']);
});

// ---------------------------------------------------------------------------
// 云端灌库（--db-url）：连的是哪个库、进度记在哪一份
// ---------------------------------------------------------------------------
test('psqlCommandFor：不给 --db-url 走本机 compose，给了就走 docker run 直连', () => {
  const local = psqlCommandFor(defaultOptions());
  assert.deepEqual(local.args.slice(0, 5), ['compose', '-f', local.args[2], 'exec', '-T']);
  assert.ok(local.args.includes('db'));
  assert.ok(local.args.includes('orange'), '本机库名 orange');
  assert.ok(local.args.includes('ON_ERROR_STOP=0'), '一行失败不该带走整批');

  const url = 'postgresql://postgres:pw@db.example.supabase.co:5432/postgres?sslmode=require';
  const cloud = psqlCommandFor({ dbUrl: url });
  assert.deepEqual(cloud.args.slice(0, 5), ['run', '--rm', '-i', 'postgres:17', 'psql']);
  assert.equal(cloud.args[5], url, '连接串是位置参数（psql 认 URL）');
  assert.equal(cloud.args.includes('-U'), false, '云端不额外给 -U：用户与库都在 URL 里');
});

test('backendOf / maskUrl：本地与云端是两笔账，口令永远不出现在输出里', () => {
  assert.equal(backendOf(defaultOptions()), 'local');
  assert.equal(backendOf({ dbUrl: 'postgresql://x' }), 'cloud');
  assert.equal(backendOf({ dbUrl: '   ' }), 'local', '空白等于没给');

  const masked = maskUrl('postgresql://postgres:SUPERSECRET@db.abc.supabase.co:5432/postgres?sslmode=require');
  assert.equal(masked, 'postgresql://postgres@db.abc.supabase.co:5432/postgres');
  assert.equal(/SUPERSECRET/.test(masked), false, '口令不能出现在任何一行日志里');
  assert.equal(maskUrl('not a url'), 'not a url');
  assert.equal(maskUrl(''), '');
});

test('进度文件的 backend 对不上就拒绝：本机写完的行不能冒充"云上也灌了"', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orange-progress-'));
  const file = path.join(dir, 'progress.json');
  writeProgressFile(file, new Set(['v1']), {
    tenant: 'tenant-a', analyzerVer: DEFAULT_ANALYZER_VER, embeddingVer: 'nomic',
    dims: EMBED_DIMS, total: 1, backend: 'cloud',
  });
  assert.throws(
    () => readProgressFile(file, {
      tenant: 'tenant-a', analyzerVer: DEFAULT_ANALYZER_VER, embeddingVer: 'nomic', dims: EMBED_DIMS, backend: 'local',
    }),
    /backend=cloud.*本次是 local/,
  );

  /* 老进度文件没有这个键：缺就不比对，等于向后兼容。 */
  const legacy = path.join(dir, 'legacy.json');
  writeFileSync(legacy, JSON.stringify({
    schema: 'orange/material-doc-progress/1', tenant: 'tenant-a', analyzerVer: DEFAULT_ANALYZER_VER,
    embeddingVer: 'nomic', dims: EMBED_DIMS, done: ['v1'],
  }));
  assert.deepEqual([...readProgressFile(legacy, { backend: 'local' }).done], ['v1']);
});
