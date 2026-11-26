// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * 元素库检索现在是**本机**做的（bge-base-zh-v1.5 + 本地向量包），不再问云端 `/v1/library/search`。
 *
 * 这一份测试因此重写：老版本起了一个假服务、断言"请求发了什么"——那测的是一个已经不存在的行为。
 * 新测试盯住现在真正要保证的两件事：
 *   1. 本机没有模型/向量时**降级成关键词**，不报错、不发网络请求；
 *   2. 即便环境里配了云端地址，也不会去问（本地优先是设计，不是巧合）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ORANGE_HOME = mkdtempSync(join(tmpdir(), 'semantic-home-'));
/* 指向一个不存在的服务：如果实现偷偷去问，这里会立刻失败（而不是等 2.5s 超时） */
process.env.ORANGE_API_URL = 'http://127.0.0.1:9';

const { nearest, passageOf } = await import('./library-semantic.mjs');
const { packVocabulary, readPacked, readVocabulary, tokenize } = await import('./sentence-model.mjs');

test('a text is cut into the vocabulary\'s pieces whose scores add up highest, between <s> and </s>', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'semantic-vocab-')), 'tokenizer.json');
  const vocab = [['<s>', 0], ['<pad>', 0], ['</s>', 0], ['<unk>', 0], ['▁', -3], ['▁cal', -6], ['m', -4], ['▁calm', -5], ['▁pi', -6], ['ano', -6], ['▁piano', -7], ['p', -9], ['i', -9], ['a', -9], ['n', -9], ['o', -9], ['▁p', -8], ['c', -9], ['l', -9], ['钢琴', -6], ['▁钢', -7]];
  writeFileSync(file, JSON.stringify({ model: { vocab } }));
  const v = readVocabulary(file);
  const id = (piece) => vocab.findIndex(([p]) => p === piece);
  assert.deepEqual(tokenize(v, 'calm piano'), [0, id('▁calm'), id('▁piano'), 2], 'whole words beat their parts');
  assert.deepEqual(tokenize(v, '  calm\tpiano  '), [0, id('▁calm'), id('▁piano'), 2], 'spaces as one');
  assert.deepEqual(tokenize(v, 'ｃａｌｍ'), [0, id('▁calm'), 2], 'NFKC: full-width letters are letters');
  assert.deepEqual(tokenize(v, 'calmx'), [0, id('▁calm'), 3, 2], 'a character no piece has is <unk>');
  assert.deepEqual(tokenize(v, '钢琴'), [0, id('▁'), id('钢琴'), 2]);
  assert.equal(tokenize(v, 'calm '.repeat(600)).length, 512, 'at most 512');
  /* packed, it finds every piece the JSON does, and nothing else */
  const packed = readPacked(packVocabulary(file));
  for (const [piece] of [...vocab, ['ca'], ['▁calmer'], ['钢'], ['']]) assert.equal(packed.id(piece), v.id(piece), piece);
  assert.deepEqual([packed.longest, packed.unknown, [...packed.scores]], [v.longest, Math.fround(v.unknown), [...v.scores]]);
  for (const text of ['calm piano', 'calmx 钢琴', 'ｃａｌｍ']) assert.deepEqual(tokenize(packed, text), tokenize(v, text));
});

test('what a thing is, in the words of its vector: names, about, group, tags in English and Chinese, energy, tempo', () => {
  const vocab = { byId: new Map([['calm', { name: { en: 'Calm', 'zh-CN': '平静' } }], ['piano', { name: { en: 'Piano', 'zh-CN': '钢琴' } }]]) };
  const passage = passageOf({ cat: 'music', group: 'calm', name: { en: 'Quiet morning piano', 'zh-CN': '清晨安静钢琴' }, tags: ['calm', 'piano', 'gone'], energy: 1, bpm: 72 },
    vocab, { name: { en: 'Calm' } });
  assert.equal(passage, 'passage: music: Quiet morning piano (清晨安静钢琴). Calm. Calm, Piano. 平静，钢琴. very calm, 72 bpm');
});

test('本机向量就是答案：不问云端，返回排好序的本地结果', async () => {
  /* ORANGE_API_URL 指向一个不存在的端口：如果实现偷偷去问，这里会超时失败而不是通过 */
  const answer = await nearest('a bright bell', 'sound', 20);
  assert.ok(Array.isArray(answer), '本地有向量包就该给出结果');
  assert.ok(answer.length > 0 && answer.length <= 20);
  const [firstPath, firstScore] = answer[0];
  assert.ok(firstPath.startsWith('audio/sfx/'), firstPath);
  assert.match(firstPath, /bell/, '问的是钟声，至少头部要真的沾边');
  for (let index = 1; index < answer.length; index += 1) {
    assert.ok(answer[index][1] <= firstScore, '按分数降序');
  }
});

test('Settings → Services 关掉库检索：不查，交回关键词', async () => {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(String(process.env.ORANGE_HOME), 'providers.json'), JSON.stringify({ libraryOff: true }), { mode: 0o600 });
  assert.equal(await nearest('a bright bell', 'sound', 20), null);
});
