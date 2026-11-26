// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/* The `orangefilm` command on PATH (cli-install.mjs): the app must only ever offer a folder a terminal already
   searches and that this user may write to, and must never replace a command that is somebody else's. The linking
   itself needs POSIX symlinks, so that part runs on a Mac and is skipped where they are not allowed (Windows). */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { candidateDirs, cliStatus, installCli, pathLine } from './cli-install.mjs';

test('only folders that exist and this user may write to are offered, and Windows offers none', () => {
  /* joined the way the module joins them, so the test does not depend on the host's path separator */
  const localBin = join('/home/someone', '.local', 'bin');
  const writable = new Set(['/usr/local/bin', localBin]);
  const exists = new Set(['/usr/local/bin', localBin]);
  const dirs = candidateDirs({
    platform: 'darwin', home: '/home/someone',
    exists: (p) => exists.has(p), writable: (p) => writable.has(p),
  });
  assert.deepEqual(dirs, ['/usr/local/bin', localBin]);
  const readOnly = candidateDirs({
    platform: 'darwin', home: '/home/someone',
    exists: (p) => exists.has(p), writable: (p) => p === localBin,
  });
  assert.deepEqual(readOnly, [localBin], 'a folder that needs an administrator is not offered');
  assert.deepEqual(candidateDirs({ platform: 'win32', home: '/home/someone' }), [], 'Windows has its own road');
  assert.equal(pathLine('/Users/x/Library/Application Support/OrangeFilm/bin/orangefilm'),
    'export PATH="/Users/x/Library/Application Support/OrangeFilm/bin:$PATH"');
});

test('the status says what is true: the shim is there, the command is not on PATH', () => {
  const home = mkdtempSync(join(tmpdir(), 'orangefilm-cli-'));
  try {
    const shim = join(home, 'bin', 'orangefilm');
    mkdirSync(join(home, 'bin'));
    writeFileSync(shim, '#!/bin/sh\n', { mode: 0o755 });
    const status = cliStatus({ platform: 'darwin', home, shim, found: () => null });
    assert.equal(status.supported, true);
    assert.equal(status.here, true);
    assert.equal(status.onPath, null);
    assert.equal(cliStatus({ platform: 'darwin', home, shim, found: () => '/usr/local/bin/orangefilm' }).onPath, '/usr/local/bin/orangefilm');
    assert.equal(cliStatus({ platform: 'win32', home, shim }).supported, false, 'Windows never shows the button');
    assert.equal(installCli({ platform: 'win32', home, shim }).code, 'not-needed');
    assert.equal(installCli({ platform: 'darwin', home, shim: join(home, 'nope') }).code, 'shim-missing');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the link points at the shim, and a second press is not an error', { skip: process.platform === 'win32' }, () => {
  const home = mkdtempSync(join(tmpdir(), 'orangefilm-cli-link-'));
  try {
    const shim = join(home, 'bin', 'orangefilm');
    mkdirSync(join(home, 'bin'));
    writeFileSync(shim, '#!/bin/sh\n', { mode: 0o755 });
    mkdirSync(join(home, 'bin-on-path'));
    const previous = process.env.PATH;
    /* the temp folder stands in for a folder a terminal already searches */
    process.env.PATH = `${join(home, 'bin-on-path')}:${previous ?? ''}`;
    try {
      const dirs = candidateDirs({ platform: 'darwin', home });
      assert.ok(dirs.length > 0, 'a writable folder is found on this machine');
      const result = installCli({ platform: 'darwin', home, shim, found: () => null });
      assert.equal(result.ok, true, `linked (${result.code})`);
      if (result.path) assert.equal(readlinkSync(result.path), shim);
      const again = installCli({ platform: 'darwin', home, shim, found: () => null });
      assert.equal(again.code, 'already');
    } finally {
      if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
