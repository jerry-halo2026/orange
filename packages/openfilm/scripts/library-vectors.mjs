#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// 元素库的向量：把每件东西"是什么"（passageOf）用**本机那个模型**算成向量，写成 library/vectors.i8（int8）
// 与 library/vectors.json（模型、维度、id 顺序、类别、每行的缩放）。
//
//   node packages/openfilm/scripts/library-vectors.mjs
//   node packages/openfilm/scripts/library-vectors.mjs --model-dir <bge-base-zh-onnx 目录>
//
// # 模型
//
// bge-base-zh-v1.5（768 维，ONNX）。与素材检索**同一个模型**：
//   - 客户端只需要下载一份（`ensureEmbedModel`，112.8 MB）；
//   - 元素与素材在同一个向量空间里，agent 用一句话问两边都成立；
//   - 以前这里是 multilingual-e5-small（384 维）+ 服务端 `/v1/library/search`，两套模型、两份下载、两个空间。
//
// 模型文件不进 git：本机在 `library/models/bge-base-zh-onnx/`，客户端在
// `<shared home>/runtime/models/bge-base-zh-v1.5/`。两者都由 `src/local-embedder.mjs` 找到。
//
// # 为什么 int8
//
// 8 718 条 × 768 维：fp32 是 26.8 MB，int8 是 6.7 MB，而每行按自己的最大绝对值缩放之后，
// 余弦与 fp32 的差在千分之一以内（名次不受影响）。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { builtInRoot, libraryIndex } from '../studio/server/library.mjs';
import { KINDS } from '../src/library-search.mjs';
import { embedder, passageOf } from '../src/library-semantic.mjs';
import { LOCAL_EMBED_DIMS, LOCAL_EMBED_MODEL } from '../src/local-embedder.mjs';
import { vocabulary } from '../src/library-words.mjs';

const argv = process.argv.slice(2);
const modelDirAt = argv.indexOf('--model-dir');
const modelDir = modelDirAt === -1 ? '' : argv[modelDirAt + 1] ?? '';

const root = builtInRoot();
const embed = modelDir ? (await import('../src/local-embedder.mjs')).createLocalEmbedder({ modelDir }) : embedder();
const vocab = vocabulary(root);
const { items, groups } = /** @type {{ items: any[], groups: Record<string, { id: string, name: Record<string, string> }[]> }} */ (libraryIndex());
const cats = new Set(Object.values(KINDS));
const things = items.filter((i) => cats.has(i.cat));

const dims = LOCAL_EMBED_DIMS;
const values = new Int8Array(things.length * dims);
const scales = [];
const started = Date.now();
for (const [n, item] of things.entries()) {
  const v = await embed(passageOf(item, vocab, groups[item.cat]?.find((g) => g.id === item.group)));
  if (v.length !== dims) throw new Error(`模型回了 ${v.length} 维，期望 ${dims}`);
  /* int8，按本行最大绝对值缩放：余弦与 fp32 的差在千分之一以内 */
  const scale = Math.max(...v.map(Math.abs)) / 127;
  for (let k = 0; k < v.length; k++) values[n * dims + k] = Math.round(v[k] / scale);
  scales.push(Number(scale.toPrecision(6)));
  if ((n + 1) % 1000 === 0) console.error(`${n + 1} of ${things.length}`);
}

writeFileSync(join(root, 'vectors.i8'), values);
writeFileSync(join(root, 'vectors.json'), `${JSON.stringify({
  version: 2, model: LOCAL_EMBED_MODEL, dims,
  ids: things.map((i) => i.id), cats: things.map((i) => i.cat), scales,
})}\n`);
const mb = (/** @type {number} */ b) => `${(b / 1e6).toFixed(1)} MB`;
console.log(`${things.length} 条向量，${Math.round((Date.now() - started) / 1000)} s，${mb(values.length)}（int8 × ${dims} 维）`);
console.log(`模型 ${LOCAL_EMBED_MODEL}（不进 git：本机 ${modelDir || 'library/models/bge-base-zh-onnx'} 或客户端 <shared home>/runtime/models/）`);
/* 读回来确认一遍：写坏了要当场知道，而不是等到检索悄悄变差 */
const check = JSON.parse(readFileSync(join(root, 'vectors.json'), 'utf8'));
if (check.ids.length !== things.length || check.dims !== dims) throw new Error('写进 vectors.json 的东西与算出来的不一致');
