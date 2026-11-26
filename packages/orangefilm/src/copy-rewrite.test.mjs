// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// 改写三式是"命中之后怎么办"的答案。锚点必须跟着走，否则合规但空话。
import test from 'node:test';
import assert from 'node:assert/strict';

import { anchorDetail, rewriteSuggestions, rewriteVerdict, splitClaim } from './copy-rewrite.mjs';

test('splitClaim：把因果句拆成锚点与结论', () => {
  const causal = splitClaim('喝了一个月，裤腰就松了');
  assert.equal(causal.joined, true);
  assert.ok(causal.anchor.includes('喝了一个月') || causal.anchor.includes('喝了一个月，裤腰'));
  assert.ok(causal.claim.includes('松'));

  const plain = splitClaim('下午泡一颗，裤腰松了');
  assert.equal(plain.joined, false);
  assert.match(plain.anchor, /下午泡一颗/);
  assert.match(plain.claim, /裤腰/);

  const noClaim = splitClaim('小青柑一颗一泡');
  assert.equal(noClaim.claim, '');
});

test('anchorDetail：抓数字/产地/人称这类可验证细节', () => {
  assert.equal(anchorDetail('新会三年陈，一颗一泡'), '新会');
  assert.equal(anchorDetail('丈母娘问我带没带'), '丈母娘');
  assert.equal(anchorDetail('喝了一个月'), '一个月');
  assert.equal(anchorDetail('没有细节的一句话'), '');
});

test('三式：并列 / 转述 / 场景，都保留锚点', () => {
  const candidates = rewriteSuggestions('喝了一个月，裤腰就松了', [{ category: 'causal-effect' }]);
  assert.deepEqual(candidates.map((entry) => entry.mode), ['parallel', 'reported', 'scene']);
  assert.ok(candidates.every((entry) => entry.keepsAnchor), JSON.stringify(candidates));
  assert.match(candidates[0].text, /裤腰还是那条裤子|一个月/);
  assert.match(candidates[1].text, /问我/);
  assert.match(candidates[2].text, /回南天/);
});

test('给了细节与场景：候选句用它们，不用占位', () => {
  const candidates = rewriteSuggestions('祛湿效果好', [{ category: 'medical-effect' }], { detail: '新会三年陈', scene: '回南天' });
  assert.match(candidates[0].text, /新会三年陈/);
  assert.match(candidates[2].text, /回南天/);
});

test('没有功效命中时，并列式换成"事实 + 记录"，不必绕成第三方', () => {
  const candidates = rewriteSuggestions('小青柑有点甜，很多人喜欢', [{ category: 'marketing-cliche' }]);
  assert.match(candidates[0].text, /记录我留着|小青柑/);
});

test('rewriteVerdict：候选丢了锚点要明说', () => {
  assert.match(rewriteVerdict(rewriteSuggestions('喝了一个月，裤腰就松了', [])), /可用 \d 式/);
  const fake = [{ mode: 'parallel', label: '并列式', text: '很好', keepsAnchor: false }];
  assert.match(rewriteVerdict(/** @type {any} */ (fake)), /都丢了锚点/);
});
