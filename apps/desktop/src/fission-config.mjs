// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * Fission's run-time configuration in an installed app.
 *
 * The package ships Fission under `resources/fission` (scripts/fission-publish.mjs): the CLI published
 * self-contained (the computer never has .NET), the small host that starts it the way Studio starts `dotnet`, and
 * the three folders its explicit paths name. What a build cannot ship is the configuration itself: Studio only
 * accepts it with absolute paths and rejects anything it cannot stat (readLocalFissionConfiguration,
 * packages/openfilm/studio/server/fission-local.mjs), while the install folder is chosen by whoever installs.
 * This module turns the resources folder the app is actually running from into that absolute configuration and
 * writes it into the app's data folder, where main.mjs hands it to Studio (ORANGE_FISSION_CONFIG_FILE).
 *
 * `FFmpeg6` is left out deliberately: it is the optional gltransition engine, nothing ships it, and the engine
 * reads a missing key as "no gltransition" and maps transitions onto FFmpeg 9's xfade
 * (workers/fission/docs/transitions-ffmpeg9.md). FFmpeg and FFprobe are the desktop's own
 * `resources/runtime/ffmpeg`, the same programs the rest of Studio runs.
 *
 * Reads no Electron module — `process.resourcesPath` arrives as an argument — so `node --test` can use it.
 */
import { mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** The file's name in the app's data folder. */
export const FISSION_CONFIG_FILE = 'fission-config.json';

const exe = (name, platform) => (platform === 'win32' ? `${name}.exe` : name);

/**
 * The absolute configuration for an app whose `resources` folder is `resourcesPath`. Pure: no filesystem access.
 * @param {string} resourcesPath the running app's resources folder (Electron's `process.resourcesPath`)
 * @param {{ platform?: string }} [options]
 * @returns {{ cli: string, dotnet: string, paths: Record<string, string> }}
 */
export function fissionConfigFor(resourcesPath, { platform = process.platform } = {}) {
  const under = (...parts) => join(resourcesPath, ...parts);
  return {
    cli: under('fission', 'Fission.Cli.dll'),
    dotnet: under('fission', exe('fission-host', platform)),
    paths: {
      FFmpeg: under('runtime', 'ffmpeg', exe('ffmpeg', platform)),
      FFprobe: under('runtime', 'ffmpeg', exe('ffprobe', platform)),
      TransitionsDir: under('fission', 'transitions'),
      AssetsRoot: under('fission', 'assets'),
      LocalAssetsRoot: under('fission', 'local-assets'),
    },
  };
}

/**
 * Write that configuration into `dataDir` and return the file, or `null` when this copy of the app carries no
 * usable Fission — a build without it (from source, or a platform the CLI is not published for), or a piece the
 * configuration names is not on disk, which Studio would reject anyway. Never throws for a missing install: the
 * app then starts with the feature absent, as it does today.
 *
 * Written through a new file and renamed into place, so a symlink at the destination cannot redirect the write
 * and a half-written file is never read (Studio refuses a configuration it cannot parse).
 * @param {{ resourcesPath?: string, dataDir?: string, platform?: string,
 *   write?: Function, rename?: Function, unlink?: Function, mkdir?: Function, stat?: Function }} options
 * @returns {string | null}
 */
export function writeFissionConfigFile({
  resourcesPath,
  dataDir,
  platform = process.platform,
  write = writeFileSync,
  rename = renameSync,
  unlink = unlinkSync,
  mkdir = mkdirSync,
  stat = statSync,
} = {}) {
  if (typeof resourcesPath !== 'string' || !resourcesPath || !isAbsolute(resourcesPath)) return null;
  if (typeof dataDir !== 'string' || !dataDir || !isAbsolute(dataDir)) return null;
  const file = (value) => {
    try { return stat(value).isFile(); } catch { return false; }
  };
  const folder = (value) => {
    try { return stat(value).isDirectory(); } catch { return false; }
  };
  const config = fissionConfigFor(resourcesPath, { platform });
  if (![config.cli, config.dotnet, config.paths.FFmpeg, config.paths.FFprobe].every(file)) return null;
  if (![config.paths.TransitionsDir, config.paths.AssetsRoot, config.paths.LocalAssetsRoot].every(folder)) return null;

  const path = join(dataDir, FISSION_CONFIG_FILE);
  const temporary = join(dataDir, `${FISSION_CONFIG_FILE}.${process.pid}.tmp`);
  try {
    mkdir(dataDir, { recursive: true });
    try { unlink(temporary); } catch { /* nothing left from a crashed start */ }
    write(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    rename(temporary, path);
  } catch {
    try { unlink(temporary); } catch { /* never written, or already gone */ }
    return null;
  }
  return path;
}
