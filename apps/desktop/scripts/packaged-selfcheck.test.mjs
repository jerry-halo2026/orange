// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * What `--dir` must refuse to pass: each of the three things an install was once missing, and the paths it names.
 * The checks are the build's own gate (release.mjs calls the same function), so a green test here is a green gate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKED_EDITOR_MODULES, PACKED_EDITOR_ROOT, PACKED_MATERIAL_MODULES } from './packed-editor-modules.mjs';
import {
  AUTH_ENVIRONMENT_FILE,
  authEnvironmentCheck,
  ffmpegCheck,
  materialModulesCheck,
  packagedSelfCheck,
  reportSelfCheck,
  unpackedResources,
} from './packaged-selfcheck.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');

const ENVIRONMENT = Object.freeze({
  environmentId: 'orange-test-desktop',
  authOrigin: 'https://auth.example',
  publishableKey: 'sb_publishable_fixture_key',
});

/**
 * A build of its own, in electron-builder's layout, holding the three things a complete one has — or missing what a
 * test leaves out.
 */
function deploymentOf({ environment = ENVIRONMENT, modules = PACKED_MATERIAL_MODULES, binaries = ['ffmpeg.exe', 'ffprobe.exe'], win = true } = {}) {
  const out = mkdtempSync(join(tmpdir(), 'selfcheck-'));
  const resources = unpackedResources({ out, win, arch: 'x64', name: 'Fixture' });
  mkdirSync(resources, { recursive: true });
  if (environment) writeFileSync(join(resources, AUTH_ENVIRONMENT_FILE), JSON.stringify(environment));
  for (const relative of modules) {
    const file = join(resources, PACKED_EDITOR_ROOT, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'export const fixture = true;\n');
  }
  for (const binary of binaries) {
    mkdirSync(join(resources, 'runtime', 'ffmpeg'), { recursive: true });
    writeFileSync(join(resources, 'runtime', 'ffmpeg', binary), '');
  }
  return { out, resources };
}

test('a complete build passes every check, and the environment file is never printed with its key', () => {
  const { out, resources } = deploymentOf();
  const report = reportSelfCheck(packagedSelfCheck({ out, win: true, arch: 'x64', name: 'Fixture' }));
  assert.equal(report.ok, true, report.lines.join('\n'));
  assert.equal(report.lines[0], `unpacked: ${resources}`, 'the folder looked at is named first');
  const environment = report.lines.find((line) => line.includes('auth-environment'));
  assert.match(environment, /^ok {3}auth-environment: /);
  assert.match(environment, /\(authOrigin, environmentId, publishableKey\)/, 'which fields it carries');
  assert.ok(!environment.includes(ENVIRONMENT.publishableKey), 'the key itself stays out of the build log');
  assert.ok(!environment.includes(ENVIRONMENT.authOrigin), 'and so does the origin');
});

test('a missing environment file fails, naming the file it wanted', () => {
  const resources = deploymentOf({ environment: null }).resources;
  const check = authEnvironmentCheck(resources);
  assert.equal(check.ok, false);
  assert.equal(check.detail, `${join(resources, AUTH_ENVIRONMENT_FILE)} is missing`);
  assert.deepEqual(check.missing, [join(resources, AUTH_ENVIRONMENT_FILE)]);
  const report = reportSelfCheck(packagedSelfCheck({ out: deploymentOf({ environment: null }).out, win: true, arch: 'x64', name: 'Fixture' }));
  assert.equal(report.ok, false);
  assert.match(report.lines.join('\n'), /MISSING auth-environment: .*auth-environment\.json is missing/);
  assert.match(report.lines.at(-1), /incomplete: auth-environment/);
});

test('an environment file short of a key fails with that key named, and a blank one counts as missing', () => {
  const short = authEnvironmentCheck(deploymentOf({ environment: { environmentId: 'e', authOrigin: 'https://auth.example' } }).resources);
  assert.equal(short.ok, false);
  assert.deepEqual(short.missing, ['publishableKey']);
  assert.match(short.detail, /lacks publishableKey/);
  const blank = authEnvironmentCheck(deploymentOf({ environment: { ...ENVIRONMENT, authOrigin: '  ' } }).resources);
  assert.deepEqual(blank.missing, ['authOrigin'], 'a blank value is the failure that surfaces later as a refused sign-in');
  const notHttp = authEnvironmentCheck(deploymentOf({ environment: { ...ENVIRONMENT, authOrigin: 'auth.example' } }).resources);
  assert.deepEqual(notHttp.missing, ['authOrigin'], 'the same rule the app reads with');
});

test('the material index modules are the closure of what the tools load, and one missing one is named', () => {
  assert.deepEqual(PACKED_MATERIAL_MODULES, [
    'packages/openfilm/src/material-tools.mjs',
    'packages/openfilm/src/material-index-build.mjs',
    'packages/openfilm/src/material-index.mjs',
    'packages/openfilm/src/material-search.mjs',
    'packages/openfilm/src/material-pack.mjs',
    'packages/openfilm/src/locations.mjs',
    'packages/openfilm/src/development-isolation.mjs',
  ]);
  for (const relative of PACKED_MATERIAL_MODULES) {
    assert.ok(PACKED_EDITOR_MODULES.includes(relative), relative + ' is packed');
    /* material-tools imports material-index-build and material-search, which import the rest: the list is a closure,
       not a guess */
    const text = readFileSync(join(repo, relative), 'utf8');
    const imports = [...text.matchAll(/from '\.\/([^']+\.mjs)'/g)].map((match) => `packages/openfilm/src/${match[1]}`);
    for (const imported of imports) assert.ok(PACKED_MATERIAL_MODULES.includes(imported), imported + ' is packed too');
  }
  const complete = materialModulesCheck(deploymentOf().resources);
  assert.equal(complete.ok, true);
  assert.match(complete.detail, /material-tools\.mjs/);
  const short = materialModulesCheck(deploymentOf({ modules: ['packages/openfilm/src/material-tools.mjs'] }).resources);
  assert.equal(short.ok, false);
  assert.match(short.detail, /material-index-build\.mjs/);
  assert.match(short.detail, /material-index\.mjs/);
});

test('ffmpeg is both programs, not one: a build with ffmpeg alone fails and names ffprobe', () => {
  assert.equal(ffmpegCheck(deploymentOf().resources, { win: true }).ok, true);
  const one = ffmpegCheck(deploymentOf({ binaries: ['ffmpeg.exe'] }).resources, { win: true });
  assert.equal(one.ok, false);
  assert.match(one.detail, /ffprobe\.exe$/);
});

test("the resources folder is electron-builder's own layout for each platform", () => {
  assert.equal(unpackedResources({ out: 'C:/w/out', win: true, arch: 'x64', name: 'X' }), join('C:/w/out', 'win-unpacked', 'resources'));
  assert.equal(
    unpackedResources({ out: '/w/out', win: false, arch: 'arm64', name: 'X' }),
    join('/w/out', 'mac-arm64', 'X.app', 'Contents', 'Resources'),
  );
});

test('release.mjs packs the environment folder into resources and gates --dir on the same checks', () => {
  /* release.mjs builds as it is run, so what it declares is read as written (as scripts/release.test.mjs does) */
  const text = readFileSync(join(here, 'release.mjs'), 'utf8');
  assert.match(text, /from: environmentDir, to: '\.'/, 'the environment lands in the resources root');
  assert.match(text, /packagedSelfCheck\(/, '--dir asks the same function the tests do');
  assert.match(text, /PACKED_EDITOR_MODULES/, 'the material modules travel with the editor modules');
});
