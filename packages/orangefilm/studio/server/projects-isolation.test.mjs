// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
/* An isolated development profile is authorised only by the policy this machine provisions at
   <repo>/.dev/orange-test-control-policy.json (`isolation-control-policy.mjs`): a profile's `baseRoot` must be that
   policy's own root, and `os.tmpdir()` (`C:\Users\…`, exported here as an 8.3 alias) is refused by
   `development-isolation.mjs` before any of this runs. The scratch root below is a plain directory on the checkout's
   own volume, for the paths that are deliberately outside the isolated projects. */
import { testRootFor } from '../../src/test-roots.mjs';
import { readIsolationProfile, isolationEnvironment } from '../../src/development-isolation.mjs';
import { ProjectError, openProject, projectById } from './projects.mjs';
const policyFile = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.dev/orange-test-control-policy.json');
/** The provisioned base root, when this machine has the policy file and the volume it names. */
const provisionedBase = () => {
  try {
    const value = JSON.parse(readFileSync(policyFile, 'utf8'));
    return typeof value?.baseRoot === 'string' && existsSync(value.baseRoot) ? value.baseRoot : null;
  } catch { return null; }
};
const base = provisionedBase();
const unprovisioned = base ? false : 'needs a provisioned isolation base root (.dev/orange-test-control-policy.json) and its volume';
/** A canonical attempt id, unique to this run: the profile keeps its files under baseRoot/instance/task/attempt. */
const attempt = (name) => `${name}-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
let root, profile;
before(() => {
  root = testRootFor('projects-isolation', 'scratch');
  if (!base) return;
  const c = { baseRoot: base, instanceId: 'instance-a', taskId: 'T01', attemptId: attempt('attempt'), ports: { studio: 18471, film: 18472 } };
  profile = readIsolationProfile({ OPENFILM_ISOLATION_PROFILE: Buffer.from(JSON.stringify(c)).toString('base64url'), OPENFILM_ISOLATION_ROOT: c.baseRoot });
  Object.assign(process.env, isolationEnvironment(profile));
});
after(() => { rmSync(root, { recursive: true, force: true }); if (profile) rmSync(profile.root, { recursive: true, force: true }); });
test('openProject rejects outside destination before its first mkdir', { skip: unprovisioned }, async () => { const outside = join(root, 'outside'); await assert.rejects(() => openProject(outside), isIsolationPathError); assert.equal(existsSync(outside), false); });
test('stored project lookup refuses outside root before describing files', { skip: unprovisioned }, async (t) => {
  const file = join(profile.paths.home, 'studio.json');
  mkdirSync(profile.paths.home, { recursive: true });
  /* the entry this test writes points outside the instance: every later call would refuse the whole list because of it */
  t.after(() => rmSync(file, { force: true }));
  writeFileSync(file, JSON.stringify({ recent: [{ id: 'original-id', path: join(root, 'external'), openedAt: 1 }], folders: [] }));
  await assert.rejects(() => projectById('original-id'), isIsolationPathError);
});
test('original project format and non-UUID identifier remain usable inside isolated projects', { skip: unprovisioned }, async () => { const dir = join(profile.paths.projects, 'native'); mkdirSync(join(dir, '.film'), { recursive: true }); writeFileSync(join(dir, '.film', 'id'), 'native_123\n'); const result = await openProject(dir); assert.equal(result.id, 'native_123'); assert.ok(existsSync(join(dir, 'film.html'))); });
test('openProject rejects linked .film before writing native metadata', { skip: unprovisioned }, async () => {
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

test('actual native project HTTP denial is 403 isolation-path without metadata or server-error stack', { skip: unprovisioned }, async () => {
  const config = { baseRoot: base, instanceId: 'instance-path', taskId: 'T01', attemptId: attempt('attempt-path'), ports: { studio: 18773, film: 18774 } };
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
    rmSync(actualProfile.root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

/* This one has no isolation profile at all, and the guard resolves its authority once per process, then keeps it: the
   records this file's other tests bound it to (`withNativeAccess`, `project-control-guard.mjs` `root()`) make the same
   process refuse to fall back to "no profile". So the assertion runs where it belongs — a process that never saw one. */
test('no-profile original openProject still permits a safe synthetic folder outside isolated projects', () => {
  const local = join(root, 'legacy-safe-project');
  const script = `
    const { openProject } = await import(${JSON.stringify(new URL('./projects.mjs', import.meta.url).href)});
    const project = await openProject(process.argv[1]);
    process.stdout.write(JSON.stringify({ path: project.path }));
  `;
  const env = { ...process.env, OPENFILM_HOME: join(root, 'legacy-home'), OPENFILM_SHARED_HOME: join(root, 'legacy-home') };
  delete env.OPENFILM_ISOLATION_PROFILE;
  delete env.OPENFILM_ISOLATION_ROOT;
  const printed = execFileSync(process.execPath, ['--input-type=module', '-e', script, local], { env, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(printed), { path: local });
  assert.ok(existsSync(join(local, 'film.html')));
});
