import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readIsolationProfile, isolationEnvironment } from '../src/development-isolation.mjs';
import { running, ensureStudio } from './client.mjs';
let root, profile, originalFetch;
before(() => { root = mkdtempSync(join(tmpdir(), 'client-isolation-')); const c = { baseRoot: join(root, 'approved'), instanceId: 'instance-a', taskId: 'T01', attemptId: 'attempt-1', ports: { studio: 18471, film: 18472 } }; profile = readIsolationProfile({ OPENFILM_ISOLATION_PROFILE: Buffer.from(JSON.stringify(c)).toString('base64url'), OPENFILM_ISOLATION_ROOT: c.baseRoot }); Object.assign(process.env, isolationEnvironment(profile)); mkdirSync(profile.paths.home, { recursive: true }); originalFetch = globalThis.fetch; });
after(() => { globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true }); });
const run = p => ({ origin: `http://127.0.0.1:${p.ports.studio}`, filmOrigin: `http://localhost:${p.ports.film}`, key: 'synthetic' });
test('isolated client refuses hostile run.json before contacting its origin or revealing key', async () => { writeFileSync(join(profile.paths.home, 'run.json'), JSON.stringify({ ...run(profile), origin: 'https://unapproved.invalid' })); let requests = 0; globalThis.fetch = async () => { requests++; throw new Error('must not fetch'); }; await assert.rejects(() => running(), /isolat|origin/); assert.equal(requests, 0); });
test('isolated client requires health home binding and paired origins, without fallback', async () => { writeFileSync(join(profile.paths.home, 'run.json'), JSON.stringify(run(profile))); globalThis.fetch = async () => ({ json: async () => ({ product: 'openfilm-studio', home: 'wrong', filmOrigin: run(profile).filmOrigin }) }); await assert.rejects(() => running(), /isolat|home/); });
test('isolated CLI uses matching native Studio without replacing old versions', async () => { writeFileSync(join(profile.paths.home, 'run.json'), JSON.stringify(run(profile))); globalThis.fetch = async () => ({ json: async () => ({ product: 'openfilm-studio', home: createHash('sha256').update(profile.paths.home).digest('hex'), filmOrigin: run(profile).filmOrigin, version: '0.0.1' }) }); const up = await ensureStudio(); assert.equal(up.origin, run(profile).origin); await assert.rejects(() => ensureStudio(() => { }, { fresh: true }), /isolat|restart/); });
test('isolated CLI does not auto-start a supervisor or make logs when desktop is absent', async () => { rmSync(join(profile.paths.home, 'run.json')); let requests = 0; globalThis.fetch = async () => { requests++; throw new Error('must not probe fallback'); }; await assert.rejects(() => ensureStudio(), /isolat|running/); assert.equal(requests, 0); });

test('isolated running accepts actual native Studio advertised localhost film origin', async () => {
  const config = { baseRoot: join(root, 'native-runtime'), instanceId: 'instance-runtime', taskId: 'T01', attemptId: 'attempt-runtime', ports: { studio: 18771, film: 18772 } };
  const actualProfile = readIsolationProfile({ OPENFILM_ISOLATION_PROFILE: Buffer.from(JSON.stringify(config)).toString('base64url'), OPENFILM_ISOLATION_ROOT: config.baseRoot });
  const env = isolationEnvironment(actualProfile);
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  let nativeStudio;
  let externalAttempts = 0;
  let localHealthRequests = 0;
  try {
    Object.assign(process.env, env);
    for (const dir of Object.values(actualProfile.paths)) mkdirSync(dir, { recursive: true });
    globalThis.fetch = async (input, options) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.origin !== 'http://127.0.0.1:18771' || url.pathname !== '/api/health') {
        externalAttempts += 1;
        throw new Error('Unapproved fetch blocked by native boundary test observer.');
      }
      localHealthRequests += 1;
      return originalFetch(input, options);
    };
    const { startStudio } = await import('./server/server.mjs');
    nativeStudio = await startStudio({ port: 18771, advertise: true, stays: true, isolation: true, openBrowser: () => assert.fail('No browser is permitted in this test.') });
    const advertised = JSON.parse(readFileSync(join(actualProfile.paths.home, 'run.json'), 'utf8'));
    assert.equal(nativeStudio.origin, 'http://127.0.0.1:18771');
    assert.equal(nativeStudio.filmOrigin, 'http://localhost:18772');
    assert.equal(advertised.filmOrigin, 'http://localhost:18772');
    const up = await running();
    assert.equal(up.origin, 'http://127.0.0.1:18771');
    assert.equal(up.filmOrigin, 'http://localhost:18772');
    assert.ok(up.key === advertised.key, 'Client retains the real native key without fallback.');
    assert.ok(localHealthRequests >= 1, 'Actual health response was consumed, not a mock.');
    assert.equal(externalAttempts, 0);
  } finally {
    await nativeStudio?.close();
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

for (const alias of ['https://unapproved.invalid:18472', 'http://localhost:18479', 'http://127.0.0.1:18472', 'http://localhost.:18472']) {
  test(`isolated client rejects non-native film origin ${alias} before health request`, async () => {
    writeFileSync(join(profile.paths.home, 'run.json'), JSON.stringify({ ...run(profile), filmOrigin: alias }));
    let requests = 0;
    globalThis.fetch = async () => { requests += 1; throw new Error('No request should reach an alias.'); };
    await assert.rejects(() => running(), /isolat|origin/);
    assert.equal(requests, 0);
  });
}
