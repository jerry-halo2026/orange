// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * 配音一步（voice-step）：按内容缓存、一条失败不拖垮整批、限并发 2。
 *
 * 无网络、无真实 key：`run` 是注入的桩，钉住的是"什么时候不再调服务"和"哪一条进了 failed"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CACHE_DIR, cacheKey, normalizeText, synthesizeVoices } from './voice-step.mjs';

/** 一个空项目（有 `.film/`，像 Studio 打开过的那样）。 */
async function project() {
  const root = await mkdtemp(join(tmpdir(), 'voice-step-'));
  await mkdir(join(root, '.film'), { recursive: true });
  return root;
}

/** 一个只回字节的桩：证明"合成"发生了几次、用的什么 `out`。 */
const stub = (/** @type {any[]} */ calls, bytes = [1, 2, 3]) => async (/** @type {any} */ { text, out }) => {
  calls.push({ text, out });
  return { files: [{ path: `assets/audio/vo/${out}.mp3`, bytes: new Uint8Array(bytes) }] };
};

test('同一条文案第二次不再调用 run：命中缓存，文件是同一个', async () => {
  const root = await project();
  const calls = [];
  const ask = { project: root, lines: ['小青柑的一条完整口播'], provider: 'minimax', model: 'speech-2.8-hd', voice: 'female-shaonv' };

  const first = await synthesizeVoices({ ...ask, run: stub(calls) });
  assert.equal(calls.length, 1, '第一次要真的合成');
  assert.equal(first.failed.length, 0);
  assert.equal(first.voices.length, 1);
  assert.equal(first.voices[0].cached, false);
  assert.equal(first.voices[0].text, '小青柑的一条完整口播');
  assert.ok(first.voices[0].file.startsWith(join(root, CACHE_DIR)), '产物在 .film/tts-cache 里');
  assert.ok(existsSync(first.voices[0].file));

  const second = await synthesizeVoices({ ...ask, run: stub(calls) });
  assert.equal(calls.length, 1, '第二次没有调用 run');
  assert.equal(second.voices[0].cached, true);
  assert.equal(second.voices[0].file, first.voices[0].file);
  assert.equal(second.voices[0].key, first.voices[0].key);

  const key = cacheKey({ provider: 'minimax', model: 'speech-2.8-hd', voice: 'female-shaonv', text: '小青柑的一条完整口播' });
  assert.equal(first.voices[0].key, key);
  assert.deepEqual((await readdir(join(root, CACHE_DIR))).sort(), [`${key}.json`, `${key}.mp3`], '音频与记录成对');
  const record = JSON.parse(await readFile(join(root, CACHE_DIR, `${key}.json`), 'utf8'));
  assert.deepEqual(Object.keys(record).sort(), ['createdAt', 'model', 'provider', 'src', 'text', 'voice']);
  assert.equal(record.provider, 'minimax');
  assert.equal(record.model, 'speech-2.8-hd');
  assert.equal(record.voice, 'female-shaonv');
  assert.equal(record.src, `assets/audio/vo/vo-${key.slice(0, 12)}.mp3`);
  assert.ok(Number.isFinite(Date.parse(record.createdAt)), 'createdAt 是时间');
  assert.deepEqual([...(await readFile(first.voices[0].file))], [1, 2, 3], '缓存里就是合成的字节');
});

test('换音色、换模型就是另一条缓存：键与文件都不同', async () => {
  const root = await project();
  const calls = [];
  const base = { project: root, lines: ['同一句话'], provider: 'qwen' };

  const a = await synthesizeVoices({ ...base, voice: 'Cherry', model: 'qwen3-tts-flash', run: stub(calls) });
  const b = await synthesizeVoices({ ...base, voice: 'Serena', model: 'qwen3-tts-flash', run: stub(calls) });
  const c = await synthesizeVoices({ ...base, voice: 'Cherry', model: 'qwen3-tts-other', run: stub(calls) });
  const d = await synthesizeVoices({ ...base, voice: 'Cherry', model: 'qwen3-tts-flash', run: stub(calls) });

  assert.notEqual(a.voices[0].key, b.voices[0].key, '音色不同 → 键不同');
  assert.notEqual(a.voices[0].key, c.voices[0].key, '模型不同 → 键不同');
  assert.equal(a.voices[0].key, d.voices[0].key, '同一个音色同一个模型 → 同一个键');
  assert.equal(calls.length, 3, 'a/b/c 各合成一次，d 命中 a 的缓存');
  assert.equal(d.voices[0].cached, true);
  assert.equal(new Set([a, b, c].map((r) => r.voices[0].file)).size, 3, '三条互不覆盖');
});

