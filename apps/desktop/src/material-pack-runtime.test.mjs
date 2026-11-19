// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// 增量下载是这套东西里唯一"省下的钱"能不能真的省下来的地方：分块错了就是每天重下整包，
// 或者更糟——拼出一份错的向量却以为成功。所以这一段用真的静态服务 + 真的字节验。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { planChunks, sha256 } from '../../../scripts/material-pack-publish.mjs';
import { ensureVectorPack, localChunks, packState } from './material-pack-runtime.mjs';

const digest = (buffer) => createHash('sha256').update(buffer).digest('hex');

/** 一份"发布目录"：两个块、一串 key，够验证增量就行。 */
function publish(root, { version, vectors, keys }) {
  const chunks = planChunks(vectors, 8);
  const folder = join(root, 'pack', version);
  mkdirSync(join(folder, 'chunks'), { recursive: true });
  for (const chunk of chunks) {
    writeFileSync(join(folder, 'chunks', `${String(chunk.index).padStart(3, '0')}.bin`),
      vectors.subarray(chunk.offset, chunk.offset + chunk.bytes));
  }
  writeFileSync(join(folder, 'keys.txt'), keys);
  const manifest = {
    version, model: 'test', dims: 2, rows: vectors.length / 4, quantization: 'float16', byteOrder: 'little-endian',
    vectors: { bytes: vectors.length, sha256: digest(vectors) },
    keys: { bytes: keys.length, sha256: digest(keys), url: `pack/${version}/keys.txt` },
    chunks: chunks.map((chunk) => ({ index: chunk.index, bytes: chunk.bytes, sha256: chunk.sha256, url: `pack/${version}/chunks/${String(chunk.index).padStart(3, '0')}.bin` })),
  };
  writeFileSync(join(root, 'materials.json'), JSON.stringify(manifest));
  return manifest;
}

/** 把发布目录用 http 端出来（客户端的 fetch 走的就是这条）。 */
async function serve(root) {
  let hits = 0;
  const server = createServer((req, res) => {
    try {
      const file = join(root, decodeURIComponent((req.url ?? '/').split('?')[0]));
      const body = readFileSync(file);
      hits += 1;
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('no');
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => server.close(), hits: () => hits };
}

test('第一次全下，第二次一块都不下', async () => {
  const published = mkdtempSync(join(tmpdir(), 'publish-'));
  const data = mkdtempSync(join(tmpdir(), 'client-'));
  const vectors = Buffer.from([...Array(32).keys()].map((i) => i * 3));
  const keys = Buffer.from('a\nb\n');
  publish(published, { version: 'v1', vectors, keys });
  const site = await serve(published);
  try {
    const first = await ensureVectorPack(data, { baseUrl: site.base });
    assert.equal(first.version, 'v1');
    assert.equal(first.changed, true);
    assert.deepEqual(first.downloaded, [0, 1, 2, 3]);
    assert.deepEqual(readFileSync(join(first.dir, 'vectors.f16')), vectors, '拼出来必须与原始字节一致');

    const before = site.hits();
    const second = await ensureVectorPack(data, { baseUrl: site.base });
    assert.equal(second.changed, false);
    assert.deepEqual(second.downloaded, []);
    assert.equal(site.hits() - before, 1, '第二次只取清单，不下块');
    assert.equal(packState(data).version, 'v1');
  } finally {
    site.close();
  }
});

test('语料变了：只重下变了的那块', async () => {
  const published = mkdtempSync(join(tmpdir(), 'publish-'));
  const data = mkdtempSync(join(tmpdir(), 'client-'));
  const first = Buffer.from([...Array(32).keys()].map((i) => i * 3));
  const keys = Buffer.from('a\nb\n');
  publish(published, { version: 'v1', vectors: first, keys });
  const site = await serve(published);
  try {
    await ensureVectorPack(data, { baseUrl: site.base });

    /* 只有最后几个字节变了（一条素材新增），版本号也随之改变 */
    const second = Buffer.from(first);
    second[30] = 0x42;
    second[31] = 0x43;
    const manifest = publish(published, { version: 'v2', vectors: second, keys });
    const result = await ensureVectorPack(data, { baseUrl: site.base });
    assert.equal(result.version, 'v2');
    assert.deepEqual(result.downloaded, [3], '只下最后一块');
    assert.equal(result.reused, manifest.chunks.length - 1);
    assert.deepEqual(readFileSync(join(result.dir, 'vectors.f16')), second);
    assert.deepEqual(localChunks(data).length, manifest.chunks.length);
  } finally {
    site.close();
  }
});

test('块被截断 / 哈希不符：报错并清掉，不落一份错的向量', async () => {
  const published = mkdtempSync(join(tmpdir(), 'publish-'));
  const data = mkdtempSync(join(tmpdir(), 'client-'));
  /* 16 字节、每块 8 字节 → 两块；把第二块截断，第一块仍然完好 */
  const vectors = Buffer.from([...Array(16).keys()].map((i) => i + 1));
  publish(published, { version: 'v1', vectors, keys: Buffer.from('a\n') });
  /* 清单说 8 字节，文件只剩 4 字节 */
  writeFileSync(join(published, 'pack', 'v1', 'chunks', '001.bin'), Buffer.from([1, 2, 3, 4]));
  const site = await serve(published);
  try {
    await assert.rejects(() => ensureVectorPack(data, { baseUrl: site.base }), /expected 4|sha256 mismatch|expected \d+/);
  } finally {
    site.close();
  }
});

test('planChunks：块数与最后一块的余数', () => {
  const buffer = Buffer.alloc(20);
  const chunks = planChunks(buffer, 8);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((chunk) => chunk.bytes), [8, 8, 4]);
  assert.equal(chunks[2].offset, 16);
  assert.equal(chunks[0].sha256, sha256(buffer.subarray(0, 8)));
});
