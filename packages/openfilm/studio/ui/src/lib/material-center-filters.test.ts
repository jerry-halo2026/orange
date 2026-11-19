// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {LIST_QUERY_KEYS, parseScopeParam, scopeParam} from './material-center/contract.ts';
import {
  DEFAULT_FILTERS, hasPageLocalFilters, narrowCards, queryIsAllowed, queryKeys, serverQuery, sortCards, toggleLabel, twoLevelOptions,
  withOneLevel, withTwoLevel, type MaterialFilters,
} from './material-center/filters.ts';
import type {MaterialCard} from './material-center/model.ts';

const card = (over: Partial<MaterialCard> = {}):MaterialCard => ({
  videoId: 'v', title: 'v', coverUrl: null, downloadCount: null, collectCount: null, accountName: null,
  accountKey: null, createTime: null, createdAtMs: null, durationSeconds: null, fileSizeBytes: null,
  oneLevelVideoType: null, twoLevelVideoType: null, videoLabels: [], videoState: null, videoType: 1, ...over,
});

const TWO_LEVEL = [
  {id: 21, name: '美妆', parentTypeId: 11},
  {id: 22, name: '口播', parentTypeId: 11},
  {id: 31, name: '剧情', parentTypeId: 12},
];
const filters = (over:Partial<MaterialFilters> = {}):MaterialFilters => ({...DEFAULT_FILTERS, ...over});

test('the three scopes a person can pick, as the server reads them', () => {
  assert.equal(scopeParam('own'), 'own');
  assert.equal(scopeParam('company'), 'company');
  assert.equal(scopeParam({accountKey: 'k_1'}), 'account:k_1');
  assert.deepEqual(parseScopeParam('account:k_1'), {accountKey: 'k_1'});
  assert.equal(parseScopeParam('account:'), null);
  assert.equal(parseScopeParam('account: k_1'), null, 'a space in the key is refused, not trimmed');
  assert.equal(parseScopeParam('other'), null);
});

test('choosing a one-level category drops a two-level row that does not belong to it', () => {
  const chosen = withTwoLevel(filters(), 21, TWO_LEVEL);
  assert.equal(chosen.oneLevelId, 11, 'the parent comes from parentTypeId');
  assert.equal(chosen.twoLevelId, 21);
  const moved = withOneLevel(chosen, 12);
  assert.equal(moved.oneLevelId, 12);
  assert.equal(moved.twoLevelId, null);
  assert.deepEqual(withOneLevel(filters(), null), filters(), 'no change leaves the state as it was');
  assert.deepEqual(withTwoLevel(filters(), 999, TWO_LEVEL), filters(), 'a row that is not in the list changes nothing');
});

test('the two-level list is the chosen parent\'s children and nothing else', () => {
  assert.deepEqual(twoLevelOptions(filters(), TWO_LEVEL).map(row => row.id), [21, 22, 31]);
  assert.deepEqual(twoLevelOptions(filters({oneLevelId: 11}), TWO_LEVEL).map(row => row.id), [21, 22]);
  assert.deepEqual(twoLevelOptions(filters({oneLevelId: 99}), TWO_LEVEL), []);
});

test('only the six keys the contract lists ever reach the server', () => {
  const query = serverQuery(filters({search: '  口播  ', oneLevelId: 11, labelIds: [5], createdFrom: '2026-01-01', sort: 'downloads', hideUnauthorized: true}), 2, 20);
  assert.deepEqual(Object.keys(query).sort(), ['name', 'pageNo', 'pageSize', 'scope', 'videoType']);
  assert.ok(queryIsAllowed(query));
  assert.ok(queryKeys(query).every(key => (LIST_QUERY_KEYS as readonly string[]).includes(key)));
  assert.equal(query.name, '口播', 'the search text goes as the supplier name parameter');
  assert.equal(serverQuery(filters({search: '   '}), 1, 20).name, undefined);
  assert.throws(() => serverQuery(filters(), 0, 20), /页码/);
  assert.throws(() => serverQuery(filters(), 1, 101), /每页条数/, 'the ceiling is the contract\'s 100, refused before a request');
  assert.throws(() => serverQuery(filters(), 1, 0), /每页条数/);
});

