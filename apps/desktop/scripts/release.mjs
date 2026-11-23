// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * Build the app people install: `pnpm --filter @openfilm/desktop release` (`--arch=x64` for Intel Macs, default this
 * Mac's; `--unsigned` for a local try; `--platform=win --arch=x64|arm64` for the Windows installer, built here too;
 * `--dir` to stop at the unpacked app, no installer — the way to look inside a build, and the step that fails a build
 * short of a file (scripts/packaged-selfcheck.mjs); `--verify` with it to check the build already made, without making
 * it again; `--official` for the project's own build; `--preview` for "OpenFilm Preview", an app of its own to try a
 * build in).
 *
 * Which build it is comes from the `openfilm` package's product files: a build of this source uses product.json,
 * empty in the repository (no update feed: the app never looks for updates); `--official` uses product.official.json
 * (the update feed under its `desktop.updates`).
 *
 *   1. the window's page (shell/: Studio's editor with the chat beside it) and Studio's editor on its own (the
 *      `openfilm` package's UI) are built (the chat's `@openfilm/shared` is bundled into the page);
 *   2. a stage folder gets the app's own files and a plain npm install of what it needs at run time: the `openfilm`
 *      package as `npm pack` makes it (what npm would publish), the agents' ACP adapters
 *      and the updater. Optional dependencies are left out: the adapters would bring the makers' own Claude Code and
 *      Codex programs (200–330 MB each), and the app uses the person's own installation instead (src/agents.mjs).
 *      The staged `openfilm` package gets the build's product.json;
 *   2b. the programs the app needs that are not node modules, for the platform and chip built for, in the app's
 *      resources (runtime/; src/main.mjs puts them to use): ffmpeg and ffprobe with their license (src/ffmpeg-runtime.mjs),
 *      and the headless browser Studio and `openfilm` draw pages in (Playwright's, the revision the staged
 *      playwright-core takes). People never download either: on a slow or blocked connection the first start used to
 *      fail there;
 *   2d. Fission, for a Windows x64 build: the batch mixer's .NET CLI, published self-contained (the computer has no
 *      .NET) into the app's resources, with the host that takes the shape Studio starts `dotnet` in, the three
 *      folders its explicit paths configuration names, and that configuration itself (scripts/fission-publish.mjs).
 *      Its FFmpeg is the one from 2b — the desktop's own resources/runtime/ffmpeg, not a second copy;
 *   2e. the environment the installed app signs into, as `resources/auth-environment.json`: the three fields
 *      `resolveEnvironment({ resourcesDir })` reads (environmentId, authOrigin, publishableKey —
 *      packages/openfilm/src/auth-environment.mjs), taken from `.dev/auth-runtime.json` (or the file
 *      ORANGE_AUTH_CONFIG_FILE names, or the JSON in ORANGE_AUTH_ENV), written 0600 with those three keys and nothing
 *      else: a bench's credentials are never packaged. Without it the installed app cannot say which environment it
 *      belongs to, so a build with no source to take it from says so and `--dir` fails on the missing file;
 *   2f. the editor's own modules, material index included (scripts/packed-editor-modules.mjs), as
 *      resources/openfilm: `openfilm-mcp.mjs` loads `material-tools.mjs` from there, and an install that lacked it
 *      answered every `material.*` call with `not-configured`;
 *   3. electron-builder makes the .dmg (to download) and the .zip (for updates), signed with the Developer ID
 *      OPENFILM_SIGN_IDENTITY ("Name (TEAMID)") and notarized (APPLE_TEAM_ID, the `openfilm-notary` keychain profile or
 *      OPENFILM_NOTARY_PROFILE), with the update feed written in (none without one). Without OPENFILM_SIGN_IDENTITY
 *      and APPLE_TEAM_ID the build is unsigned, as with --unsigned.
 *
 *   4. the .dmg is signed and notarized too, so the download itself opens without a warning.
 *
 * Windows: an NSIS installer (OpenFilm-Setup-<version>-<arch>.exe, per user, no admin) and its feed (latest.yml). It is
 * built on this Mac: the program's icon and version are written into OpenFilm.exe with resedit (rcedit would need
 * wine). Not code-signed yet (no Windows certificate): SmartScreen asks once, "More info" → "Run anyway".
 *
 * npm and pnpm run as node programs (`process.execPath …/npm-cli.js`, `…/pnpm.cjs`), never as bare names: on Windows
 * `npm` is npm.cmd/npm.ps1, not a program, and `execFileSync('npm', …)` there fails with ENOENT before anything is
 * packed (cliCommand() below).
 *
 * Output: .release/<arch>/out (git-ignored). Nothing is uploaded: official builds are published by the project's
 * release pipeline.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { PACKED_EDITOR_MODULES, PACKED_EDITOR_ROOT } from './packed-editor-modules.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lockedOverrides, versionsOffLock } from './locked-versions.mjs';
