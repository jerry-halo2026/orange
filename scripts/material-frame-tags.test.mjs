// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// 打标的两个外部依赖（ffmpeg、视觉模型）都是注入的，所以每条分支都能跑；真 ffmpeg 抽帧单独验一次。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { askVision, extractFrames, tagMaterials } from './material-frame-tags.mjs';

const rows = [
  { media_key: '48135993', name: '展示小青柑1', duration_ms: 33000, entry: 'D:/x/1.mp4' },
  { media_key: 'no-duration', name: '坏行', duration_ms: 0, entry: 'D:/x/2.mp4' },
];

/** 假抽帧：建出三个文件并回报时间点（真抽帧见下面那条真 ffmpeg 的测试） */
const fakeExtract = async ({ dir, id }) => {
  const files = [0, 1, 2].map((index) => {
    const file = join(dir, `${id}-${index}.jpg`);
    writeFileSync(file, 'jpeg');
    return file;
  });
  return { files, at: [3.3, 16.5, 29.7] };
};

test('extractFrames：真 ffmpeg 抽三帧（没有 ffmpeg 就跳过）', async () => {
  /* a real ffmpeg, when this machine has one: `ORANGE_TEST_FFMPEG`, or `ffmpeg` on the PATH. A fixed path under one
     person's profile cannot be the default — it made the test pass only on that machine and named a home folder in the
     repository. */
  const ffmpeg = process.env.ORANGE_TEST_FFMPEG ?? 'ffmpeg';
  const { execFileSync } = await import('node:child_process');
  /* a path must exist; a bare name is looked for on the PATH, and having none is a skip, not a failure */
  const usable = ffmpeg.includes('/') || ffmpeg.includes('\\')
    ? existsSync(ffmpeg)
    : (() => {
        try {
          execFileSync(ffmpeg, ['-version'], { stdio: 'ignore' });
          return true;
        } catch {
          return false;
        }
      })();
  if (!usable) {
    assert.ok(true, '本机没有 ffmpeg，跳过');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'real-frames-'));
  const input = join(dir, 'clip.mp4');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x568:rate=30:duration=3', '-pix_fmt', 'yuv420p', input]);
  const result = await extractFrames({ ffmpeg, input, durationSec: 3, dir, id: 'clip' });
  assert.equal(result.files.length, 3);
  for (const file of result.files) {
    assert.ok(existsSync(file), file);
    assert.ok((await import('node:fs')).statSync(file).size > 500, `${file} 太小`);
  }
});

test('tagMaterials：dry-run 只抽帧、不写库', async () => {
  let written = 0;
  const summary = await tagMaterials({
    rows: rows.slice(0, 1), ffmpeg: 'none', extract: fakeExtract, limit: 5, dryRun: true,
    ask: async () => '{}', write: async () => { written += 1; },
  });
  assert.equal(summary.ok, 1);
  assert.equal(written, 0);
  assert.match(summary.results[0].note, /dry-run/);
});

test('tagMaterials：没有时长的行直接跳过', async () => {
  const summary = await tagMaterials({ rows: rows.slice(1), ffmpeg: 'none', extract: fakeExtract, limit: 5, dryRun: true, ask: async () => '{}' });
  assert.equal(summary.failed, 1);
  assert.match(summary.results[0].note, /没有时长/);
});

test('tagMaterials：模型回答合格式就写库，文本是 tagText', async () => {
  /** @type {{ tags: any, text: string }[]} */
  const writes = [];
  const summary = await tagMaterials({
    rows: rows.slice(0, 1), ffmpeg: 'none', extract: fakeExtract, visionCmd: 'x', limit: 5,
    ask: async () => '```json\n{"subject":"小青柑","action":"倒茶","shotSize":"特写","light":"暖光","scene":"桌面","person":false}\n```',
    write: async (row, tags, text) => { writes.push({ tags, text }); },
  });
  assert.equal(summary.ok, 1, JSON.stringify(summary.results));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].tags.subject, '小青柑');
  assert.match(writes[0].text, /展示小青柑1 · 小青柑 · 倒茶/);
  assert.match(String(writes[0].tags.ver), /frame-tag/);
});

test('tagMaterials：模型回答不是 JSON → 记失败，绝不写脏标签', async () => {
  const summary = await tagMaterials({
    rows: rows.slice(0, 1), ffmpeg: 'none', extract: fakeExtract, visionCmd: 'x', limit: 5,
    ask: async () => '我觉得这个画面挺好看的',
    write: async () => { throw new Error('不该写'); },
  });
  assert.equal(summary.failed, 1);
  assert.match(summary.results[0].note, /不是 JSON/);
});

test('tagMaterials：抽帧失败只影响那一行', async () => {
  const summary = await tagMaterials({
    rows: rows.slice(0, 1), ffmpeg: 'none', limit: 5, dryRun: true, ask: async () => '{}',
    extract: async () => { throw new Error('ffmpeg 不在 PATH'); },
  });
  assert.equal(summary.failed, 1);
  assert.match(summary.results[0].note, /抽帧失败/);
});

test('askVision：图片与提示词作为 JSON 传给脚本，收回 stdout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vision-cmd-'));
  const script = join(dir, 'vision.mjs');
  writeFileSync(script, `
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const payload = JSON.parse(raw);
process.stdout.write(JSON.stringify({ got: payload.images.length, hasPrompt: payload.prompt.length > 0 }));
`, 'utf8');
  const answer = await askVision({ cmd: process.execPath, args: [script], images: ['a.jpg', 'b.jpg'], prompt: 'p', timeoutMs: 20_000 });
  assert.deepEqual(JSON.parse(answer), { got: 2, hasPrompt: true });
});
