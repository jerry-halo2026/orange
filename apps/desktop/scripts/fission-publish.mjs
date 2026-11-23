// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * Fission in the installer: the batch mixer Studio's Fission pane runs. It is a .NET 10 program
 * (workers/fission), and the computers people install OpenFilm on have no .NET, so the CLI is published
 * self-contained for win-x64 and shipped under the app's `resources/fission`.
 *
 * Why a host. Studio starts the CLI the way a framework-dependent .NET program starts —
 * `spawn(runtime.dotnet, [runtime.cli, 'run', …])` (packages/openfilm/studio/server/fission-local.mjs) — and a
 * self-contained publish has no `dotnet.exe`: its apphost takes `run` as its first argument. So the shipped
 * configuration names the host as `dotnet` and the published program as `cli`; the host drops the `cli` argument,
 * starts the program beside it with the rest, shares stdio (Studio reads the CLI's `[Fission:…]` markers from its
 * child's stderr and writes START/DONE to its stdin) and returns the CLI's exit code.
 *
 * What `cli` names follows the platform, because the published program does: on Windows the framework-dependent
 * `Fission.Cli.dll` (started by `Fission.Cli.exe`), on macOS the apphost `Fission.Cli` itself. The host drops that
 * argument either way (it starts the program beside itself), so the value is documentation of the layout as much as an
 * argument — it says what the package actually contains, not what Windows happens to contain.
 *
 * FFmpeg is not copied: `runtime.paths.FFmpeg/FFprobe` name the desktop's own `resources/runtime/ffmpeg`, fetched
 * once by `release.mjs` through src/ffmpeg-runtime.mjs (FFmpeg 9.0.2 on Windows). `FFmpeg6` is not shipped and the
 * key is left out, which is the supported "no gltransition" form: the engine maps transitions onto FFmpeg 9's
 * xfade or falls back explicitly (workers/fission/docs/transitions-ffmpeg9.md).
 *
 * Fonts. `paths.FontsDir` names `resources/fission/fonts`, the fonts that travel beside the CLI. It is optional, like
 * `FFmpeg6`: absent (or empty) means "use the platform's font folder", and that fallback is `SpecialFolder.Fonts`, which
 * is not a folder on macOS — so a macOS build whose subtitles should render needs this key pointing at fonts that exist.
 * No font is part of this repository, so the publish does not invent the folder: the key is written regardless and the
 * log says when no font travelled with the package ("未随包字体，macOS 字幕将不可用"). A missing folder is not a failed
 * build — the Windows release burns subtitles with the system fonts it always used.
 *
 * `TransitionsDir`/`AssetsRoot`/`LocalAssetsRoot` must exist as directories before Studio will accept the
 * configuration (readLocalFissionConfiguration) and before the engine reads them (EnginePaths.ValidateEngines):
 * they are carried as real folders with a README saying what belongs in them. The asset corpora themselves are
 * not in this repository, so nothing is invented here.
 *
 * Paths. The packaged configuration must hold absolute paths, but the install folder is chosen at install time
 * (the NSIS installer lets people put the app anywhere), so a build cannot write them. `shippedConfiguration()`
 * is what travels in the package — relative to the app's `resources` folder — and `fissionConfigFor(resourcesDir)`
 * turns it into the absolute configuration at run time, where `process.resourcesPath` is known.
 *
 * Reads no Electron module, so `node --test` can use it.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix } from 'node:path';

/** The runtime Fission is published for on Windows x64 — the default every existing caller and test assumes. */
export const FISSION_RID = 'win-x64';

/**
 * Which .NET runtime identifier each (platform, arch) publishes for. A pair that is not here ships no Fission:
 * the app then starts without the feature instead of carrying a binary that cannot run (fission-config.mjs).
 * macOS is arm64 only in this release; Intel Macs are out of scope by decision, not by accident.
 */
export const FISSION_RIDS = Object.freeze({ 'win32-x64': 'win-x64', 'darwin-arm64': 'osx-arm64' });