import { fissionCliName, fissionHostName, fissionRid, publishFission } from './fission-publish.mjs';
import { releaseEnvironment } from './release-environment.mjs';
import { AUTH_ENVIRONMENT_FILE, packagedSelfCheck, reportSelfCheck } from './packaged-selfcheck.mjs';

const require = createRequire(import.meta.url);
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/* the `openfilm` package (Studio, the CLI), where node finds it */
const protocol = dirname(require.resolve('openfilm/package.json'));
const asked = process.argv.find((a) => a.startsWith('--arch='))?.slice('--arch='.length);
const arch = asked === 'x64' || asked === 'arm64' ? asked : process.arch === 'arm64' ? 'arm64' : 'x64';
/* --platform=win, and the machine's own name for it (`--platform win-x64`, which says the arch too): either way the
   build is the Windows one. The value is taken with `=` or as the next word, so both spellings mean the same thing */
const platformArgs = process.argv.filter((arg, index, all) => arg.startsWith('--platform') || all[index - 1] === '--platform');
const win = platformArgs.some((arg) => /win/i.test(arg));
const work = join(desktop, '.release', win ? `win-${arch}` : arch);
const stage = join(work, 'app');
const out = join(work, 'out');
/* the Developer ID ("Name (TEAMID)") and its team, from the environment (the release pipeline's secrets) */
const IDENTITY = process.env.OPENFILM_SIGN_IDENTITY?.trim() || '';
const TEAM_ID = process.env.APPLE_TEAM_ID?.trim() || '';
const unsigned = process.argv.includes('--unsigned') || (!win && (!IDENTITY || !TEAM_ID));
if (unsigned && !win && !process.argv.includes('--unsigned')) {
  console.warn('OPENFILM_SIGN_IDENTITY and APPLE_TEAM_ID are not set: building an unsigned app (not notarized). Official builds are signed by the release pipeline.');
}

/* this build's product: its update feed (see the header) */
const official = process.argv.includes('--official');
/* --preview: "<product> Preview", to try a build in apart from an installed app: its own name and bundle, data
   folder, Studio home, port and projects (src/flavor.mjs `preview`, from the package's `openfilmFlavor`); no updates */
const preview = process.argv.includes('--preview');
if (preview && official) throw new Error('--preview is never the official build');
/* --dir: the unpacked app only (no installer, no signing): the way to look inside a build */
const unpacked = process.argv.includes('--dir');
/* the names, from brand.json at the repository's root (brand.json is the one file that names the product): `productName`
   as the app and its downloads are called, `installerName` as the Windows installer's file is, `companyName` and
   `about.copyright` as the version resource's — a rename is that file, never this script */
const brandFile = join(desktop, '..', '..', 'brand.json');
const brand = existsSync(brandFile) ? JSON.parse(readFileSync(brandFile, 'utf8')) : {};
const said = (value, fallback) => (typeof value === 'string' && value.trim() ? value.trim() : fallback);
const PRODUCT = said(brand.productName, 'OrangeFilm');
const INSTALLER = said(brand.installerName, PRODUCT);
const COMPANY = said(brand.companyName, 'Orange');
const COPYRIGHT = said(brand.about?.copyright, `© 2026 ${PRODUCT}`);
/* the bundle id / Windows AppId, from the same file: it used to be the string this script happened to carry, so every
   installer we built was registered on the machine as somebody else's app (the updater, the data folder and the
   uninstall entry all followed that id). brand.json is the one place that names the product, and this is part of the
   name: a rename is that file, never this script */
