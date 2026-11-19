// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// 包检索是客户端唯一的排序实现：没有数据库可退，错了就是搜不出来。所以用小包逐条验。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { toFloat16 } from '../../../scripts/material-vector-pack.mjs';
import { createPackSearch, decodeFloat16, readPack, topScores } from './material-pack.mjs';

/** 一个只含两行、4 维的包，向量手写，方便断言。 */
function tinyPack() {
  const dir = mkdtempSync(join(tmpdir(), 'pack-'));
  const dims = 4;
  const rows = [
    { key: 'a', vector: [1, 0, 0, 0] },
    { key: 'b', vector: [0, 1, 0, 0] },
    { key: 'c', vector: [0.7071, 0.7071, 0, 0] },
  ];
  const buffer = Buffer.alloc(rows.length * dims * 2);
  let at = 0;
  for (const row of rows) for (const value of row.vector) { buffer.writeUInt16LE(toFloat16(value), at); at += 2; }
  const keys = `${rows.map((row) => row.key).join('\n')}\n`;
  writeFileSync(join(dir, 'vectors.f16'), buffer);
  writeFileSync(join(dir, 'keys.txt'), keys);
  writeFileSync(join(dir, 'pack.json'), JSON.stringify({
    version: 'v1', model: 'test', dims, rows: rows.length,
    files: [
      { path: 'vectors.f16', bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') },
      { path: 'keys.txt', bytes: Buffer.byteLength(keys), sha256: createHash('sha256').update(keys).digest('hex') },
    ],
  }));
  return { dir, dims };
}

test('decodeFloat16：与打包脚本的编码器往返一致', () => {
  const buffer = Buffer.alloc(8);
  let at = 0;
  for (const value of [0, 1, -0.5, 0.1]) { buffer.writeUInt16LE(toFloat16(value), at); at += 2; }
  const out = decodeFloat16(buffer, 1, 4);
  assert.equal(out.length, 4);
  assert.ok(Math.abs(out[1] - 1) < 1e-3);
  assert.ok(Math.abs(out[2] + 0.5) < 1e-3);
  assert.ok(Math.abs(out[3] - 0.1) < 1e-3);
});

test('readPack：缺文件、字节数不符、行数不符都是 null（调用方降级，不抛给用户）', () => {
  const { dir, dims } = tinyPack();
  const pack = readPack(dir);
  assert.equal(pack?.dims, dims);
  assert.deepEqual(pack?.keys, ['a', 'b', 'c']);

  assert.equal(readPack(''), null);
  assert.equal(readPack(join(dir, 'nope')), null);

  /* 向量文件被截断：manifest 说的字节数与磁盘不符 */
  const truncated = mkdtempSync(join(tmpdir(), 'pack-trunc-'));
  writeFileSync(join(truncated, 'vectors.f16'), Buffer.alloc(4));
  writeFileSync(join(truncated, 'keys.txt'), 'a\n');
  writeFileSync(join(truncated, 'pack.json'), JSON.stringify({
    version: 'v1', dims: 4, rows: 1,
    files: [{ path: 'vectors.f16', bytes: 8 }, { path: 'keys.txt', bytes: 2 }],
  }));
  assert.equal(readPack(truncated), null);
});

test('createPackSearch：按余弦排序，命中第一名的就是方向最接近的那行', async () => {
  const { dir } = tinyPack();
  const search = createPackSearch({ dir, embed: async () => [1, 0, 0, 0] });
  const answer = await search('随便', { limit: 2 });
  assert.equal(answer?.mode, 'pack');
  assert.deepEqual(answer?.items.map((item) => item.mediaKey), ['a', 'c']);
  assert.ok(answer.items[0].score > answer.items[1].score);
});

test('createPackSearch：allowed 只在给定行里挑（结构化过滤）', async () => {
  const { dir } = tinyPack();
  const search = createPackSearch({ dir, embed: async () => [1, 0, 0, 0] });
  const filtered = await search('随便', { limit: 5, allowed: ['c', 'b'] });
  assert.deepEqual(filtered?.items.map((item) => item.mediaKey), ['c', 'b']);
  const none = await search('随便', { limit: 5, allowed: ['nope'] });
  assert.equal(none?.count, 0, '一个都不许，就老实回空，而不是退回全表');
});

test('createPackSearch：维度不符时给 pack-dims，不静默算出垃圾', async () => {
  const { dir } = tinyPack();
  const search = createPackSearch({ dir, embed: async () => [1, 0, 0] });
  await assert.rejects(() => search('随便'), (error) => error.code === 'pack-dims');
});

test('createPackSearch：包不存在 → null（调用方退到词法/索引）', async () => {
  const search = createPackSearch({ dir: join(tmpdir(), 'no-pack-' + Date.now()), embed: async () => [1] });
  assert.equal(await search('随便'), null);
});

test('topScores：只要头 N 名，顺序正确且不排全表', () => {
  const scores = Float32Array.from([0.1, 0.9, 0.5, 0.7, 0.3]);
  assert.deepEqual(topScores(scores, 2).map((hit) => hit.index), [1, 3]);
  assert.deepEqual(topScores(scores, 3, [0, 2, 4]).map((hit) => hit.index), [2, 4, 0]);
});
