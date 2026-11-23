// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * Fission 的发布是**按平台**的：Windows x64 与 macOS arm64 各一份 self-contained 产物，程序名与配置里的
 * 路径随之变化（macOS 上 `Fission.Cli` 没有 `.exe`，ffmpeg 也没有；配置里的 `cli` 也随平台指向真正的入口）。
 *
 * 这一组测试盯住"平台一换，名字和配置跟着换"，以及"没有这个平台的产物时要说清楚，而不是拿 Windows 的
 * 二进制糊上去"。另外盯住 `FontsDir`：字体不在仓库里，键仍然写进配置，缺字体只是一条 warning。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FISSION_CONFIG_TEMPLATE, FISSION_FOLDERS, FISSION_FONTS, FISSION_FONT, fissionCliEntry, fissionCliName, fissionHostName,
  fissionRid, configurationProblems, publishedProblems, publishFission, shippedConfiguration, hostSources,
} from './fission-publish.mjs';

test('host 丢掉 host 与 cli 两个参数：Windows 的 dll 与 macOS 的 apphost 一致（不按 .dll 分支）', () => {
  for (const [platform, rid] of [['win32', 'win-x64'], ['darwin', 'osx-arm64']]) {
    const { program } = hostSources({ rid, platform });
    assert.match(program, /var skip = 2;/, `${platform}: 丢掉 host 与 cli`);
    assert.doesNotMatch(program, /EndsWith\("\.dll"/, `${platform}: 不再按扩展名判断`);
    assert.match(program, /argv\[skip\.\.\]/, `${platform}: 转发 run 及其后的参数`);
  }
});

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

test('配置里的 cli 随平台：Windows 指 dll，macOS 指 apphost 本身', () => {
  assert.equal(fissionCliEntry('win32'), 'Fission.Cli.dll');
  assert.equal(fissionCliEntry('darwin'), 'Fission.Cli');
});

test('随包的配置：mac 上 ffmpeg/ffprobe/host 都没有后缀，cli 是 apphost', () => {
  const darwin = shippedConfiguration({ platform: 'darwin' });
  assert.equal(darwin.cli, 'fission/Fission.Cli', 'mac 上真正的入口是 apphost，不是 dll');
  assert.equal(darwin.dotnet, 'fission/fission-host');
  assert.equal(darwin.paths.FFmpeg, 'runtime/ffmpeg/ffmpeg');
  assert.equal(darwin.paths.FFprobe, 'runtime/ffmpeg/ffprobe');

  const win = shippedConfiguration({ platform: 'win32' });
  assert.equal(win.cli, 'fission/Fission.Cli.dll', 'Windows 启动的是 framework-dependent 的 dll');
  assert.equal(win.dotnet, 'fission/fission-host.exe');
  assert.equal(win.paths.FFmpeg, 'runtime/ffmpeg/ffmpeg.exe');
});

test('随包的配置里 FontsDir 指向随包字体目录（两个平台一样）', () => {
  for (const platform of ['win32', 'darwin']) {
    assert.equal(shippedConfiguration({ platform }).paths.FontsDir, `fission/${FISSION_FONTS}`, platform);
  }
  assert.equal(FISSION_FONTS, 'fonts');
  assert.equal(FISSION_FOLDERS.includes(FISSION_FONTS), false, '字体目录不是那三个必须存在的空目录之一');
});

test('configurationProblems：FontsDir 是可选的，给了就必须是绝对路径', () => {
  const base = () => {
    const config = shippedConfiguration({ platform: 'darwin' });
    return {
      cli: `/App/${config.cli}`, dotnet: `/App/${config.dotnet}`,
      paths: Object.fromEntries(Object.entries(config.paths).map(([key, value]) => [key, `/App/${value}`])),
    };
  };
  assert.deepEqual(configurationProblems(base(), { platform: 'darwin' }), [], 'FontsDir 在，配置可用');

  const without = base();
  delete without.paths.FontsDir;
  assert.deepEqual(configurationProblems(without, { platform: 'darwin' }), [], 'FontsDir 不在也可用（引擎回落平台字体目录）');

  const relative = base();
  relative.paths.FontsDir = 'fission/fonts';
  assert.deepEqual(configurationProblems(relative, { platform: 'darwin' }), ['paths.FontsDir is not an absolute path']);

  const unknown = base();
  unknown.paths.Fonts = '/App/fission/fonts';
  assert.ok(configurationProblems(unknown, { platform: 'darwin' }).some((line) => line.includes('paths.Fonts is not a key')), '别的键仍然被拒');
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

/**
 * `dotnet publish` 的替身：按 `-o <folder>` 写出那一份产物会有的文件（CLI 的 dll/apphost/pdb，或 host 的可执行）。
 * @param {{ fonts?: boolean }} [options] 是否在 CLI 的产物目录里留一个 fonts 目录（模拟"随包字体"）
 */
const fakePublish = ({ fonts = false } = {}) => (cmd, args) => {
  assert.equal(cmd, 'dotnet');
  const output = args[args.length - 1];
  mkdirSync(output, { recursive: true });
  if (args[1].endsWith('fission-host.csproj')) {
    writeFileSync(join(output, 'fission-host.exe'), 'fixture');
    return;
  }
  for (const name of ['Fission.Cli.exe', 'Fission.Cli.dll', 'Fission.Cli.pdb']) writeFileSync(join(output, name), 'fixture');
  if (fonts) {
    mkdirSync(join(output, FISSION_FONTS), { recursive: true });
    writeFileSync(join(output, FISSION_FONTS, FISSION_FONT), 'fixture');
  }
};

test('publishFission：没有随包字体只 warning 不失败，配置里 FontsDir 照样在', async () => {
  const warnings = [];
  const result = await publishFission({
    repoRoot: process.cwd(), work: mkdtempSync(join(tmpdir(), 'fission-work-')), platform: 'win32', arch: 'x64',
    run: fakePublish(), log: () => {}, warn: (line) => warnings.push(line), font: false,
  });
  assert.equal(warnings.length, 1, `一条警告：${warnings.join(' | ')}`);
  assert.match(warnings[0], /未随包字体/);
  assert.match(warnings[0], /macOS 字幕将不可用/);
  assert.equal(result.fonts, false);
  const template = JSON.parse(readFileSync(join(result.dir, FISSION_CONFIG_TEMPLATE), 'utf8'));
  assert.equal(template.paths.FontsDir, 'fission/fonts', '字体不在仓库里，键仍然写进配置');
  assert.deepEqual(template, shippedConfiguration({ platform: 'win32' }));
  assert.deepEqual(publishedProblems(result.dir, { platform: 'win32' }), [], '缺字体不是"这份发布不合格"');
});

test('publishFission：随包字体在时不 warning', async () => {
  const warnings = [];
  const result = await publishFission({
    repoRoot: process.cwd(), work: mkdtempSync(join(tmpdir(), 'fission-work-')), platform: 'win32', arch: 'x64',
    run: fakePublish({ fonts: true }), log: () => {}, warn: (line) => warnings.push(line), font: false,
  });
  assert.deepEqual(warnings, []);
  assert.equal(result.fonts, true);
});

test('publishFission：字体下载失败只 warning（不阻断打包），并说清 macOS 字幕不可用', async () => {
  const warnings = [];
  const result = await publishFission({
    repoRoot: process.cwd(), work: mkdtempSync(join(tmpdir(), 'fission-work-')), platform: 'win32', arch: 'x64',
    run: fakePublish(), log: () => {}, warn: (line) => warnings.push(line),
    font: true, fetch: async () => { throw new Error('offline'); },
  });
  assert.ok(warnings.some((line) => /字体下载失败/.test(line)), warnings.join(' | '));
  assert.equal(result.fonts, false);
});
