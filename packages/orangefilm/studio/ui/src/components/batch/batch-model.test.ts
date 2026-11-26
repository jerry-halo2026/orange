// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * 批量出片页的模型行为：三档状态、失败人话、只重出受影响项、进度文案。
 * 断言写成"人看到什么"，不是"对象长什么样"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  describeEntry, humanReason, pageState, progressLine, retryTargets, shortName, statusLabel, statusOf, summaryLine,
} from './batch-model.ts';

const entry = (patch = {}) => ({ planId: 'youqi-001', copyPreview: '开箱那一下', totalSec: 15, shotCount: 6, blocking: 0, canFilm: true, ...patch });
const done = (patch = {}) => ({ ok: true, message: '完成' });

test('三档状态：可发 / 不许发 / 失败 / 排队中', () => {
  assert.equal(statusOf(entry({ result: done() })), 'ready');
  assert.equal(statusOf(entry({ result: done(), blocking: 2 })), 'blocked');
  assert.equal(statusOf(entry({ result: done(), canFilm: false })), 'blocked');
  assert.equal(statusOf(entry({ result: { ok: false, message: '渲染失败（退出码 1）' } })), 'failed');
  assert.equal(statusOf(entry({})), 'pending');
  assert.equal(statusLabel('ready'), '可发');
  assert.equal(statusLabel('blocked'), '不许发');
  assert.equal(statusLabel('pending'), '排队中');
});

test('失败说人话：五种常见原因各自的下一步', () => {
  assert.match(humanReason('渲染器还差配置：找不到 app 自带的 ffmpeg'), /先让 app 把 ffmpeg 下下来/);
  assert.match(humanReason('没有排队：S1 没有配音文件（先跑 measurePlanVoices）'), /先把文案合成语音/);
  assert.match(humanReason('[Fission:CFG_ENGINE_PATHS] 未注入'), /缺渲染器配置/);
  assert.match(humanReason('no space left on device'), /磁盘空间不足/);
  assert.match(humanReason('unknown'), /unknown/);
});

test('汇总：跑了几条、能发几条、要改几条', () => {
  const entries = [
    entry({ planId: 'a', result: done() }),
    entry({ planId: 'b', result: done(), blocking: 1 }),
    entry({ planId: 'c', result: { ok: false, message: '超时' } }),
    entry({ planId: 'd' }),
  ];
  assert.equal(summaryLine(entries), '4 条 · 可发 1 · 不许发 1 · 失败 1');
  assert.match(summaryLine(entries, 'running'), /渲染中 3\/4/);
  assert.equal(summaryLine([]), '这个工程还没有计划');
});

test('只重出受影响项：默认只挑失败，也可以连"不许发"一起', () => {
  const entries = [
    entry({ planId: 'a', result: done() }),
    entry({ planId: 'b', result: done(), blocking: 1 }),
    entry({ planId: 'c', result: { ok: false, message: 'x' } }),
  ];
  assert.deepEqual(retryTargets(entries), ['c']);
  assert.deepEqual(retryTargets(entries, { onlyFailed: false }), ['b', 'c']);
});

test('一行副标题与短名', () => {
  assert.equal(describeEntry(entry({ voiceId: 'qwen', bgm: 'bgmA' })), '15.0s · 6 镜 · 配音 qwen · BGM bgmA');
  assert.equal(shortName('youqi-oulong-007'), 'oulong-007');
  assert.equal(shortName('plain'), 'plain');
});

test('后端状态 → 页面状态；进度文案带"正在哪一条"', () => {
  assert.equal(pageState(null), 'idle');
  assert.equal(pageState({ state: 'running' }), 'running');
  assert.equal(pageState({ state: 'completed-with-failures' }), 'completed-with-failures');
  assert.match(
    progressLine({ state: 'running', done: 12, total: 100, ok: 10, failed: 2, events: [{ planId: 'youqi-013' }] }),
    /12\/100 · 完成 10 · 失败 2 · 正在 youqi-013/,
  );
  assert.equal(progressLine({ state: 'completed', done: 5, total: 5, verdict: '5 条全部完成' }), '5 条全部完成');
  assert.equal(progressLine(null), '还没有批次');
});
