// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The local Fission runtime a bench run can actually start, or what is missing.
 *
 * Studio's Fission pane talks to `fission-local` (server/fission-local-routes.mjs), which only exists when the app's
 * utility process was given `ORANGE_FISSION_CONFIG_FILE` naming a configuration that reads as a runnable runtime
 * (apps/desktop/src/studio-process.mjs): `dotnet`, the Fission CLI, ffmpeg/ffprobe in one folder, and the three engine
 * folders. A missing or invalid one leaves the feature unavailable — the pane says so and every call answers 503 — so a
 * bench test must find out *before* it asserts anything about the wizard, and skip saying which piece is absent.
 *
 * Where the configuration comes from, in this order:
 *
 *   1. `ORANGE_FISSION_CONFIG_FILE` in the environment — what a person pointed the app at;
 *   2. the same key in `.dev/bench-auth.env`, beside the bench's sign-in;
 *   3. `.dev/fission-smoke-runtime.json`, the one a previous run derived (git-ignored, so it never travels);
 *   4. derived here: the packaged app's own `resources` (`.release/win-x64`, laid out by
 *      scripts/fission-publish.mjs `fissionConfigFor`), else the source build in `workers/fission` with the ffmpeg the
 *      packaging fetched and engine folders this file makes under `.dev/`.
 *
 * The rules a configuration is judged by are the packaging step's own (`configurationProblems`) plus the filesystem
 * says-so checks `readLocalFissionConfiguration` makes: files that are files, folders that are folders. Nothing here
 * starts a program or trusts a path it has not looked at.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { configurationProblems, fissionConfigFor, shippedConfiguration } from '../scripts/fission-publish.mjs';

/** The bench's own folder (`apps/desktop`), as app.mjs has it — passed in rather than imported, so this stays callable alone. */
const noop = () => {};

