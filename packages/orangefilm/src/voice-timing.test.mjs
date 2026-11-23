// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// 时长是整条片子的时间基准：量错 0.5 秒，最后一句话就会被切掉。用假 TTS + 假 probe 钉住每个分支。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { measurePlanVoices, stretchShotsToAudio } from './voice-timing.mjs';

const planWith = (segments, shots = []) => ({
  spec: { breathSec: 0.2, targetSec: 15, minShots: 5, minShotSec: 1.2, maxShotSec: 8 },
  segments,
  shots,
});

const speech = (id, text, audioSec = 0) => ({ id, kind: 'speech', text, audioSec, estimated: audioSec === 0 });

test('每个口播段配音并实测：audioSec 变成探针给的值，estimated 变 false', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-'));
  const plan = planWith([speech('S1', '第一句'), speech('S2', '第二句')]);
  const { plan: out, measured, failed } = await measurePlanVoices(plan, {
    speak: async (text) => ({ bytes: new Uint8Array([1, 2, 3]), mime: 'audio/mpeg', provider: 'qwen' }),
    voiceDir: dir,
    probe: async (file) => (file.endsWith('S1.mp3') ? 2.4 : 3.1),
  });
  assert.deepEqual(measured, ['S1', 'S2']);
  assert.deepEqual(failed, []);
  assert.equal(out.segments[0].audioSec, 2.4);
  assert.equal(out.segments[0].estimated, false);
  assert.ok(existsSync(join(dir, 'S1.mp3')), '音频落在 voiceDir');
});

test('一个段落配音失败：保留估算值、记进 failed、不拖垮其他段', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-'));
  const plan = planWith([speech('S1', '会失败'), speech('S2', '会成功')]);
  const { plan: out, measured, failed } = await measurePlanVoices(plan, {
    speak: async (text) => {
      if (text === '会失败') throw new Error('401');
      return { bytes: new Uint8Array([1]), mime: 'audio/mpeg' };
    },
    voiceDir: dir,
    probe: async () => 2.0,
  });
  assert.deepEqual(measured, ['S2']);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].id, 'S1');
  assert.equal(out.segments[0].estimated, true, '失败的段仍然是"估算"状态');
});

test('探针量不出时长，也算失败（不当成 0 秒）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-'));
  const plan = planWith([speech('S1', '一句话')]);
  const { failed } = await measurePlanVoices(plan, {
    speak: async () => ({ bytes: new Uint8Array([1]), mime: 'audio/mpeg' }),
    voiceDir: dir,
    probe: async () => null,
  });
  assert.equal(failed.length, 1);
  assert.match(failed[0].reason, /量不出时长/);
});

test('句间插入呼吸段，不重复插', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-'));
  const plan = planWith([speech('S1', '一'), speech('S2', '二'), speech('S3', '三')]);
  const first = await measurePlanVoices(plan, { speak: async () => ({ bytes: new Uint8Array([1]), mime: 'audio/mpeg' }), voiceDir: dir, probe: async () => 2 });
  const breaths = first.plan.segments.filter((/** @type {any} */ s) => s.kind === 'breath');
  assert.equal(breaths.length, 2, '三段之间两个呼吸');
  const second = await measurePlanVoices(first.plan, { speak: async () => ({ bytes: new Uint8Array([1]), mime: 'audio/mpeg' }), voiceDir: dir, probe: async () => 2 });
  assert.equal(second.plan.segments.filter((/** @type {any} */ s) => s.kind === 'breath').length, 2, '不重复插');
});

test('stretchShotsToAudio：镜头够长就不动，不够长且素材够就拉长，素材不够就要求重排', () => {
  const plan = {
    spec: { breathSec: 0 },
    segments: [
      { id: 'S1', kind: 'speech', text: '一', audioSec: 2.0, estimated: false },
      { id: 'S2', kind: 'speech', text: '二', audioSec: 3.0, estimated: false },
    ],
    shots: [
      { segmentId: 'S1', mediaId: 'm1', startSec: 0, endSec: 5, speed: 1, shownSec: 2.4 },
      { segmentId: 'S2', mediaId: 'm2', startSec: 0, endSec: 2.0, speed: 1, shownSec: 2.0 },
    ],
  };
  const { needsReplan } = stretchShotsToAudio(plan);
  assert.equal(plan.shots[0].shownSec, 2.4, '已有的富余不动');
  assert.deepEqual(needsReplan, ['S2'], '素材只有 2s，撑不住 3.15s 的句子');
});
