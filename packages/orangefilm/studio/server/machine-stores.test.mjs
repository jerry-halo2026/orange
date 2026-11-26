// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The stores this computer keeps for itself — the skills installed on it, Discover's index, the boards kept from its
 * canvases, and the characters kept from them — belong to no account (server.mjs `machineStore`): a Studio with a
 * signed-in account reads them as before, and one that cannot be read right now is said once in the log and answered
 * as the empty state, never as a 503 for something that is merely not made yet. The stores that keep what an account
 * owns (browse, get, kept, canvas) keep answering 503 until they have that account's mapping.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStudio } from './server.mjs';

const root = mkdtempSync(join(tmpdir(), 'of-machine-stores-'));
const home = join(root, 'home');
const variables = {
  ORANGE_HOME: home, ORANGE_SHARED_HOME: home, ORANGE_LIBRARY: join(root, 'library'),
  ORANGE_SKILLS: join(root, 'mine'), ORANGE_SKILLS_INDEX: join(root, 'index.json'),
};
const previous = Object.fromEntries(Object.keys(variables).map((key) => [key, process.env[key]]));
Object.assign(process.env, variables);
mkdirSync(home, { recursive: true });
mkdirSync(join(variables.ORANGE_LIBRARY), { recursive: true });

/** one of the person's own skills, as a folder of the skills library */
mkdirSync(join(variables.ORANGE_SKILLS, 'quiet'), { recursive: true });
writeFileSync(join(variables.ORANGE_SKILLS, 'quiet', 'SKILL.md'), '---\nname: quiet\ndescription: A skill of mine, on this computer.\n---\n\n# Quiet\n');