/** The runtime identifier for this platform and chip, or null when Fission is not published for it. */
export const fissionRid = (platform, arch) => FISSION_RIDS[`${platform}-${arch}`] ?? null;
/** The CLI project, from the repository root. */
export const FISSION_PROJECT = 'workers/fission/src/Fission.Cli/Fission.Cli.csproj';
/** The published program, and the host that starts it the way Studio starts `dotnet`. */
export const FISSION_CLI = 'Fission.Cli.exe';
export const FISSION_HOST = 'fission-host.exe';
/** What the package says about the configuration it cannot finish (see the header). */
export const FISSION_CONFIG_TEMPLATE = 'fission-config.template.json';
/** The folders `TransitionsDir`, `AssetsRoot` and `LocalAssetsRoot` name, in that order. */
export const FISSION_FOLDERS = Object.freeze(['transitions', 'assets', 'local-assets']);
/** The folder `paths.FontsDir` names: fonts shipped beside the CLI, when a build has any (see the header). */
export const FISSION_FONTS = 'fonts';
/** 随包的 CJK 字体（libass 在 macOS 上没有系统字体目录可用，必须自带一份）。OFL，可再分发。 */
export const FISSION_FONT = 'NotoSansSC-Regular.otf';
const FONT_SOURCE = Object.freeze({
  font: {
    url: 'https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf',
    sha256: '2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b',
  },
  license: {
    url: 'https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/LICENSE',
    sha256: '6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2',
    name: 'OFL.txt',
  },
});
/** The build folder the host's sources and output live in, under the release work folder. */
const HOST_WORK = 'fission-host';

const exe = (name, platform = 'win32') => (platform === 'win32' ? `${name}.exe` : name);

/** The CLI is published for a runtime identifier: its program name follows the platform (no `.exe` off Windows). */
export const fissionCliName = (platform = 'win32') => exe('Fission.Cli', platform);
/**
 * The published entry point, which the configuration names as `cli` (see the header): Windows starts the
 * framework-dependent `Fission.Cli.dll`, macOS its apphost `Fission.Cli`.
 */
export const fissionCliEntry = (platform = 'win32') => (platform === 'win32' ? 'Fission.Cli.dll' : 'Fission.Cli');
/** The host Studio starts as `dotnet`, named the same way. */
export const fissionHostName = (platform = 'win32') => exe('fission-host', platform);

/** `dotnet publish` for the CLI: self-contained (the computer has no .NET), Release, for the Windows x64 runtime. */
export const cliPublishArgs = (project, output, rid = FISSION_RID) => ['publish', project, '-r', rid, '--self-contained', '-c', 'Release', '-o', output];

/** `dotnet publish` for the host: one self-contained file, trimmed (it forwards arguments and waits, nothing else). */
export const hostPublishArgs = (project, output) => ['publish', project, '-c', 'Release', '-o', output];

/**
 * The host's project and program, as text: it is built in the release work folder, not kept in the repository
 * (the program that starts Fission belongs to the packaging step; workers/fission is imported source).
 * @returns {{ csproj: string, program: string }}
 */
export function hostSources({ rid = FISSION_RID, platform = 'win32' } = {}) {
  return {
    csproj: `<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <AssemblyName>fission-host</AssemblyName>
    <RuntimeIdentifier>${rid}</RuntimeIdentifier>
    <SelfContained>true</SelfContained>
    <PublishSingleFile>true</PublishSingleFile>
    <EnableCompressionInSingleFile>true</EnableCompressionInSingleFile>
    <PublishTrimmed>true</PublishTrimmed>
    <InvariantGlobalization>true</InvariantGlobalization>
    <DebugType>none</DebugType>
    <TreatWarningsAsErrors>false</TreatWarningsAsErrors>
  </PropertyGroup>

</Project>
`,
    program: `using System.Diagnostics;

// Studio starts the CLI as spawn(dotnet, [cli, "run", …]). A self-contained Fission has no dotnet.exe,
// so the configuration names this host as dotnet and the published program as cli (the dll on Windows, the
// apphost on macOS): drop that one argument and start the program beside this file. Stdio is inherited
// unchanged — the CLI's START/DONE handshake and its [Fission:…] markers travel over the very pipes Studio
// gave this process.
var argv = Environment.GetCommandLineArgs();
// Studio starts the CLI as spawn(dotnet, [cli, "run", …]) on every platform. argv is [host, cli, run, …]:
// drop the host and the cli argument, and forward from "run" on. Do not branch on ".dll" — on macOS that
// left the apphost path in front of "run", so the CLI saw an unknown verb and failed with CFG_ENGINE_PATHS.
var skip = 2;
var forward = argv.Length > skip ? argv[skip..] : [];
var program = Path.Combine(AppContext.BaseDirectory, "${fissionCliName(platform)}");
if (!File.Exists(program))
{
    Console.Error.WriteLine("[Fission:HOST-MISSING] the Fission CLI is not beside the host.");
    return 3;
}

var start = new ProcessStartInfo(program) { UseShellExecute = false, WorkingDirectory = Environment.CurrentDirectory };
foreach (var argument in forward)
{
    start.ArgumentList.Add(argument);
}

using var child = Process.Start(start)
    ?? throw new InvalidOperationException("[Fission:HOST-START] the Fission CLI did not start.");
child.WaitForExit();
return child.ExitCode;
`,
  };
}

