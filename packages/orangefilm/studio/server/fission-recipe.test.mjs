// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { JOB_FIELDS, jobFromRecipe, normalizeRecipe, prepareRecipeRun, stageRecipe } from './fission-recipe.mjs';

const project = () => {
  const root = mkdtempSync(join(tmpdir(), 'mix-recipe-'));
  mkdirSync(join(root, 'assets', 'video'), { recursive: true });
  for (const name of ['a.mp4', 'b.mp4', 'c.mp4']) writeFileSync(join(root, 'assets', 'video', name), 'x');
  return root;
};

const recipeOf = (/** @type {Record<string, any>} */ over = {}) => {
  const base = {
    schema: 'orange/mix-recipe/1',
    groups: [{ name: '01-开场', refs: [{ kind: 'asset', path: 'assets/video/a.mp4' }, { kind: 'asset', path: 'assets/video/b.mp4' }] }],
    script: { provider: 'minimax', voice: 'female-shaonv', lines: ['第一条口播。', '第二条口播。'] },
    params: { count: 4, audioUses: 2, subtitle: true },
  };
  return { ...base, ...over };
};

const voicesOf = (/** @type {string} */ dir) => {
  const files = ['v1.mp3', 'v2.mp3'].map((name) => { const file = join(dir, name); writeFileSync(file, 'v'); return file; });
  return files.map((file, i) => ({ file, text: `第${i + 1}条口播。` }));
};

test('normalizeRecipe：缺省值补齐，非法项逐条报出', () => {
  const { recipe, problems } = normalizeRecipe(recipeOf());
  assert.deepEqual(problems, []);
  assert.equal(recipe.params.threads, 4);
  assert.equal(recipe.params.pick, 'sceneOrder');
  assert.equal(recipe.params.aspect, '9:16');
  assert.equal(recipe.groups[0].rule, 'random');

  const bad = normalizeRecipe({ groups: [{ name: 'a/b', refs: [] }], script: { lines: [] }, params: { threads: 999, transitionSec: 9 } });
  assert.ok(bad.problems.some((line) => line.includes('groups[0].name')));
  assert.ok(bad.problems.some((line) => line.includes('refs')));
  assert.ok(bad.problems.some((line) => line.includes('script.lines')));
  assert.ok(bad.problems.some((line) => line.includes('transitionSec')));
  assert.equal(bad.recipe.params.threads, 64, '线程数被夹到 1–64');
});

test('stageRecipe：组名逐字成为一级目录，配音落 audio，meta.json 在 audio 的父目录且 items 与文件名逐字对应', () => {
  const dir = project();
  const { recipe } = normalizeRecipe(recipeOf());
  const voices = voicesOf(dir);
  const staged = stageRecipe({ recipe, project: dir, workRoot: join(dir, '.film', 'fission', 'work'), batchId: 'b1', voices });
  assert.deepEqual(staged.problems, []);
  assert.deepEqual(readdirSync(join(dir, '.film', 'fission', 'work', 'b1', 'video')), ['01-开场']);
  assert.deepEqual(readdirSync(staged.audioDir).sort(), ['01.mp3', '02.mp3']);
  const meta = JSON.parse(readFileSync(join(dir, '.film', 'fission', 'work', 'b1', 'meta.json'), 'utf8'));
  assert.equal(meta.items.length, 2);
  assert.deepEqual(meta.items.map((/** @type {any} */ i) => i.file), ['01.mp3', '02.mp3']);
  assert.equal(meta.items[0].text, '第1条口播。');
});

