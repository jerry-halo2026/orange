// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The file the Studio child reads must be the environment this build names, and only the three keys desktop-auth
 * accepts — everything else it would refuse as a snapshot it does not understand.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { authEnvironmentMessage, authEnvironmentReason, materializeAuthEnvironmentFile } from './auth-env-file.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'auth-env-file-'));

test('an explicit file wins, unchanged', async () => {
  const at = dir();
  try {
    const found = await materializeAuthEnvironmentFile({ env: { ORANGE_AUTH_CONFIG_FILE: join(at, 'given.json') }, dataDir: at });
    assert.equal(found.source, 'override');
    assert.equal(found.file, join(at, 'given.json'));
    assert.equal(existsSync(join(at, 'auth-runtime.json')), false);
  } finally { rmSync(at, { recursive: true, force: true }); }
});

test('the resolved environment is written with exactly three keys and 0600', async () => {
  const at = dir();
  try {
    const found = await materializeAuthEnvironmentFile({ env: {}, dataDir: at, requireDescription: false });
    assert.equal(found.source, 'local-docker');
    assert.equal(found.local, true);
    const written = JSON.parse(readFileSync(found.file, 'utf8'));
    assert.deepEqual(Object.keys(written).sort(), ['authOrigin', 'environmentId', 'publishableKey']);
    assert.equal(typeof written.environmentId, 'string');
  } finally { rmSync(at, { recursive: true, force: true }); }
});

test('a packaged build with no description is an installer problem, in words a person can act on', async () => {
  const at = dir();
  try {
    const found = await materializeAuthEnvironmentFile({ env: {}, dataDir: at, requireDescription: true });
    assert.equal(found.code, 'auth-environment-missing');
    assert.match(found.message, /重新安装/);
    assert.equal(authEnvironmentMessage({ code: 'auth-environment-conflict' }).includes('两个'), true);
    assert.equal(authEnvironmentMessage({ code: 'auth-environment-incomplete', missing: ['publishableKey'] }).includes('publishableKey'), true);
  } finally { rmSync(at, { recursive: true, force: true }); }
});

test('the written file has the mode the child expects on a platform that keeps modes', async () => {  const at = dir();
  try {
    const found = await materializeAuthEnvironmentFile({ env: {}, dataDir: at, requireDescription: false });
    const mode = statSync(found.file).mode & 0o777;
    if (process.platform !== 'win32') assert.equal(mode, 0o600);
    assert.ok(existsSync(found.file));
  } finally { rmSync(at, { recursive: true, force: true }); }
});

/* The window's reason comes from the resolver's code, through one whitelist: an installed app that cannot find its
   environment must not be told to "provide local configuration" — that is advice only a development checkout can
   follow, and on 2026-11-19 it was shown to someone who had just installed the app. */
test('an installer problem and a development gap are different reasons', () => {
  assert.equal(authEnvironmentReason('auth-environment-missing'), 'install-incomplete');
  assert.equal(authEnvironmentReason('auth-environment-incomplete'), 'install-incomplete');
  assert.equal(authEnvironmentReason('auth-environment-unreadable'), 'install-incomplete');
  assert.equal(authEnvironmentReason('auth-environment-conflict'), 'install-conflict');
  assert.equal(authEnvironmentReason(undefined), 'configuration-required');
  assert.equal(authEnvironmentReason('something-else'), 'configuration-required');
});
