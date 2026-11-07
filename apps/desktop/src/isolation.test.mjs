import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launcherEnvironment, childEnvironment } from './environment.mjs';
let api = {};
try {
    api = await import('./isolation.mjs');
}
catch (e) {
    if (e.code !== 'ERR_MODULE_NOT_FOUND')
        throw e;
}
function capability(name) { assert.equal(typeof api[name], 'function', `missing ${name}`); return api[name]; }
let fixture;
before(() => { fixture = mkdtempSync(join(tmpdir(), 'desktop-isolation-')); });
after(() => rmSync(fixture, { recursive: true, force: true }));
function declaration() {
    const config = { baseRoot: join(fixture, 'approved'), instanceId: 'instance-a', taskId: 'T01', attemptId: 'attempt-1', ports: { studio: 18471, film: 18472 } };
    return { OPENFILM_ISOLATION_PROFILE: Buffer.from(JSON.stringify(config)).toString('base64url'), OPENFILM_ISOLATION_ROOT: config.baseRoot };
}
test('launcher and child environment carry identical isolated native paths despite legacy extras', () => {
    const source = declaration();
    const launched = launcherEnvironment(source, process.env.PATH);
    assert.equal(launched.OPENFILM_ISOLATION_PROFILE, source.OPENFILM_ISOLATION_PROFILE);
    const child = childEnvironment({ source: launched, shell: { PATH: process.env.PATH }, extra: { OPENFILM_HOME: 'legacy', OPENFILM_SHARED_HOME: 'official' } });
    assert.equal(child.OPENFILM_HOME, join(source.OPENFILM_ISOLATION_ROOT, 'instance-a', 'T01', 'attempt-1', 'home'));
    assert.equal(child.OPENFILM_SHARED_HOME, join(source.OPENFILM_ISOLATION_ROOT, 'instance-a', 'T01', 'attempt-1', 'shared-home'));
    assert.equal(child.TEMP, join(source.OPENFILM_ISOLATION_ROOT, 'instance-a', 'T01', 'attempt-1', 'temp'));
});
test('Electron native paths are configured before readiness, all directory writes follow validation', () => {
    const calls = [];
    const env = declaration();
    const app = { isPackaged: false, isReady: () => false, setPath: (key, value) => calls.push(['path', key, value]), setAppLogsPath: (value) => calls.push(['logs', value]), commandLine: { appendSwitch: (key, value) => calls.push(['switch', key, value]) } };
    const profile = capability('prepareDesktopIsolation')(app, env, { mkdir: (value) => calls.push(['mkdir', value]) });
    for (const [key, want] of Object.entries({ userData: profile.paths.userData, sessionData: join(profile.paths.cache, 'session'), temp: profile.paths.temp, downloads: profile.paths.downloads, crashDumps: profile.paths.crash }))
        assert.ok(calls.some(c => c[0] === 'path' && c[1] === key && c[2] === want), key);
    assert.ok(calls.some(c => c[0] === 'logs' && c[1] === profile.paths.logs));
});
test('invalid or packaged profile creates no directories and changes no Electron paths', () => {
    let effects = 0;
    const app = { isPackaged: true, isReady: () => false, setPath: () => effects++ };
    assert.throws(() => capability('prepareDesktopIsolation')(app, declaration(), { mkdir: () => effects++ }));
    assert.equal(effects, 0);
});
test('Electron validates derived appData aliases before the first directory creation', async () => {
    const { mkdirSync, symlinkSync } = await import('node:fs');
    const { readIsolationProfile } = await import('openfilm/development-isolation');
    const env = declaration();
    const p = readIsolationProfile(env);
    mkdirSync(p.paths.userData, { recursive: true });
    const outside = join(fixture, 'outside-appdata');
    mkdirSync(outside);
    symlinkSync(outside, join(p.paths.userData, 'appdata'), 'junction');
    let effects = 0;
    const app = { isPackaged: false, isReady: () => false, setPath: () => effects++, setAppLogsPath() { }, commandLine: { appendSwitch() { } } };
    assert.throws(() => capability('prepareDesktopIsolation')(app, env, { mkdir: () => effects++ }), /link|alias/);
    assert.equal(effects, 0);
});
