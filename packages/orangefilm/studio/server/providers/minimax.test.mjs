// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * MiniMax: `tts`, `asr`, `music`. The stub `fetch` pins the three shapes that matter — hex audio (not base64),
 * `data.status` meaning finished-or-not, and a music refusal that is a 200 with a sentence inside it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import minimax, { audioOf, statusOf } from './minimax.mjs';

const ctx = (bytes = new Uint8Array([1, 2, 3])) => /** @type {any} */ ({
  key: 'group-1:abcdefghijklmnopqrstuvwxyz', root: '/p', signal: new AbortController().signal, say() {}, read: async () => bytes,
});

test('minimax 说的三件事：tts / asr / music', () => {
  assert.deepEqual([...minimax.verbs].sort(), ['asr', 'music', 'tts']);
  assert.equal(minimax.models?.tts?.[0]?.id, 'speech-2.8-hd');
  assert.equal(minimax.models?.music?.[0]?.id, 'music-3.0');
  assert.throws(() => minimax.checkKey('short'), /16/);
  assert.doesNotThrow(() => minimax.checkKey('group-1:abcdefghijklmnopqrstuvwxyz'));
});

test('audioOf：hex 与 url 都认；都不是就带出服务端那句话', () => {
  assert.deepEqual(audioOf({ data: { audio: '00ff10' } }), { hex: '00ff10' });
  assert.deepEqual(audioOf({ data: { url: 'https://x/a.mp3' } }), { url: 'https://x/a.mp3' });
  assert.throws(() => audioOf({ base_resp: { status_msg: 'music model retired' } }), /music model retired/);
});

test('statusOf：2 完成、1 未完成，其它一律当失败（不能当成"没声音但成功"）', () => {
  assert.equal(statusOf({ data: { status: 2 } }), 2);
  assert.equal(statusOf({ data: { status: 1 } }), 1);
  assert.equal(statusOf({ data: {} }), 2);
  assert.throws(() => statusOf({ data: { status: 9 } }), /status 9/);
});

test('tts：hex 解码落盘，groupId 走 header，文件落在 assets/audio/vo/', async () => {
  let seen = /** @type {any} */ (null);
  const saved = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async (url, init) => {
    seen = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
    return { ok: true, status: 200, json: async () => ({ data: { audio: '0011ff', status: 2 } }) };
  });
  try {
    const result = await minimax.run('tts', { text: '三十秒口播', voice: 'female-shaonv', out: 'v' }, ctx());
    assert.match(seen.url, /\/v1\/t2a_v2$/);
    assert.equal(seen.headers['group-id'], 'group-1', '老账号的 groupId 必须带上');
    assert.equal(seen.headers.authorization, 'Bearer abcdefghijklmnopqrstuvwxyz', '密钥不该含 groupId 前缀');
    assert.equal(seen.body.voice_setting.voice_id, 'female-shaonv');
    assert.deepEqual([...result.files[0].bytes], [0x00, 0x11, 0xff], 'hex 解码，不是 base64');
    assert.equal(result.files[0].path, 'assets/audio/vo/v.mp3', '--out 是名字，落盘由 landing 决定');
    assert.equal(result.index[0].src, 'assets/audio/vo/v.mp3', 'src 指项目内，不指项目外');
    assert.ok(result.index[0].src.startsWith('assets/audio/vo/'));
    assert.equal(result.index[0].voice, 'female-shaonv');
    assert.deepEqual(
      { model: result.receipt.model, voice: result.receipt.voice, seconds: result.receipt.seconds },
      { model: 'speech-2.8-hd', voice: 'female-shaonv', seconds: 30 },
      '回执保留 model/voice/seconds',
    );
  } finally {
    globalThis.fetch = saved;
  }
});

test('tts：--out 给成路径时当场说清（不静默写到项目外）', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async () => ({ ok: true, status: 200, json: async () => ({ data: { audio: '0011', status: 2 } }) }));
  try {
    await assert.rejects(() => minimax.run('tts', { text: 'x', voice: 'female-shaonv', out: 'assets/v.mp3' }, ctx()), /--out is a name/);
  } finally {
    globalThis.fetch = saved;
  }
});

test('asr：verbose_json 的分段变 words', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async () => ({
    ok: true, status: 200,
    json: async () => ({ text: '小青柑的功效', segments: [{ start: 0, end: 1.2, text: '小青柑' }, { start: 1.2, end: 2.4, text: '的功效' }] }),
  }));
  try {
    const result = await minimax.run('asr', { src: 'assets/v.mp3' }, ctx());
    assert.equal(result.index[0].text, '小青柑的功效');
    assert.equal(result.index[0].words.length, 2);
    assert.deepEqual(result.index[0].words[0], { token: '小青柑', start: 0, end: 1.2 });
  } finally {
    globalThis.fetch = saved;
  }
});

test('音乐：服务端用 200 说"已退役"时，报出它自己的话，不生成空文件', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async () => ({
    ok: true, status: 200, json: async () => ({ base_resp: { status_code: 2054, status_msg: 'music model is retired for new accounts' } }),
  }));
  try {
    await assert.rejects(() => minimax.run('music', { prompt: '温柔的钢琴', sec: 30 }, ctx()), /retired for new accounts.*Not retried/s);
  } finally {
    globalThis.fetch = saved;
  }
});

test('音乐：hex 也经 landing 落到 assets/audio/music/，src 不指项目外', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async () => ({ ok: true, status: 200, json: async () => ({ data: { audio: '00ff', status: 2 } }) }));
  try {
    const result = await minimax.run('music', { prompt: '温柔的钢琴', sec: 30, out: 'bed' }, ctx());
    assert.equal(result.files[0].path, 'assets/audio/music/bed.mp3');
    assert.equal(result.index[0].src, 'assets/audio/music/bed.mp3');
    assert.equal(result.receipt.model, 'music-3.0');
  } finally {
    globalThis.fetch = saved;
  }
});