/** What each carried folder is for, as the README that keeps the folder in the package. */
export function folderReadme(folder) {
  return {
    transitions: `GLSL transitions (gl-transitions' shaders, one .glsl per transition).
The engine lists this folder as the only source of transition names
(workers/fission: TransitionCatalog). It holds no shaders yet: with none, a gltransition
backend is impossible anyway (no FFmpeg6 is shipped), so transitions use FFmpeg 9's
xfade mapping and fall back explicitly where none exists (docs/transitions-ffmpeg9.md).
`,
    assets: `Original asset root (AssetsRoot): LUT series, stickers, effect videos and GIFs, borders,
masks and fonts, in the folders AssetRegistry scans (\`智能滤镜\`, \`探店美食滤镜\`, \`特效动图\`,
\`更多特效视频\`, \`更多贴纸\`, \`图片边框\`, \`fonts\`). Empty until an asset set is admitted for
distribution: the corpora are not part of this repository.
`,
    'local-assets': `Local asset root (LocalAssetsRoot): \`bgm/preset\` and \`bgm/library\` for the audio the
person adds themselves. Those live in the app's data folder, not in the installation.
`,
  }[folder] ?? '';
}

/**
 * The absolute run-time configuration for an app whose `resources` folder is `resourcesDir` — what Studio reads
 * (cli, dotnet, and the required paths, `FontsDir` for the fonts the package carries, no FFmpeg6). Pure: no filesystem
 * access, so `FontsDir` is written whether or not the folder is there (the engine reads it as optional).
 * @param {string} resourcesDir the installed app's resources folder (Electron's `process.resourcesPath`)
 * @param {{ platform?: string }} [options]
 */
export function fissionConfigFor(resourcesDir, { platform = 'win32' } = {}) {
  const under = (...parts) => join(resourcesDir, ...parts);
  return {
    cli: under('fission', fissionCliEntry(platform)),
    dotnet: under('fission', exe('fission-host', platform)),
    paths: {
      FFmpeg: under('runtime', 'ffmpeg', exe('ffmpeg', platform)),
      FFprobe: under('runtime', 'ffmpeg', exe('ffprobe', platform)),
      TransitionsDir: under('fission', 'transitions'),
      AssetsRoot: under('fission', 'assets'),
      LocalAssetsRoot: under('fission', 'local-assets'),
      FontsDir: under('fission', FISSION_FONTS),
    },
  };
}

/**
 * The configuration that travels in the package: the same shape, relative to the app's `resources` folder, in
 * forward slashes (the install folder is not known until the person installs). See the header.
 */
export function shippedConfiguration({ platform = 'win32' } = {}) {
  return {
    cli: posix.join('fission', fissionCliEntry(platform)),
    dotnet: posix.join('fission', fissionHostName(platform)),
    paths: {
      FFmpeg: posix.join('runtime', 'ffmpeg', exe('ffmpeg', platform)),
      FFprobe: posix.join('runtime', 'ffmpeg', exe('ffprobe', platform)),
      TransitionsDir: posix.join('fission', 'transitions'),
      AssetsRoot: posix.join('fission', 'assets'),
      LocalAssetsRoot: posix.join('fission', 'local-assets'),
      FontsDir: posix.join('fission', FISSION_FONTS),
    },
  };
}

/**
 * What Studio would reject, as the same rules readLocalFissionConfiguration and EngineRunConfiguration apply:
 * exactly cli/dotnet/paths, the five required path keys (FFmpeg6 and FontsDir optional), absolute paths, and
 * ffmpeg/ffprobe as the two program names in one folder. Pure; `[]` means the configuration is usable.
 * @param {unknown} config @param {{ platform?: string }} [options]
 */
