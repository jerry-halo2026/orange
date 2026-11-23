// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * Fission's configuration as an installed app writes it: absolute paths, no FFmpeg6, 0600, and no configuration at
 * all for a copy of the app that carries no Fission (the app then starts without the feature instead of throwing).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { FISSION_CONFIG_FILE, fissionConfigFor, writeFissionConfigFile } from './fission-config.mjs';
import { fissionConfigFor as shippedRuntimeConfig, configurationProblems } from '../scripts/fission-publish.mjs';

const temp = (prefix) => mkdtempSync(join(tmpdir(), prefix));

/** A `resources` folder shaped like the packaged one (scripts/fission-publish.mjs), as empty files and folders. */
function packaged(platform = 'win32') {
  const resources = temp('of-fission-resources-');
  const exe = (name) => (platform === 'win32' ? `${name}.exe` : name);
  const file = (relative) => {
    const path = join(resources, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'fixture');
  };
  for (const folder of ['transitions', 'assets', 'local-assets']) mkdirSync(join(resources, 'fission', folder), { recursive: true });
  writeFileSync(join(resources, 'fission', 'Fission.Cli.dll'), 'fixture');
  file(join('fission', exe('fission-host')));
  file(join('runtime', 'ffmpeg', exe('ffmpeg')));
  file(join('runtime', 'ffmpeg', exe('ffprobe')));
  return resources;
}

test('the configuration names absolute paths for the CLI, the host, ffmpeg and the three folders, and no FFmpeg6', () => {
  const resources = packaged();
  const config = fissionConfigFor(resources, { platform: 'win32' });
  assert.deepEqual(Object.keys(config).sort(), ['cli', 'dotnet', 'paths'], 'exactly what Studio reads');
  assert.equal(config.cli, join(resources, 'fission', 'Fission.Cli.dll'));
  assert.equal(config.dotnet, join(resources, 'fission', 'fission-host.exe'), 'the host Studio starts as `dotnet`');
  assert.deepEqual(Object.keys(config.paths).sort(), ['AssetsRoot', 'FFmpeg', 'FFprobe', 'FontsDir', 'LocalAssetsRoot', 'TransitionsDir'].sort());
  for (const value of [config.cli, config.dotnet, ...Object.values(config.paths)]) {
    assert.equal(isAbsolute(value), true, `${value} is absolute`);
    assert.equal(value.startsWith(resources), true, `${value} stays in the running app's resources`);
  }
  assert.equal('FFmpeg6' in config.paths, false, 'gltransition is not shipped, so the key is absent');
  assert.equal(join(config.paths.FFmpeg, '..'), join(config.paths.FFprobe, '..'), 'ffmpeg and ffprobe are one folder');
  /* 同一个布局：随包的那份与 app 写出的这份都必须带可选的 FontsDir（字体目录可以缺席，读取端允许）。 */
  assert.deepEqual(config, shippedRuntimeConfig(resources, { platform: 'win32' }), 'the package and the app describe one layout');
  assert.deepEqual(configurationProblems(config, { platform: 'win32' }), [], 'nothing Studio would refuse');
});

test('a macOS-shaped name is the same configuration without the .exe suffix', () => {
  const config = fissionConfigFor(join('/Applications', 'App.app', 'Contents', 'Resources'), { platform: 'darwin' });
  assert.equal(config.cli, join('/Applications', 'App.app', 'Contents', 'Resources', 'fission', 'Fission.Cli'), 'macOS ships an apphost, not a dll');
  assert.equal(config.dotnet, join('/Applications', 'App.app', 'Contents', 'Resources', 'fission', 'fission-host'));
  assert.equal(config.paths.FFmpeg, join('/Applications', 'App.app', 'Contents', 'Resources', 'runtime', 'ffmpeg', 'ffmpeg'));
  assert.equal('FFmpeg6' in config.paths, false);
  assert.equal(config.paths.FontsDir, join('/Applications', 'App.app', 'Contents', 'Resources', 'fission', 'fonts'));
});

test('a copy of the app that carries no Fission gets no configuration, and no error', () => {
  const resources = temp('of-fission-empty-');
  const data = temp('of-fission-data-');
  assert.equal(writeFissionConfigFile({ resourcesPath: resources, dataDir: data }), null);
  assert.throws(() => statSync(join(data, FISSION_CONFIG_FILE)), { code: 'ENOENT' }, 'nothing is written');
  assert.equal(writeFissionConfigFile({ dataDir: data }), null, 'no resources folder named');
  assert.equal(writeFissionConfigFile({ resourcesPath: resources }), null, 'no data folder named');
  assert.equal(writeFissionConfigFile({ resourcesPath: 'resources', dataDir: data }), null, 'a relative resources folder is not one');
});

test('one piece missing means no configuration: Studio would refuse it', () => {
  const data = temp('of-fission-data-');
  for (const missing of [join('fission', 'Fission.Cli.dll'), join('fission', 'fission-host.exe'), join('runtime', 'ffmpeg', 'ffprobe.exe'), join('fission', 'assets')]) {
    const resources = packaged();
    rmSync(join(resources, missing), { recursive: true, force: true });
    assert.equal(writeFissionConfigFile({ resourcesPath: resources, dataDir: data }), null, `${missing} missing`);
  }
});

test('the configuration is written 0600 and read back as what Studio expects', () => {
  const resources = packaged();
  const data = join(temp('of-fission-data-'), 'nested');
  const path = writeFissionConfigFile({ resourcesPath: resources, dataDir: data, platform: 'win32' });
  assert.equal(path, join(data, FISSION_CONFIG_FILE));
  const value = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(value, fissionConfigFor(resources, { platform: 'win32' }));
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600, 'only the owner reads the configuration');
  else assert.ok(statSync(path).isFile());

  /* the mode is asked for on the file that is renamed into place; the tidier check above cannot see it on Windows */
  const written = [];
  const again = writeFissionConfigFile({
    resourcesPath: resources,
    dataDir: data,
    platform: 'win32',
    write: (file, text, options) => { written.push([file, options]); writeFileSync(file, text, options); },
  });
  assert.equal(again, path);
  assert.deepEqual(written.map(([, options]) => options), [{ flag: 'wx', mode: 0o600 }], 'a new file, owner-only, never a rewrite of a path picked by someone else');
});

test('a configuration left from an earlier start is replaced, and a crashed temporary file is cleaned up', () => {
  const resources = packaged();
  const data = temp('of-fission-data-');
  const path = join(data, FISSION_CONFIG_FILE);
  writeFileSync(path, '{"stale":true}');
  writeFileSync(join(data, `${FISSION_CONFIG_FILE}.${process.pid}.tmp`), '{"half":');
  assert.equal(writeFissionConfigFile({ resourcesPath: resources, dataDir: data, platform: 'win32' }), path);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), fissionConfigFor(resources, { platform: 'win32' }));
  assert.throws(() => statSync(join(data, `${FISSION_CONFIG_FILE}.${process.pid}.tmp`)), { code: 'ENOENT' });
});

test('Studio\'s own reader accepts the file this writes', async () => {
  const { readLocalFissionConfiguration } = await import('../../../packages/orangefilm/studio/server/fission-local.mjs');
  const resources = packaged();
  const data = temp('of-fission-data-');
  const path = writeFissionConfigFile({ resourcesPath: resources, dataDir: data, platform: 'win32' });
  assert.deepEqual(await readLocalFissionConfiguration(path), fissionConfigFor(resources, { platform: 'win32' }));
});
