// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The rename of the product's folder (`…/Videos/OrangeFilm` → `…/Videos/OrangeFilm`): the person's projects, `Saved` and
 * `Skills` move with it on the first start, and the owner records follow them — a project whose record kept the old
 * root would answer `project-access-denied`. Simulated in a temporary home: no real project is touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateProductFolder } from '../../../packages/orangefilm/src/locations.mjs';
import { migrateOwnerRoots } from './desktop-auth.mjs';

const quiet = () => {};
/** A folder with a project in it, as the app makes them (film.html is what makes a folder a project). */
function project(root, name) {
  mkdirSync(join(root, 'Projects', name), { recursive: true });
  writeFileSync(join(root, 'Projects', name, 'film.html'), '<!doctype html>');
}

test('the product\'s folder moves once: projects, Saved and Skills with it, and nothing is copied or merged', () => {
  const base = mkdtempSync(join(tmpdir(), 'of-folder-'));
  const from = join(base, 'Videos', 'OpenFilm');
  const to = join(base, 'Videos', 'OrangeFilm');
  project(from, 'My film');
  mkdirSync(join(from, 'Saved'), { recursive: true });
  mkdirSync(join(from, 'Skills', 'mine'), { recursive: true });

  const moved = migrateProductFolder({ from, to, log: quiet });
  assert.equal(moved.status, 'moved');
  assert.equal(moved.method, 'rename', 'the whole folder, every byte and date kept');
  assert.equal(moved.keptOld, false);
  assert.ok(existsSync(join(to, 'Projects', 'My film', 'film.html')), 'the project is in the new folder');
  assert.ok(existsSync(join(to, 'Saved')), 'what the person saved, beside it');
  assert.ok(existsSync(join(to, 'Skills', 'mine')), 'the skills they added, beside it');
  assert.equal(existsSync(from), false, 'nothing is left under the old name');

  /* a start after it: the new folder is there, so the old one is never merged into it */
  const again = migrateProductFolder({ from, to, log: quiet });
  assert.equal(again.status, 'already');
  assert.equal(existsSync(join(to, 'Projects', 'My film', 'film.html')), true);

  /* a first start with nothing before it */
  const fresh = migrateProductFolder({ from: join(base, 'Videos', 'Nowhere'), to: join(base, 'Videos', 'Nowhere2'), log: quiet });
  assert.equal(fresh.status, 'none');
});

test('the owner records follow the folder: their roots move, every other record and key stays as it was', () => {
  const base = mkdtempSync(join(tmpdir(), 'of-owners-'));
  const home = join(base, 'home');
  const from = join(base, 'Videos', 'OpenFilm');
  const to = join(base, 'Videos', 'OrangeFilm');
  mkdirSync(home, { recursive: true });
  const mine = join(from, 'Projects', 'My film');
  const elsewhere = join(base, 'Elsewhere', 'Another film');
  const records = {
    version: 1,
    projects: [
      { environmentId: 'env', subjectId: 'sub', projectId: 'one', root: mine },
      { environmentId: 'env', subjectId: 'sub', projectId: 'two', root: elsewhere },
    ],
  };
  writeFileSync(join(home, 'orange-project-owners.json'), `${JSON.stringify(records)}\n`);

  const moved = migrateOwnerRoots({ home, from, to });
  assert.equal(moved, 1, 'only the record under the old folder moves');
  const after = JSON.parse(readFileSync(join(home, 'orange-project-owners.json'), 'utf8'));
  assert.equal(after.version, 1);
  assert.deepEqual(after.projects[0], { environmentId: 'env', subjectId: 'sub', projectId: 'one', root: join(to, 'Projects', 'My film') });
  assert.deepEqual(after.projects[1], records.projects[1], 'a project outside it is left alone');
  assert.equal(migrateOwnerRoots({ home, from, to }), 0, 'a second time there is nothing to move');
});

test('a records file this does not know is left exactly as it was', () => {
  const base = mkdtempSync(join(tmpdir(), 'of-owners-unknown-'));
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const text = `${JSON.stringify({ version: 2, projects: [] })}\n`;
  writeFileSync(join(home, 'orange-project-owners.json'), text);
  assert.equal(migrateOwnerRoots({ home, from: join(base, 'a'), to: join(base, 'b') }), 0);
  assert.equal(readFileSync(join(home, 'orange-project-owners.json'), 'utf8'), text);
  assert.equal(migrateOwnerRoots({ home: join(base, 'no-home'), from: join(base, 'a'), to: join(base, 'b') }), 0, 'no records, nothing to do');
});
