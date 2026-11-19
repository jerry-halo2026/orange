// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The wiki's UI wiring, held as source contracts: the entry is on the card, the reads happen in the panels (never on a
 * page render), and the entity view and its arbitration are reachable.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const page = readFileSync(new URL('./material-center/MaterialCenterPage.tsx', import.meta.url), 'utf8');
const card = readFileSync(new URL('./material-center/MaterialCard.tsx', import.meta.url), 'utf8');
const row = readFileSync(new URL('./material-center/MaterialListRow.tsx', import.meta.url), 'utf8');

test('the notes entry is on the card and the row, and it only asks the page to open them', () => {
  assert.match(card, /data-action="open-wiki"/);
  assert.match(card, /onClick=\{\(\) => onWiki\(entry\.card!\.videoId\)\}/);
  assert.match(card, /aria-pressed=\{wikiOpen === true\}/);
  assert.match(row, /data-action="open-wiki"/);
});

test('the page renders the notes only for the material that was opened: the list itself reads nothing', () => {
  assert.match(page, /\{wiki && wikiFor && <WikiPanel/, 'one panel, only when a material is open');
  assert.equal(/wiki\.video\(/.test(page), false, 'the page never reads a wiki itself');
  assert.match(page, /onWiki: \(videoId: string\) => setWikiFor\(/, 'the card asks, the page decides');
  /* The entity entry sat in the toolbar that was deleted with the two views' switch; the entities themselves stay a
     component of their own (WikiEntities), drawn only when a page mounts it explicitly. */
  assert.equal(/data-action="open-wiki-entities"/.test(page), false, 'the deleted toolbar took the entity entry with it');
  const entities = readFileSync(new URL('./material-center/WikiEntities.tsx', import.meta.url), 'utf8');
  assert.match(entities, /data-wiki="entit/, 'the entity view is still a component, with its own entries');
});

test('the three production badges, and the disputed state, come from the copy', () => {
  const copy = readFileSync(new URL('../lib/material-center/wiki-copy.ts', import.meta.url), 'utf8');
  for (const production of ['live', 'ai', 'code', 'mixed']) assert.match(copy, new RegExp(production + ':'), production);
  assert.match(copy, /disputed: '有争议'/, 'zh');
  assert.match(copy, /disputed: 'Disputed'/, 'en');
  const panel = readFileSync(new URL('./material-center/WikiPanel.tsx', import.meta.url), 'utf8');
  assert.match(panel, /data-wiki-badge="production"/);
  assert.match(panel, /data-wiki-badge="status"/);
});

test('the entity view keeps hooks and selling points as their own sections', () => {
  const model = readFileSync(new URL('../lib/material-center/wiki.ts', import.meta.url), 'utf8');
  assert.match(model, /'hook', 'selling_point'/, 'both kinds are in the catalogue order');
  const copy = readFileSync(new URL('../lib/material-center/wiki-copy.ts', import.meta.url), 'utf8');
  assert.match(copy, /hook: '话术钩子'/);
  assert.match(copy, /selling_point: '卖点'/);
});

test('a material card offers notes only for cloud material, and the label comes from the library copy', () => {
  assert.match(card, /onWiki && entry\.source === 'cloud' && entry\.card/);
  assert.match(card, /\{copy\.wiki\}/);
  const copy = readFileSync(new URL('../lib/material-center/copy.ts', import.meta.url), 'utf8');
  assert.match(copy, /wiki: '纪要'/);
  assert.match(copy, /wiki: 'Notes'/);
});
