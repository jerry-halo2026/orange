// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * A 子合集's own read: the group is asked for **by its name prefix**, page by page, and the button that asks for the
 * next page disappears once the loaded rows reach the supplier's total.
 *
 * The three defects this holds shut (all three were live): a group was filtered out of the page the list happened to
 * have (`索引 23 条，本页已加载 0 条`, a wall of nothing); its covers were nowhere, because the index keeps `md5` and not
 * `coverUrl`; and there was no way to ask for the rest of it.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {LIST_QUERY_KEYS, type MaterialPage, type WireItem} from './material-center/contract.ts';
import {
  GROUP_PAGE_SIZE, appendGroupPage, createGroupPageReader, emptyGroupPage, groupLoadMore, groupPageQuery,
  groupPrefixOf, groupTotalOf,
} from './material-center/group-page.ts';

const row = (videoId: string, name: string, coverUrl: string | null): WireItem => ({
  videoId: {value: videoId, sourceType: 'string', source: videoId},
  observation: {name, ...(coverUrl ? {coverUrl} : {})},
});

/** One answered page, as the supplier shapes it: `total` is the company-wide claim for this query. */
function pageOf(pageNo: number, items: WireItem[], total: number | null, pageSize = GROUP_PAGE_SIZE): MaterialPage {
  return {
    authorization: {layer: 'self', reason: 'own-account-key'},
    providerScope: 'company',
    pageNo, pageSize,
    items,
    total: total === null ? null : {sourceType: 'number', source: String(total)},
    providerTotal: total,
    totalIsProviderTotal: true,
    filtered: {inspected: items.length, dropped: 0},
    grants: false,
  };
}

test('the prefix is the group id: <日期>-<产品>-<分组>, and the sequence stays out of it', () => {
  assert.equal(groupPrefixOf('20261109-油弃乌龙茶', {id: '20261109-油弃乌龙茶-茶干', name: '茶干'}), '20261109-油弃乌龙茶-茶干');
  assert.equal(groupPrefixOf('20261106-2024头采新会柑普茶250g罐', {id: '20261106-2024头采新会柑普茶250g罐-包装', name: '包装'}),
    '20261106-2024头采新会柑普茶250g罐-包装', 'a product that carries a dash keeps it');
  /* Not one of the names it matches: the prefix is the group, never a whole material name. */
  const prefix = groupPrefixOf('20261109-油弃乌龙茶', {id: '20261109-油弃乌龙茶-茶干', name: '茶干'});
  assert.equal(/\s\(\d+\)$/.test(prefix), false, 'no ` (12)` sequence in a prefix');
  /* An id that does not sit under the collection is not used as a prefix: the collection and the name say it instead. */
  assert.equal(groupPrefixOf('20261109-油弃乌龙茶', {id: 'derived:unfiled:茶干', name: '茶干'}),
    '20261109-油弃乌龙茶-茶干');
});

test('the query is a prefix read: name= the group, pageSize 100, and only keys the contract lists', () => {
  const query = groupPageQuery('20261109-油弃乌龙茶-茶干', {videoType: 1, scope: 'company', pageNo: 1});
  assert.deepEqual(query, {pageNo: 1, pageSize: 100, videoType: 1, name: '20261109-油弃乌龙茶-茶干', scope: 'company'});
  assert.deepEqual(Object.keys(query).filter(key => !(LIST_QUERY_KEYS as readonly string[]).includes(key)), [],
    'nothing outside pageNo/pageSize/videoType/name/scope is sent');
  assert.equal(GROUP_PAGE_SIZE, 100, 'the supplier ceiling: one press is one full page');
  assert.equal(groupPageQuery('p', {videoType: 1, scope: 'own', pageNo: 1, pageSize: 500}).pageSize, 100, 'never past 100');
  assert.equal(groupPageQuery('p', {videoType: 1, scope: {accountKey: 'acc'}, pageNo: 0}).pageNo, 1, 'no page 0');
  assert.equal(groupPageQuery('p', {videoType: 1, scope: {accountKey: 'acc'}, pageNo: 1}).scope, 'account:acc');
});

test('the total is the supplier\'s own: providerTotal, else the wire total, else nothing', () => {
  assert.equal(groupTotalOf(pageOf(1, [], 45)), 45);
  const wireOnly = {...pageOf(1, [], null), total: {sourceType: 'number' as const, source: '221'}};
  assert.equal(groupTotalOf(wireOnly), 221);
  assert.equal(groupTotalOf(pageOf(1, [], null)), null, 'a page that claims nothing claims nothing');
});

