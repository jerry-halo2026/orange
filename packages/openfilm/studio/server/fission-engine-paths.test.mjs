// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// Fission 拒绝猜路径是对的：猜错一个，出来的片子是黑的，而错误离现场很远。所以这一层要算得准、缺得清。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ffmpegRuntimeDir, resolveEnginePaths, transitionNames } from './fission-engine-paths.mjs';

const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);

const dataWith = (version) => {
  const data = mkdtempSync(join(tmpdir(), 'engine-data-'));
  const dir = join(data, 'runtime', `ffmpeg-${version}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, exe('ffmpeg')), 'stub');
  writeFileSync(join(dir, exe('ffprobe')), 'stub');
  return data;
};

test('ffmpegRuntimeDir：取版本号最大的那份，缺 ffprobe 的不算', () => {
  const data = dataWith('8.1.2');
  const newer = join(data, 'runtime', 'ffmpeg-9.0.2');
  mkdirSync(newer, { recursive: true });
  writeFileSync(join(newer, exe('ffmpeg')), 'stub');
  writeFileSync(join(newer, exe('ffprobe')), 'stub');
  /* 一个更"新"但缺 ffprobe 的目录：不该被选中 */
  const broken = join(data, 'runtime', 'ffmpeg-10.0.0');
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, exe('ffmpeg')), 'stub');

  assert.match(ffmpegRuntimeDir(data) ?? '', /ffmpeg-9\.0\.2$/);
  rmSync(data, { recursive: true, force: true });
});

test('一台没装 ffmpeg 的机器：说清缺什么，而不是给一个空字符串', () => {
  const data = mkdtempSync(join(tmpdir(), 'engine-empty-'));
  const project = mkdtempSync(join(tmpdir(), 'engine-project-'));
  const { ok, problems, paths } = resolveEnginePaths({ dataDir: data, project, env: {} });
  assert.equal(ok, false);
  assert.ok(problems.some((line) => line.includes('ffmpeg')), problems.join(' | '));
  assert.equal(paths.FFmpeg, '', '缺就留空，不编一个路径');
});

test('七项齐全：目录自动建好，TransitionsDir 缺失不算致命', () => {
  const data = dataWith('9.0.2');
  const project = mkdtempSync(join(tmpdir(), 'engine-project-'));
  const { ok, paths, json } = resolveEnginePaths({ dataDir: data, project, env: {} });
  assert.equal(ok, true);
  for (const key of ['FFmpeg', 'FFprobe', 'TransitionsDir', 'AssetsRoot', 'LocalAssetsRoot', 'WorkRoot', 'OutRoot']) {
    assert.ok(paths[key], `${key} 应该有值`);
  }
  assert.match(paths.WorkRoot, /\.film[\\/]fission[\\/]work$/);
  assert.match(paths.OutRoot, /\.film[\\/]fission[\\/]out$/);
  assert.deepEqual(JSON.parse(json), paths, 'json 就是喂给 FISSION_ENGINE_PATHS 的那份');
  rmSync(data, { recursive: true, force: true });
});

test('transitionNames：空目录 = 没有 glsl（全部按 xfade 降级），有就列名字', () => {
  const data = dataWith('9.0.2');
  const project = mkdtempSync(join(tmpdir(), 'engine-project-'));
  const { paths } = resolveEnginePaths({ dataDir: data, project, env: {} });
  assert.deepEqual(transitionNames(paths), []);
  writeFileSync(join(paths.TransitionsDir, 'fade.glsl'), '// stub');
  writeFileSync(join(paths.TransitionsDir, 'wipe.glsl'), '// stub');
  assert.deepEqual(transitionNames(paths), ['fade', 'wipe']);
  rmSync(data, { recursive: true, force: true });
});
