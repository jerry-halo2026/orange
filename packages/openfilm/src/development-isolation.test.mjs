import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let api = {};
try {
    api = await import('./development-isolation.mjs');
}
catch (e) {
    if (e.code !== 'ERR_MODULE_NOT_FOUND')
        throw e;
}
function capability(name) { assert.equal(typeof api[name], 'function', `missing ${name}`); return api[name]; }
let fixture;
before(() => { fixture = mkdtempSync(join(tmpdir(), 'native-profile-')); });
after(() => rmSync(fixture, { recursive: true, force: true }));
const config = () => ({ baseRoot: join(fixture, 'approved'), instanceId: 'instance-a', taskId: 'T01', attemptId: 'attempt-1', ports: { studio: 18471, film: 18472 } });
const declaration = (value = config()) => ({ OPENFILM_ISOLATION_PROFILE: Buffer.from(JSON.stringify(value)).toString('base64url'), OPENFILM_ISOLATION_ROOT: value.baseRoot });
test('no opt-in preserves the original environment and does not invent a profile', () => { assert.equal(capability('readIsolationProfile')({}), null); });
test('explicit profile round-trips through the original environment transport', () => {
    const profile = capability('readIsolationProfile')(declaration());
    const env = capability('isolationEnvironment')(profile);
    assert.equal(env.OPENFILM_HOME, join(profile.root, 'home'));
    assert.equal(env.OPENFILM_SHARED_HOME, join(profile.root, 'shared-home'));
    assert.equal(env.OPENFILM_LIBRARY, join(profile.root, 'projects'));
    assert.equal(env.OPENFILM_SAVED, join(profile.root, 'Saved'));
    assert.equal(env.OPENFILM_LIBRARY_CACHE, join(profile.root, 'library'));
    assert.equal(env.OPENFILM_SKILLS, join(profile.root, 'skills'));
    assert.equal(env.OPENFILM_EXPORTS, join(profile.root, 'exports'));
    assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, join(profile.root, 'cache', 'browsers'));
    for (const key of ['TEMP', 'TMP', 'TMPDIR'])
        assert.equal(env[key], join(profile.root, 'temp'));
    assert.equal(env.OPENFILM_STUDIO_PORT, '18471');
    assert.equal(env.OPENFILM_NO_UPDATE_CHECK, '1');
    assert.deepEqual(capability('readIsolationProfile')(env), profile);
});
for (const env of [{ OPENFILM_ISOLATION_PROFILE: 'broken' }, { OPENFILM_ISOLATION_ROOT: 'missing' }, { OPENFILM_ISOLATION_PROFILE: '' }]) {
    test(`partial or malformed opt-in fails closed ${JSON.stringify(env)}`, () => { assert.throws(() => capability('readIsolationProfile')(env)); });
}
test('native server paired ports reject an unhonorable arbitrary film port', () => {
    const value = config();
    value.ports.film = 18479;
    assert.throws(() => capability('readIsolationProfile')(declaration(value)), /next|pair/);
});
test('development profiles cannot be used by a packaged release', () => { assert.throws(() => capability('readIsolationProfile')(declaration(), { packaged: true }), /packaged/); });
test('effective isolated environment refuses contradictory legacy path values', () => {
    assert.throws(() => capability('readIsolationProfile')({ ...declaration(), OPENFILM_SHARED_HOME: join(fixture, 'official') }), /conflict|match/);
});
test('write boundary checks reject outside and traversal before touching filesystem', () => {
    const profile = capability('readIsolationProfile')(declaration());
    const check = capability('assertIsolationPath');
    assert.equal(check(profile, join(profile.paths.exports, 'one'), 'exports'), join(profile.paths.exports, 'one'));
    assert.throws(() => check(profile, join(fixture, 'outside'), 'exports'));
    assert.throws(() => check(profile, profile.paths.exports + '/a/../outside', 'exports'));
});
test('write boundary rechecks new filesystem links created after profile resolution', () => {
    const profile = capability('readIsolationProfile')(declaration());
    mkdirSync(profile.paths.exports, { recursive: true });
    const external = join(fixture, 'external');
    mkdirSync(external);
    symlinkSync(external, join(profile.paths.exports, 'link'), 'junction');
    assert.throws(() => capability('assertIsolationPath')(profile, join(profile.paths.exports, 'link', 'out'), 'exports'));
});