/** an account session, as the desktop app gives Studio one (nothing of it is needed by these stores) */
const auth = {
  assertActive: () => ({ subjectId: 'synthetic' }), runNative: (work) => work(), onState: () => () => {},
  getPublicState: () => ({ kind: 'active' }), authorizeProjectId() {}, authorizeProject() {},
};
const studio = await startStudio({ port: 0, key: 'fixture-key', advertise: false, openBrowser: () => {}, desktopAuth: auth });
const api = (path, { method = 'GET', body } = {}) => fetch(studio.origin + path, {
  method, headers: { 'x-studio-key': studio.key, 'origin': studio.origin, ...(body ? { 'content-type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});
test.after(async () => {
  await studio.close();
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(root, { recursive: true, force: true });
});

test('a signed-in Studio lists the skills on this computer: an empty store is an empty answer, not a 503', async () => {
  const res = await api('/api/skills');
  assert.equal(res.status, 200, 'the skills installed here are no account\'s');
  const body = await res.json();
  assert.equal(body.catalog, null, 'Discover\'s index was never read here');
  assert.deepEqual(body.skills.slice(0, 3).map((s) => s.uid), ['orangefilm/edit', 'orangefilm/media', 'orangefilm/canvas'], 'OrangeFilm\'s own first');
  const mine = body.skills.find((s) => s.uid === 'local/quiet');
  assert.deepEqual([mine?.source, mine?.installed], ['mine', true], 'the person\'s own, listed as it is');
});

test('the boards kept from canvases are listed, and a store that cannot be read is an empty list', async () => {
  mkdirSync(join(home, 'canvas-templates', 'beat'), { recursive: true });
  writeFileSync(join(home, 'canvas-templates', 'beat', 'template.json'), JSON.stringify({ name: 'Beat', created: 1, nodes: [{ id: 'a' }, { id: 'b' }], edges: [] }));
  const listed = await api('/api/canvas-templates');
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).templates.map((t) => [t.id, t.name, t.nodes]), [['beat', 'Beat', 2]]);

  /* the store itself is not a folder any more: an empty list, said in the log, rather than a page's 503 */
  rmSync(join(home, 'canvas-templates'), { recursive: true, force: true });
  writeFileSync(join(home, 'canvas-templates'), '');
  const broken = await api('/api/canvas-templates');
  assert.equal(broken.status, 200);
  assert.deepEqual(await broken.json(), { templates: [] });
  rmSync(join(home, 'canvas-templates'), { force: true });
});

test('Discover\'s index: what was read before is answered with why it could not be read again; never read, it says so', async () => {
  writeFileSync(variables.ORANGE_SKILLS_INDEX, JSON.stringify({ version: 1, skills: [] }));
  const first = await api('/api/skills/catalog', { method: 'POST', body: { fresh: 0 } });
  assert.equal(first.status, 200);
  const read = (await first.json()).catalog.read;
  assert.equal(typeof read, 'string', 'when the index was read');

  /* the index is not there any more (off the network, renamed, not published yet) */
  rmSync(variables.ORANGE_SKILLS_INDEX, { force: true });
  const stale = await api('/api/skills/catalog', { method: 'POST', body: { fresh: 0 } });
  assert.equal(stale.status, 200, 'Discover still shows what it read before');
  const kept = await stale.json();
  assert.deepEqual([kept.catalog.read, kept.stale], [read, true]);
  assert.match(kept.error, /index\.json/i, 'said why, in the answer');

  /* nothing was ever read: there is nothing to show, and the answer says what to fix */
  rmSync(join(home, 'skill-catalog'), { recursive: true, force: true });
  const none = await api('/api/skills/catalog', { method: 'POST', body: { fresh: 0 } });
  assert.equal(none.status, 502);
  assert.match((await none.json()).error, /Discover could not be read now: /);
});

test('a store that cannot be read at all: the empty state, said in the log once, and not a 503', async () => {
  const lines = [];
  const logged = console.error;
  console.error = (...args) => { lines.push(args.join(' ')); };
  const before = process.env.ORANGE_ISOLATION_PROFILE;
  /* a profile that is not one: every location of this computer cannot be named, so the stores throw */
  process.env.ORANGE_ISOLATION_PROFILE = Buffer.from('{}').toString('base64url');
  try {
    const skills = await api('/api/skills');
    assert.equal(skills.status, 200);
    assert.deepEqual(await skills.json(), { catalog: null, skills: [] });
    const again = await api('/api/skills');
    assert.equal(again.status, 200, 'a page asking again gets the same empty answer');
    const templates = await api('/api/canvas-templates');
    assert.equal(templates.status, 200);
    assert.deepEqual(await templates.json(), { templates: [] });
  } finally {
    if (before === undefined) delete process.env.ORANGE_ISOLATION_PROFILE; else process.env.ORANGE_ISOLATION_PROFILE = before;
    console.error = logged;
  }
  assert.equal(lines.filter((line) => line.includes('the skills could not be read')).length, 1, 'said once, however often asked');
  assert.equal(lines.filter((line) => line.includes('the canvas templates could not be read')).length, 1);
});

test('the characters kept from canvases are this computer\'s, not an account\'s: 200, and an empty list when unreadable', async () => {
  mkdirSync(join(home, 'canvas-characters', 'lead-abc123'), { recursive: true });
  writeFileSync(join(home, 'canvas-characters', 'lead-abc123', 'character.json'), JSON.stringify({ name: 'Lead', created: 5, pictures: [] }));
  const listed = await api('/api/canvas-characters');
  assert.equal(listed.status, 200, 'the people kept here are no account\'s to unlock');
  assert.deepEqual((await listed.json()).characters.map((c) => [c.id, c.name]), [['lead-abc123', 'Lead']]);

  /* the store cannot be read at all: the empty state, not a page's 503 */
  rmSync(join(home, 'canvas-characters'), { recursive: true, force: true });
  writeFileSync(join(home, 'canvas-characters'), '');
  const broken = await api('/api/canvas-characters');
  assert.equal(broken.status, 200);
  assert.deepEqual(await broken.json(), { characters: [] });
  rmSync(join(home, 'canvas-characters'), { force: true });
});

test('what an account owns is still answered as not yet connected to it', async () => {
  const res = await api('/api/browse');
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, 'account-resource-unavailable');
});