const APP_ID = said(brand.appId, 'com.orange.studio');
const NAME = preview ? `${PRODUCT} Preview` : PRODUCT;
const productFile = join(protocol, official ? 'product.official.json' : 'product.json');
const product = JSON.parse(readFileSync(productFile, 'utf8'));
const updates = typeof product.desktop?.updates === 'string' ? product.desktop.updates.trim().replace(/\/+$/, '') : '';
/** Where the packaged app looks for updates (the release's files are uploaded there), or null: it never looks. */
export const FEED = updates ? `${updates}/${win ? 'win' : 'mac'}/${arch}` : null;
const NOTARY_PROFILE = process.env.OPENFILM_NOTARY_PROFILE || 'openfilm-notary';

/* ── npm and pnpm, whoever's machine this is ─────────────────────────────────────────────────────────────────────
 * Windows has no `npm` program, only shims: npm.cmd, and npm.ps1 which PowerShell refuses to load at all (execution
 * policy: "running scripts is disabled on this system"). `execFileSync('npm', …)` looks for npm.exe, finds nothing and
 * fails with ENOENT — so `npm pack` never ran, and neither would `npm install` or pnpm. The same holds for pnpm, a
 * shim over `node …/pnpm.cjs`.
 *
 * So an npm-family CLI is treated as what it is: a JavaScript file, run by the very node running this script.
 * `process.execPath …/npm-cli.js pack …` needs no shell, no .cmd, no PATHEXT and cannot be deflected by a shim on
 * PATH; the arguments stay exactly the fixed ones below, so no quoting or injection question arises. A bare command
 * name is only the last resort (nothing found: npm installed some way this does not know), and then only a shell can
 * start the Windows shim.
 */

/** The `bin` of the package `pkg`, as the node running this script ships it: Windows puts node beside
 *  node_modules, POSIX installs (nvm, Homebrew, /usr/local) put it in <prefix>/lib/node_modules. */
function shippedCli(pkg, bin) {
  const nodeDir = dirname(process.execPath);
  return [join(nodeDir, 'node_modules', pkg, 'bin', bin), join(nodeDir, '..', 'lib', 'node_modules', pkg, 'bin', bin), join(nodeDir, '..', 'libexec', 'lib', 'node_modules', pkg, 'bin', bin)].find((file) => existsSync(file)) ?? null;
}

/** The JavaScript file a shim hands to node, read out of the shim itself: pnpm.cmd says `node "…/pnpm.cjs" %*`, and
 *  npm.cmd names `%~dp0\node_modules\npm\bin\npm-cli.js` (its own folder, written out here). Only a file named after
 *  a wanted `bin` counts: the same shim also names npm-prefix.js and npx-cli.js. */
function cliFromShim(file, bins) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  text = text.replace(/%~dp0/gi, dirname(file));
  const named = [...text.matchAll(/"([^"\r\n]+?\.(?:c|m)?js)"/g), ...text.matchAll(/(?:^|[\s=])((?:[A-Za-z]:[\\/]|\/)[^\s"']+?\.(?:c|m)?js)/gm)]
    /* npm.cmd writes `SET "NPM_CLI_JS=<path>"`: the assignment is not part of the path */
    .map((match) => match[1].replace(/^.*?((?:[A-Za-z]:[\\/]|\/))/s, '$1'))
    .filter((path) => bins.includes(basename(path)));
  return named.find((path) => existsSync(path)) ?? null;
}

/** The JavaScript entry of `pkg`'s `bin` found beside a `name` on PATH: the package next to the shim, or the file
 *  the shim starts. */
function pathCli(pkg, bins, name) {
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const bin of bins) {
      const beside = join(dir, 'node_modules', pkg, 'bin', bin);
      if (existsSync(beside)) return beside;
    }
    for (const shim of [join(dir, `${name}.cmd`), join(dir, name)]) {
      if (!existsSync(shim)) continue;
      const entry = cliFromShim(shim, bins);
      if (entry) return entry;
    }
  }
  return null;
}

/**
 * How to run an npm-family CLI here: `command` and the arguments every call starts with, plus whether a shell is
 * needed (only when no JavaScript entry could be found and the bare name has to be started by one).
 * Looked for in this order: the environment's own `npm_execpath` (set when this runs under `pnpm run release`), the
 * package as a dependency (`require.resolve`), the npm/pnpm shipped with this node, and a shim on PATH.
 * @param {{ pkg: string, bins: string[], name: string }} cli
 * @returns {{ command: string, args: string[], shell: boolean }}
 */
