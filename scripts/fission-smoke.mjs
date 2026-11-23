#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// 真出片冒烟：造素材 → 建计划 → 通过批次注册表渲染 → 断言产物。
//
//   node scripts/fission-smoke.mjs                    # 开发树：用本机的 ffmpeg 与 dotnet，找不到就自己下 ffmpeg
//   node scripts/fission-smoke.mjs --packaged DIR     # 打包产物：DIR 是 .app 的 Resources（跑随包的 host + CLI + ffmpeg）
//   node scripts/fission-smoke.mjs --keep             # 保留临时工程
//
// 为什么不做成单测：它要真 ffmpeg 与真 dotnet，跑一次几秒到几十秒；放进 `pnpm test` 会让每次改文案都等它，
// 而且在没有 ffmpeg 的机器上必然失败。所以它是**手动冒烟**，Windows 与 macOS 各跑一次。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveEnginePaths } from '../packages/orangefilm/studio/server/fission-engine-paths.mjs';
import { buildBatch, runBatch, batchVerdict } from '../packages/orangefilm/studio/server/fission-batch.mjs';
import { runFission } from '../packages/orangefilm/studio/server/fission-run.mjs';
import { writePlan } from '../packages/orangefilm/src/plan-store.mjs';

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const packagedAt = (() => {
  const at = args.indexOf('--packaged');
  return at === -1 ? '' : resolve(args[at + 1] ?? '');
})();

/** 应用的数据目录：Windows 是 %APPDATA%，macOS 是 ~/Library/Application Support。 */
export function appDataDir(platform = process.platform, env = process.env) {
  const explicit = String(env.OPENFILM_DATA_DIR ?? '').trim();
  if (explicit) return explicit;
  const product = 'OpenFilm Dev';
  if (platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), product);
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', product);
  return join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), product);
}

const project = mkdtempSync(join(tmpdir(), 'fission-smoke-'));
const assets = join(project, 'assets');
const voiceDir = join(assets, 'voice');
mkdirSync(voiceDir, { recursive: true });
writeFileSync(join(project, 'film.html'), '<!doctype html><html><body><div id="film"></div></body></html>');

/* ── 引擎：开发树自己算；打包产物直接读随包的那份配置 ────────────────────────── */
let engine;
/** @type {{ dotnet?: string, dll?: string }} */
let runner = {};
if (packagedAt) {
  const { fissionConfigFor, configurationProblems } = await import(pathToFileURL(resolve('apps/desktop/scripts/fission-publish.mjs')).href);
  /* 平台必须显式传：fissionConfigFor 的默认值是 win32，漏了就会去找 `ffmpeg.exe`（macOS 上 ENOENT） */
  const config = fissionConfigFor(packagedAt, { platform: process.platform });
  const problems = configurationProblems(config, { platform: process.platform });
  if (problems.length) {
    console.error('✗ 打包产物的 Fission 配置有问题：');
    for (const line of problems) console.error('  · ' + line);
    process.exit(2);
  }
  engine = {
    ok: true,
    paths: {
      ...config.paths,
      /* 只借 ffmpeg 与 host/CLI；素材根与工作目录属于这次冒烟的工程（app 里的 assets 是只读的随包素材根） */
      AssetsRoot: assets,
      WorkRoot: join(project, '.film', 'fission', 'work'),
      OutRoot: join(project, '.film', 'fission', 'out'),
    },
    problems: [],
  };
  mkdirSync(engine.paths.WorkRoot, { recursive: true });
  mkdirSync(engine.paths.OutRoot, { recursive: true });
  runner = { dotnet: config.dotnet, dll: config.cli };
  console.log('打包产物：' + packagedAt);
  console.log('  dotnet(host): ' + config.dotnet);
  console.log('  cli:          ' + config.cli);
} else {
  const dataDir = appDataDir();
  engine = resolveEnginePaths({ dataDir, project });
  if (!engine.ok) {
    /* 开发机上没有 ffmpeg：用 app 自己的 pinned 源下一个（Windows gyan 9.0.2 / macOS Shaka 8.1.2） */
    const runtime = await import(pathToFileURL(resolve('apps/desktop/src/ffmpeg-runtime.mjs')).href);
    if (!runtime.ffmpegDownloadable()) {
      console.error(`✗ 这个平台没有 pinned 的 ffmpeg（${process.platform}-${process.arch}），也没有现成的`);
      process.exit(2);
    }
    console.log('本机没有 ffmpeg，按 pinned 源下载（' + process.platform + '-' + process.arch + '）…');
    await runtime.ensureFfmpeg(dataDir, { onProgress: (fraction) => process.stdout.write(`  ${Math.round(fraction * 100)}%\r`) });
    engine = resolveEnginePaths({ dataDir, project });
  }
  if (!engine.ok) {
    console.error('✗ 渲染器还差配置：');
    for (const line of engine.problems) console.error('  · ' + line);
    process.exit(2);
  }
}
const ffmpeg = engine.paths.FFmpeg;
console.log('引擎：' + ffmpeg);

