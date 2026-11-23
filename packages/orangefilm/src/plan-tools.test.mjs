// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// 这是 agent 剪片真正调的那一层：一句话需求 → 可校验的 plan。错了就是"剪不出来还看不出为什么"。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createPlanFromBrief, paceToTarget, verdictOf } from './plan-tools.mjs';

const candidates = [
  { id: 'm1', durationSec: 6, kind: 'shot', score: 0.9, name: '包装_1' },
  { id: 'm2', durationSec: 9, kind: 'shot', score: 0.8, name: '原料_2' },
  { id: 'm3', durationSec: 7, kind: 'shot', score: 0.7, name: '人物_3' },
  { id: 'm4', durationSec: 12, kind: 'shot', score: 0.6, name: '包装_4' },
  { id: 'm5', durationSec: 8, kind: 'shot', score: 0.5, name: '展示_5' },
  { id: 'b1', durationSec: 6, kind: 'broll', score: 0.4, name: '晒场' },
];

const lines = [
  '过完年，饭局有点多',
  '下午那杯是我的开关',
  '新会三年陈，一颗一泡',
  '柑皮先香，茶汤后甜',
  '丈母娘问我：带没带',
];

test('五句话 → 五个镜头、五条字幕，逐句有素材', () => {
  const { plan, report } = createPlanFromBrief({ id: 'xqg', lines, candidates, spec: { targetSec: 0 } });
  assert.equal(plan.shots.length, 5);
  assert.equal(plan.cues.length, 5);
  assert.equal(plan.cues[0].text, lines[0]);
  for (const shot of plan.shots) assert.ok(shot.mediaId, `${shot.segmentId} 没有素材`);
  /* targetSec=0 时不该因为时长被 block；其余七条里"估算时长"是 warn */
  const blocking = report.issues.filter((issue) => issue.level === 'block').map((issue) => issue.code);
  assert.deepEqual(blocking, [], JSON.stringify(report.issues));
});

test('候选不够长：报告里说清楚，不假装成功', () => {
  const { report } = createPlanFromBrief({
    lines: ['这一句话很长很长很长很长很长很长很长很长很长很长很长很长'],
    candidates: [{ id: 'tiny', durationSec: 1.0 }],
    spec: { targetSec: 0 },
  });
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((issue) => issue.code === 'shot-count' || issue.code === 'segment-no-shot'));
});

test('合规：draft 只标注，publish 才阻断（因果句）', () => {
  const bad = ['喝了一个月，裤腰就松了', '下午那杯是我的开关', '新会三年陈，一颗一泡', '柑皮先香', '丈母娘问我：带没带'];
  const draft = createPlanFromBrief({ lines: bad, candidates, spec: { targetSec: 0 }, compliance: 'draft' });
  assert.equal(draft.claims.find((claim) => claim.text.includes('裤腰'))?.ok, true, 'draft 不阻断');
  assert.equal(draft.claims.find((claim) => claim.text.includes('裤腰'))?.blocking, 1);

  const publish = createPlanFromBrief({ lines: bad, candidates, spec: { targetSec: 0 }, compliance: 'publish' });
  assert.equal(publish.plan.compliance.blocking, 1);
  assert.ok(publish.report.issues.some((issue) => issue.code === 'compliance-blocking' && issue.level === 'block'));
  assert.equal(publish.report.ok, false);
});

test('场景标签随句子带出来（办公/送礼各归各）', () => {
  const { claims } = createPlanFromBrief({
    lines: ['下午三点，办公室里泡一颗', '过年送礼给长辈'],
    candidates,
    spec: { targetSec: 0 },
  });
  assert.ok(claims[0].scenes.includes('办公'), JSON.stringify(claims[0].scenes));
  assert.ok(claims[1].scenes.includes('送礼'), JSON.stringify(claims[1].scenes));
});

test('verdictOf：三种结局各说一句人话', () => {
  const ok = { ok: true, issues: [], summary: { totalSec: 15, shotCount: 5 } };
  assert.match(verdictOf(ok), /可以出片：15s \/ 5 个镜头/);
  const blocking = { ok: false, issues: [{ level: 'block', code: 'duration', message: '总时长 12s，目标 15s（差 -3s）' }], summary: { totalSec: 12, shotCount: 5 } };
  assert.match(verdictOf(blocking), /1 处必须改：总时长/);
  const warn = { ok: true, issues: [{ level: 'warn', code: 'audio-estimated', message: 'S1 的时长是估算的' }], summary: { totalSec: 15, shotCount: 5 } };
  assert.match(verdictOf(warn), /可以出片，但 1 处要留意/);
});

test('空输入直接抛，不生成空计划', () => {
  assert.throws(() => createPlanFromBrief({ lines: [], candidates }), /至少给一句文案/);
  assert.throws(() => createPlanFromBrief({ lines, candidates: [] }), /至少给一个素材候选/);
});

test('paceToTarget：差出来的时长先给句间呼吸，再给片尾，最后才报缺口', () => {
  const base = () => ({
    spec: { targetSec: 15, breathSec: 0.2 },
    segments: [
      { id: 'S1', kind: 'speech', text: '一', audioSec: 2.6, estimated: false },
      { id: 'G1', kind: 'breath', text: '', audioSec: 0.2 },
      { id: 'S2', kind: 'speech', text: '二', audioSec: 2.4, estimated: false },
      { id: 'G2', kind: 'breath', text: '', audioSec: 0.2 },
      { id: 'S3', kind: 'speech', text: '三', audioSec: 2.6, estimated: false },
    ],
    shots: [
      { segmentId: 'S1', mediaId: 'm1', startSec: 0, endSec: 3, speed: 1, shownSec: 2.75 },
      { segmentId: 'S2', mediaId: 'm2', startSec: 0, endSec: 3, speed: 1, shownSec: 2.55 },
      { segmentId: 'S3', mediaId: 'm3', startSec: 0, endSec: 3, speed: 1, shownSec: 2.75 },
    ],
  });

  /* 口播 8.05s + 呼吸 0.4s = 8.45s，目标 15s：呼吸补到 0.6 各一次（+0.8），片尾 +1.0，还差 ~4.7s */
  const plan = base();
  const result = paceToTarget(plan, { maxBreathSec: 0.6, tailSec: 1.0 });
  assert.ok(result.addedSec > 1.5, `补了 ${result.addedSec}s`);
  assert.ok(result.shortageSec > 0, '还差的部分要如实报，不硬凑');
  assert.equal(plan.segments[1].audioSec, 0.6, '呼吸补到上限');
  assert.ok(plan.shots[2].shownSec > 2.75, '片尾的镜头多留一口气');

  /* 已经够长：什么都不动 */
  const long = base();
  long.shots = long.shots.map((shot) => ({ ...shot, shownSec: 5 }));
  const untouched = paceToTarget(long);
  assert.equal(untouched.addedSec, 0, '够长就不动');
});

test('paceToTarget：没有目标时长就直说跳过', () => {
  const result = paceToTarget({ spec: { targetSec: 0 }, segments: [], shots: [] });
  assert.match(result.notes[0], /没有目标时长/);
});
