import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readIsolationProfile, isolationEnvironment } from 'openfilm/development-isolation';
let api = {};
try {
    api = await import('./studio.mjs');
}
catch (e) {
    if (!/electron/.test(e.message))
        throw e;
}
function entry() { assert.equal(typeof api.startWindowStudio, 'function', 'Studio must be importable without Electron and accept injected process adapters'); return api.startWindowStudio; }
async function fixture(run) { const root = mkdtempSync(join(tmpdir(), 'studio-profile-')); try {
    const cfg = { baseRoot: join(root, 'approved'), instanceId: 'instance-a', taskId: 'T01', attemptId: 'attempt-1', ports: { studio: 18471, film: 18472 } };
    const profile = readIsolationProfile({ OPENFILM_ISOLATION_PROFILE: Buffer.from(JSON.stringify(cfg)).toString('base64url'), OPENFILM_ISOLATION_ROOT: cfg.baseRoot });
    await run(profile);
}
finally {
    rmSync(root, { recursive: true, force: true });
} }
const options = p => ({ home: p.paths.home, port: p.ports.studio, env: isolationEnvironment(p), log() { }, onExit() { } });
test('isolated native Studio never takes over or retries a random port', () => fixture(async (p) => { let taken = 0, forks = 0; await assert.rejects(() => entry()(options(p), { takeover: async () => taken++, forkStudio: async () => { forks++; throw Object.assign(new Error('occupied'), { code: 'EADDRINUSE' }); } }), /occupied/); assert.equal(taken, 0); assert.equal(forks, 1); }));
test('existing isolated run.json is refused without contacting its advertised origin', () => fixture(async (p) => { mkdirSync(p.paths.home, { recursive: true }); writeFileSync(join(p.paths.home, 'run.json'), '{}'); let effects = 0; await assert.rejects(() => entry()(options(p), { takeover: async () => effects++, forkStudio: async () => effects++ }), /run.json|already/); assert.equal(effects, 0); }));
test('no-profile Studio keeps original takeover and random-port fallback', async () => { let taken = 0; const ports = []; const child = new EventEmitter(); const up = await entry()({ home: 'unused', port: 4757, env: {}, log() { }, onExit() { } }, { takeover: async () => taken++, forkStudio: async (o) => { ports.push(o.port); if (ports.length === 1)
        throw Object.assign(new Error('taken'), { code: 'EADDRINUSE' }); return { child, origin: 'local', filmOrigin: 'film', key: 'synthetic' }; } }); assert.equal(taken, 1); assert.deepEqual(ports, [4757, 0]); assert.equal(up.origin, 'local'); });
test('isolated Studio refuses even a dangling run.json alias before fork', () => fixture(async (p) => {
    const { symlinkSync } = await import('node:fs');
    mkdirSync(p.paths.home, { recursive: true });
    symlinkSync(join(p.root, 'missing-run-target'), join(p.paths.home, 'run.json'), 'junction');
    let forks = 0;
    await assert.rejects(() => entry()(options(p), { forkStudio: async () => { forks++; return { child: new EventEmitter() }; } }), /run.json|already/);
    assert.equal(forks, 0);
}));
