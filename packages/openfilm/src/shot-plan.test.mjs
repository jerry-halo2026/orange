// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// 排片器决定"画面对不对得上声音"，错了整条片子就废。所以每条规则都用构造的例子钉住。
import test from 'node:test';
import assert from 'node:assert/strict';

import { PLAN_DEFAULTS, estimateSpeechSec, planShots } from './shot-plan.mjs';

const candidate = (id, durationSec, kind = 'shot', score = 0.5) => ({ id, durationSec, kind, score });
const speech = (id, durationSec) => ({ id, durationSec, kind: 'speech' });

test('一句一镜：镜头被裁到句子长度，不会把句子拉长', () => {
  const plan = planShots({
    segments: [speech('s1', 2.0), speech('s2', 3.0)],
    candidates: [candidate('m1', 33), candidate('m2', 48)],
  });
  assert.equal(plan.summary.shotCount, 2);
  for (const shot of plan.shots) {
    assert.ok(shot.shownSec >= shot.speed === false || shot.shownSec > 0);
    assert.ok(shot.endSec - shot.startSec > 0, '裁切区间必须有长度');
    assert.equal(shot.speed, 1, '素材够长就用原速');
  }
  /* 每段显示时长 = 句子 + 余量（0.15），这是"对得上"的定义 */
  assert.equal(plan.shots[0].shownSec, 2 + PLAN_DEFAULTS.marginSec);
});

test('长素材从头偏一点起裁，不裁过素材末尾', () => {
  const plan = planShots({ segments: [speech('s1', 3)], candidates: [candidate('m1', 10)] });
  const shot = plan.shots[0];
  assert.ok(shot.startSec >= 0);
  assert.ok(shot.endSec <= 10 + 1e-9, `end ${shot.endSec} 越过素材长度`);
  assert.ok(shot.startSec > 0, '长素材不该总是从第 0 秒起');
});

test('素材都不够长：先慢放兜住，并如实记 slowed', () => {
  /* 需要 3.15s，素材只有 3.0s → 慢放到 0.95 左右就够 */
  const plan = planShots({ segments: [speech('s1', 3)], candidates: [candidate('m1', 3)] });
  const shot = plan.shots[0];
  assert.ok(shot.speed < 1, '需要慢放');
  assert.ok(shot.speed >= PLAN_DEFAULTS.slowestSpeed, '不慢于 0.9');
  assert.ok(plan.problems.some((p) => p.includes('slowed-to')), plan.problems.join(' | '));
});

test('慢放也救不了：报 no-candidate-long-enough，绝不截断句子', () => {
  const plan = planShots({ segments: [speech('s1', 6)], candidates: [candidate('m1', 2)] });
  assert.equal(plan.shots.length, 0);
  assert.ok(plan.problems.some((p) => p.includes('no-candidate-long-enough')));
});

test('同一素材不重复用；池子用尽才复用并记账', () => {
  const plan = planShots({
    segments: [speech('s1', 1), speech('s2', 1)],
    candidates: [candidate('m1', 5), candidate('m2', 5)],
  });
  assert.deepEqual(plan.shots.map((shot) => shot.mediaId), ['m1', 'm2']);
  assert.equal(plan.summary.reused, 0);

  const tight = planShots({ segments: [speech('s1', 1), speech('s2', 1)], candidates: [candidate('m1', 5)] });
  assert.deepEqual(tight.shots.map((shot) => shot.mediaId), ['m1', 'm1']);
  assert.equal(tight.summary.reused, 1);
  assert.ok(tight.problems.some((p) => p.includes('reused-material')));
});

test('空镜只填缝：breath 段挑空镜素材，口播段避开空镜', () => {
  const plan = planShots({
    segments: [speech('s1', 1), { id: 'b1', durationSec: 1, kind: 'breath' }],
    candidates: [candidate('shot1', 5, 'shot'), candidate('broll1', 5, 'broll')],
  });
  const bySegment = Object.fromEntries(plan.shots.map((shot) => [shot.segmentId, shot.mediaId]));
  assert.equal(bySegment.s1, 'shot1', '口播用非空镜');
  assert.equal(bySegment.b1, 'broll1', '空镜段用空镜');
});

test('总时长与目标差超过 0.5s 要说出来', () => {
  const plan = planShots({
    segments: [speech('s1', 2), speech('s2', 2)],
    candidates: [candidate('m1', 10), candidate('m2', 10)],
    targetSec: 10,
  });
  assert.ok(Math.abs(plan.summary.deviationSec ?? 0) > 0.5);
  assert.ok(plan.problems.some((p) => p.startsWith('total ')), plan.problems.join(' | '));
});

test('estimateSpeechSec：中文口播按 4.5 字/秒，标点算停顿', () => {
  assert.equal(estimateSpeechSec(''), 0);
  const short = estimateSpeechSec('小青柑，三年陈。');
  assert.ok(short > 7 / 4.5, '不会少于纯字数的一半时间');
  assert.ok(short < 3, `一句话不该估到 3 秒以上：${short}`);
  const long = estimateSpeechSec('小青柑是广东新会的一味老茶。'.repeat(3));
  assert.ok(long > short);
});
