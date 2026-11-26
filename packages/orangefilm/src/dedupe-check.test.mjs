// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// 自查必须在渲染前做完。判据是"渲染输入会不会撞"，不是"出片后像不像"。
import test from 'node:test';
import assert from 'node:assert/strict';

import { frameCells, jaccard, planSimilarity, renderSignature, sequenceSimilarity } from './dedupe-check.mjs';

const plan = (id, { lines, shots, voices = [], bgm = null, spec = { width: 1080, height: 1920, fps: 30 } }) => ({
  id, lines, shots, voices, bgm, spec,
});
const shot = (mediaId, startSec, shownSec, speed = 1) => ({ mediaId, startSec, shownSec, speed });

test('渲染签名：输入一样就一样，任何一处不同就不同', () => {
  const a = plan('a', { lines: ['一'], shots: [shot('m1', 0.4, 2.15)], voices: ['v1.mp3'] });
  const b = plan('b', { lines: ['完全不同的台词'], shots: [shot('m1', 0.4, 2.15)], voices: ['v1.mp3'] });
  assert.equal(renderSignature(a), renderSignature(b), '字幕不影响签名（它由台词派生，跟着 plan 走就行）');
  const c = plan('c', { lines: ['一'], shots: [shot('m1', 0.9, 2.15)], voices: ['v1.mp3'] });
  assert.notEqual(renderSignature(a), renderSignature(c), '裁切点不同就是不同输入');
  const d = plan('d', { lines: ['一'], shots: [shot('m1', 0.4, 2.15)], voices: ['v2.mp3'] });
  assert.notEqual(renderSignature(a), renderSignature(d), '换配音就是不同输入');
});

test('签名相同 → block（必出同一份字节），canRender=false', () => {
  const same = { lines: ['一句话'], shots: [shot('m1', 0.4, 2.15)], voices: ['v.mp3'], bgm: 'bgmA' };
  const result = planSimilarity([plan('a', same), plan('b', same)]);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.canRender, false);
  assert.match(result.verdict, /完全一样/);
});

test('同一批配音文件复用 → 音频层命中（ASR 之后就是同一段话）', () => {
  const result = planSimilarity([
    plan('a', { lines: ['句子甲'], shots: [shot('m1', 0.0, 2.0)], voices: ['voice-x.mp3'] }),
    plan('b', { lines: ['句子乙完全不一样'], shots: [shot('m3', 1.0, 2.4)], voices: ['voice-x.mp3'] }),
  ]);
  const pair = result.risky.find((entry) => entry.a === 'a' && entry.b === 'b');
  assert.ok(pair?.hits.includes('配音文件相同'), JSON.stringify(pair));
});

test('画面重叠过高 → 视觉层命中（同一素材、重叠取用区间）', () => {
  const result = planSimilarity([
    plan('a', { lines: ['甲'], shots: [shot('m1', 0.5, 4.0)], voices: ['v1.mp3'] }),
    plan('b', { lines: ['乙'], shots: [shot('m1', 0.6, 4.0)], voices: ['v2.mp3'] }),
  ]);
  const pair = result.risky.find((entry) => entry.a === 'a' && entry.b === 'b');
  assert.ok(pair?.hits.some((hit) => hit.startsWith('画面')), JSON.stringify(pair));
});

test('首帧相同 → 封面会撞，单独报一层', () => {
  const result = planSimilarity([
    plan('a', { lines: ['甲'], shots: [shot('m1', 0.2, 2.0), shot('m2', 0.0, 2.0)], voices: ['v1'] }),
    plan('b', { lines: ['乙'], shots: [shot('m1', 0.25, 1.2), shot('m5', 1.0, 2.0)], voices: ['v2'] }),
  ]);
  const pair = result.risky.find((entry) => entry.a === 'a' && entry.b === 'b');
  assert.ok(pair?.hits.some((hit) => hit.includes('首帧')), JSON.stringify(pair));
});

test('完全不同的两条：什么都不报，canRender=true', () => {
  const result = planSimilarity([
    plan('a', { lines: ['过完年饭局多'], shots: [shot('m1', 0.0, 2.3), shot('m2', 1.0, 2.5)], voices: ['v1'], bgm: 'bgmA' }),
    plan('b', { lines: ['开箱那一下我就知道'], shots: [shot('m7', 0.5, 3.1), shot('m9', 2.0, 1.9)], voices: ['v2'], bgm: 'bgmB' }),
  ]);
  assert.equal(result.risky.length, 0);
  assert.equal(result.duplicates.length, 0);
  assert.equal(result.canRender, true);
  assert.match(result.verdict, /没有哪一层过近/);
});

test('frameCells：0.25s 粒度、按速度换算、相邻合并', () => {
  assert.deepEqual([...frameCells([shot('m1', 0, 0.5)])].sort(), ['m1#0', 'm1#1', 'm1#2']);
  /* 2 倍速显示 1s = 用掉 2s 源片 → 0.25s 一格，两端都算，共 9 格 */
  assert.deepEqual([...frameCells([shot('m1', 0, 1.0, 2)])].sort(), ['m1#0', 'm1#1', 'm1#2', 'm1#3', 'm1#4', 'm1#5', 'm1#6', 'm1#7', 'm1#8']);
});

test('小工具：jaccard / sequenceSimilarity', () => {
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
  assert.equal(jaccard(new Set(['a']), new Set(['b'])), 0);
  assert.equal(sequenceSimilarity([2, 3], [2.05, 2.9]), 1);
  assert.equal(sequenceSimilarity([2, 3], [4, 6]), 0);
});
