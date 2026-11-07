import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as launcher from './start.mjs';
test('invalid isolation is rejected before build, runtime lookup, directories or spawn', async () => {
    assert.equal(typeof launcher.startDevelopment, 'function', 'missing testable native launcher');
    let effects = 0;
    await assert.rejects(() => launcher.startDevelopment({ source: { OPENFILM_ISOLATION_PROFILE: 'broken' }, adapters: { build: () => effects++, electron: () => effects++, mkdir: () => effects++, spawn: () => effects++ } }));
    assert.equal(effects, 0);
});
test('original launcher passes the resolved profile through build and Electron spawn', async () => {
    assert.equal(typeof launcher.startDevelopment, 'function', 'missing testable native launcher');
    const fixture = mkdtempSync(join(tmpdir(), 'launcher-profile-'));
    try {
        const cfg = { baseRoot: join(fixture, 'approved'), instanceId: 'instance-a', taskId: 'T01', attemptId: 'attempt-1', ports: { studio: 18471, film: 18472 } };
        const source = { OPENFILM_ISOLATION_PROFILE: Buffer.from(JSON.stringify(cfg)).toString('base64url'), OPENFILM_ISOLATION_ROOT: cfg.baseRoot };
        let built, spawned;
        const child = new EventEmitter();
        await launcher.startDevelopment({ source, argv: [], adapters: { build: (env) => { built = env; }, electron: () => '/unused-electron', runtime: async (executable) => executable, login: async () => ({ PATH: process.env.PATH }), spawn: (exe, args, options) => { spawned = options.env; return child; }, control: { on() { } } } });
        const want = join(cfg.baseRoot, 'instance-a', 'T01', 'attempt-1', 'home');
        assert.equal(built.OPENFILM_HOME, want);
        assert.equal(spawned.OPENFILM_HOME, want);
        assert.equal(spawned.OPENFILM_STUDIO_PORT, '18471');
        assert.equal(spawned.OPENFILM_DESKTOP_FLAVOR, 'dev');
    }
    finally {
        rmSync(fixture, { recursive: true, force: true });
    }
});