test('一条失败进 failed，其它条照常落盘', async () => {
  const root = await project();
  const run = async (/** @type {any} */ { text, out }) => {
    if (text.includes('失败')) throw new Error('Qwen HTTP 500: boom');
    return { files: [{ path: `assets/audio/vo/${out}.mp3`, bytes: new Uint8Array([7]) }] };
  };
  const result = await synthesizeVoices({
    project: root, lines: ['好的第一条', '这条要失败', '好的第三条'], provider: 'qwen', voice: 'Cherry', run,
  });
  assert.deepEqual(result.failed, [{ textIndex: 1, reason: 'Qwen HTTP 500: boom' }]);
  assert.deepEqual(result.voices.map((v) => v.text), ['好的第一条', '好的第三条'], '顺序按脚本，失败的那条不留空位');
  assert.ok(result.voices.every((v) => existsSync(v.file)));
});

test('空行也进 failed：不拿空文件冒充一条配音', async () => {
  const root = await project();
  const result = await synthesizeVoices({
    project: root, lines: ['   ', '有内容的一句'], provider: 'minimax', voice: 'female-shaonv', run: stub([]),
  });
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].textIndex, 0);
  assert.match(result.failed[0].reason, /空的/);
  assert.equal(result.voices.length, 1);
  assert.equal(result.voices[0].text, '有内容的一句');
});

test('run 只给项目内路径时，从项目里读字节写进缓存（别家 provider 的形态）', async () => {
  const root = await project();
  const run = async (/** @type {any} */ { out }) => {
    const rel = `assets/audio/vo/${out}.mp3`;
    await mkdir(join(root, 'assets', 'audio', 'vo'), { recursive: true });
    await writeFile(join(root, rel), Buffer.from([4, 5, 6]));
    return { files: [{ path: rel }], index: [{ src: rel, kind: 'sound', voice: 'Cherry' }] };
  };
  const result = await synthesizeVoices({ project: root, lines: ['从磁盘来的'], provider: 'elevenlabs', voice: 'Cherry', run });
  assert.deepEqual([...(await readFile(result.voices[0].file))], [4, 5, 6]);
  assert.equal(result.voices[0].src, `assets/audio/vo/vo-${result.voices[0].key.slice(0, 12)}.mp3`, '记录来源路径');
});

test('并发上限是 2', async () => {
  const root = await project();
  let live = 0;
  let peak = 0;
  const run = async (/** @type {any} */ { out }) => {
    live += 1;
    peak = Math.max(peak, live);
    await new Promise((done) => setTimeout(done, 15));
    live -= 1;
    return { files: [{ path: `assets/audio/vo/${out}.mp3`, bytes: new Uint8Array([1]) }] };
  };
  const lines = Array.from({ length: 6 }, (_, i) => `第 ${i + 1} 条完整口播`);
  const result = await synthesizeVoices({ project: root, lines, provider: 'minimax', voice: 'female-shaonv', run });
  assert.equal(result.voices.length, 6);
  assert.equal(peak, 2, '同时最多两条在合成');
});

test('键只看 provider|model|voice|规范化文本：空白差异不重复花钱', async () => {
  assert.equal(normalizeText('  小 青 柑\n\n三十秒  '), '小 青 柑 三十秒');
  const one = cacheKey({ provider: 'minimax', model: 'speech-2.8-hd', voice: 'female-shaonv', text: ' 一条口播 ' });
  const two = cacheKey({ provider: 'minimax', model: 'speech-2.8-hd', voice: 'female-shaonv', text: '一条口播' });
  assert.equal(one, two);
  assert.match(one, /^[0-9a-f]{64}$/);

  const root = await project();
  const calls = [];
  const ask = { project: root, provider: 'minimax', voice: 'female-shaonv' };
  await synthesizeVoices({ ...ask, lines: ['一条口播'], run: stub(calls) });
  const again = await synthesizeVoices({ ...ask, lines: ['  一条口播\n'], run: stub(calls) });
  assert.equal(calls.length, 1, '只换了空白，仍是同一条缓存');
  assert.equal(again.voices[0].cached, true);
});