test('jobFromRecipe：字段名是引擎真名，条数与配音策略照抄，字幕只在 9:16 打开', () => {
  const dir = project();
  const { recipe } = normalizeRecipe(recipeOf());
  const staged = stageRecipe({ recipe, project: dir, workRoot: join(dir, 'w'), batchId: 'b1', voices: voicesOf(dir) });
  const { job, notes } = jobFromRecipe({ recipe, staged });
  for (const key of Object.keys(job)) assert.ok(JOB_FIELDS.has(key), `${key} 不是 FissionJob 字段`);
  assert.equal(job.Pick, 'SceneOrderRandomWithin');
  assert.equal(job.Align, 1);
  assert.equal(job.Naming, 'AudioFileName');
  assert.equal(job.Count, 4);
  assert.equal(job.AudioUses, 2);
  assert.equal(job.SceneGroups[0].Name, '01-开场');
  assert.equal(job.SubtitleEnabled, true);
  assert.equal('TargetDurationSec' in job, false, '不写目标时长 = 跟随配音');
  assert.deepEqual(notes, []);

  const wide = normalizeRecipe(recipeOf({ params: { count: 4, audioUses: 2, subtitle: true, aspect: '16:9' } }));
  const wideStage = stageRecipe({ recipe: wide.recipe, project: dir, workRoot: join(dir, 'w2'), batchId: 'b2', voices: voicesOf(dir) });
  const wideJob = jobFromRecipe({ recipe: wide.recipe, staged: wideStage });
  assert.equal(wideJob.job.OutWidth, 1920);
  assert.equal('SubtitleEnabled' in wideJob.job, false, 'ASS 画布固定 1080×1920，横屏不开字幕');
  assert.ok(wideJob.notes.some((line) => line.includes('1080×1920')));

  /* macOS 的随包 ffmpeg 换成带 libass 的 9.0.2 之后，darwin 与 Windows 一样开字幕。 */
  const mac = normalizeRecipe(recipeOf());
  const macStage = stageRecipe({ recipe: mac.recipe, project: dir, workRoot: join(dir, 'w3'), batchId: 'b3', voices: voicesOf(dir) });
  const macJob = jobFromRecipe({ recipe: mac.recipe, staged: macStage, platform: 'darwin' });
  assert.equal(macJob.job.SubtitleEnabled, true);
  assert.deepEqual(macJob.notes, []);
  const winJob = jobFromRecipe({ recipe: mac.recipe, staged: macStage, platform: 'win32' });
  assert.equal(winJob.job.SubtitleEnabled, true, 'Windows 照常开字幕');
});

test('prepareRecipeRun：缺素材/缺配音进 problems，不抛异常也不假装成功', () => {
  const dir = project();
  const { recipe } = normalizeRecipe(recipeOf({
    groups: [{ name: '01-开场', refs: [{ kind: 'asset', path: 'assets/video/nope.mp4' }] }],
  }));
  const run = prepareRecipeRun({ recipe, project: dir, workRoot: join(dir, 'w'), batchId: 'b3', voices: [] });
  assert.ok(run.problems.some((line) => line.includes('nope.mp4')));
  assert.ok(run.problems.some((line) => line.includes('没有任何配音')));
  assert.equal(run.staged.groups['01-开场'].count, 0);
});

test('stageRecipe：同一批次重跑会重建，不同批次互不影响（旧实现会删在跑的输入）', () => {
  const dir = project();
  const { recipe } = normalizeRecipe(recipeOf());
  const first = stageRecipe({ recipe, project: dir, workRoot: join(dir, 'w'), batchId: 'b4', voices: voicesOf(dir) });
  writeFileSync(join(first.videoDir, '01-开场', 'stale.mp4'), 'stale');
  const again = stageRecipe({ recipe, project: dir, workRoot: join(dir, 'w'), batchId: 'b4', voices: voicesOf(dir) });
  assert.equal(readdirSync(join(again.videoDir, '01-开场')).includes('stale.mp4'), false);
  const other = stageRecipe({ recipe, project: dir, workRoot: join(dir, 'w'), batchId: 'b5', voices: voicesOf(dir) });
  assert.notEqual(first.videoDir, other.videoDir);
});

test('normalizeRecipe：组名忽略大小写重复要拒（引擎的组名字典是 OrdinalIgnoreCase）', () => {
  const { problems } = normalizeRecipe(recipeOf({
    groups: [
      { name: 'Open', refs: [{ kind: 'asset', path: 'assets/video/a.mp4' }] },
      { name: 'open', refs: [{ kind: 'asset', path: 'assets/video/b.mp4' }] },
    ],
  }));
  assert.ok(problems.some((line) => line.includes('groups[1].name') && line.includes('重名')), problems.join(' | '));

  const distinct = normalizeRecipe(recipeOf({
    groups: [
      { name: 'Open', refs: [{ kind: 'asset', path: 'assets/video/a.mp4' }] },
      { name: 'Close', refs: [{ kind: 'asset', path: 'assets/video/b.mp4' }] },
    ],
  }));
  assert.deepEqual(distinct.problems, [], '大小写不同但不重名的不该被拒');
});

