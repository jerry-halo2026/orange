// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The drill-down cycle: back to the groups, then into the same group again, must cost nothing.
 *
 * The panel keeps the drilled library mounted (hidden) so a second visit is a visibility change; the group's list was
 * read once, and the count it answered is written back to the card from the session memory — no request on the way back.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {drillKey, sameDrill} from './material-center/drill.ts';
import {createGroupBoard, createGroupBoardCache, allGroups, type GroupBoardClient, type GroupRef} from './material-center/groups.ts';
import {createMaterialCenterController} from './material-center/controller.ts';
import type {Facets, MaterialPage} from './material-center/contract.ts';
import type {MaterialsClient} from './material-center/client.ts';

const group: GroupRef = {id: 21, name: '二级 A', oneLevelId: 11, oneLevelName: '一级 A', key: '11/21'};
const other: GroupRef = {...group, id: 22, name: '二级 B', key: '11/22'};

const tree: Facets = {
  authorization: {layer: 'self', reason: 's'}, providerScope: 's', videoType: 1,
  oneLevel: [{id: 11, name: '一级 A', level: 1, children: [{id: 21, name: '二级 A', parentTypeId: 11, level: 2}]}],
  twoLevel: [], states: [], publicLabels: [], labelTotal: null,
};
const page = (total: number): MaterialPage => ({
  authorization: {layer: 'self', reason: 's'}, providerScope: 's', pageNo: 1, pageSize: 20,
  items: [], total: null, providerTotal: total, totalIsProviderTotal: true, filtered: {inspected: 0, dropped: 0}, grants: false,
});

test('re-entering the same group (same scope) is the same drill; another group or scope is not', () => {
  assert.equal(sameDrill(null, group, 'company'), false, 'nothing drilled yet');
  assert.equal(sameDrill({group, scope: 'company'}, group, 'company'), true, 'the same group in the same scope');
  assert.equal(sameDrill({group, scope: 'company'}, group, 'own'), false, 'the same group in another scope is another library');
  assert.equal(sameDrill({group, scope: 'company'}, other, 'company'), false);
  assert.equal(drillKey(group, 'company'), 'company|11/21');
  assert.notEqual(drillKey(group, 'company'), drillKey(group, 'own'));
});

test('entering a group is one list; the count it answers is written back without a second request', async () => {
  const calls = {list: 0, facets: 0};
  const client: MaterialsClient = {
    routes: ['/list', '/facets', '/labels'],
    async list() { calls.list += 1; return page(42); },
    async facets() { calls.facets += 1; return tree; },
    async labels() { return {authorization: {layer: 'self', reason: 's'}, providerScope: 's', pageNo: 1, pageSize: 20, labels: [], total: null}; },
  };
  const controller = createMaterialCenterController({client, initialFilters: {source: 'cloud', twoLevelId: 21, groupIds: [21]}});
  await controller.refresh();
  assert.equal(calls.list, 1, 'the drill reads its first page once');
  assert.equal(controller.getState().page?.providerTotal, 42, 'and the answer carries the total');

  /* The panel's write-back: the same answer, into the session memory — no request. */
  const memory = createGroupBoardCache();
  const board = createGroupBoard({client: {facets: async () => tree, list: async () => page(42)}, scope: 'company', videoType: 1, cache: memory});
  await board.load();
  board.remember(group, 42);
  assert.equal(calls.list, 1, 'remembering is not a read');
  assert.equal(board.count(group.key), 42);
  controller.destroy();
  board.destroy();
});

test('the cloud tab keeps the open 合集 and hands it to the one library, remembering its total', () => {
  const tab = readFileSync(new URL('../components/material-center/CloudMaterialsTab.tsx', import.meta.url), 'utf8');
  assert.match(tab, /renderLibrary\(\)/, 'the tab renders the one library and scopes nothing of its own');
  assert.equal(/setOpen|board\.remember/.test(tab), false, 'a board with its own drill is no longer the tab\'s');
  /* The step into a 合集 and back is the shared collections view\'s (both hosts draw the same one). */
  const view = readFileSync(new URL('../components/material-center/CollectionsView.tsx', import.meta.url), 'utf8');
  assert.match(view, /setSelection\(selectionOf\(batchId, row\.id\)\)/, 'a 合集 card opens that 合集 (with its batch)');
  assert.match(view, /selectionAtCrumb\(selection, crumb\.level, crumb\.id\)/, 'and every crumb goes back one level');
  assert.equal(/drillKey|sameDrill/.test(tab), false, 'a tab is not a panel: no hidden drill pane to keep mounted');
});
