import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readIsolationProfile, isolationEnvironment } from '../../src/development-isolation.mjs';
import { ProjectError, openProject, projectById } from './projects.mjs';
let root, profile;
before(() => { root = mkdtempSync(join(tmpdir(), 'projects-isolation-')); const c = { baseRoot: join(root, 'approved'), instanceId: 'instance-a', taskId: 'T01', attemptId: 'attempt-1', ports: { studio: 18471, film: 18472 } }; profile = readIsolationProfile({ OPENFILM_ISOLATION_PROFILE: Buffer.from(JSON.stringify(c)).toString('base64url'), OPENFILM_ISOLATION_ROOT: c.baseRoot }); Object.assign(process.env, isolationEnvironment(profile)); });
after(() => rmSync(root, { recursive: true, force: true }));
test('openProject rejects outside destination before its first mkdir', async () => { const outside = join(root, 'outside'); await assert.rejects(() => openProject(outside), isIsolationPathError); assert.equal(existsSync(outside), false); });
test('stored project lookup refuses outside root before describing files', async () => { mkdirSync(profile.paths.home, { recursive: true }); writeFileSync(join(profile.paths.home, 'studio.json'), JSON.stringify({ recent: [{ id: 'original-id', path: join(root, 'external'), openedAt: 1 }], folders: [] })); await assert.rejects(() => projectById('original-id'), isIsolationPathError); });
test('original project format and non-UUID identifier remain usable inside isolated projects', async () => { const dir = join(profile.paths.projects, 'native'); mkdirSync(join(dir, '.film'), { recursive: true }); writeFileSync(join(dir, '.film', 'id'), 'native_123\n'); const result = await openProject(dir); assert.equal(result.id, 'native_123'); assert.ok(existsSync(join(dir, 'film.html'))); });
test('openProject rejects linked .film before writing native metadata', async () => {
    const { symlinkSync } = await import('node:fs');
    const dir = join(profile.paths.projects, 'linked-meta');
    const external = join(root, 'external-meta');
    mkdirSync(dir, { recursive: true });
    mkdirSync(external);
    symlinkSync(external, join(dir, '.film'), 'junction');
    await assert.rejects(() => openProject(dir), isIsolationPathError);
    assert.equal(existsSync(join(external, '.gitignore')), false);
});

const isIsolationPathError = (error) => error instanceof ProjectError && error.status === 403 && error.code === 'isolation-path';

test('actual native project HTTP denial is 403 isolation-path without metadata or server-error stack', async () => {
  const config = { baseRoot: join(root, 'runtime-path'), instanceId: 'instance-path', taskId: 'T01', attemptId: 'attempt-path', ports: { studio: 18773, film: 18774 } };
  const actualProfile = readIsolationProfile({ OPENFILM_ISOLATION_PROFILE: Buffer.from(JSON.stringify(config)).toString('base64url'), OPENFILM_ISOLATION_ROOT: config.baseRoot });
  const env = isolationEnvironment(actualProfile);
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  let studio;
  let externalAttempts = 0;
  const serverErrors = [];
  try {
    Object.assign(process.env, env);
    for (const dir of Object.values(actualProfile.paths)) mkdirSync(dir, { recursive: true });
    globalThis.fetch = async (input, options) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.origin !== 'http://127.0.0.1:18773' || !url.pathname.startsWith('/api/')) {
        externalAttempts += 1;
        throw new Error('External request blocked by project-path test observer.');
      }
      return originalFetch(input, options);
    };
    console.error = (...args) => serverErrors.push(args);
    const { startStudio } = await import('./server.mjs');
    studio = await startStudio({ port: 18773, advertise: true, stays: true, isolation: true, openBrowser: () => assert.fail('Browser startup is not permitted.') });
    const outside = join(root, 'http-outside');
    const denial = await fetch(studio.origin + '/api/projects', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-studio-key': studio.key }, body: JSON.stringify({ path: outside }),
    });
    const deniedBody = await denial.json();
    assert.deepEqual({ status: denial.status, code: deniedBody.code, metadataExists: existsSync(join(outside, '.film')), serverErrors: serverErrors.length },
      { status: 403, code: 'isolation-path', metadataExists: false, serverErrors: 0 });
    const local = join(actualProfile.paths.projects, 'Native local');
    const created = await fetch(studio.origin + '/api/projects', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-studio-key': studio.key }, body: JSON.stringify({ path: local }),
    });
    assert.equal(created.status, 200);
    const { project } = await created.json();
    assert.equal(project.path, local);
    const listing = await fetch(studio.origin + '/api/projects', { headers: { 'x-studio-key': studio.key } });
    assert.equal(listing.status, 200);
    assert.ok((await listing.json()).projects.some(value => value.id === project.id && value.path === local));
    assert.ok(existsSync(join(local, '.film', 'id')));
    assert.equal(serverErrors.length, 0);
    assert.equal(externalAttempts, 0);
  } finally {
    await studio?.close();
    console.error = originalError;
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('no-profile original openProject still permits a safe synthetic folder outside isolated projects', async () => {
  const replacement = { OPENFILM_ISOLATION_PROFILE: undefined, OPENFILM_ISOLATION_ROOT: undefined, OPENFILM_HOME: join(root, 'legacy-home'), OPENFILM_SHARED_HOME: join(root, 'legacy-home') };
  const previous = Object.fromEntries(Object.keys(replacement).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(replacement)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    const local = join(root, 'legacy-safe-project');
    const project = await openProject(local);
    assert.equal(project.path, local);
    assert.ok(existsSync(join(local, 'film.html')));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