/* ── 素材：两条 3 秒片段 + 两段 2.15 秒配音 ──────────────────────────────────── */
const clip = (name, source) => {
  const file = join(assets, name);
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', source, '-pix_fmt', 'yuv420p', file], { windowsHide: true });
  return file;
};
clip('包装 (m1).mp4', 'testsrc=size=1080x1920:rate=30:duration=3');
clip('原料 (m2).mp4', 'testsrc2=size=1080x1920:rate=30:duration=3');
for (const id of ['S1', 'S2']) {
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2.15', join(voiceDir, id + '.mp3')], { windowsHide: true });
}

/* 两份计划：素材与裁切点不同（否则会被渲染前的闸门拦下 —— 那本身是对的） */
const plan = (id, media, start) => ({
  id,
  spec: { width: 1080, height: 1920, fps: 30, minShots: 2, targetSec: 4.5 },
  segments: [
    { id: 'S1', kind: 'speech', text: '开箱那一下', audioSec: 2.15, estimated: false, voice: { file: join(voiceDir, 'S1.mp3') } },
    { id: 'S2', kind: 'speech', text: '油切的乌龙不涩口', audioSec: 2.15, estimated: false, voice: { file: join(voiceDir, 'S2.mp3') } },
  ],
  shots: [
    { segmentId: 'S1', mediaId: media, startSec: start, endSec: start + 2.15, speed: 1, shownSec: 2.15 },
    { segmentId: 'S2', mediaId: media, startSec: start + 0.2, endSec: start + 2.35, speed: 1, shownSec: 2.15 },
  ],
  compliance: { mode: 'publish', blocking: 0 },
});
const plans = [plan('smoke-001', 'm1', 0.0), plan('smoke-002', 'm2', 0.1)];
for (const item of plans) writePlan(project, item);

const { tasks, problems } = buildBatch(plans.map((item) => ({ plan: item })), {
  project, assetsRoot: engine.paths.AssetsRoot, workRoot: engine.paths.WorkRoot, enginePaths: engine.paths,
});
if (problems.length) console.log('问题：' + problems.join(' | '));

const started = Date.now();
const summary = await runBatch({
  tasks, project, enginePaths: engine.paths, concurrency: 1,
  /* 打包产物的形态：spawn(host, [cli, 'run', …]) —— 这正是 Studio 在安装后的做法 */
  ...(runner.dotnet ? { run: (input) => runFission({ ...input, dotnet: runner.dotnet, dll: runner.dll }) } : {}),
  onEvent: (event) => console.log(`  [${event.done}/${event.total}] ${event.planId} ${event.ok ? 'ok' : 'fail'} ${event.message}`),
});
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

console.log('\n结论：' + batchVerdict(summary) + `（${elapsed}s）`);
const outDir = join(project, '.film', 'fission', 'out');
if (existsSync(outDir)) {
  for (const name of readdirSync(outDir)) {
    const size = statSync(join(outDir, name)).size;
    console.log(`  产物 ${name} ${(size / 1024).toFixed(0)} KB`);
  }
}
console.log('工程目录：' + project + (keep ? '' : '（想看就加 --keep）'));
process.exit(summary.failed ? 1 : 0);
