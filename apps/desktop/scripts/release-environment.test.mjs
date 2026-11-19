// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * What an installer signs people into: the committed `release/environment.json`, an explicit override, or no build.
 *
 * The regression this file pins: until 2026-11-19 packaging read `.dev/auth-runtime.json` — a git-ignored file that
 * exists on one machine — so a build from a clean tree carried no environment and installed an app nobody could sign
 * in to. `.dev/auth-runtime.json` must never be a packaging source again, and a build without one of the three
 * documented sources must fail here rather than produce an installer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { COMMITTED_ENVIRONMENT, packagingProblems, releaseEnvironment } from './release-environment.mjs';

const good = {
  environmentId: 'orange-test-desktop',
  authOrigin: 'https://example.supabase.co',
  publishableKey: 'sb_publishable_client_key',
};

/** A throwaway `apps/desktop`-shaped folder: only `release/environment.json` matters to the resolver. */
function desktopWith(environment) {
  const root = mkdtempSync(join(tmpdir(), 'release-environment-'));
  const desktop = join(root, 'desktop');
  const at = join(desktop, COMMITTED_ENVIRONMENT);
  mkdirSync(join(desktop, 'release'), { recursive: true });
  if (environment) writeFileSync(at, JSON.stringify(environment));
  return { root, desktop, at, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('the committed environment is what a build packages', () => {
  const at = desktopWith(good);
  try {
    const found = releaseEnvironment({ desktop: at.desktop, env: {} });
    assert.equal(found.description.environmentId, good.environmentId);
    assert.equal(found.description.authOrigin, good.authOrigin);
    assert.equal(found.description.publishableKey, good.publishableKey);
    assert.match(found.origin, /release[\\/]environment\.json/);
  } finally {
    at.cleanup();
  }
});

test('an explicit override wins over the committed file', () => {
  const at = desktopWith(good);
  try {
    const inline = releaseEnvironment({
      desktop: at.desktop,
      env: { ORANGE_AUTH_ENV: JSON.stringify({ ...good, environmentId: 'another-environment' }) },
    });
    assert.equal(inline.description.environmentId, 'another-environment');
    assert.equal(inline.origin, 'ORANGE_AUTH_ENV');

    const file = join(at.root, 'given.json');
    writeFileSync(file, JSON.stringify({ ...good, environmentId: 'from-a-file' }));
    const read = releaseEnvironment({ desktop: at.desktop, env: { ORANGE_AUTH_CONFIG_FILE: file } });
    assert.equal(read.description.environmentId, 'from-a-file');
    assert.equal(read.origin, `ORANGE_AUTH_CONFIG_FILE ${file}`);
  } finally {
    at.cleanup();
  }
});

/* The regression: a developer's own pointer is not a packaging input. Without a committed file the build stops even
   though `.dev/auth-runtime.json` exists in the checkout that runs it. */
test('a checkout with only .dev/auth-runtime.json packages nothing: the build stops', () => {
  const at = desktopWith(null);
  try {
    mkdirSync(join(at.root, '.dev'), { recursive: true });
    writeFileSync(join(at.root, '.dev', 'auth-runtime.json'), JSON.stringify(good));
    assert.throws(() => releaseEnvironment({ desktop: at.desktop, env: {} }), /No environment to package/);
  } finally {
    at.cleanup();
  }
});

test('no source at all names the file the build wants', () => {
  const at = desktopWith(null);
  try {
    assert.throws(() => releaseEnvironment({ desktop: at.desktop, env: {} }), (error) => {
      assert.match(error.message, /No environment to package/);
      assert.match(error.message, /release[\\/]environment\.json/);
      return true;
    });
  } finally {
    at.cleanup();
  }
});

test('an environment that cannot ship is refused, with the field named', () => {
  const cases = [
    [{ ...good, publishableKey: '' }, /publishableKey/],
    [{ environmentId: good.environmentId, authOrigin: good.authOrigin }, /publishableKey/],
    [{ ...good, extra: 'field' }, /exactly/],
    [{ ...good, authOrigin: 'http://example.supabase.co' }, /https/],
    [{ ...good, publishableKey: 'sb_secret_server_key' }, /privileged/],
    [
      {
        ...good,
        publishableKey: `x.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.y`,
      },
      /privileged/,
    ],
  ];
  for (const [environment, expected] of cases) {
    const at = desktopWith(environment);
    try {
      assert.throws(() => releaseEnvironment({ desktop: at.desktop, env: {} }), expected);
    } finally {
      at.cleanup();
    }
  }
});

test('packagingProblems is quiet for a shippable description', () => {
  assert.deepEqual(packagingProblems(good), []);
});
