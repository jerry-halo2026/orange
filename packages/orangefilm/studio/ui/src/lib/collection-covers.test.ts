// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The four covers of a 合集 card, without a browser: the rows are injected (`list`), so one test holds the request shape
 * (one page of four, `name=` = the set's prefix), the cache (a second look is not a second request), the failure (no
 * cover, no sentence) and the join with the page's own entries (a foreign material never lends its cover).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collageUrls, createCollectionCoverStore, COLLAGE_CELLS, NO_COVERS } from './material-center/collection-covers.ts';
import type { MaterialPage, WireItem } from './material-center/contract.ts';

const row = (videoId: string, coverUrl: string | null): WireItem => ({
  videoId: { value: videoId, sourceType: 'string', source: videoId },
  observation: { name: videoId, ...(coverUrl ? { coverUrl } : {}) },
});

const answer = (items: readonly WireItem[], pageSize = 4): MaterialPage => ({
  authorization: { layer: 'self', reason: 's' }, providerScope: 's', pageNo: 1, pageSize,
  items, total: { sourceType: 'number', source: String(items.length) }, providerTotal: items.length,
  totalIsProviderTotal: true, filtered: { inspected: items.length, dropped: 0 }, grants: false,
});

test('a collage is four covers at most: the rows read for the set first, then this page\'s own rows of it', () => {
  const entries = [
    { id: 'cloud:c1', cover: '/a.jpg' },
    { id: 'cloud:c2', cover: '/b.jpg' },
    { id: 'cloud:other', cover: '/foreign.jpg' },
  ];
  assert.deepEqual(collageUrls({ ids: ['c1', 'c2', 'c3', 'c4'], entries }), ['/a.jpg', '/b.jpg'],
    'the materials of another set never lend a cover, and there is no cover for a row this page does not have');
  assert.deepEqual(collageUrls({ ids: ['c1', 'c2'], entries, fetched: ['/a.jpg', '/x.jpg', '/y.jpg', '/z.jpg', '/w.jpg'] }),
    ['/a.jpg', '/x.jpg', '/y.jpg', '/z.jpg'], 'the read rows come first, deduped against the entries, four at most');
  assert.equal(COLLAGE_CELLS, 4);
  assert.deepEqual(collageUrls({ ids: [], entries: [] }), [], 'nothing known is no cover, not a broken one');
  assert.deepEqual(collageUrls({ ids: ['c1'], entries: [{ id: 'cloud:c1', cover: '   ' }] }), [],
    'a blank cover is no cover');
});

test('one page of four per set: the same prefix is never asked for twice, and the filters are read at request time', async () => {
  const asked: string[] = [];
  let scope = 'company';
  const store = createCollectionCoverStore({
    list: async query => {
      asked.push(String(query.name) + '|' + query.pageNo + '|' + query.pageSize + '|' + query.scope + '|' + query.videoType);
      return answer([row('v1', '/1.jpg'), row('v2', '/2.jpg'), row('v3', null), row('v4', '/4.jpg'), row('v5', '/5.jpg')]);
    },
    context: () => ({ videoType: 1, scope: scope as 'company' | 'own' }),
  });
  assert.deepEqual(store.coversOf('20261106-柠檬宝藏茶200g罐'), NO_COVERS, 'nothing is asked before a card is in view');

  store.ensure('20261106-柠檬宝藏茶200g罐');
  store.ensure('20261106-柠檬宝藏茶200g罐');
  scope = 'own';
  store.ensure('20261106-柠檬宝藏茶200g罐');
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.deepEqual(asked, ['20261106-柠檬宝藏茶200g罐|1|4|company|1'], 'one request: four rows, the prefix, the class and scope of now');
  const covers = store.coversOf('20261106-柠檬宝藏茶200g罐');
  assert.equal(covers.state, 'ready');
  assert.deepEqual(covers.urls, ['/1.jpg', '/2.jpg', '/4.jpg', '/5.jpg'], 'a row without a cover is not a cell, and four are kept');
  store.destroy();
});

test('a refused read is remembered as failed: no cover, no second request, nothing thrown at the card', async () => {
  let calls = 0;
  const store = createCollectionCoverStore({
    list: async () => { calls += 1; throw new Error('material-service-unavailable'); },
    context: () => ({ videoType: 1, scope: 'company' }),
  });
  store.ensure('20261106-柠檬宝藏茶200g罐');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  assert.deepEqual(store.coversOf('20261106-柠檬宝藏茶200g罐'), { state: 'failed', urls: [] });
  store.ensure('20261106-柠檬宝藏茶200g罐');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls, 1, 'a failure is not retried by every render of the card');
  store.destroy();
});

test('an empty prefix is never a request, and a destroyed store publishes nothing', async () => {
  let calls = 0;
  const store = createCollectionCoverStore({
    list: async () => { calls += 1; return answer([]); },
    context: () => ({ videoType: 1, scope: 'company' }),
  });
  store.ensure('');
  store.ensure('   ');
  assert.equal(calls, 0, 'a 「未归档」 bucket has no prefix, so there is nothing to ask for');
  store.ensure('12.13');
  store.destroy();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls, 1);
});
