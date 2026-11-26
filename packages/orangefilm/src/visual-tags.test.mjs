// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// 打标是"静音素材唯一的语义来源"。抽帧位置、三帧合并、可检索文本、模型回答解析，逐条钉住。
import test from 'node:test';
import assert from 'node:assert/strict';

import { TAG_FIELDS, VISUAL_VER, frameTimes, mergeFrameTags, parseTagAnswer, tagText, taggingPrompt, tagsDigest } from './visual-tags.mjs';

test('frameTimes：10/50/90%，并躲开片头片尾 0.3s', () => {
  const long = frameTimes(33);
  assert.deepEqual(long.map((entry) => entry.role), ['head', 'middle', 'tail']);
  assert.deepEqual(long.map((entry) => entry.at), [3.3, 16.5, 29.7]);

  /* 太短的素材（1s）也要给出三个合理位置，且不越界 */
  const short = frameTimes(1);
  for (const entry of short) {
    assert.ok(entry.at >= 0 && entry.at <= 1, `${entry.at} 越界`);
  }
  assert.equal(short.length, 3);

  /* 2s：留 0.3s 边距 → head 0.3、middle 1.0、tail 1.7 */
  assert.deepEqual(frameTimes(2).map((entry) => entry.at), [0.3, 1, 1.7]);

  assert.deepEqual(frameTimes(0), []);
  assert.deepEqual(frameTimes(Number.NaN), []);
});

test('mergeFrameTags：主体取中间帧，人物取并集，场景取众数', () => {
  const merged = mergeFrameTags([
    { subject: '手', action: '拿起', shotSize: '特写', light: '暖光', scene: '桌面', person: true },
    { subject: '小青柑', action: '静态摆放', shotSize: '近景', light: '暖光', scene: '桌面', person: false },
    { subject: '茶汤', action: '倒茶', shotSize: '特写', light: '暖光', scene: '桌面', person: false },
  ]);
  assert.equal(merged.subject, '小青柑', '中间那帧最像代表画面');
  assert.equal(merged.action, '静态摆放');
  assert.equal(merged.scene, '桌面');
  assert.equal(merged.light, '暖光');
  assert.equal(merged.person, true, '有一帧有人就算有人');
});

test('mergeFrameTags：空输入不炸，字段是空串', () => {
  const merged = mergeFrameTags([]);
  assert.deepEqual(merged, { subject: '', action: '', shotSize: '', light: '', scene: '', person: false });
});

test('tagText：顺序稳定，带名字，带有人/无人物', () => {
  const tags = { subject: '小青柑', action: '倒茶', shotSize: '特写', light: '暖光', scene: '桌面', person: true };
  assert.equal(tagText(tags, { name: '展示小青柑1' }), '展示小青柑1 · 小青柑 · 倒茶 · 特写 · 暖光 · 桌面 · 有人物');
  assert.equal(tagText({ ...tags, person: false }), '小青柑 · 倒茶 · 特写 · 暖光 · 桌面 · 无人物');
  assert.equal(tagText({}), '');
});

test('tagsDigest：版本或任一字段变了就变', () => {
  const a = { subject: '小青柑', action: '倒茶', shotSize: '特写', light: '暖光', scene: '桌面', person: true };
  assert.equal(tagsDigest(a), tagsDigest({ ...a }));
  assert.notEqual(tagsDigest(a), tagsDigest({ ...a, action: '开箱' }));
  assert.notEqual(tagsDigest(a), tagsDigest({ ...a, person: false }));
  assert.ok(VISUAL_VER.includes('frame-tag'));
  assert.deepEqual([...TAG_FIELDS], ['subject', 'action', 'shotSize', 'light', 'scene', 'person']);
});

test('parseTagAnswer：容忍代码块与前后废话', () => {
  const answer = '好的，结果如下：\n```json\n{"subject":"茶汤","action":"倒茶","shotSize":"特写","light":"暖光","scene":"桌面","person":false}\n```\n希望有帮助';
  const parsed = parseTagAnswer(answer);
  assert.equal(parsed?.subject, '茶汤');
  assert.equal(parsed?.person, false);
  assert.equal(parseTagAnswer('完全不是 JSON'), null);
  assert.equal(parseTagAnswer(''), null);
});

test('taggingPrompt：要求紧凑 JSON、不要解释', () => {
  const prompt = taggingPrompt();
  assert.match(prompt, /JSON/);
  assert.match(prompt, /不要解释/);
  for (const field of TAG_FIELDS) assert.ok(prompt.includes(field), field);
});
