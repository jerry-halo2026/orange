// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MIGRATION_MARKER, describeHomeMigration, migrateHome, planHomeMigration } from './home-migration.mjs';

const root = () => mkdtempSync(join(tmpdir(), 'orc-home-migration-'));

test('a migration copies configuration, not the library, and keeps the old home', () => {
  const base = root();
  const from = join(base, '.openfilm');
  const to = join(base, '.orangefilm');
  mkdirSync(from, { recursive: true });
  writeFileSync(join(from, 'prefs.json'), '{"projectsFolder":"/films"}\n');
  writeFileSync(join(from, 'cloud-steward.json'), '{}\n');
  mkdirSync(join(from, 'library'));
  writeFileSync(join(from, 'library', 'big.bin'), 'x');

  const plan = planHomeMigration({ from, to });
  assert.equal(plan.action, 'copy');
  assert.deepEqual(plan.entries, ['prefs.json', 'cloud-steward.json']);

  const dry = migrateHome({ from, to, dryRun: true });
  assert.equal(dry.action, 'dry-run');
  assert.equal(existsSync(to), false, 'dry-run writes nothing');

  const done = migrateHome({ from, to });
  assert.equal(done.action, 'migrated');
  assert.equal(readFileSync(join(to, 'prefs.json'), 'utf8'), '{"projectsFolder":"/films"}\n');
  assert.equal(existsSync(join(to, MIGRATION_MARKER)), true);
  assert.equal(existsSync(join(to, 'library')), false, 'the library is not copied by default');
  assert.equal(existsSync(join(from, 'prefs.json')), true, 'the old home is kept');
  assert.match(describeHomeMigration(done), /was kept/);

  assert.equal(migrateHome({ from, to }).action, 'already');
  rmSync(base, { recursive: true, force: true });
});

test('a target with data is never merged without a marker, and --include-library is explicit', () => {
  const base = root();
  const from = join(base, '.openfilm');
  const to = join(base, '.orangefilm');
  mkdirSync(from, { recursive: true });
  mkdirSync(join(from, 'library'));
  mkdirSync(to, { recursive: true });
  writeFileSync(join(from, 'prefs.json'), '{}\n');
  writeFileSync(join(to, 'prefs.json'), '{"kept":true}\n');
  assert.equal(planHomeMigration({ from, to }).action, 'blocked');

  rmSync(to, { recursive: true, force: true });
  const done = migrateHome({ from, to, includeLibrary: true });
  assert.equal(done.action, 'migrated');
  assert.deepEqual(done.entries, ['prefs.json', 'library']);
  assert.equal(existsSync(join(to, 'library')), true);
  rmSync(base, { recursive: true, force: true });
});
