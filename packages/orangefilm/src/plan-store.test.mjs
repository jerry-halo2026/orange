// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// 计划物是唯一真相源：写坏一次，后面全都错。所以存取的每条边界都要钉住。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deletePlan, listPlans, planFile, readPlan, safePlanId, writePlan } from './plan-store.mjs';

const project = () => mkdtempSync(join(tmpdir(), 'plan-store-'));

const plan = (id, extra = {}) => ({
  id,
  segments: [{ id: 'S1', kind: 'speech', text: '一句话', audioSec: 2, estimated: false }],
  shots: [{ segmentId: 'S1', mediaId: 'm1', startSec: 0.2, endSec: 2.2, speed: 1, shownSec: 2.2 }],
  ...extra,
});

test('写→读：规范化后原样回来，文件落在 .film/plan', () => {
  const root = project();
  const written = writePlan(root, plan('xqg'));
  assert.equal(written.id, 'xqg');
  assert.equal(written.file, join(root, '.film', 'plan', 'xqg.json'));
  const back = readPlan(root, 'xqg');
  assert.equal(back?.id, 'xqg');
  assert.equal(back?.schema, 'orange/plan/1');
  assert.equal(back?.cues.length, 1, 'cues 由 plan 派生并落盘');
  assert.ok(readFileSync(written.file, 'utf8').includes('orange/plan/1'));
});

test('原子写：写完没有临时文件残留', () => {
  const root = project();
  writePlan(root, plan('a'));
  const listed = listPlans(root);
  assert.deepEqual(listed.map((entry) => entry.id), ['a']);
  assert.equal(listed.some((entry) => entry.id.includes('tmp')), false);
});

test('坏文件 / 不存在 → null，绝不返回半个对象', () => {
  const root = project();
  assert.equal(readPlan(root, 'nope'), null);
  writePlan(root, plan('bad'));
  writeFileSync(planFile(root, 'bad'), '{ not json');
  assert.equal(readPlan(root, 'bad'), null);
});

test('id 不合法就抛：不允许路径穿越', () => {
  const root = project();
  for (const id of ['../evil', '.hidden', 'a/b', '', 'x'.repeat(80)]) {
    assert.equal(safePlanId(id), false, id);
    assert.throws(() => planFile(root, id), /不合法/, id);
  }
  assert.equal(safePlanId('xqg-15s_v2'), true);
});

test('listPlans：按修改时间倒序，删掉就没了', () => {
  const root = project();
  writePlan(root, plan('one'));
  writePlan(root, plan('two'));
  assert.equal(listPlans(root).length, 2);
  deletePlan(root, 'one');
  assert.deepEqual(listPlans(root).map((entry) => entry.id), ['two']);
  deletePlan(root, 'one'); // 再删一次不报错
});