export function cliCommand({ pkg, bins, name }) {
  const execPath = process.env.npm_execpath ?? '';
  const entry = [
    ...(bins.some((bin) => basename(execPath) === bin) ? [execPath] : []),
    ...bins.flatMap((bin) => {
      try {
        return [require.resolve(`${pkg}/bin/${bin}`)];
      } catch {
        return [];
      }
    }),
    ...bins.map((bin) => shippedCli(pkg, bin)),
    pathCli(pkg, bins, name),
  ].find((file) => typeof file === 'string' && file && existsSync(file));
  if (entry) return { command: process.execPath, args: [entry], shell: false };
  return { command: name, args: [], shell: process.platform === 'win32' };
}

/** npm, as a program node can start on this machine (see above). */
export const npmCommand = () => cliCommand({ pkg: 'npm', bins: ['npm-cli.js'], name: 'npm' });
/** pnpm, as a program node can start on this machine (see above). */
export const pnpmCommand = () => cliCommand({ pkg: 'pnpm', bins: ['pnpm.cjs', 'pnpm.mjs', 'pnpm.js'], name: 'pnpm' });

const npm = npmCommand();
const pnpm = pnpmCommand();
/** npm with the arguments this build passes it: fixed literals, never anything a person typed. */
const runNpm = (args, opts = {}) => execFileSync(npm.command, [...npm.args, ...args], { stdio: 'inherit', shell: npm.shell, ...opts });
/** pnpm, the same way. */
const runPnpm = (args, opts = {}) => execFileSync(pnpm.command, [...pnpm.args, ...args], { stdio: 'inherit', shell: pnpm.shell, ...opts });

/* dotnet (2d, scripts/fission-publish.mjs) and the Mac's codesign/xcrun/spctl need no such help: they are programs —
   dotnet.exe on Windows, names under /usr/bin on the Mac — not shells' own shims. */
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const pkg = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));
/* the read-only material service, beside the window in the checkout: it runs as its own Node process */
const api = resolve(desktop, '../api');
/* the platform built for, and where ffmpeg comes from (2b): read here, because `--verify` asks the same question before
   anything is built */
const platform = win ? 'win32' : 'darwin';
const { ffmpegDownloadable, fetchFfmpeg } = await import(pathToFileURL(join(desktop, 'src/ffmpeg-runtime.mjs')).href);

/* --verify: the `--dir` checks against the build already made, and nothing else — no page to build, no package to
   install. It is how a build that lost a file is looked at again (and how a hand-deleted file is shown to fail). */
if (process.argv.includes('--verify')) {
  /* Whether this build carries Fission is a question about the target platform, not about Windows:
     macOS arm64 publishes it too (osx-arm64), and a platform with no runtime identifier ships none. */
  const targetPlatform = win ? 'win32' : 'darwin';
  const fission = fissionRid(targetPlatform, arch)
    ? { cli: fissionCliName(targetPlatform), host: fissionHostName(targetPlatform) }
    : null;
  const report = reportSelfCheck(packagedSelfCheck({ out, win, arch, name: NAME, fission, ffmpeg: ffmpegDownloadable(platform, arch) }));
  console.log(report.lines.join('\n'));
  process.exit(report.ok ? 0 : 1);
}