/** `KEY=value` lines as a shell env file has them (`loadBenchAuth` reads the same file this way). */
function entries(file) {
  /** @type {Record<string, string>} */
  const kept = {};
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const found = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (found) kept[found[1]] = found[2].replace(/^(['"])([\s\S]*)\1$/, '$2');
    }
  } catch { /* no such file */ }
  return kept;
}

/**
 * What is wrong with a configuration, in words a person can act on: the packaging step's rules first, then whether
 * each path is there and of the kind it must be. `[]` means Studio will start the runtime from it.
 * @param {unknown} config
 * @param {{ fs?: { lstat: (path: string) => { isFile: () => boolean, isDirectory: () => boolean } } }} [options]
 * @returns {string[]}
 */
export function configurationIssues(config, { fs = { lstat: lstatSync } } = {}) {
  /* 平台必须显式传：configurationProblems 默认 win32，会把 mac 的 `ffmpeg`（无 .exe）判成缺件。 */
  const problems = configurationProblems(config, { platform: process.platform });
  if (problems.length) return problems;
  const value = /** @type {any} */ (config);
  const look = (path) => { try { return fs.lstat(path); } catch { return null; } };
  for (const key of ['dotnet', 'cli']) {
    const stat = look(value[key]);
    if (!stat || !stat.isFile()) problems.push(`${key} is not a file: ${value[key]}`);
  }
  const folders = new Set(['TransitionsDir', 'AssetsRoot', 'LocalAssetsRoot', 'FontsDir']);
  for (const [key, path] of Object.entries(value.paths ?? {})) {
    const stat = look(String(path));
    /* FontsDir 是可选的随包字体目录：缺席不算问题（引擎回落到系统字体）。 */
    if (!stat) { if (key !== 'FontsDir') problems.push(`paths.${key} does not exist: ${path}`); }
    else if (folders.has(key) ? !stat.isDirectory() : !stat.isFile()) problems.push(`paths.${key} is not a ${folders.has(key) ? 'folder' : 'file'}: ${path}`);
  }
  return problems;
}

/**
 * A configuration read from a file, with what is wrong with it: the file itself must be a plain absolute path to a
 * readable JSON document (the same shape `readLocalFissionConfiguration` insists on).
 * @param {string} file
 */
export function readConfiguration(file) {
  if (!isAbsolute(file)) return { config: null, problems: [`ORANGE_FISSION_CONFIG_FILE is not an absolute path: ${file}`] };
  if (!existsSync(file)) return { config: null, problems: [`the configuration is not there: ${file}`] };
  let config;
  try { config = JSON.parse(readFileSync(file, 'utf8')); } catch { return { config: null, problems: [`the configuration cannot be read as JSON: ${file}`] }; }
  const problems = configurationIssues(config).map((problem) => `${problem} (${file})`);
  return { config, problems };
}

/** The packaged app's resources folder, when a release has been built here: it holds fission/ and runtime/ffmpeg. */
function packagedRoot(desktop) {
  for (const root of [join(desktop, '.release', 'win-x64'), join(desktop, '.release')]) {
    const template = join(root, 'fission', 'fission-config.template.json');
    if (!existsSync(template)) continue;
    let shipped;
    try { shipped = JSON.parse(readFileSync(template, 'utf8')); } catch { continue; }
    if (JSON.stringify(shipped) !== JSON.stringify(shippedConfiguration())) continue;
    const config = fissionConfigFor(root);
    if (!configurationIssues(config).length) return { root, config };
  }
  return null;
}

/** `dotnet` where this machine keeps it: the PATH first, then the installer's default folder. */
function findDotnet() {
  const { PATH, Path } = process.env;
  const dirs = String(PATH ?? Path ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
  const names = process.platform === 'win32' ? ['dotnet.exe'] : ['dotnet'];
  for (const dir of dirs) for (const name of names) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  const installed = process.platform === 'win32' ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'dotnet', 'dotnet.exe') : '/usr/local/share/dotnet/dotnet';
  return existsSync(installed) ? installed : null;
}

/** The Fission CLI a source build left behind (Release first: the packaging step publishes Release). */
function findCli(repoRoot) {
  const base = join(repoRoot, 'workers', 'fission', 'src', 'Fission.Cli', 'bin');
  for (const at of ['Release/net10.0', 'Release/net10.0/win-x64', 'Debug/net10.0']) {
    const candidate = join(base, ...at.split('/'), 'Fission.Cli.dll');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** ffmpeg and ffprobe in one folder: named by the environment, fetched by a release, or on the PATH. */
function findMediaTools(desktop, environment) {
  const named = (dir) => (dir && existsSync(join(dir, 'ffmpeg.exe')) && existsSync(join(dir, 'ffprobe.exe')) ? dir : null);
  const fromEnvironment = named(environment.ORANGE_FISSION_FFMPEG_DIR);
  if (fromEnvironment) return fromEnvironment;
  const fromRelease = named(join(desktop, '.release', 'win-x64', 'runtime', 'ffmpeg'));
  if (fromRelease) return fromRelease;
  const { PATH, Path } = environment;
  for (const dir of String(PATH ?? Path ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean)) {
    const found = named(dir);
    if (found) return found;
  }
  return null;
}

/**
 * The runtime configuration this bench run is to use, or the reasons there is none.
 *
 * `configFile` is set on `process.env.ORANGE_FISSION_CONFIG_FILE` by the caller before it launches the app, because
 * that is the one switch the app's utility process reads.
 * @param {{
 *   environment?: Record<string, string | undefined>,
 *   desktop?: string,
 *   log?: (line: string) => void,
 *   write?: boolean,
 * }} [options]
 * @returns {{ configFile: string | null, source: string, problems: string[] }}
 */
export function findFissionRuntime({ environment = process.env, desktop = process.cwd(), log = noop, write = true } = {}) {
  const wanted = join(desktop, '.dev', 'fission-smoke-runtime.json');
  /** Every place a configuration may be named, and how it failed: a skip says all of them, not the last one. */
  const tried = [];
  const accept = (file, source) => {
    const { config, problems } = readConfiguration(file);
    if (!problems.length) return { configFile: file, source, problems: [], config };
    tried.push(...problems.map((problem) => `${source}: ${problem}`));
    return null;
  };

  const fromEnvironment = String(environment.ORANGE_FISSION_CONFIG_FILE ?? '').trim();
  if (fromEnvironment) {
    const found = accept(resolve(fromEnvironment), 'ORANGE_FISSION_CONFIG_FILE');
    if (found) return { configFile: found.configFile, source: found.source, problems: [] };
  }
  const fromBenchAuth = String(entries(join(desktop, '.dev', 'bench-auth.env')).ORANGE_FISSION_CONFIG_FILE ?? '').trim();
  if (fromBenchAuth) {
    const found = accept(resolve(fromBenchAuth), '.dev/bench-auth.env');
    if (found) return { configFile: found.configFile, source: found.source, problems: [] };
  }
  if (existsSync(wanted)) {
    const found = accept(wanted, 'derived earlier');
    if (found) return { configFile: found.configFile, source: found.source, problems: [] };
  }

  const repoRoot = resolve(desktop, '..', '..');
  /** @type {{ source: string, config: any }[]} */
  const derived = [];
  const packaged = packagedRoot(desktop);
  if (packaged) derived.push({ source: 'packaged release', config: packaged.config });
  const dotnet = findDotnet();
  const cli = findCli(repoRoot);
  const media = findMediaTools(desktop, environment);
  if (dotnet && cli && media) {
    const engine = join(desktop, '.dev', 'fission-smoke-runtime');
    const folders = { TransitionsDir: join(engine, 'transitions'), AssetsRoot: join(engine, 'assets'), LocalAssetsRoot: join(engine, 'local-assets') };
    derived.push({
      source: 'source build',
      config: {
        dotnet,
        cli,
        paths: {
          FFmpeg: join(media, 'ffmpeg.exe'),
          FFprobe: join(media, 'ffprobe.exe'),
          ...folders,
        },
      },
    });
  } else {
    tried.push(`source build: ${[!dotnet && 'no dotnet on the PATH', !cli && 'workers/fission is not built (dotnet build workers/fission/Fission.slnx -c Release)', !media && 'no ffmpeg/ffprobe folder (set ORANGE_FISSION_FFMPEG_DIR)'].filter(Boolean).join('; ')}`);
  }

  for (const candidate of derived) {
    /* The three engine folders are this file's own to make (a source build has none), so they are made before the
       paths are judged existent — judging first is what made a fresh checkout un-derivable. */
    for (const dir of [candidate.config.paths.TransitionsDir, candidate.config.paths.AssetsRoot, candidate.config.paths.LocalAssetsRoot]) mkdirSync(dir, { recursive: true });
    const problems = configurationIssues(candidate.config);
    if (problems.length) { tried.push(...problems.map((problem) => `${candidate.source}: ${problem}`)); continue; }
    if (write) {
      try {
        mkdirSync(join(desktop, '.dev'), { recursive: true });
        writeFileSync(wanted, `${JSON.stringify(candidate.config, null, 2)}\n`);
        log(`Fission runtime: wrote ${wanted} from the ${candidate.source}`);
      } catch (error) {
        tried.push(`derived (${candidate.source}): the configuration cannot be written to ${wanted}: ${error?.message ?? error}`);
        continue;
      }
    }
    return { configFile: wanted, source: `derived from the ${candidate.source}`, problems: [] };
  }
  if (!tried.length) tried.push('no Fission runtime configuration was found and none could be derived');
  return { configFile: null, source: 'none', problems: tried };
}
