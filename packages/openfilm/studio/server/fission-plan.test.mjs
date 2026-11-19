// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// 这一层决定"Fission 到底渲的是不是我们那份计划"。顺序、对齐、时长、缺件，逐条钉住。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { explainFissionFailure, findFootage, jobFromPlan, stagePlanForFission } from './fission-plan.mjs';

/** 一个工程：assets/ 里有两条素材；计划两段、每段有配音文件。 */
function fixture() {
  const project = mkdtempSync(join(tmpdir(), 'fission-plan-'));
  const assets = join(project, 'assets');
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, '包装_93 (48135993).mp4'), 'stub-m1');
  writeFileSync(join(assets, '原料展示 (40280102).mp4'), 'stub-m2');
  const voiceDir = join(project, 'assets', 'voice');
  mkdirSync(voiceDir, { recursive: true });
  writeFileSync(join(voiceDir, 'S1.mp3'), 'stub-voice-1');
  writeFileSync(join(voiceDir, 'S2.mp3'), 'stub-voice-2');
  const plan = {
    id: 'xqg',
    spec: { width: 1080, height: 1920, fps: 30 },
    segments: [
      { id: 'S1', kind: 'speech', text: '一', audioSec: 2, voice: { file: join(voiceDir, 'S1.mp3') } },
      { id: 'G1', kind: 'breath', audioSec: 0.2 },
      { id: 'S2', kind: 'speech', text: '二', audioSec: 3, voice: { file: join(voiceDir, 'S2.mp3') } },
    ],
    shots: [
      { segmentId: 'S1', mediaId: '48135993', startSec: 0.4, endSec: 2.4, speed: 1, shownSec: 2.15 },
      { segmentId: 'S2', mediaId: '40280102', startSec: 1, endSec: 4, speed: 1, shownSec: 3.15 },
    ],
    bgm: null,
    elements: { transitions: [], stickers: [], text: [] },
  };
  return { project, assets, plan, workRoot: join(project, '.film', 'fission', 'work') };
}

test('findFootage：按 mediaId 在 assets 里找视频，找不到就是 null', () => {
  const { assets } = fixture();
  assert.match(findFootage(assets, '48135993') ?? '', /包装_93/);
  assert.equal(findFootage(assets, 'nope'), null);
});

test('stagePlanForFission：按计划顺序复制，序号 = 计划顺序，呼吸段不占位', () => {
  const { project, assets, plan, workRoot } = fixture();
  const { staged, problems } = stagePlanForFission(plan, { project, assetsRoot: assets, workRoot });
  assert.deepEqual(problems, []);
  const videos = readdirSync(staged.videoDir).sort();
  assert.deepEqual(videos, ['01_S1.mp4', '02_S2.mp4'], '两条素材按计划顺序，序号是顺序');
  const audios = readdirSync(staged.audioDir).sort();
  assert.deepEqual(audios, ['01_S1.mp3', '02_S2.mp3'], '配音跟素材同序号');
  assert.equal(staged.entries.length, 2);
  assert.equal(staged.entries[0].sourceStartSec, 0.4, '取用区间随条目带出');
});

test('缺素材 / 缺配音：如实进 problems，不拿别的片段顶替', () => {
  const { project, assets, plan, workRoot } = fixture();
  plan.shots[1].mediaId = 'unknown-id';
  delete plan.segments[2].voice;
  const { staged, problems } = stagePlanForFission(plan, { project, assetsRoot: assets, workRoot });
  assert.ok(problems.some((line) => line.includes('unknown-id')));
  assert.ok(problems.some((line) => line.includes('没有配音')));
  assert.deepEqual(readdirSync(staged.videoDir), ['01_S1.mp4'], '只有一条能复制');
});

test('jobFromPlan：不切、按序、裁到音频长度，尺寸与时长来自计划', () => {
  const { project, assets, plan, workRoot } = fixture();
  const { staged } = stagePlanForFission(plan, { project, assetsRoot: assets, workRoot });
  const enginePaths = { TransitionsDir: join(project, 'transitions'), OutRoot: join(project, 'out') };
  const { job, notes } = jobFromPlan(plan, staged, { enginePaths });
  assert.equal(job.SplitMode, 'None');
  assert.equal(job.PickRule, 'Sequential');
  assert.equal(job.AlignStrategy, 'TrimLonger');
  assert.equal(job.Count, 1);
  assert.equal(job.OutWidth, 1080);
  assert.equal(job.OutHeight, 1920);
  assert.equal(job.TargetDurationSec, Number((2.15 + 3.15).toFixed(3)));
  assert.equal(job.VideoDir, staged.videoDir);
  assert.equal(job.AudioDir, staged.audioDir);
  assert.ok(notes.some((line) => line.includes('xfade')), '没有 glsl 时说清会降级');
});

test('explainFissionFailure：五种失败都说人话', () => {
  assert.match(explainFissionFailure({ code: 3, stderr: '[Fission:CFG_ENGINE_PATHS] 未注入' }), /引擎路径配置/);
  assert.match(explainFissionFailure({ code: 1, stderr: 'ffmpeg: not recognized' }), /找不到 ffmpeg/);
  assert.match(explainFissionFailure({ code: 1, stderr: 'No such file: D:\\x.mp4' }), /输入文件不存在/);
  assert.match(explainFissionFailure({ code: 1, stderr: 'no space left on device' }), /磁盘空间不足/);
  assert.match(explainFissionFailure({ code: 0, outDir: 'D:/out' }), /完成，产物在 D:\/out/);
});
