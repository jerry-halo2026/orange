// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * `scripts/media-daily.mjs` —— 增量四步的编排器。不连库：只钉参数、步骤表与结果解析。
 *
 * 这一层的价值是"资源纪律"：并发上限、单次条数上限、云端推送默认关闭。
 * 所以测的是这些约束会不会被参数绕过，而不是"函数被调用了"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { defaultOptions, parseArgs, readOffset, steps, summarize } from './media-daily.mjs';

test('默认就是"轻"的：上限 2000、并发 2、不推云端', () => {
  const options = defaultOptions();
  assert.equal(options.limit, 2000);
  assert.equal(options.concurrency, 2);
  assert.equal(options.cloud, false);
  assert.equal(options.dryRun, false);
});

test('parseArgs：并发上限 4、limit 必须为正，--help 返回 null', () => {
  assert.equal(parseArgs(['--help']), null);
  assert.throws(() => parseArgs(['--concurrency', '8']), /--concurrency/);
  assert.throws(() => parseArgs(['--limit', '0']), /--limit/);
  const parsed = parseArgs(['--limit=500', '--only', 'embed']);
  assert.equal(parsed.limit, 500);
  assert.equal(parsed.only, 'embed');
  /* --cloud 已停用：参数仍然认，但明确关掉，不让脚本以为"推过了" */
  assert.equal(parseArgs(['--cloud']).cloud, false);
  assert.equal(parseArgs(['--pack']).pack, true);
});

test('四步的顺序固定：scan → embed → levels → push', () => {
  const plan = steps({ ...defaultOptions(), indexFile: 'x' });
  assert.deepEqual(plan.map((step) => step.key), ['scan', 'embed', 'levels', 'push']);
});

test('embed 那一步走客户端同一条 ONNX 管线：768 维、CLS、pending、写 embedding', () => {
  const plan = steps({ ...defaultOptions(), limit: 500, analyzerVer: 'card-meta-2', tenant: 'tenant-a' });
  const embed = plan.find((step) => step.key === 'embed');
  const args = embed.command[1];
  assert.ok(args.includes('--pending'), '只补还没有向量的行');
  assert.equal(args[args.indexOf('--dims') + 1], '768', 'bge-base-zh 原生 768 维，不截断');
  assert.equal(args[args.indexOf('--pooling') + 1], 'cls', 'BERT 系取 CLS，不是 e5 的 mean');
  assert.equal(args[args.indexOf('--write-column') + 1], 'embedding');
  assert.equal(args[args.indexOf('--corpus-limit') + 1], '500');
  assert.match(args.join(' '), /bge-base-zh-onnx/, '用的是客户端分发的那个模型');
});

test('push 现在是打向量包：默认不跑，--pack 才跑', () => {
  assert.equal(steps(defaultOptions()).find((step) => step.key === 'push').when(), false);
  const packed = steps({ ...defaultOptions(), pack: true });
  const push = packed.find((step) => step.key === 'push');
  assert.equal(push.when(), true);
  assert.match(push.command[1].join(' '), /material-vector-pack/, '云端推送换成了打客户端分发的包');
});

test('summarize 从各步的汇总里抠出数字，抠不到就给破折号', () => {
  /* 真实格式来自 material-doc-index 的汇总行：written / unchanged / changed / noop / fail */
  assert.match(summarize('embed', 'written=12 unchanged=3 changed=12 noop=0 fail=0'), /written=12 noop=0 fail=0/);
  assert.match(summarize('levels', '完成：168 批，实际更新 0 行（其余是值本来就对的），耗时 42s'), /更新 0 行/);
  assert.match(summarize('push', '同步结束：300 条，written=300'), /推送 300 条/);
  assert.equal(summarize('scan', 'whatever'), '—');
  assert.equal(summarize('embed', '没有可解析的行'), '—', '抠不到就如实给破折号，不编数字');
});

test('readOffset 读不到/坏文件都返回 null（不能假装"已完成"）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orange-daily-'));
  assert.equal(readOffset(path.join(dir, 'nope.json')), null);
  const broken = path.join(dir, 'broken.json');
  writeFileSync(broken, '{ not json');
  assert.equal(readOffset(broken), null);
  const good = path.join(dir, 'good.json');
  writeFileSync(good, JSON.stringify({ offset: 4200 }));
  assert.equal(readOffset(good), 4200);
});
