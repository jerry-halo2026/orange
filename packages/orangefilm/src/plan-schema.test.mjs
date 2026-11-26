// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// plan 是整条流水线的唯一真相源：字段错、校验错，后面全错。用构造的例子钉住七条规则。
import test from 'node:test';
import assert from 'node:assert/strict';

import { PLAN_SCHEMA, cuesFromPlan, defaultSpec, normalisePlan, validatePlan } from './plan-schema.mjs';

/** 一条"全绿"的 15s 五镜计划：5 句各 2.8s + 两个呼吸 0.5s ≈ 15s */
function goodPlan() {
  const segments = [
    { id: 'S1', kind: 'speech', text: '过完年，饭局有点多', audioSec: 2.6, estimated: false },
    { id: 'B1', kind: 'breath', audioSec: 0.7 },
    { id: 'S2', kind: 'speech', text: '下午那杯是我的开关', audioSec: 2.4, estimated: false },
    { id: 'S3', kind: 'speech', text: '新会三年陈，一颗一泡', audioSec: 2.6, estimated: false },
    { id: 'B2', kind: 'breath', audioSec: 0.7 },
    { id: 'S4', kind: 'speech', text: '柑皮先香，茶汤后甜', audioSec: 2.4, estimated: false },
    { id: 'S5', kind: 'speech', text: '丈母娘问我：带没带', audioSec: 2.8, estimated: false },
  ];
  /* 只有口播段有镜头；呼吸段是间隙，不占镜头 */
  const places = { S1: 'm1', S2: 'm2', S3: 'm3', S4: 'm4', S5: 'm5' };
  const shots = segments.filter((segment) => segment.kind !== 'breath').map((segment) => ({
    segmentId: segment.id,
    mediaId: places[segment.id],
    startSec: 0.4,
    endSec: 0.4 + segment.audioSec + 0.15,
    speed: 1,
    shownSec: Number((segment.audioSec + 0.15).toFixed(2)),
    kind: 'shot',
  }));
  return { id: 'xqg', segments, shots, compliance: { mode: 'publish', blocking: 0 } };
}

test('normalisePlan：补默认、算 cues、版本固定', () => {
  const plan = normalisePlan(goodPlan());
  assert.equal(plan.schema, PLAN_SCHEMA);
  assert.equal(plan.spec.targetSec, defaultSpec().targetSec);
  assert.equal(plan.cues.length, 5, '五个口播段各一条字幕（呼吸段没有）');
  assert.equal(plan.cues[0].text, '过完年，饭局有点多');
  /* 字幕必须与镜头等长（这是"切点同帧"的数据基础） */
  assert.equal(
    Number((plan.cues[0].endSec - plan.cues[0].startSec).toFixed(2)),
    plan.shots[0].shownSec,
  );
});

test('cuesFromPlan：呼吸段不进字幕，时间仍然连续', () => {
  const plan = normalisePlan(goodPlan());
  const cues = cuesFromPlan(plan);
  assert.equal(cues.length, 5);
  for (let i = 1; i < cues.length; i += 1) {
    assert.ok(cues[i].startSec >= cues[i - 1].endSec, '字幕不能重叠');
  }
});

test('一条合格的计划：七条校验全绿', () => {
  const result = validatePlan(goodPlan());
  const blocking = result.issues.filter((issue) => issue.level === 'block');
  assert.deepEqual(blocking, [], JSON.stringify(result.issues));
  assert.equal(result.summary.shotCount, 5, '五个口播段各一个镜头，呼吸段不占镜头');
  assert.ok(Math.abs(result.summary.deviationSec) <= 0.3, `偏差 ${result.summary.deviationSec}`);
});

test('口播比镜头长 → block（画面先跑完就是对不上）', () => {
  const plan = goodPlan();
  plan.shots[0].shownSec = 1.5;
  const result = validatePlan(plan);
  assert.ok(result.issues.some((issue) => issue.code === 'audio-overruns-shot' && issue.level === 'block'));
});

test('镜头数不足、碎镜、没素材 → block', () => {
  const few = goodPlan();
  few.shots = few.shots.slice(0, 3);
  few.segments = few.segments.slice(0, 3);
  const fewResult = validatePlan(few);
  assert.ok(fewResult.issues.some((issue) => issue.code === 'shot-count'));

  const tiny = goodPlan();
  tiny.shots[0].shownSec = 0.6;
  assert.ok(validatePlan(tiny).issues.some((issue) => issue.code === 'shot-too-short'));

  const empty = goodPlan();
  empty.shots[2].mediaId = '';
  assert.ok(validatePlan(empty).issues.some((issue) => issue.code === 'shot-no-media'));
});

test('时长偏差超过 0.3s → block', () => {
  const plan = goodPlan();
  plan.shots[0].shownSec += 1.2;
  const result = validatePlan(plan);
  assert.ok(result.issues.some((issue) => issue.code === 'duration' && issue.level === 'block'));
});

test('时长是估算的 → warn，不是 block', () => {
  const plan = goodPlan();
  plan.segments[0].estimated = true;
  const result = validatePlan(plan);
  assert.ok(result.issues.some((issue) => issue.code === 'audio-estimated' && issue.level === 'warn'));
  assert.equal(result.ok, true);
});

test('合规还停在 draft / 有 block → 分别 warn 与 block', () => {
  const draft = goodPlan();
  draft.compliance = { mode: 'draft', blocking: 0 };
  assert.ok(validatePlan(draft).issues.some((issue) => issue.code === 'compliance-draft' && issue.level === 'warn'));

  const blocked = goodPlan();
  blocked.compliance = { mode: 'publish', blocking: 2 };
  const result = validatePlan(blocked);
  assert.ok(result.issues.some((issue) => issue.code === 'compliance-blocking' && issue.level === 'block'));
  assert.equal(result.ok, false);
});

test('第一个镜头是空镜 → warn（前 0.4s 没有主体）', () => {
  const plan = goodPlan();
  plan.shots[0].kind = 'broll';
  assert.ok(validatePlan(plan).issues.some((issue) => issue.code === 'first-shot-broll'));
});
