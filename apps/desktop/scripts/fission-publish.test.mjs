// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * Fission 的发布是**按平台**的：Windows x64 与 macOS arm64 各一份 self-contained 产物，程序名与配置里的
 * 路径随之变化（macOS 上 `Fission.Cli` 没有 `.exe`，ffmpeg 也没有）。
 *
 * 这一组测试盯住"平台一换，名字和配置跟着换"，以及"没有这个平台的产物时要说清楚，而不是拿 Windows 的
 * 二进制糊上去"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FISSION_CONFIG_TEMPLATE, FISSION_FOLDERS, fissionCliName, fissionHostName, fissionRid,
  publishedProblems, publishFission, shippedConfiguration,
} from './fission-publish.mjs';

test('runtime identifier 的对照表：win-x64 与 osx-arm64，其余为 null', () => {
  assert.equal(fissionRid('win32', 'x64'), 'win-x64');
  assert.equal(fissionRid('darwin', 'arm64'), 'osx-arm64');
  assert.equal(fissionRid('darwin', 'x64'), null, 'Intel Mac 不在首版范围');
  assert.equal(fissionRid('linux', 'x64'), null);
  assert.equal(fissionRid('win32', 'arm64'), null);
});

test('程序名随平台：只有 Windows 带 .exe', () => {
  assert.equal(fissionCliName('win32'), 'Fission.Cli.exe');
  assert.equal(fissionCliName('darwin'), 'Fission.Cli');
  assert.equal(fissionHostName('win32'), 'fission-host.exe');
  assert.equal(fissionHostName('darwin'), 'fission-host');
});

test('随包的配置：mac 上 ffmpeg/ffprobe/host 都没有后缀', () => {
  const darwin = shippedConfiguration({ platform: 'darwin' });
  assert.equal(darwin.dotnet, 'fission/fission-host');
  assert.equal(darwin.paths.FFmpeg, 'runtime/ffmpeg/ffmpeg');
  assert.equal(darwin.paths.FFprobe, 'runtime/ffmpeg/ffprobe');

  const win = shippedConfiguration({ platform: 'win32' });
  assert.equal(win.dotnet, 'fission/fission-host.exe');
  assert.equal(win.paths.FFmpeg, 'runtime/ffmpeg/ffmpeg.exe');
});

/** 一个"发布好了"的 resources/fission 目录：按平台放对名字。 */
const published = (platform) => {
  const dir = mkdtempSync(join(tmpdir(), `fission-published-${platform}-`));
  const file = (name) => writeFileSync(join(dir, name), 'fixture');
  file(fissionCliName(platform));
  file('Fission.Cli.dll');
  file(fissionHostName(platform));
  writeFileSync(join(dir, FISSION_CONFIG_TEMPLATE), JSON.stringify(shippedConfiguration({ platform })));
  for (const folder of FISSION_FOLDERS) mkdirSync(join(dir, folder), { recursive: true });
  return dir;
};

test('publishedProblems：mac 产物按 mac 检查是通过的', () => {
  assert.deepEqual(publishedProblems(published('darwin'), { platform: 'darwin' }), []);
});

test('publishedProblems：拿 mac 产物当 Windows 检查会缺件（不静默通过）', () => {
  const problems = publishedProblems(published('darwin'), { platform: 'win32' });
  assert.ok(problems.some((line) => line.includes('Fission.Cli.exe')), problems.join(' | '));
  assert.ok(problems.some((line) => line.includes('fission-host.exe')), problems.join(' | '));
});

test('publishFission：这个平台没有产物就直接抛，不说"打包成功"', async () => {
  await assert.rejects(
    () => publishFission({ repoRoot: process.cwd(), work: mkdtempSync(join(tmpdir(), 'fission-work-')), platform: 'linux', arch: 'x64', run: () => { throw new Error('不该调用 dotnet'); } }),
    /not published for linux-x64/,
  );
});