test('labels are a multi-selection: a repeat click removes', () => {
  const one = toggleLabel(filters(), 5);
  assert.deepEqual(one.labelIds, [5]);
  assert.deepEqual(toggleLabel(one, 6).labelIds, [5, 6]);
  assert.deepEqual(toggleLabel(toggleLabel(one, 6), 5).labelIds, [6]);
});

test('the page in hand narrows by classification, labels, the creation window and permissions', () => {
  const cards = [
    card({videoId: 'a', oneLevelVideoType: {id: 11, name: '口播'}, twoLevelVideoType: {id: 21, name: '美妆'}, videoLabels: [{id: 5, name: '转化'}], accountKey: 'mine', createdAtMs: new Date(2026, 10, 1).getTime()}),
    card({videoId: 'b', oneLevelVideoType: {id: 12, name: '剧情'}, twoLevelVideoType: {id: 31, name: '反转'}, videoLabels: [{id: 6, name: '剧情'}], accountKey: 'other', createdAtMs: new Date(2026, 10, 5).getTime()}),
    card({videoId: 'c', accountKey: null}),
  ];
  const ids = (rows: readonly MaterialCard[]) => rows.map(row => row.videoId);
  assert.deepEqual(ids(narrowCards(cards, filters(), null)), ['a', 'b', 'c']);
  assert.deepEqual(ids(narrowCards(cards, filters({oneLevelId: 11}), null)), ['a']);
  assert.deepEqual(ids(narrowCards(cards, filters({twoLevelId: 31}), null)), ['b']);
  assert.deepEqual(ids(narrowCards(cards, filters({labelIds: [6]}), null)), ['b']);
  assert.deepEqual(ids(narrowCards(cards, filters({createdFrom: '2026-11-02'}), null)), ['b'], 'a row with no date cannot satisfy a date window');
  assert.deepEqual(ids(narrowCards(cards, filters({hideUnauthorized: true}), ['mine'])), ['a']);
  assert.deepEqual(ids(narrowCards(cards, filters({hideUnauthorized: true}), null)), [], 'without a known permission set, "hide unauthorized" hides everything rather than guessing');
});

test('the length band narrows the page in hand: an unknown length belongs to no band, only to "any"', () => {
  const cards = [
    card({videoId: 'short', durationSeconds: 30}),
    card({videoId: 'five', durationSeconds: 120}),
    card({videoId: 'long', durationSeconds: 3600}),
    card({videoId: 'unknown'}),
  ];
  const ids = (over: Partial<MaterialFilters>) => narrowCards(cards, filters(over), null).map(row => row.videoId);
  assert.deepEqual(ids({duration: 'any'}), ['short', 'five', 'long', 'unknown'], 'any takes everything, an unknown length too');
  assert.deepEqual(ids({duration: 'under1m'}), ['short']);
  assert.deepEqual(ids({duration: 'oneTo5m'}), ['five']);
  assert.deepEqual(ids({duration: 'fiveTo20m'}), []);
  assert.deepEqual(ids({duration: 'over20m'}), ['long']);
  assert.equal(hasPageLocalFilters(filters({duration: 'under1m'})), true, 'and it is a page-local narrowing: the panel says so');
  assert.equal(hasPageLocalFilters(filters()), false);
});

test('the page in hand sorts by the four orders the panel offers', () => {
  const cards = [
    card({videoId: 'a', title: 'B', downloadCount: '2', collectCount: '9', createdAtMs: 100}),
    card({videoId: 'b', title: 'A', downloadCount: '10', collectCount: '1', createdAtMs: 300}),
  ];
  assert.deepEqual(sortCards(cards, 'newest').map(row => row.videoId), ['b', 'a']);
  assert.deepEqual(sortCards(cards, 'downloads').map(row => row.videoId), ['b', 'a']);
  assert.deepEqual(sortCards(cards, 'collected').map(row => row.videoId), ['a', 'b']);
  assert.deepEqual(sortCards(cards, 'name').map(row => row.videoId), ['b', 'a']);
  assert.deepEqual(cards.map(row => row.videoId), ['a', 'b'], 'sorting a page does not reorder the page it came from');
});
