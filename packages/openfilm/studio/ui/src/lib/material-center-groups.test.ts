// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The group board under the product's real scale: 888 groups.
 *
 * The rule the supplier forced: a card is a name. The panel's own opening is one `facets` read and **no list at all**;
 * a count appears only after a group is opened (its list's `providerTotal`) or after a person asks for counts, in one
 * small controlled pass that stops the moment the supplier says no.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildGroupSections, createGroupBoard, createGroupBoardCache, allGroups, isThrottled, type GroupBoardClient, type GroupRef, type GroupScope} from './material-center/groups.ts';
import type {Facets, MaterialPage, WireItem} from './material-center/contract.ts';

const leaf = (id: number, parent: number) => ({id, name: '二级 ' + id, parentTypeId: parent, level: 2});
/** 888 groups across 120 one-level sections, the real catalogue's order of magnitude. */
function bigTree(): Facets {
  const sections = 111;
  const perSection = 8;
  return {
    authorization: {layer: 'self', reason: 's'}, providerScope: 's', videoType: 1,
    oneLevel: Array.from({length: sections}, (_, index) => ({id: 10 + index, name: '一级 ' + (index + 1), level: 1,
      children: Array.from({length: perSection}, (_, at) => leaf(1000 + index * 10 + at, 10 + index))})),
    twoLevel: [], states: [], publicLabels: [], labelTotal: null,
  };
}
function smallTree(groups: number): Facets {
  return {
    authorization: {layer: 'self', reason: 's'}, providerScope: 's', videoType: 1,
    oneLevel: [{id: 11, name: '一级 A', level: 1, children: Array.from({length: groups}, (_, at) => leaf(1000 + at, 11))}],
    twoLevel: [], states: [], publicLabels: [], labelTotal: null,
  };
}
const page = (total: unknown = null, items: WireItem[] = []): MaterialPage => ({
  authorization: {layer: 'self', reason: 's'}, providerScope: 's', pageNo: 1, pageSize: 1,
  items, total: null, providerTotal: total as never, totalIsProviderTotal: true, filtered: {inspected: items.length, dropped: 0}, grants: false,
});

function counting(tree: Facets, answer: (query: Record<string, string | number>) => Promise<MaterialPage> = async () => page(7)) {
  const calls = {facets: 0, list: [] as Record<string, string | number>[]};
  const client: GroupBoardClient = {
    async facets() { calls.facets += 1; return tree; },
    async list(query) { calls.list.push(query); return answer(query); },
  };
  return {calls, client};
}

test('opening the panel at 888 groups is one facets read and no list at all', async () => {
  const {calls, client} = counting(bigTree());
  const board = createGroupBoard({client, scope: 'company', videoType: 1, cache: createGroupBoardCache()});
  await board.load();
  assert.equal(calls.facets, 1);
  assert.equal(calls.list.length, 0, 'a card is a name: nothing is read to draw the list');
  assert.equal(allGroups(board.sections()).length, 888);
  board.destroy();
});

test('twenty scroll rounds and fifty cards in and out of view ask for nothing', async () => {
  const {calls, client} = counting(bigTree());
  const board = createGroupBoard({client, scope: 'company', videoType: 1, cache: createGroupBoardCache()});
  await board.load();
  /* A card in view draws its name and its count if one is already known; both are memory reads. */
  for (let round = 0; round < 20; round += 1) {
    for (const group of allGroups(board.sections()).slice(0, 3)) {
      void board.count(group.key);
      void board.sections();
    }
  }
  for (let at = 0; at < 50; at += 1) void board.count('11/1000');
  assert.equal(calls.list.length, 0, 'scrolling is not a request');
  assert.equal(calls.facets, 1);
  board.destroy();
});

test('a group opened answers its total once, and the card says it on the way back without asking again', async () => {
  const {calls, client} = counting(smallTree(3), async () => page(42));
  const board = createGroupBoard({client, scope: 'company', videoType: 1, cache: createGroupBoardCache()});
  await board.load();
  const [group] = allGroups(board.sections());
  assert.equal(board.count(group!.key), null, 'unknown until something reads it');
  /* The drill-down's first page is the read that pays for the count: the board only remembers the answer. */
  board.remember(group!, 42);
  assert.equal(board.count(group!.key), 42);
  assert.equal(calls.list.length, 0, 'writing the count back is not a request');
  board.destroy();
});

test('the explicit counts pass is bounded: at most 24 groups, two at a time, and it stops on a throttle', async () => {
  const {calls, client} = counting(smallTree(60));
  const board = createGroupBoard({client, scope: 'company', videoType: 1, cache: createGroupBoardCache()});
  await board.load();
  let inFlight = 0;
  let max = 0;
  const original = client.list;
  (client as {list: GroupBoardClient['list']}).list = async query => {
    inFlight += 1;
    max = Math.max(max, inFlight);
    try { return await original(query); } finally { inFlight -= 1; }
  };
  await board.collect();
  assert.equal(calls.list.length, 24, 'one pass asks about 24 groups, not 60');
  assert.ok(max <= 2, 'and no more than two are out at once, got ' + max);
  assert.equal(board.batchSize(), 24);
  board.destroy();
});

