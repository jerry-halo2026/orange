// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The storm guard, held to the new design: at 888 groups the panel's opening reads the tree once and no group at all.
 *
 * A re-render, a remount, a scroll round or a drill-down round trip adds no request — counts live in the session memory
 * and are only ever learned from a payment already made (the drill's own list) or an explicit, bounded pass.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createGroupBoard, createGroupBoardCache, allGroups, type GroupBoardClient} from './material-center/groups.ts';
import type {Facets, MaterialPage} from './material-center/contract.ts';

const tree = (sections: number, perSection: number): Facets => ({
  authorization: {layer: 'self', reason: 's'}, providerScope: 's', videoType: 1,
  oneLevel: Array.from({length: sections}, (_, index) => ({id: 10 + index, name: '一级 ' + (index + 1), level: 1,
    children: Array.from({length: perSection}, (_, at) => ({id: 1000 + index * 10 + at, name: '二级', parentTypeId: 10 + index, level: 2}))})),
  twoLevel: [], states: [], publicLabels: [], labelTotal: null,
});
const page = (): MaterialPage => ({
  authorization: {layer: 'self', reason: 's'}, providerScope: 's', pageNo: 1, pageSize: 1,
  items: [], total: null, providerTotal: 1, totalIsProviderTotal: true, filtered: {inspected: 0, dropped: 0}, grants: false,
});

function counting() {
  const calls = {facets: 0, list: 0};
  const client: GroupBoardClient = {
    async facets() { calls.facets += 1; return tree(111, 8); },
    async list() { calls.list += 1; return page(); },
  };
  return {calls, client};
}

test('a session of twenty mounts over 888 groups reads the tree once and no group at all', async () => {
  const {calls, client} = counting();
  const memory = createGroupBoardCache();
  for (let at = 0; at < 20; at += 1) {
    const board = createGroupBoard({client, scope: 'company', videoType: 1, cache: memory});
    await board.load();
    /* What a render does: read sections and counts. What a scroll does: read them again for other cards. */
    for (const group of allGroups(board.sections()).slice(0, 20)) void board.count(group.key);
    board.destroy();
  }
  assert.equal(calls.facets, 1, 'one tree for the session');
  assert.equal(calls.list, 0, 'no card is read to draw it');
});

test('fifty in-and-out viewport cycles add nothing', async () => {
  const {calls, client} = counting();
  const board = createGroupBoard({client, scope: 'company', videoType: 1, cache: createGroupBoardCache()});
  await board.load();
  const group = allGroups(board.sections())[0]!;
  for (let at = 0; at < 50; at += 1) { void board.count(group.key); void board.sections(); }
  assert.equal(calls.list, 0);
  board.destroy();
});

test('opening a panel costs one facets, and the first explicit counts pass costs at most 24 lists', async () => {
  const {calls, client} = counting();
  const board = createGroupBoard({client, scope: 'company', videoType: 1, cache: createGroupBoardCache()});
  await board.load();
  assert.equal(calls.facets, 1);
  assert.equal(calls.list, 0);
  await board.collect();
  assert.equal(calls.list, 24, 'a bounded pass, not a walk of the catalogue');
  assert.equal(calls.facets, 1);
  board.destroy();
});

test('a group already known is not asked about again by the pass', async () => {
  const {calls, client} = counting();
  const board = createGroupBoard({client, scope: 'company', videoType: 1, cache: createGroupBoardCache()});
  await board.load();
  const groups = allGroups(board.sections());
  board.remember(groups[0]!, 5);
  board.remember(groups[1]!, 6);
  await board.collect();
  assert.equal(calls.list, 24, 'the pass fills 24 *unknown* groups');
  assert.equal(board.count(groups[0]!.key), 5, 'and never overwrites an answer it already had');
  board.destroy();
});
