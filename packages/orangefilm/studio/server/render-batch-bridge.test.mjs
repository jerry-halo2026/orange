// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * `createRenderBatchBridge` 的两件必须成立的事：
 * 1. 工程读取跑在桌面的 native 授权上下文里（`desktopAuth.runNative`），否则 projects.mjs 抛
 *    control-required，被 catch 吞成“没有这个工程”（安装后的应用里 /api/fission-render/* 永远 404）。
 * 2. 引擎路径优先用随包配置（`ORANGE_FISSION_CONFIG_FILE`），缺了才退回 `<dataDir>/runtime/ffmpeg-<ver>`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createRenderBatchBridge } from './render-batch-bridge.mjs';
import { resolveEnginePathsFromConfig } from './fission-engine-paths.mjs';

test('projectById：有 runNative 就在授权上下文里读，且读得到', async () => {
  let calls = 0;
  const bridge = createRenderBatchBridge({
    auth: { assertActive() {}, runNative: (work) => { calls += 1; return work(); } },
    projects: {
      projectById: async (id) => ({ id, path: join(tmpdir(), 'p') }),
      listProjects: async () => [],
    },
    home: () => tmpdir(),
  });
  const found = await bridge.projectById('p1');
  assert.equal(found?.path, join(tmpdir(), 'p'));
  assert.ok(calls >= 1, '工程读取进了 native 上下文');
});

test('projectById：没有 runNative（单测/无宿主）也照常工作', async () => {
  const bridge = createRenderBatchBridge({
    auth: { assertActive() {} },
    projects: { projectById: async (id) => ({ id, path: '/p' }), listProjects: async () => [] },
    home: () => tmpdir(),
  });
  assert.equal((await bridge.projectById('x'))?.path, '/p');
});

test('resolveEnginePathsFromConfig：用随包配置的绝对路径，WorkRoot/OutRoot 由工程派生', () => {
  const root = mkdtempSync(join(tmpdir(), 'engine-config-'));
  const project = join(root, 'project');
  for (const dir of ['ffmpeg', 'transitions', 'assets', 'local']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'ffmpeg', 'ffmpeg'), 'x');
  writeFileSync(join(root, 'ffmpeg', 'ffprobe'), 'x');
  mkdirSync(project, { recursive: true });
  const config = join(root, 'fission-config.json');
  writeFileSync(config, JSON.stringify({ paths: {
    FFmpeg: join(root, 'ffmpeg', 'ffmpeg'), FFprobe: join(root, 'ffmpeg', 'ffprobe'),
    TransitionsDir: join(root, 'transitions'), AssetsRoot: join(root, 'assets'), LocalAssetsRoot: join(root, 'local'),
    FontsDir: join(root, 'fonts'),
  } }));
  const resolved = resolveEnginePathsFromConfig({ file: config, project });
  assert.equal(resolved?.ok, true, resolved?.problems?.join(' | '));
  assert.equal(resolved?.paths.FFmpeg, realpathSync.native(join(root, 'ffmpeg', 'ffmpeg')));
  assert.equal(resolved?.paths.WorkRoot, realpathSync.native(join(project, '.film', 'fission', 'work')));
  assert.equal(resolved?.source, 'config');
});

test('resolveEnginePathsFromConfig：没配或配坏就返回 null/不可用，让调用方退回推导', () => {
  assert.equal(resolveEnginePathsFromConfig({ file: '', project: tmpdir(), env: {} }), null);
  const root = mkdtempSync(join(tmpdir(), 'engine-bad-'));
  const bad = join(root, 'bad.json');
  writeFileSync(bad, '{}');
  const resolved = resolveEnginePathsFromConfig({ file: bad, project: root });
  assert.equal(resolved?.ok, false);
  assert.ok(resolved?.problems.length);
});