test('one page appends, dedupes by videoId, and keeps the cover the row carried', () => {
  const opened = emptyGroupPage('20261109-油弃乌龙茶-茶干');
  const first = appendGroupPage(opened, pageOf(1, [
    row('1', '20261109-油弃乌龙茶-茶干 (1)', 'https://example.test/1.jpg'),
    row('2', '20261109-油弃乌龙茶-茶干 (2)', null),
  ], 3, 2), 2);
  assert.equal(first.loaded, 2);
  assert.equal(first.total, 3);
  assert.equal(first.exhausted, false, 'a full page that has not reached the total is not the end');
  assert.equal(first.cards[0]!.coverUrl, 'https://example.test/1.jpg', 'the cover comes from the row, not from the index');
  assert.equal(first.cards[1]!.coverUrl, null, 'and a row without one stays without one (the card draws its placeholder)');

  const second = appendGroupPage(first, pageOf(2, [
    row('2', '20261109-油弃乌龙茶-茶干 (2)', null),
    row('3', '20261109-油弃乌龙茶-茶干 (3)', 'https://example.test/3.jpg'),
  ], 3, 2), 2);
  assert.deepEqual(second.cards.map(card => card.videoId), ['1', '2', '3'], 'appended in order, the repeat dropped');
  assert.equal(second.loaded, 3);
  assert.equal(second.exhausted, true, 'loaded reached total: nothing more to take');
});

test('a group reads one page per press, appends the next, and stops asking at its total', async () => {
  const asked: Record<string, string | number>[] = [];
  const full = (pageNo: number, count: number) => pageOf(pageNo, Array.from({length: count}, (_, at) =>
    row(String(pageNo * 1000 + at), '20261109-油弃乌龙茶-茶干 (' + (pageNo * 1000 + at) + ')', 'https://example.test/c.jpg')), 221);
  const reader = createGroupPageReader({
    context: () => ({videoType: 1, scope: 'company'}),
    async list(query) {
      asked.push({...query});
      const pageNo = Number(query.pageNo);
      return pageNo < 3 ? full(pageNo, 100) : pageOf(3, full(3, 21).items, 221, 21);
    },
  });
  const prefix = '20261109-油弃乌龙茶-茶干';

  await reader.open(prefix);
  assert.equal(asked.length, 1, 'opening a group is one request');
  assert.equal(asked[0]!.name, prefix, 'and it is asked for by the group prefix');
  assert.equal(asked[0]!.pageNo, 1);
  assert.equal(asked[0]!.pageSize, 100);
  assert.equal(asked[0]!.videoType, 1, 'the view\'s own class travels with it');
  assert.equal(reader.getState().loaded, 100);
  assert.equal(reader.getState().total, 221);
  assert.equal(groupLoadMore(reader.getState()), true, 'the button is there while rows remain');

  await reader.open(prefix);
  assert.equal(asked.length, 1, 'opening the group already on screen is no request at all');

  await reader.more();
  assert.equal(asked.length, 2);
  assert.equal(asked[1]!.pageNo, 2, 'the next page, appended');
  assert.equal(reader.getState().loaded, 200);
  assert.equal(groupLoadMore(reader.getState()), true);

  await reader.more();
  assert.equal(asked.length, 3);
  assert.equal(asked[2]!.pageNo, 3);
  assert.equal(reader.getState().loaded, 221);
  assert.equal(reader.getState().exhausted, true, 'the total is reached');
  assert.equal(groupLoadMore(reader.getState()), false, 'so the load-more button is gone');

  await reader.more();
  assert.equal(asked.length, 3, 'and pressing again asks for nothing: the total is the end');
  reader.destroy();
});

test('a group with nothing under its prefix is empty, not "0 loaded of a page that was never asked for"', async () => {
  const reader = createGroupPageReader({
    context: () => ({videoType: 1, scope: 'company'}),
    async list() { return pageOf(1, [], 0); },
  });
  await reader.open('20261109-油弃乌龙茶-茶干');
  const state = reader.getState();
  assert.equal(state.loaded, 0);
  assert.equal(state.total, 0);
  assert.equal(state.exhausted, true);
  assert.equal(groupLoadMore(state), false, 'no button over an empty group');
  reader.destroy();
});

test('a page past the end does not overwrite the total it already learned', () => {
  const first = appendGroupPage(emptyGroupPage('20261106-柠檬宝藏茶'), pageOf(1, [
    row('1', '20261106-柠檬宝藏茶200g罐-茶干 (1)', null),
  ], 221, 1), 1);
  assert.equal(first.total, 221);
  /* Measured on the live supplier: one page past the end answers `total: 0` with no rows. */
  const past = appendGroupPage(first, pageOf(4, [], 0, 100), 100);
  assert.equal(past.total, 221, 'the learned total stays');
  assert.equal(past.loaded, 1);
  assert.equal(past.exhausted, true, 'an empty page is the end even when the total says rows remain');
  assert.equal(groupLoadMore(past), false);
});

