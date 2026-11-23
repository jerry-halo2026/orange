// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * Qwen (DashScope): `tts` makes a file, `asr` makes a transcript. No network here: `fetch` is a stub, so what is pinned
 * is the shape of what goes out and what comes back — a wrong field name would otherwise only show up as a 400 from a
 * person's paid key.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import qwen, { audioOf, transcriptOf } from './qwen.mjs';

/** A `RunContext` whose `read` answers fixed bytes. */
const ctx = (bytes = new Uint8Array([1, 2, 3])) => /** @type {any} */ ({
  key: 'sk-test', root: '/p', signal: new AbortController().signal, say() {}, read: async () => bytes,
});

test('qwen 只说两种话：tts 与 asr', () => {
  assert.deepEqual([...qwen.verbs].sort(), ['asr', 'tts', 'voice']);
  assert.equal(qwen.models?.tts?.[0]?.id, 'qwen3-tts-flash');
  assert.equal(qwen.models?.asr?.[0]?.id, 'qwen3-asr-flash');
  assert.throws(() => qwen.checkKey('ofk_x'), /sk-/);
});

test('audioOf：url 与 base64 两种形态都要认，都没有就说人话', () => {
  assert.deepEqual(audioOf({ output: { audio: { url: 'https://x/a.mp3' } } }), { url: 'https://x/a.mp3' });
  assert.deepEqual(audioOf({ output: { audio: { data: 'AAA' } } }), { base64: 'AAA' });
  assert.throws(() => audioOf({ output: {}, message: 'nope' }), /no audio: nope/);
});

test('transcriptOf：有词级时间戳就带，没有就只给文本（不编时间）', () => {
  assert.deepEqual(transcriptOf({ output: { choices: [{ message: { content: '你好' } }] } }), { text: '你好' });
  assert.deepEqual(
    transcriptOf({ output: { choices: [{ message: { content: [{ text: '你好', words: [{ text: '你', start_time: 0, end_time: 200 }] }] } }] } }),
    { text: '你好', words: [{ token: '你', start: 0, end: 0.2 }] },
  );
  assert.throws(() => transcriptOf({ output: { choices: [] } }), /no transcript/);
});

test('tts：把句子和音色发出去，把下载到的音频落成 assets/audio/vo/ 里的文件', async () => {
  const sent = [];
  const fetchImpl = async (/** @type {any} */ url, /** @type {any} */ init) => {
    sent.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    if (String(url).endsWith('/generation')) {
      return { ok: true, status: 200, json: async () => ({ output: { audio: { url: 'https://cdn/a.mp3' } } }) };
    }
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([9, 9]).buffer };
  };
  const saved = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (fetchImpl);
  try {
    const result = await qwen.run('tts', { text: '小青柑 三十秒口播', voice: 'Cherry', out: 'v' }, ctx());
    assert.equal(sent[0].body.model, 'qwen3-tts-flash');
    assert.deepEqual(sent[0].body.input, { text: '小青柑 三十秒口播', voice: 'Cherry' });
    assert.equal(result.files[0].path, 'assets/audio/vo/v.mp3', '--out 是名字，落盘由 landing 决定');
    assert.equal(result.files[0].bytes.length, 2);
    assert.equal(result.index[0].src, 'assets/audio/vo/v.mp3', 'src 指项目内，不指项目外');
    assert.ok(result.index[0].src.startsWith('assets/audio/vo/'));
    assert.equal(result.index[0].voice, 'Cherry');
    assert.deepEqual(result.receipt, { voice: 'Cherry', model: 'qwen3-tts-flash' });
  } finally {
    globalThis.fetch = saved;
  }
});

test('tts：--out 给成路径时当场说清（不静默写到项目外）', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async () => ({ ok: true, status: 200, json: async () => ({ output: { audio: { data: 'AAA' } } }) }));
  try {
    await assert.rejects(() => qwen.run('tts', { text: 'x', voice: 'Cherry', out: 'assets/v.mp3' }, ctx()), /--out is a name/);
  } finally {
    globalThis.fetch = saved;
  }
});

test('asr：录音按 data URL 发出去，回执带文本与词数', async () => {
  let sent = /** @type {any} */ (null);
  const saved = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async (url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ output: { choices: [{ message: { content: '小青柑的功效' } }] } }) };
  });
  try {
    const result = await qwen.run('asr', { src: 'assets/v.mp3' }, ctx());
    assert.equal(sent.model, 'qwen3-asr-flash');
    assert.match(sent.input.messages[0].content[0].audio, /^data:audio\/mpeg;base64,/);
    assert.equal(result.index[0].text, '小青柑的功效');
    assert.equal(result.receipt.words, 0, '没有时间戳就是 0 个词，不假造');
  } finally {
    globalThis.fetch = saved;
  }
});

test('401 说清是区域问题（北京 key 打新加坡端点）', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async () => ({ ok: false, status: 401, text: async () => 'bad key' }));
  try {
    await assert.rejects(() => qwen.run('tts', { text: 'x' }, ctx()), /401.*OPENFILM_QWEN_URL/s);
  } finally {
    globalThis.fetch = saved;
  }
});
