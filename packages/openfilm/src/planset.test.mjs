// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// 展开器决定"100 条从哪来、彼此差在哪"。确定性、去重、池子配额，每条都要钉住。
import test from 'node:test';
import assert from 'node:assert/strict';

import { expandPlans, variantToBrief } from './planset.mjs';

const base = () => ({
  id: 'youqi',
  copy: [
    { id: 'A', lines: ['开箱那一下', '我就知道选对了'] },
    { id: 'B', lines: ['过完年饭局多', '下午那杯是我的开关'] },
  ],
  voices: [{ id: 'v1', provider: 'qwen', voice: 'Cherry' }, { id: 'v2', provider: 'minimax', voice: 'female' }],
  pools: [
    { id: 'main', fills: ['S1', 'S2'], items: ['m1', 'm2', 'm3', 'm4'] },
    { id: 'broll', fills: ['S3'], items: ['b1', 'b2'], kind: 'broll' },
  ],
  bgm: { pool: ['bgmA', 'bgmB'] },
  expand: 4,
});

test('展开 4 条：take 轮转，素材按池轮转，BGM 相邻不同', () => {
  const { variants, report } = expandPlans(base());
  assert.equal(variants.length, 4);
  assert.equal(report.takes, 4, '2 条文案 × 2 个音色 = 4 个 take');
  const takes = variants.map((variant) => `${variant.copyId}/${variant.voiceId}`);
  assert.equal(new Set(takes).size, 4, '四条各用一个 take（说法先散开）');
  for (let i = 1; i < variants.length; i += 1) {
    assert.notEqual(variants[i].bgm, variants[i - 1].bgm, `第 ${i + 1} 条 BGM 与上一条相同`);
  }
  for (const variant of variants) {
    assert.ok(variant.media.S1 && variant.media.S2 && variant.media.S3, '每个位都分到素材');
    assert.equal(Object.keys(variant.media).length, 3);
  }
});

test('同一条 planset 两次展开结果完全一致（可复现）', () => {
  const a = expandPlans(base());
  const b = expandPlans(base());
  assert.deepEqual(a.variants.map((v) => [v.id, v.copyId, v.voiceId, v.media, v.bgm]), b.variants.map((v) => [v.id, v.copyId, v.voiceId, v.media, v.bgm]));
});

test('池子不够：跨条不重复用尽后如实报 shortage，不静默重复', () => {
  const planset = base();
  planset.expand = 8;                      // 8 条 × 2 位 = 16 个镜头位，main 池只有 4 条
  planset.dedupe = { material: { acrossPlans: 'no-repeat', fallbackMaxReuse: 2 } };
  const { report } = expandPlans(planset);
  assert.ok(report.shortages.some((line) => line.includes('只有 4 条')), report.shortages.join(' | '));
  assert.ok(report.shortages.some((line) => line.includes('用满')), report.shortages.join(' | '));
});

test('说法不够：take 用完就停，并说清要加文案', () => {
  const planset = base();
  planset.expand = 100;
  planset.dedupe = { take: { maxPlansPerTake: 2 } };
  const { variants, report } = expandPlans(planset);
  assert.equal(variants.length, 8, '4 个 take × 每条最多 2 = 8 条');
  assert.ok(report.shortages.some((line) => line.includes('请加文案')), report.shortages.join(' | '));
});

test('没有 pools：仍然产出变体（素材留给后续检索），不报错', () => {
  const planset = base();
  delete planset.pools;
  const { variants } = expandPlans(planset);
  assert.equal(variants.length, 4);
  assert.deepEqual(variants[0].media, {});
});

test('variantToBrief：按位次把素材排成候选，缺的交给排片器报错', () => {
  const candidates = [
    { id: 'b1', durationSec: 4, kind: 'broll' },
    { id: 'm1', durationSec: 8, kind: 'shot' },
    { id: 'm2', durationSec: 6, kind: 'shot' },
  ];
  const brief = variantToBrief(
    { id: 'x-001', lines: ['一', '二'], media: { S1: 'm1', S2: 'm2', S3: 'b1' }, voice: null, bgm: null },
    { candidates, spec: { targetSec: 15 } },
  );
  assert.equal(brief.id, 'x-001');
  /* 素材挂到对应那句上（不是整池交给排片器重新挑） */
  /* 两句台词 → 前两个位（S1、S2）挂上素材；多出来的 S3 没有句子可挂，留给后续补 */
  assert.deepEqual(brief.lines.map((line) => (typeof line === 'string' ? null : line.mediaId)), ['m1', 'm2']);
  assert.ok(brief.candidates.length >= 3, '候选池仍在（撑不住时排片器还有得选）');
  assert.equal(brief.compliance, 'publish');
  assert.equal(brief.spec.targetSec, 15);
});

test('空文案直接抛：展开一个没有说法的计划没有意义', () => {
  assert.throws(() => expandPlans({ id: 'x', copy: [], expand: 3 }), /文案/);
});