/* 1. the window's page, and Studio's editor for the package */
const vite = join(dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');
run(process.execPath, [vite, 'build', '--config', 'shell/vite.config.ts', '--logLevel', 'warn'], { cwd: desktop });
/* the old assets stay: a Studio already running from this checkout keeps loading the pages it has open */
run(process.execPath, [vite, 'build', '--config', 'studio/ui/vite.config.ts', '--emptyOutDir=false', '--logLevel', 'warn'], { cwd: protocol });

/* 2. the stage */
rmSync(work, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(desktop, 'src'), join(stage, 'src'), { recursive: true, filter: (from) => !from.endsWith('.test.mjs') && !from.split(/[\\/]/).includes('node_modules') });
cpSync(join(desktop, 'shell/dist'), join(stage, 'shell/dist'), { recursive: true });
/* the material service (apps/api): its source only — the child is `node …/apps/api/src/main.ts` and installs nothing.
   The tests and any node_modules are not shipped: they are not part of the program. */
cpSync(api, join(stage, 'apps', 'api'), { recursive: true, filter: (from) => !from.includes('node_modules') && !from.endsWith('.test.ts') });
const pack = (dir) => runNpm(['pack', '--ignore-scripts', '--pack-destination', work, '--silent'], { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim().split('\n').pop();
const dependencies = { ...pkg.dependencies, openfilm: `file:../${pack(protocol)}` };
/* npm takes the versions pnpm's lockfile has (locked-versions.mjs): what the tests ran with, not the latest */
const lockedTree = JSON.parse(runPnpm(['list', '--prod', '--depth', 'Infinity', '--json'], { cwd: desktop, encoding: 'utf8', stdio: 'pipe', maxBuffer: 256 * 1024 * 1024 }))[0];
writeFileSync(join(stage, 'package.json'), `${JSON.stringify({
  name: 'openfilm-desktop',
  productName: NAME,
  ...(preview ? { openfilmFlavor: 'preview' } : {}),
  version: pkg.version,
  description: pkg.description,
  author: PRODUCT,
  license: 'UNLICENSED',
  private: true,
  type: 'module',
  main: 'src/main.mjs',
  dependencies,
  overrides: lockedOverrides(lockedTree, pkg.dependencies),
}, null, 2)}\n`);
runNpm(['install', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund', '--no-package-lock', '--loglevel=error'], { cwd: stage });
const offLock = versionsOffLock(lockedTree, join(stage, 'node_modules'));
if (offLock.length) {
  throw new Error(`The installer's packages are not the lockfile's:\n${offLock.map((p) => `  ${p.name} ${p.version} (locked: ${p.locked.join(', ')})`).join('\n')}`);
}
/* the build's product file */
cpSync(productFile, join(stage, 'node_modules/openfilm/product.json'));
/* models and project templates are excluded from npm pack (`files`), but the installed app needs them:
   BGE for local material search, Whisper for subtitles, and the project templates the canvas offers. */
for (const part of ['models', 'project-templates']) {
  const from = join(protocol, 'library', part);
  if (existsSync(from)) {
    cpSync(from, join(stage, 'node_modules/openfilm/library', part), { recursive: true });
    console.log(`library/${part}: copied into the installed package`);
  } else {
    console.warn(`library/${part}: not in this checkout — the installed app will miss it`);
  }
}

/* 2b. ffmpeg and the headless browser, for the platform and chip built for */
const runtime = join(work, 'runtime');
if (ffmpegDownloadable(platform, arch)) {
  /* 离线/慢网：用已下载好的同一版本 ffmpeg 目录，跳过发布时的再下载（内容与 pin 一致，license 也带）。 */
  const cachedFfmpeg = String(process.env.OPENFILM_FFMPEG_CACHE ?? '').trim();
  if (cachedFfmpeg && existsSync(join(cachedFfmpeg, 'ffmpeg'))) cpSync(cachedFfmpeg, join(runtime, 'ffmpeg'), { recursive: true });
  else await fetchFfmpeg(join(runtime, 'ffmpeg'), { platform, arch, license: true });
} else console.warn(`No ffmpeg build for ${platform}-${arch}: this app downloads none either; people install their own.`);
/* 同理：已装好的 Playwright 浏览器目录直接复制，安装器在目录已存在时不再联网。 */
const cachedBrowsers = String(process.env.OPENFILM_PLAYWRIGHT_CACHE ?? '').trim();
if (cachedBrowsers && existsSync(cachedBrowsers)) {
  cpSync(cachedBrowsers, join(runtime, 'ms-playwright'), { recursive: true });
} else {
  run(process.execPath, [join(stage, 'node_modules/playwright-core/cli.js'), 'install', 'chromium-headless-shell'], {
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(runtime, 'ms-playwright'), PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: win ? 'win64' : arch === 'arm64' ? 'mac15-arm64' : 'mac15' },
  });
}

/* 2d. Fission, for Windows x64: the batch mixer Studio's own pane starts. It is a .NET program and the computer
   has no .NET, so it is published self-contained, with the host that takes the shape Studio starts `dotnet` in,
   the folders its explicit paths configuration names, and that configuration (scripts/fission-publish.mjs). Its
   ffmpeg and ffprobe are the ones from 2b: the desktop's own resources/runtime/ffmpeg, not a second copy */
const targetPlatform = win ? 'win32' : 'darwin';
const fission = fissionRid(targetPlatform, arch)
  ? await publishFission({ repoRoot: resolve(desktop, '..', '..'), work, platform: targetPlatform, arch })
  : null;
if (!fission) console.warn(`Fission is not published for ${win ? 'win32' : 'darwin'}-${arch}: this build carries none.`);

/* 2c. the editor's own modules, beside the archive: the MCP tools load them by name
   (src/openfilm-mcp.mjs reads resources/openfilm/... in an installed app; the checkout has no such
   folder, which is why they are copied rather than reached by relative path) */
const openfilmModules = join(work, PACKED_EDITOR_ROOT);
for (const relative of PACKED_EDITOR_MODULES) {
  const to = join(openfilmModules, relative);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(join(desktop, '..', '..', relative), to);
}

/* 2e. the environment the installed app signs into: `resources/auth-environment.json`, exactly the three fields
   `resolveEnvironment({ resourcesDir })` reads. Where it comes from, and why a build without one stops instead of
   warning, is scripts/release-environment.mjs: the committed `release/environment.json` is the source, an explicit
   override can replace it, and `.dev/auth-runtime.json` is deliberately not a source — that file exists on one
   machine, and an installer built from it cannot be reproduced anywhere else */
const packagedEnvironment = releaseEnvironment({ desktop });
const environmentDir = join(work, 'environment');
mkdirSync(environmentDir, { recursive: true });
{
  const file = join(environmentDir, AUTH_ENVIRONMENT_FILE);
  writeFileSync(file, `${JSON.stringify(packagedEnvironment.description, null, 2)}\n`);
  chmodSync(file, 0o600);
  /* the id names the environment, never the key: a build log is pasted into issues and chat */
  console.log(`environment: ${packagedEnvironment.origin} → ${AUTH_ENVIRONMENT_FILE} (environmentId=${packagedEnvironment.description.environmentId}; 0600)`);
}

/* 3. the app */
const builder = require('electron-builder');
const electronVersion = require('electron/package.json').version;
const env = unsigned || win ? { CSC_IDENTITY_AUTO_DISCOVERY: 'false' } : { APPLE_KEYCHAIN_PROFILE: NOTARY_PROFILE, APPLE_TEAM_ID: TEAM_ID };
Object.assign(process.env, env);
await builder.build({
  projectDir: stage,
  publish: 'never',
  ...(unpacked ? { dir: true } : win ? { win: ['nsis'] } : { mac: ['dmg', 'zip'] }),
  [arch]: true,
  config: {
    afterPack: win ? (context) => windowsResources(context).catch((error) => { console.warn(`windows resources skipped: ${error?.message ?? error}`); }) : undefined,
    /* afterPack runs before electron-builder's executable edit; this runs after it and before the installer. */
    artifactBuildStarted: win ? (context) => windowsResources({ appOutDir: context.packager.appOutDir }).catch((error) => { console.warn(`windows resources skipped at artifact: ${error?.message ?? error}`); }) : undefined,
    /* unsigned on a Mac: signed ad hoc, whole, before the .dmg and .zip are made. Electron's fuses are written into
       its framework after the linker signed it, and an Apple chip kills a program whose pages no longer match its
       signature ("Code Signature Invalid") the moment it starts */
    afterSign: !win && unsigned ? (context) => adHocSign(context) : undefined,
    win: {
      icon: join(desktop, 'build/icon.ico'),
      /* electron-builder skips its own resource edit; afterPack writes the icon after packing, and fuses are off. */
      signAndEditExecutable: false,
      /* the installer's own file name: brand.json's `installerName` (OrangeFilm-Setup-<arch>.exe) */
      artifactName: `${INSTALLER.replace(' ', '-')}-Setup-\${arch}.\${ext}`,
    },
    nsis: {
      /* electron-builder's NSIS target keeps `.mp4`/`.webm`/… out of the archive and adds them back one by one, and that
         walk does not enter a folder named `node_modules` — ours is `resources/app.asar.unpacked/node_modules/openfilm`.
         The library's preview videos were therefore dropped from every Windows installer without a warning, and the
         cards had nothing to play under the pointer. `null` keeps them in the archive like any other file; they are
         9.6 MB, so 7z compressing them costs little. This line comes before the names below on purpose: they are
         written as template placeholders, and `release.test.mjs` reads this setting out of the script's text, where a
         checker that cannot cross a closing brace would otherwise stop short of it. */
      preCompressedFileExtensions: null,
      /* the installer asks where to put the app (the person's own folder by default), so it need not live on C: */
      oneClick: false,
      allowToChangeInstallationDirectory: true,
      perMachine: false,
      installerIcon: join(desktop, 'build/icon.ico'),
      uninstallerIcon: join(desktop, 'build/icon.ico'),
      shortcutName: NAME,
      deleteAppDataOnUninstall: false,
      artifactName: `${INSTALLER.replace(' ', '-')}-Setup-\${arch}.\${ext}`,
    },
    appId: preview ? `${APP_ID}.preview` : APP_ID,
    productName: NAME,
    copyright: `Copyright ${COPYRIGHT}`,
    electronVersion,
    asar: true,
    /* run by Electron as Node from outside the archive: the CLI the agents run, the agents' adapters, and the
       material service's source (a plain node child cannot read an asar archive) */
    asarUnpack: ['node_modules/openfilm/**', 'node_modules/@agentclientprotocol/**', 'node_modules/playwright-core/**', 'apps/api/**'],
    files: ['src/**/*', 'shell/dist/**/*', 'apps/api/**/*', 'package.json', 'node_modules/**/*'],
    /* ffmpeg, the headless browser (2b) and Fission (2d), as files of their own beside the archive: they run as
       programs. Fission's ffmpeg is the same resources/runtime/ffmpeg folder, never a second copy */
    extraResources: [
      { from: runtime, to: 'runtime' },
      ...(fission ? [{ from: fission.dir, to: 'fission' }] : []),
      { from: openfilmModules, to: PACKED_EDITOR_ROOT },
      /* the environment the app signs into (2e), at the root of resources where resolveEnvironment() reads it:
         `to: '.'` is a folder's contents into the resources folder itself, not a folder of its own */
      { from: environmentDir, to: '.' },
      /* brand.json beside the archive: what the packaged app calls itself (src/brand.mjs reads it there), so a
         renamed product needs a rebuild of this file, never a new string in the source */
      { from: brandFile, to: 'brand.json' },
    ],
    directories: { output: out, buildResources: join(desktop, 'build') },
    /* Fuses rewrite the executable after afterPack and drop the icon Windows resources wrote. The app needs
       RunAsNode (the MCP server is this exe as Node); keep Electron's defaults instead of rewriting the PE. */
    electronFuses: false,
    /* one feed folder for both channels: the app reads latest(-mac).yml, or beta(-mac).yml when Beta Updates is on
       (src/update-channel.mjs); publishing puts this build's feed under either name */
    publish: FEED ? [{ provider: 'generic', url: FEED, channel: 'latest' }] : null,
    mac: {
      category: 'public.app-category.video',
      icon: join(desktop, 'build/icon.icns'),
      minimumSystemVersion: '13.0',
      /* the .zip the updater downloads; the .dmg has its own name (dmg.artifactName) */
      artifactName: `${NAME.replace(' ', '-')}-\${version}-\${arch}-mac.\${ext}`,
      hardenedRuntime: true,
      gatekeeperAssess: false,
      entitlements: join(desktop, 'build/entitlements.mac.plist'),
      entitlementsInherit: join(desktop, 'build/entitlements.mac.plist'),
      /* what macOS says when Studio's record button first asks for the microphone (the entitlement above lets it) */
      extendInfo: { NSMicrophoneUsageDescription: `${PRODUCT} records sound from the microphone when you press Record.` },
      ...(unsigned ? { identity: null } : { identity: IDENTITY, notarize: true }),
    },
    /* the downloads keep one name from version to version: the website links the latest release's by it */
    dmg: { title: NAME, artifactName: `${NAME.replace(' ', '-')}-\${arch}.\${ext}` },
  },
});

if (!unpacked && !unsigned && !win && FEED) {
  const app = join(out, arch === 'arm64' ? 'mac-arm64' : 'mac', `${NAME}.app`);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  run('/usr/bin/xcrun', ['stapler', 'validate', app]);
  /* 4. the download */
  const dmg = join(out, `${NAME.replace(' ', '-')}-${arch}.dmg`);
  run('/usr/bin/codesign', ['--sign', `Developer ID Application: ${IDENTITY}`, '--timestamp', dmg]);
  run('/usr/bin/xcrun', ['notarytool', 'submit', dmg, '--keychain-profile', NOTARY_PROFILE, '--wait']);
  run('/usr/bin/xcrun', ['stapler', 'staple', dmg]);
  run('/usr/sbin/spctl', ['-a', '-t', 'open', '--context', 'context:primary-signature', '-v', dmg]);
  /* signing and stapling changed the .dmg: the feed lists it as it is now (the updater itself takes the .zip) */
  const bytes = readFileSync(dmg);
  const sha512 = createHash('sha512').update(bytes).digest('base64');
  const feed = join(out, 'latest-mac.yml');
  const name = basename(dmg);
  writeFileSync(feed, readFileSync(feed, 'utf8').replace(new RegExp(`(- url: ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n\\s+sha512: )\\S+(\\n\\s+size: )\\d+`), `$1${sha512}$2${bytes.length}`));
  if (!readFileSync(feed, 'utf8').includes(sha512)) throw new Error('the feed does not list the signed .dmg');
}
/* What is actually inside the app, looked at where it will be read from (resources/). Every build, not only `--dir`:
   an installer is what reaches a person, and a check that ran only for the build you look inside is how a build with
   no environment shipped twice (2026-11-19). One missing file fails the build, and the installers this run produced
   are moved into `out/incomplete/` — a failed build must not leave something publishable under a name a script picks
   up (scripts/packaged-selfcheck.mjs names each file it wants) */
{
  const report = reportSelfCheck(
    packagedSelfCheck({
      out,
      win,
      arch,
      name: NAME,
      fission: fission ? { cli: fissionCliName(targetPlatform), host: fissionHostName(targetPlatform) } : null,
      ffmpeg: ffmpegDownloadable(platform, arch),
    }),
  );
  console.log(report.lines.join('\n'));
  if (!report.ok) {
    const incomplete = join(out, 'incomplete');
    mkdirSync(incomplete, { recursive: true });
    for (const file of readdirSync(out).filter((name) => /\.(dmg|zip|exe|yml|blockmap)$/.test(name))) {
      renameSync(join(out, file), join(incomplete, file));
    }
    console.error(`the build is incomplete (${report.checks.filter((check) => !check.ok).map((check) => check.label).join(', ')}): its installers are in ${incomplete}`);
    process.exitCode = 1;
  }
}
console.log(`\n${readdirSync(out).filter((f) => /\.(dmg|zip|exe|yml)$/.test(f)).map((f) => join(out, f)).join('\n')}`);
console.log(`feed: ${FEED ?? 'none (a build of this source: it never looks for updates)'}`);
if (!unpacked && FEED && !existsSync(join(out, win ? 'latest.yml' : 'latest-mac.yml'))) process.exitCode = 1;

/** An unsigned Mac app signed ad hoc (no identity), all of it, so it starts. @param {{ appOutDir: string }} context */
function adHocSign(context) {
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', join(context.appOutDir, `${NAME}.app`)], { stdio: 'inherit' });
}

/** The app's .exe: its icon and version, as rcedit would write them (brand.json's names, never this script's). */
async function windowsResources(context) {
  const ResEdit = await import('resedit');
  const PE = await import('pe-library');
  const file = join(context.appOutDir, `${NAME}.exe`);
  const exe = PE.NtExecutable.from(readFileSync(file), { ignoreCert: true });
  const res = PE.NtExecutableResource.from(exe);
  const icon = ResEdit.Data.IconFile.from(readFileSync(join(desktop, 'build/icon.ico')));
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, icon.icons.map((item) => item.data));
  const info = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0] ?? ResEdit.Resource.VersionInfo.createEmpty();
  const [major, minor, patch] = pkg.version.split('.').map(Number);
  info.setFileVersion(major, minor, patch, 0, 1033);
  info.setProductVersion(major, minor, patch, 0, 1033);
  /* brand.json says the © line as a person reads it ("© 2026 OrangeFilm"); the version resource's own field says
     "Copyright © 2026 OrangeFilm", so the word is put in front once */
  const legalCopyright = /^copyright\b/i.test(COPYRIGHT) ? COPYRIGHT : `Copyright ${COPYRIGHT}`;
  info.setStringValues({ lang: 1033, codepage: 1200 }, {
    ProductName: PRODUCT, FileDescription: PRODUCT, CompanyName: COMPANY, OriginalFilename: `${NAME}.exe`,
    InternalName: PRODUCT, LegalCopyright: legalCopyright, FileVersion: pkg.version, ProductVersion: pkg.version,
  });
  info.outputToResourceEntries(res.entries);
  res.outputResource(exe);
}