export function configurationProblems(config, { platform = 'win32' } = {}) {
  const problems = [];
  const plain = config !== null && typeof config === 'object' && !Array.isArray(config);
  if (!plain || Object.keys(config).sort().join(',') !== 'cli,dotnet,paths') {
    problems.push('the configuration must hold exactly cli, dotnet and paths');
    return problems;
  }
  for (const key of ['cli', 'dotnet']) {
    const value = config[key];
    if (typeof value !== 'string' || !isAbsolute(value)) problems.push(`${key} is not an absolute path`);
  }
  const paths = config.paths;
  if (paths === null || typeof paths !== 'object' || Array.isArray(paths)) {
    problems.push('paths must be an object');
    return problems;
  }
  const required = ['FFmpeg', 'FFprobe', 'TransitionsDir', 'AssetsRoot', 'LocalAssetsRoot'];
  const allowed = [...required, 'FFmpeg6', 'FontsDir'];
  for (const key of Object.keys(paths)) if (!allowed.includes(key)) problems.push(`paths.${key} is not a key Fission reads`);
  for (const key of required) {
    if (!(key in paths)) problems.push(`paths.${key} is missing`);
    else if (typeof paths[key] !== 'string' || !isAbsolute(paths[key])) problems.push(`paths.${key} is not an absolute path`);
  }
  /* optional, but a value that is there must be the absolute folder the engine will read (EnginePaths.FontsDir) */
  if ('FontsDir' in paths && (typeof paths.FontsDir !== 'string' || !isAbsolute(paths.FontsDir))) {
    problems.push('paths.FontsDir is not an absolute path');
  }
  if (typeof paths.FFmpeg === 'string' && typeof paths.FFprobe === 'string') {
    const fold = (value) => (platform === 'win32' ? value.toLowerCase() : value);
    if (fold(basename(paths.FFmpeg)) !== fold(exe('ffmpeg', platform))) problems.push(`paths.FFmpeg must be named ${exe('ffmpeg', platform)}`);
    if (fold(basename(paths.FFprobe)) !== fold(exe('ffprobe', platform))) problems.push(`paths.FFprobe must be named ${exe('ffprobe', platform)}`);
    if (fold(dirname(paths.FFmpeg)) !== fold(dirname(paths.FFprobe))) problems.push('FFmpeg and FFprobe must be in one folder');
  }
  return problems;
}

/**
 * What a published `resources/fission` must contain, so the pack fails here rather than in the app: the CLI and
 * its runtime, the host, the three folders, and no build leftovers. Pure apart from reading the folder.
 * @param {string} dir @param {{ platform?: string }} [options]
 */
export function publishedProblems(dir, { platform = 'win32' } = {}) {
  const problems = [];
  const file = (name) => {
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) problems.push(`${name} is not a file`);
    } catch {
      problems.push(`${name} is missing`);
    }
  };
  file(fissionCliName(platform));
  file('Fission.Cli.dll');
  file(fissionHostName(platform));
  file(FISSION_CONFIG_TEMPLATE);
  for (const folder of FISSION_FOLDERS) {
    try {
      if (!statSync(join(dir, folder)).isDirectory()) problems.push(`${folder} is not a folder`);
    } catch {
      problems.push(`${folder} is missing`);
    }
  }
  try {
    const configuration = JSON.parse(readFileSync(join(dir, FISSION_CONFIG_TEMPLATE), 'utf8'));
    const expected = JSON.stringify(shippedConfiguration({ platform }));
    if (JSON.stringify(configuration) !== expected) problems.push('the shipped configuration is not the one this step writes');
  } catch {
    problems.push('the shipped configuration cannot be read');
  }
  const leftovers = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.pdb')) : [];
  if (leftovers.length) problems.push(`build leftovers travel in the package: ${leftovers.join(', ')}`);
  return problems;
}

/**
 * Publish Fission into `work/fission`: the CLI self-contained, the host, the folders and the configuration
 * template. Throws when what a run would need is not there. A package with no fonts is not such a case: it warns
 * (`warn`) and the configuration still names `FontsDir` (see the header).
 * @param {{ repoRoot: string, work: string, run?: (cmd: string, args: string[], options?: object) => unknown,
 *   log?: (line: string) => void, warn?: (line: string) => void }} options
 */
/** 下载一个带 sha256 固定的文件到 `file`（先写 .part 再改名）；校验不符就抛。 */
async function pinnedFile(url, sha256, file, fetchImpl) {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== sha256) throw new Error(`${url} did not match its checksum`);
  writeFileSync(`${file}.part`, bytes);
  renameSync(`${file}.part`, file);
}

