// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The gate every bench call passes: a launch key is not a sign-in. Studio answers `/api/open` 403
 * `authentication-required` until the bench's own account has signed in (desktop-auth.mjs, server.mjs), and a refused
 * sign-in leaves it shut. The attempt's details are never printed — only the code Studio answers with.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { DESKTOP, prepare, signIn, withBenchAuth } from './app.mjs';
import { launcherEnvironment, loginShellEnvironment } from '../src/environment.mjs';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

test('the bench Studio answers 403 until its own account signs in, and a refused sign-in keeps it shut', { timeout: 240_000 }, async (t) => {
  const auth = withBenchAuth(t);
  if (!auth) return;
  const dir = join(DESKTOP, '.dev', `auth-gate-${Date.now()}`);
  prepare(dir);
  const { PATH } = await loginShellEnvironment();
  const app = await electron.launch({
    executablePath: createRequire(import.meta.url)('electron'), args: [DESKTOP], cwd: DESKTOP,
    env: { ...launcherEnvironment(process.env, PATH), OPENFILM_DESKTOP_FLAVOR: 'bench', OPENFILM_BENCH_DIR: dir },
  });
  try {
    let run = null;
    for (let attempt = 0; attempt < 600 && !run; attempt += 1) {
      if (existsSync(join(dir, 'home/run.json'))) run = JSON.parse(readFileSync(join(dir, 'home/run.json'), 'utf8'));
      else await sleep(100);
    }
    assert.ok(run, 'Studio never advertised itself');
    /** Studio's own window asks from its own origin: a call from anywhere else is refused before it is answered. */
    const call = async (path, body) => {
      const response = await fetch(`${run.origin}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), 'x-studio-key': run.key, origin: run.origin },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    };

    const shut = await call('/api/open', { fallback: 0 });
    assert.equal(shut.status, 403, 'a launch key is not a sign-in');
    assert.equal(shut.body?.code, 'authentication-required');

    /* A password one character off: refused, and the Studio stays shut. */
    const refused = await call('/api/auth/sign-in', { email: auth.email, password: `${auth.password} ` });
    assert.equal(refused.status, 200);
    assert.equal(refused.body?.ok, false, 'a wrong password is not a sign-in');
    assert.equal(typeof refused.body?.code, 'string', 'the refusal says why, by code');
    const stillShut = await call('/api/open', { fallback: 0 });
    assert.equal(stillShut.status, 403);
    assert.equal(stillShut.body?.code, 'authentication-required');

    await signIn(run, auth);
    const state = await call('/api/auth/state');
    assert.equal(state.status, 200);
    assert.equal(state.body?.kind, 'active');

    /* Signed in: the same route answers. No folder: the last project, else the Projects window. */
    const open = await call('/api/open', { fallback: 0 });
    assert.equal(open.status, 200);
    console.log('Auth gate passed: 403 authentication-required while signed out and after a refused password, /api/auth/state active and /api/open 200 once signed in.');
    console.log(`Auth gate artifacts: ${dir}`);
  } finally {
    await app.close();
  }
});
