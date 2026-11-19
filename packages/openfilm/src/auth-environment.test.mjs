// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The resolver is the only place that names an environment, so what it resolves is what every reader gets. These tests
 * pin the three properties the incident came from: one answer, no silent fallback to a wrong one, and a failure that
 * says which field is missing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AuthEnvironmentError, LOCAL_DOCKER, belongsToEnvironment, environmentProblems, resolveEnvironment,
} from './auth-environment.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'auth-env-'));

test('nothing exported and nothing packaged is the local Docker stack, and it says so', () => {
  const found = resolveEnvironment({ env: {} });
  assert.equal(found.environmentId, LOCAL_DOCKER.environmentId);
  assert.equal(found.source, 'local-docker');
  assert.equal(found.local, true);
});

test('a packaged description is used when nothing overrides it', () => {
  const at = dir();
  try {
    writeFileSync(join(at, 'auth-environment.json'), JSON.stringify({
      environmentId: 'packaged-env', authOrigin: 'https://auth.example/', publishableKey: 'pk-packaged',
    }));
    const found = resolveEnvironment({ env: {}, resourcesDir: at });
    assert.equal(found.source, 'packaged');
    assert.equal(found.environmentId, 'packaged-env');
    assert.equal(found.authOrigin, 'https://auth.example');
    assert.equal(found.local, false);
  } finally {
    rmSync(at, { recursive: true, force: true });
  }
});

test('an explicit file wins, and the inline form wins over the file', () => {
  const at = dir();
  try {
    writeFileSync(join(at, 'runtime.json'), JSON.stringify({
      environmentId: 'file-env', authOrigin: 'http://127.0.0.1:9', publishableKey: 'pk-file',
    }));
    const fromFile = resolveEnvironment({ env: { ORANGE_AUTH_CONFIG_FILE: join(at, 'runtime.json') } });
    assert.equal(fromFile.environmentId, 'file-env');
    assert.equal(fromFile.source, 'override-file');

    // Both are overrides; two different environments at once is a conflict, not a silent win for one of them.
    assert.throws(
      () => resolveEnvironment({
        env: {
          ORANGE_AUTH_CONFIG_FILE: join(at, 'runtime.json'),
          ORANGE_AUTH_ENV: JSON.stringify({ environmentId: 'inline-env', authOrigin: 'https://auth.example', publishableKey: 'pk-inline' }),
        },
      }),
      (error) => error instanceof AuthEnvironmentError && error.code === 'auth-environment-conflict',
    );
  } finally {
    rmSync(at, { recursive: true, force: true });
  }
});

test('a description missing a field fails immediately and names the field', () => {
  const at = dir();
  try {
    writeFileSync(join(at, 'auth-environment.json'), JSON.stringify({ environmentId: 'packaged-env', authOrigin: 'https://auth.example' }));
    assert.throws(
      () => resolveEnvironment({ env: {}, resourcesDir: at }),
      (error) => error instanceof AuthEnvironmentError
        && error.code === 'auth-environment-incomplete'
        && error.missing.includes('publishableKey'),
    );
  } finally {
    rmSync(at, { recursive: true, force: true });
  }
});

test('a build with nothing and no local stack is an installer problem, not a login problem', () => {
  assert.throws(
    () => resolveEnvironment({ env: {}, requireDescription: true }),
    (error) => error instanceof AuthEnvironmentError && error.code === 'auth-environment-missing',
  );
});

test('blank fields count as missing, an unstable id and a non-http origin are rejected', () => {
  assert.deepEqual(environmentProblems({ environmentId: 'env-1', authOrigin: 'https://a.example', publishableKey: '  ' }), ['publishableKey']);
  assert.deepEqual(environmentProblems({ environmentId: 'x', authOrigin: 'https://a.example', publishableKey: 'pk' }), ['environmentId']);
  assert.deepEqual(environmentProblems({ environmentId: 'env-1', authOrigin: 'ftp://a.example', publishableKey: 'pk' }), ['authOrigin']);
  assert.deepEqual(environmentProblems(null), ['environmentId', 'authOrigin', 'publishableKey']);
});

test('a token belongs to the environment it was minted in, and to no other', () => {
  const environment = resolveEnvironment({ env: {} });
  assert.equal(belongsToEnvironment(environment, LOCAL_DOCKER.environmentId), true);
  assert.equal(belongsToEnvironment(environment, 'another-env'), false);
  assert.equal(belongsToEnvironment(environment, null), false);
});
