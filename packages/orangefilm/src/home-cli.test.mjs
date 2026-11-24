// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { homeCommand } from './home-cli.mjs';

test('home status reads a plan and dry-run never creates the target', () => {
  const base = mkdtempSync(join(tmpdir(), 'home-cli-'));
  const from = join(base, '.openfilm');
  const to = join(base, '.orangefilm');
  mkdirSync(from, { recursive: true });
  writeFileSync(join(from, 'prefs.json'), '{}\n');
  const status = homeCommand(['status'], { from, to });
  assert.equal(status.ok, true);
  assert.match(status.lines[0], /ready to migrate/);
  const dry = homeCommand(['migrate'], { from, to, 'dry-run': true });
  assert.equal(dry.ok, true);
  assert.match(dry.lines[0], /would copy/);
  assert.equal(existsSync(to), false);
  rmSync(base, { recursive: true, force: true });
});
