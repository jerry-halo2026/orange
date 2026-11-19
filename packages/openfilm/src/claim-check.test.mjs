// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// 合规检查错了的代价是违规下架，所以用真实案例里的原句钉住每一条规则。
import test from 'node:test';
import assert from 'node:assert/strict';

import { checkClaims, sceneTags } from './claim-check.mjs';

const ids = (/** @type {string} */ text) => checkClaims(text).hits.map((hit) => hit.ruleId);

test('茶叶素材提"二甲双胍"——抖音点名的违规案例，必须 block', () => {
  const result = checkClaims('我爸血糖高，我让他别喝二甲双胍了，改喝这个茶');
  assert.equal(result.ok, false);
  assert.ok(result.hits.some((hit) => hit.ruleId === 'disease-hint' && hit.severity === 'block'));
});

test('功效词：祛湿 / 助消化 / 增强免疫力 / 减肥 都是 block', () => {
  for (const line of ['这款茶祛湿特别快', '吃完喝一杯助消化', '每天喝增强免疫力', '坚持喝能减肥']) {
    const result = checkClaims(line);
    assert.equal(result.ok, false, line);
    assert.ok(result.hits.some((hit) => hit.ruleId === 'medical-effect'), line);
  }
});

test('绝对化用语 block，并给出"用凭证换绝对化"的改写方向', () => {
  const result = checkClaims('这是全网销量第一的小青柑');
  assert.equal(result.ok, false);
  const hit = result.hits.find((entry) => entry.ruleId === 'absolute');
  assert.ok(hit);
  assert.match(hit.rewrite, /凭证|截图|主观/);
});

test('黑五类暗示：不说"减肥"但说"穿小一码"，同样被拦', () => {
  const result = checkClaims('这个冬天悄悄安排上，过年惊艳所有人，肚子小了一圈');
  assert.equal(result.ok, false);
  assert.ok(result.hits.some((hit) => hit.ruleId === 'koc-black-five'));
});

test('时间承诺与稀缺是 warn，不是 block（能发，但要改）', () => {
  const time = checkClaims('喝七天就见效');
  assert.ok(time.hits.some((hit) => hit.ruleId === 'time-promise' && hit.severity === 'warn'));
  const scarce = checkClaims('仅此一天，最后 20 件');
  assert.ok(scarce.hits.some((hit) => hit.ruleId === 'price-fake' && hit.severity === 'warn'));
});

test('干净的一句话：ok 为真，场景标签也认得出', () => {
  const line = '下午三点，办公室里泡一杯小青柑，柑皮的苦味先上来，回甘在后面';
  const result = checkClaims(line);
  assert.equal(result.ok, true, JSON.stringify(result.hits));
  assert.equal(result.hits.length, 0);
  const tags = sceneTags(line);
  assert.ok(tags.includes('办公'), tags.join(','));
  assert.ok(tags.includes('爱茶'), tags.join(','));
});

test('同一段里多个命中都列出来，带着上下文', () => {
  const result = checkClaims('家人们冲！这是最高级的小青柑，喝三天祛湿');
  assert.equal(result.ok, false);
  const rules = new Set(result.hits.map((hit) => hit.ruleId));
  assert.ok(rules.has('marketing-cliche'));
  assert.ok(rules.has('absolute'));
  assert.ok(rules.has('medical-effect'));
  for (const hit of result.hits) assert.ok(hit.context.length > 0);
});

test('sceneTags：说不清给谁看的文案，一个标签都没有', () => {
  assert.deepEqual(sceneTags('小青柑茶'), []);
  assert.ok(sceneTags('过年送礼给长辈').includes('送礼'));
  assert.ok(sceneTags('一个人窝在沙发上追剧').includes('独处'));
});

test('因果暗示功效：不写"减肥"，写"喝了一个月，裤子松了"，同样 block', () => {
  const cases = [
    '喝了一个月，裤腰就松了',
    '坚持喝，所以现在穿衣服都不一样了',
    '喝完之后肚子不胀了',
    '因为它，我的皮肤变好了',
    '一喝就顺',
  ];
  for (const line of cases) {
    const result = checkClaims(line);
    assert.equal(result.ok, false, line);
    assert.ok(result.hits.some((hit) => hit.ruleId === 'causal-effect'), `${line} → ${result.hits.map((h) => h.ruleId).join(',')}`);
  }
});

test('并列陈述不触发因果：事实 + 体感分开说', () => {
  for (const line of ['我下午泡一颗，胃里暖暖的', '早上先喝一杯，然后去上班']) {
    const result = checkClaims(line);
    assert.ok(!result.hits.some((hit) => hit.ruleId === 'causal-effect'), `${line} → ${result.hits.map((h) => h.ruleId).join(',')}`);
  }
});

test('千川/广告法：诱导点击、联系方式、效果保证、虚假价格', () => {
  const cases = [
    ['点击下方链接，立刻下单', 'ad-solicit'],
    ['加我微信领试喝装', 'ad-solicit'],
    ['扫码进群有福利', 'ad-solicit'],
    ['无效退款，不满意全额', 'ad-guarantee'],
    ['全网最低价，赔本冲量', 'ad-price-claim'],
  ];
  for (const [line, rule] of cases) {
    const result = checkClaims(line);
    assert.equal(result.ok, false, line);
    assert.ok(result.hits.some((hit) => hit.ruleId === rule), `${line} → ${result.hits.map((h) => h.ruleId).join(',')}`);
  }
});

test('千川素材的正常台词不受影响', () => {
  for (const line of ['新会三年陈，一颗一泡', '下午那杯是我的开关', '这一批是去年晒的，量就这些']) {
    assert.equal(checkClaims(line, { mode: 'publish' }).ok, true, line);
  }
});