test('a failure keeps its status and code, and the retry asks the page that failed again', async () => {
  const asked: number[] = [];
  let fail = true;
  const reader = createGroupPageReader({
    context: () => ({videoType: 1, scope: 'company'}),
    async list(query) {
      asked.push(Number(query.pageNo));
      if (fail) throw Object.assign(new Error('no'), {status: 403, code: 'authorization-denied'});
      return pageOf(Number(query.pageNo), [row('1', '20261109-油弃乌龙茶-茶干 (1)', null)], 1);
    },
  });
  await reader.open('20261109-油弃乌龙茶-茶干');
  assert.deepEqual(reader.getState().failure, {status: 403, code: 'authorization-denied', message: 'no'},
    'the real code is kept, so the view can print it');
  assert.equal(groupLoadMore(reader.getState()), false, 'a failure is not a "load more"');
  fail = false;
  await reader.retry();
  assert.deepEqual(asked, [1, 1], 'the first page is asked again');
  assert.equal(reader.getState().failure, null);
  assert.equal(reader.getState().loaded, 1);
  reader.destroy();
});

test('the view draws the prefix read, the load-more button and the "all loaded" line, and never "已加载 0 条"', () => {
  const view = readFileSync(new URL('../components/material-center/CollectionsView.tsx', import.meta.url), 'utf8');
  const group = readFileSync(new URL('../components/material-center/GroupMaterials.tsx', import.meta.url), 'utf8');
  const copy = readFileSync(new URL('../lib/material-center/copy.ts', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../components/material-center/MaterialCenterPage.tsx', import.meta.url), 'utf8');
  const center = readFileSync(new URL('../components/MaterialCenter.tsx', import.meta.url), 'utf8');

  assert.match(view, /groupPrefixOf\(collection\.id, group\)/, 'the group is read by its own prefix');
  assert.match(view, /<GroupMaterials copy=\{copy\} prefix=\{groupPrefixOf\(collection\.id, group\)\} page=\{page\} renderEntries=\{renderEntries\}/);
  assert.match(group, /data-action="load-more"/, 'the button is there');
  assert.match(group, /groupLoadMore\(state\) &&/, 'and it is drawn only while rows remain');
  assert.match(group, /copy\.groupLoadedAll\(state\.loaded\)/, 'the line that replaces it names how many are loaded');
  assert.match(group, /data-state="group-empty"[\s\S]{0,120}copy\.groupEmpty/, 'an empty group says so');
  assert.match(group, /data-code-text=\{state\.failure\.code\}/, 'a failure prints its real code');
  assert.match(group, /cloudEntries\(state\.cards\)/, 'the cards (and their covers) come from the rows');
  assert.equal(/groupWindow/.test(copy + group + view + page), false, 'the 索引 N 条／本页已加载 M 条 sentence is gone for good');
  assert.match(copy, /groupEmpty: '该分组暂无素材。'/);
  assert.match(copy, /groupLoadMore: '加载更多'/);
  assert.match(copy, /groupLoadedAll: loaded => `已全部加载 \$\{loaded\} 条`/);
  assert.match(page, /createGroupPageReader\(\{/, 'the page owns one reader');
  assert.match(page, /readonly list: GroupPageClient\['list'\]/, 'the list route is handed in, not built here');
  assert.match(center, /list=\{studioClient\.list\}/, 'and it is the one client\'s list route (no second client)');
  assert.match(page, /context: \(\) => \(\{videoType: controller\.getState\(\)\.filters\.videoType, scope: controller\.getState\(\)\.filters\.author\}\)/,
    'the class and the scope are the view\'s at request time');
});

test('the derived batches say how many there are and how many are listed', () => {
  const view = readFileSync(new URL('../components/material-center/CollectionsView.tsx', import.meta.url), 'utf8');
  const copy = readFileSync(new URL('../lib/material-center/copy.ts', import.meta.url), 'utf8');
  assert.match(view, /copy\.derivedMore\(stages\.derived\.length, derivedShown\.length\)/);
  assert.match(view, /data-derived-total=\{stages\.derived\.length\}/, 'the total is on screen, not only the hidden count');
  assert.match(copy, /共 \$\{total\} 个派生批次，只显示前 \$\{shown\} 个/);
  assert.match(copy, /`\$\{total\} derived batches in all; the first \$\{shown\} are listed`/);
});