test('normalizeRecipe：NFC / NFD 是同一个组名（也拒），并按 NFC 收敛；ref.path 同样收敛', () => {
  const nfd = 'cafe\u0301';           // 也等于 macOS 盘上的写法
  const nfc = nfd.normalize('NFC');
  assert.notEqual(nfd, nfc);
  const { recipe, problems } = normalizeRecipe(recipeOf({
    groups: [
      { name: nfd, refs: [{ kind: 'asset', path: `assets/video/${nfd}.mp4` }] },
      { name: nfc, refs: [{ kind: 'asset', path: `assets/video/${nfc}.mp4` }] },
    ],
  }));
  assert.ok(problems.some((line) => line.includes('groups[1].name')), problems.join(' | '));
  assert.equal(recipe.groups[0].name, nfc, '组名统一 NFC');
  assert.equal(recipe.groups[0].refs[0].path, `assets/video/${nfc}.mp4`, 'ref.path 统一 NFC');
});

test('stageRecipe / jobFromRecipe：目录名与 SceneGroups.Name 都是同一串 NFC 字节', () => {
  const dir = project();
  const nfd = 'cafe\u0301';
  const nfc = nfd.normalize('NFC');
  /* 手写 recipe，不过 normalizeRecipe：staging 自己也要收敛 */
  const recipe = {
    groups: [{ name: nfd, refs: [{ kind: 'asset', path: 'assets/video/a.mp4' }], enabled: true, rule: 'random', takePerOutput: 0, speed: 1 }],
    script: { provider: 'minimax', voice: 'female-shaonv', lines: ['一条口播。'] },
    params: { count: 1, audioUses: 1, aspect: '9:16', split: 'scene', pick: 'sceneOrder', naming: 'audioFileName', align: 1 },
    bgm: [], intro: [], outro: [],
  };
  const staged = stageRecipe({ recipe, project: dir, workRoot: join(dir, 'w'), batchId: 'b6', voices: voicesOf(dir) });
  assert.deepEqual(readdirSync(staged.videoDir), [nfc]);
  assert.deepEqual(Object.keys(staged.groups), [nfc]);
  const { job } = jobFromRecipe({ recipe, staged });
  assert.equal(job.SceneGroups[0].Name, nfc);
  assert.ok(existsSync(join(staged.videoDir, job.SceneGroups[0].Name, '001.mp4')), 'job 里的组名要能对上目录');
});

test('jobFromRecipe：字幕开且给了字体族才写 SubtitleFontFamily', () => {
  const dir = project();
  assert.ok(JOB_FIELDS.has('SubtitleFontFamily'), 'JOB_FIELDS 要认这个新字段（Lane A 在 C# 侧同名加）');
  const withFont = normalizeRecipe(recipeOf({ params: { count: 2, audioUses: 1, subtitle: true, subtitleFontFamily: '  Noto Sans SC ' } }));
  assert.deepEqual(withFont.problems, []);
  assert.equal(withFont.recipe.params.subtitleFontFamily, 'Noto Sans SC', '两端空格去掉');
  const staged = stageRecipe({ recipe: withFont.recipe, project: dir, workRoot: join(dir, 'w'), batchId: 'b7', voices: voicesOf(dir) });
  const { job } = jobFromRecipe({ recipe: withFont.recipe, staged });
  assert.equal(job.SubtitleFontFamily, 'Noto Sans SC');
  assert.equal(job.SubtitleEnabled, true);

  /* 没给字体族：不写，交给引擎缺省 */
  const plain = normalizeRecipe(recipeOf());
  const plainStage = stageRecipe({ recipe: plain.recipe, project: dir, workRoot: join(dir, 'w2'), batchId: 'b8', voices: voicesOf(dir) });
  assert.equal('SubtitleFontFamily' in jobFromRecipe({ recipe: plain.recipe, staged: plainStage }).job, false);

  /* 字幕关：写了字体族也不进 job */
  const off = normalizeRecipe(recipeOf({ params: { count: 2, audioUses: 1, subtitle: false, subtitleFontFamily: 'Noto Sans SC' } }));
  const offStage = stageRecipe({ recipe: off.recipe, project: dir, workRoot: join(dir, 'w3'), batchId: 'b9', voices: voicesOf(dir) });
  const offJob = jobFromRecipe({ recipe: off.recipe, staged: offStage }).job;
  assert.equal('SubtitleFontFamily' in offJob, false);
  assert.equal('SubtitleEnabled' in offJob, false);
});