test('a 429 stops the pass, says why, and never asks again by itself', async () => {
  let calls = 0;
  const client: GroupBoardClient = {
    async facets() { return smallTree(60); },
    async list() {
      calls += 1;
      if (calls === 3) throw Object.assign(new Error('provider-rate-limited'), {status: 429, code: 'provider-rate-limited'});
      return page(5);
    },
  };
  const board = createGroupBoard({client, scope: 'company', videoType: 1, cache: createGroupBoardCache()});
  await board.load();
  await board.collect();
  assert.equal(board.notice(), 'throttled', 'the panel has a sentence to show');
  assert.equal(board.collecting(), false);
  const after = calls;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls, after, 'nothing keeps going on its own');
  await board.collect();
  assert.equal(calls, after, 'a second pass while the notice stands does nothing either');
  board.clearNotice();
  board.destroy();
});

test('a throttled answer is recognised by its status or its code', () => {
  assert.equal(isThrottled({status: 429}), true);
  assert.equal(isThrottled({code: 'provider-rate-limited'}), true);
  assert.equal(isThrottled({body: {code: 'provider-rate-limited'}}), true);
  assert.equal(isThrottled({status: 500, code: 'internal-error'}), false);
});

test('company and own keep separate trees and separate counts', async () => {
  const {calls, client} = counting(smallTree(2));
  const memory = createGroupBoardCache();
  const company = createGroupBoard({client, scope: 'company', videoType: 1, cache: memory});
  await company.load();
  const shared = allGroups(company.sections())[0]!;
  company.remember(shared, 9);
  const own = createGroupBoard({client, scope: 'own', videoType: 1, cache: memory});
  await own.load();
  assert.equal(calls.facets, 2, 'a tree per scope');
  assert.equal(own.count(shared.key), null, 'a count from company is never shown as own');
  assert.equal(company.count(shared.key), 9);
  own.remember(allGroups(own.sections())[0]!, 4);
  assert.equal(company.count(shared.key), 9, 'and the other way round');
  company.destroy();
  own.destroy();
});

test('a remount reuses the session: no facets, no counts read', async () => {
  const {calls, client} = counting(smallTree(5));
  const memory = createGroupBoardCache();
  const first = createGroupBoard({client, scope: 'company', videoType: 1, cache: memory});
  await first.load();
  first.remember(allGroups(first.sections())[0]!, 3);
  first.destroy();
  const again = createGroupBoard({client, scope: 'company', videoType: 1, cache: memory});
  await again.load();
  assert.equal(calls.facets, 1);
  assert.equal(calls.list.length, 0);
  assert.equal(again.count(allGroups(again.sections())[0]!.key), 3, 'the count survived the remount');
  again.destroy();
});

test('one board loads once even when asked three times at once', async () => {
  const {calls, client} = counting(smallTree(2));
  const board = createGroupBoard({client, scope: 'company', videoType: 1, cache: createGroupBoardCache()});
  await Promise.all([board.load(), board.load(), board.load()]);
  await board.load();
  assert.equal(calls.facets, 1);
  board.destroy();
});

test('the tree is sections of two-level groups: a single child is not nested twice, an empty one has no card', () => {
  const sections = buildGroupSections({...smallTree(1), oneLevel: [
    {id: 11, name: '一级 A', level: 1, children: [leaf(21, 11), leaf(22, 11)]},
    {id: 12, name: '一级 B', level: 1, children: [leaf(31, 12)]},
    {id: 13, name: '一级 C', level: 1, children: []},
  ]});
  assert.equal(sections.length, 2, 'a one-level with no two-level makes no section');
  assert.equal(sections[0]!.flat, false);
  assert.equal(sections[1]!.flat, true, 'a single child is shown directly');
  assert.equal(allGroups(sections).length, 3);
});

test('the tab renders no request path of its own: no visibility probe, no cover read', () => {
  const tab = readFileSync(new URL('../components/material-center/CloudMaterialsTab.tsx', import.meta.url), 'utf8');
  assert.equal(/IntersectionObserver/.test(tab), false, 'a card does not watch the viewport');
  assert.equal(/LazyCover|<img/.test(tab), false, 'and no cover is drawn (a cover is a read)');
  assert.equal(/probe/i.test(tab), false, 'the probe path is gone');
  /* Counts come from the index the library built once (one read), never from a page the tab reads for itself. */
  const view = readFileSync(new URL('../components/material-center/CollectionsView.tsx', import.meta.url), 'utf8');
  assert.match(view, /data-group-count=\{row\.count\}/, 'counts come from what the index already counted');
  assert.equal(/fetch\s*\(/.test(tab), false, 'nothing here fetches a page of its own');
});