export async function publishFission({ repoRoot, work, platform = 'win32', arch = 'x64', run = (cmd, args, options = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...options }), log = console.log, warn = console.warn, font = true, fetch: fetchImpl = fetch }) {
  const rid = fissionRid(platform, arch);
  if (!rid) throw new Error(`Fission is not published for ${platform}-${arch}: the app ships without it on that platform.`);
  const target = join(work, 'fission');
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  /** `dotnet publish`, saying what is missing when the build machine has no SDK. */
  const dotnet = (args, cwd) => {
    try {
      return run('dotnet', args, { cwd });
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error('Publishing Fission needs the .NET 10 SDK on the build machine (`dotnet publish` was not found).');
      throw error;
    }
  };

  log(`Fission: publishing the CLI self-contained for ${rid} (no .NET on the computer)`);
  dotnet(cliPublishArgs(join(repoRoot, FISSION_PROJECT), target, rid), repoRoot);

  /* the host: one self-contained file, built from sources written here rather than kept in the repository */
  const hostWork = join(work, HOST_WORK);
  rmSync(hostWork, { recursive: true, force: true });
  mkdirSync(hostWork, { recursive: true });
  const sources = hostSources({ rid, platform });
  writeFileSync(join(hostWork, 'fission-host.csproj'), sources.csproj);
  writeFileSync(join(hostWork, 'Program.cs'), sources.program);
  log('Fission: publishing the host that starts the CLI as Studio starts `dotnet`');
  const hostOut = join(hostWork, 'out');
  dotnet(hostPublishArgs(join(hostWork, 'fission-host.csproj'), hostOut), hostWork);
  cpSync(join(hostOut, fissionHostName(platform)), join(target, fissionHostName(platform)));

  /* the build's own symbols are not part of the program */
  for (const name of readdirSync(target)) {
    if (name.endsWith('.pdb')) rmSync(join(target, name), { force: true });
  }

  /* the folders the engine's explicit paths name, each kept by a README (an empty folder is not a folder in a package) */
  for (const folder of FISSION_FOLDERS) {
    mkdirSync(join(target, folder), { recursive: true });
    writeFileSync(join(target, folder, 'README.txt'), folderReadme(folder));
  }

  /* the configuration cannot hold the install folder yet: relative to resources, resolved at run time */
  writeFileSync(join(target, FISSION_CONFIG_TEMPLATE), `${JSON.stringify(shippedConfiguration({ platform }), null, 2)}\n`);

  /* the fonts are not in this repository: the key is written anyway, and the log says what that costs (the header) */
  /* 字体：libass 在 macOS 上没有可用的系统字体目录，所以随包一份 CJK 字体（OFL）与它的许可证。
     下载失败不阻断打包，只 warning：Windows 仍可用系统字体，macOS 字幕会不可用。 */
  const fonts = join(target, FISSION_FONTS);
  mkdirSync(fonts, { recursive: true });
  if (font && !existsSync(join(fonts, FISSION_FONT))) {
    try {
      await pinnedFile(FONT_SOURCE.font.url, FONT_SOURCE.font.sha256, join(fonts, FISSION_FONT), fetchImpl);
      await pinnedFile(FONT_SOURCE.license.url, FONT_SOURCE.license.sha256, join(fonts, FONT_SOURCE.license.name), fetchImpl);
      log(`Fission: 随包字体 ${FISSION_FONT}（OFL）与 ${FONT_SOURCE.license.name}`);
    } catch (error) {
      warn(`Fission: 字体下载失败（${/** @type {any} */ (error)?.message ?? error}）——macOS 字幕将不可用`);
    }
  }
  const hasFonts = existsSync(join(fonts, FISSION_FONT));
  if (!hasFonts) {
    warn(`Fission: 未随包字体（${fonts} 不存在）——macOS 字幕将不可用（FontsDir 指向的目录没有字体），Windows 仍用系统字体目录`);
  }

  const problems = publishedProblems(target, { platform });
  if (problems.length) throw new Error(`The Fission resources are not what a run needs:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  const bytes = readdirSync(target, { withFileTypes: true }).reduce((sum, item) => sum + (item.isFile() ? statSync(join(target, item.name)).size : 0), 0);
  log(`Fission: ${fissionCliName(platform)}, ${fissionHostName(platform)}, ${FISSION_FOLDERS.join('/')}, ${hasFonts ? FISSION_FONTS : `no ${FISSION_FONTS}`} and ${FISSION_CONFIG_TEMPLATE} in ${target} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
  return { dir: target, cli: fissionCliName(platform), host: fissionHostName(platform), fonts: hasFonts, configuration: shippedConfiguration({ platform }) };
}
