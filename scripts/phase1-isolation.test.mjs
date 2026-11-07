import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let implementation = {};
try { implementation = await import('./phase1-isolation.mjs'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND' || !error.message.includes('phase1-isolation.mjs')) throw error; }
function resolve(config, policy) {
  assert.equal(typeof implementation.resolveIsolationProfile, 'function', 'runtime profile resolver capability is missing');
  return implementation.resolveIsolationProfile(config, policy);
}
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratchParent = path.join(repo, '.dev');
let fixture;
before(() => { mkdirSync(scratchParent, { recursive: true }); fixture = mkdtempSync(path.join(scratchParent, 't01-profile-')); });
after(() => {
  assert.ok(fixture.startsWith(scratchParent + path.sep));
  rmSync(fixture, { recursive: true, force: true });
});
function input(baseRoot = path.join(fixture, 'approved')) {
  return { baseRoot, instanceId: 'instance-a', taskId: 'T01', attemptId: 'attempt-1', ports: { studio: 18471, film: 18472 } };
}
function policy(config) { return { approvedBaseRoot: config.baseRoot }; }
function rejected(config, approval = policy(config)) {
  assert.equal(typeof implementation.resolveIsolationProfile, 'function', 'runtime profile resolver capability is missing');
  assert.throws(() => resolve(config, approval));
}

test('derives every writable location under the explicit instance/task/attempt without creating it', () => {
  const config = input();
  const beforeEntries = readdirSync(fixture);
  const profile = resolve(config, policy(config));
  const scope = path.join(config.baseRoot, 'instance-a', 'T01', 'attempt-1');
  assert.equal(profile.root, scope);
  assert.deepEqual(profile.ports, { studio: 18471, film: 18472 });
  assert.deepEqual(profile.paths, {
    home: path.join(scope, 'home'), sharedHome: path.join(scope, 'shared-home'),
    projects: path.join(scope, 'projects'), saved: path.join(scope, 'Saved'), library: path.join(scope, 'library'),
    exports: path.join(scope, 'exports'), skills: path.join(scope, 'skills'), downloads: path.join(scope, 'downloads'),
    cache: path.join(scope, 'cache'), logs: path.join(scope, 'logs'), temp: path.join(scope, 'temp'),
    crash: path.join(scope, 'crash'), userData: path.join(scope, 'user-data'),
  });
  assert.deepEqual(readdirSync(fixture), beforeEntries);
});

test('rejects absent profile rather than falling back to the official home', () => rejected(undefined, { approvedBaseRoot: path.join(fixture, 'approved') }));
test('requires caller approval independent from the requested base root', () => rejected(input(), {}));
for (const key of ['baseRoot', 'instanceId', 'taskId', 'attemptId', 'ports']) {
  test(`rejects missing ${key}`, () => { const config = input(); delete config[key]; rejected(config, { approvedBaseRoot: path.join(fixture, 'approved') }); });
}
for (const id of ['', '../other', '..', 'instance/b', 'instance\\b', 'CON', 'aux.txt', 'name.', 'name ', 'a:b', 'UPPER', 'i\u0000d']) {
  test(`rejects ambiguous or unsafe instance ID ${JSON.stringify(id)}`, () => rejected({ ...input(), instanceId: id }));
}
test('rejects unapproved root and prefix lookalikes', () => { const config = input(); rejected({ ...config, baseRoot: config.baseRoot + '-other' }, policy(config)); });
test('rejects explicit shared-home overrides instead of silently accepting official state', () => rejected({ ...input(), paths: { sharedHome: path.join(fixture, 'official') } }));
test('rejects cross-instance project overrides', () => rejected({ ...input(), paths: { projects: path.join(fixture, 'approved', 'instance-b', 'T01', 'attempt-1', 'projects') } }));
test('different instances and attempts have disjoint writable locations', () => {
  const config = input();
  const one = resolve(config, policy(config));
  for (const changed of [{ instanceId: 'instance-b' }, { attemptId: 'attempt-2' }]) {
    const two = resolve({ ...config, ...changed }, policy(config));
    for (const a of Object.values(one.paths)) for (const b of Object.values(two.paths)) assert.notEqual(a, b);
  }
});
for (const ports of [{ studio: 18471 }, { studio: 18471, film: 18471 }, { studio: 0, film: 18472 }, { studio: 65536, film: 18472 }, { studio: '18471', film: 18472 }, { studio: 18471.5, film: 18472 }]) {
  test(`rejects absent, colliding or invalid ports ${JSON.stringify(ports)}`, () => rejected({ ...input(), ports }));
}
const invalidWindowsRoots = ['relative', 'E:relative', '\\relative', 'E:\\', 'C:\\isolated', 'c:/isolated', '\\\\server\\share\\isolated', '\\\\?\\E:\\isolated', 'E:/a/../isolated', 'E:/a/./isolated', 'E:/a//isolated', 'E:/isolated/', 'E:/bad./isolated', 'E:/bad /isolated', 'E:/CON/isolated', 'E:/isolate:stream', 'E:/PROGRA~1/isolated'];
for (const baseRoot of invalidWindowsRoots) {
  test(`rejects Windows root escape or alias ${JSON.stringify(baseRoot)}`, () => rejected(input(baseRoot), { approvedBaseRoot: baseRoot, platform: 'win32' }));
}
// Regression: Windows recognizes superscript 1/2/3 as device digits, and
// console stream aliases must not be Windows development directories. On macOS,
// these are ordinary POSIX components; only a native Mac can test that branch.
const reservedWindowsDevices = [
  'COM¹', 'COM²', 'COM³', 'LPT¹', 'LPT²', 'LPT³',
  'com¹.txt', 'com².log', 'com³.data', 'lpt¹.txt', 'lpt².log', 'lpt³.data',
  'CONIN$', 'CONOUT$', 'conin$', 'conout$',
  'CONIN$.txt', 'CONOUT$.log', 'conin$.data', 'conout$.txt',
];
for (const device of reservedWindowsDevices) {
  const behavior = process.platform === 'win32' ? 'rejects Windows reserved device component' : 'accepts macOS ordinary POSIX component';
  test(`${behavior} ${JSON.stringify(device)}`, () => {
    const config = input(path.join(fixture, 'reserved-root', device, 'isolated'));
    if (process.platform === 'win32') {
      assert.throws(() => resolve(config, policy(config)), { name: 'TypeError', message: /path aliases/ });
    } else {
      // These spellings are legal POSIX directory components, not macOS devices.
      // Never simulate darwin filesystem checks on another host or skip Windows
      // rejection checks. Unsupported hosts must fail rather than pass silently.
      assert.equal(process.platform, 'darwin', 'This suite requires a native Windows or macOS host.');
      const profile = resolve(config, policy(config));
      assert.equal(profile.baseRoot, config.baseRoot);
      assert.equal(profile.paths.home, path.join(config.baseRoot, 'instance-a', 'T01', 'attempt-1', 'home'));
    }
  });
}
for (const ordinary of ['COM0', 'COM10', 'COM⁴', 'COM¹safe', 'CONIN$backup', 'CONOUT$backup']) {
  test(`does not mistake ordinary component ${JSON.stringify(ordinary)} for a reserved device`, () => {
    const config = input(path.join(fixture, 'ordinary-root', ordinary, 'isolated'));
    assert.equal(resolve(config, policy(config)).baseRoot, config.baseRoot);
  });
}
test('rejects unsupported platform instead of using host semantics silently', () => rejected(input(), { ...policy(input()), platform: 'linux' }));
test('accepts existing ordinary directories without changing their contents', () => {
  const config = input(path.join(fixture, 'existing'));
  mkdirSync(config.baseRoot);
  writeFileSync(path.join(config.baseRoot, 'sentinel'), 'original');
  assert.equal(resolve(config, policy(config)).baseRoot, config.baseRoot);
  assert.deepEqual(readdirSync(config.baseRoot), ['sentinel']);
});
test('rejects a file in an existing ancestor before attempting directory creation', () => {
  const baseRoot = path.join(fixture, 'file');
  writeFileSync(baseRoot, 'not a directory');
  rejected(input(baseRoot));
});
test('rejects a base-root junction alias even when its target is inside the fixture', () => {
  const target = path.join(fixture, 'outside-base');
  mkdirSync(target);
  const alias = path.join(fixture, 'base-alias');
  symlinkSync(target, alias, 'junction');
  assert.equal(realpathSync(alias), realpathSync(target));
  rejected(input(alias));
});
test('rejects an existing instance junction escaping approved root', () => {
  const config = input(path.join(fixture, 'instance-escape'));
  const target = path.join(fixture, 'outside-instance');
  mkdirSync(config.baseRoot); mkdirSync(target);
  symlinkSync(target, path.join(config.baseRoot, 'instance-a'), 'junction');
  rejected(config);
});
test('rejects a shared-home junction escaping its attempt', () => {
  const config = input(path.join(fixture, 'shared-escape'));
  const scope = path.join(config.baseRoot, 'instance-a', 'T01', 'attempt-1');
  const target = path.join(fixture, 'official-home');
  mkdirSync(scope, { recursive: true }); mkdirSync(target);
  symlinkSync(target, path.join(scope, 'shared-home'), 'junction');
  rejected(config);
});
test('rejects cross-instance junction even if target remains within approved base', () => {
  const config = input(path.join(fixture, 'cross-instance'));
  const scope = path.join(config.baseRoot, 'instance-a', 'T01', 'attempt-1');
  const target = path.join(config.baseRoot, 'instance-b');
  mkdirSync(scope, { recursive: true }); mkdirSync(target);
  symlinkSync(target, path.join(scope, 'projects'), 'junction');
  rejected(config);
});
test('rejects a dangling link rather than treating it as a missing directory', () => {
  const config = input(path.join(fixture, 'dangling'));
  mkdirSync(config.baseRoot);
  symlinkSync(path.join(fixture, 'does-not-exist'), path.join(config.baseRoot, 'instance-a'), 'junction');
  rejected(config);
});
