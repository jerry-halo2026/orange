// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * `scripts/media-doc-sync.mjs` —— 本机向量搬到云上。不连真库：读的行用桩数据。
 *
 * 这一层要钉死的是**载荷形状**：少一个键就是丢字段，多写 768 那一列就是把云上空间翻倍。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { defaultOptions, parseArgs, payloadOf, readProgress, writeProgress } from './media-doc-sync.mjs';

const ROW = {
  media_key: 'v1', analyzer_ver: 'card-meta-2', gran: 'asset', video_id: 'v1', shot_index: 0,
  name: '柠檬宝藏茶 外包装', batch: '20261106', product: '柠檬宝藏茶200g罐', gname: '外包装',
  labels: ['绿'], duration_ms: 1200, author: '小尹', source_kind: 'cloud',
  text: '绿茶 外包装 柠檬宝藏茶200g罐 外包装 1200 小尹', embedding_ver_4096: 'qwen3-embedding-8b',
  embedding_4096: '[0.1,0.2]',
};

test('payloadOf 只带 4096 那一列，且 14 个业务键一个不少', () => {
  const payload = payloadOf(ROW, defaultOptions());
  assert.equal(payload.embedding_4096, '[0.1,0.2]');
  assert.equal(payload.embedding_ver_4096, 'qwen3-embedding-8b');
  assert.equal('embedding' in payload, false, '云上不灌 768：省一半空间，也避免两列谁说了算');
  assert.deepEqual(payload.labels, ['绿']);
  for (const key of ['media_key', 'analyzer_ver', 'gran', 'video_id', 'shot_index', 'name', 'batch',
    'product', 'gname', 'labels', 'duration_ms', 'author', 'source_kind', 'text']) {
    assert.ok(key in payload, `缺键 ${key}`);
  }
});

test('payloadOf 缺字段时用确定的默认值，不写 undefined', () => {
  const payload = payloadOf({ media_key: 'v9', text: 'x' }, { analyzerVer: 'card-meta-2' });
  assert.equal(payload.analyzer_ver, 'card-meta-2', '缺 analyzer_ver 时用本次的版本');
  assert.equal(payload.gran, 'asset');
  assert.equal(payload.shot_index, 0);
  assert.deepEqual(payload.labels, []);
  assert.equal(payload.source_kind, 'cloud');
});

test('parseArgs：--batch 越界直接抛，--help 返回 null', () => {
  assert.equal(parseArgs(['--help']), null);
  assert.throws(() => parseArgs(['--batch', '999']), /--batch/);
  const parsed = parseArgs(['--db-url', 'postgresql://x', '--limit=50', '--analyzer-ver', 'card-meta-2']);
  assert.equal(parsed.limit, 50);
  assert.equal(parsed.dbUrl, 'postgresql://x');
});

test('进度文件是 offset 断点：写进去什么读回来什么，坏文件当从头开始', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orange-sync-'));
  const file = path.join(dir, 'sync.json');
  assert.deepEqual(readProgress(file), { offset: 0 });

  writeProgress(file, { offset: 300, done: 300, batch: 2 });
  assert.deepEqual(readProgress(file), { offset: 300 });
  assert.match(readFileSync(file, 'utf8'), /orange\/media-doc-sync\/1/);

  const broken = path.join(dir, 'broken.json');
  writeFileSync(broken, '{ not json');
  assert.deepEqual(readProgress(broken), { offset: 0 }, '坏文件不能让它假装"已完成"');
});

test('分页靠 offset，不是 media_key：源表是边跑边填的，keyset 会在第一个空档处提前收工', () => {
  /* 真踩到的坑：回填按索引顺序写，写进来的 key 在 media_key 序上是散落的；从最小的 key 往后翻，
     一旦翻过"当前已写的最大 key"就没有下一行，第一次跑只搬了 600 条就停了，而库里还有上万行
     躺在更小的 key 上。offset 分页对"集合仍在长大"的源也成立：多搬的变 noop，漏的由最终一遍补齐。 */
  const source = readFileSync(new URL('./media-doc-sync.mjs', import.meta.url), 'utf8');
  assert.match(source, /limit \$\{take\} offset \$\{offset\}/, '分页必须是 offset');
  assert.equal(/and media_key > /.test(source), false, '不许再用 media_key > lastKey 做 keyset');
});
