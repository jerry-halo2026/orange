// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

﻿import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {Facets, Labels, MaterialPage, WireItem} from './material-center/contract.ts';
import {createMaterialCenterController, USE_NOTICE, USE_UNAVAILABLE_NOTICE} from './material-center/controller.ts';
import type {MaterialsClient} from './material-center/client.ts';
import {copyFor, failureCopy} from './material-center/copy.ts';

const item = (id:string, over: Partial<Record<string, never>> = {}):WireItem => ({
  videoId: {value: id, sourceType: 'string', source: id},
  observation: {name: '素材 ' + id, accountKey: 'ak_mine', downloadCount: {sourceType: 'number', source: '3'}, ...over},
});

const page = (over: Partial<MaterialPage> = {}):MaterialPage => ({
  authorization: {layer: 'self', reason: 'own-account-key'}, providerScope: 's', pageNo: 1, pageSize: 2,
  items: [item('a'), item('b')], total: null, providerTotal: 178391, totalIsProviderTotal: true,
  filtered: {inspected: 2, dropped: 0}, grants: false, ...over,
});

const facets:Facets = {
  authorization: {layer: 'self', reason: 'own-account-key'}, providerScope: 's', videoType: 1,
  oneLevel: [{id: 11, name: '口播', level: 1, children: [{id: 21, name: '美妆', parentTypeId: 11, level: 2}]}],
  twoLevel: [{id: 21, name: '美妆', parentTypeId: 11, level: 2}], states: [], publicLabels: [], labelTotal: null,
};
const labels:Labels = {authorization: {layer: 'self', reason: 'own-account-key'}, providerScope: 's', pageNo: 1, pageSize: 1, labels: [], total: null};

/** Every call the controller could possibly make, recorded. The material centre is expected to make very few. */
function recordingClient(answers: {list?: () => Promise<MaterialPage>} = {}) {
  const calls: {route: string; query: Readonly<Record<string, string | number>>}[] = [];
  const client:MaterialsClient = {
    routes: ['/list', '/facets', '/labels'],
    async list(query) { calls.push({route: 'list', query}); return answers.list ? answers.list() : page(); },
    async facets(query) { calls.push({route: 'facets', query}); return facets; },
    async labels(query) { calls.push({route: 'labels', query}); return labels; },
  };
  return {client, calls, listCalls: () => calls.filter(call => call.route === 'list')};
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

test('hovering a card asks nothing: it records what the pointer is over and stops there', async () => {
  const {client, calls} = recordingClient();
  const controller = createMaterialCenterController({client});
  await controller.refresh();
  const before = calls.length;
  controller.hover('a');
  controller.hover('b');
  controller.hover(null);
  await flush();
  assert.equal(calls.length, before, 'a hover must not reach the network — not the list, not the facets, not a file');
  assert.equal(controller.getState().hovered, null);
  controller.hover('a');
  assert.equal(controller.getState().hovered, 'a');
  assert.equal(calls.length, before);
  controller.destroy();
});

test('one page load is one request; a short page is never fetched again by itself', async () => {
  const {client, calls, listCalls} = recordingClient();
  const controller = createMaterialCenterController({client, pageSize: 2});
  await controller.refresh();
  assert.equal(listCalls().length, 1, 'the short-page rule: the client decides to stop, the UI does not help itself');
  assert.equal(controller.getState().status, 'ready');
  assert.deepEqual(controller.getState().cards.map(card => card.videoId), ['a', 'b']);
  assert.equal(controller.getState().hasMore, true, 'a full page may have more behind it');
  assert.equal(calls.length, 1);
  controller.destroy();
});

test('a page the authorization layer emptied is empty with a reason, not "no materials"', async () => {
  const {client} = recordingClient({list: async () => page({items: [], filtered: {inspected: 20, dropped: 20}})});
  const controller = createMaterialCenterController({client});
  await controller.refresh();
  const state = controller.getState();
  assert.equal(state.status, 'empty');
  assert.equal(state.hasMore, false);
  assert.match(state.emptyReason ?? '', /全部不在授权范围内/);
  assert.match(state.emptyReason ?? '', /翻到下一页/, 'the person is told the page can be flipped, not that the library is empty');
  controller.destroy();
});

test('a dropped-row page says "本页已按授权过滤" and names the numbers', async () => {
  const {client} = recordingClient({list: async () => page({filtered: {inspected: 20, dropped: 18}})});
  const controller = createMaterialCenterController({client});
  await controller.refresh();
  const state = controller.getState();
  assert.match(state.filteredNotice ?? '', /本页已按授权过滤/);
  assert.match(state.filteredNotice ?? '', /丢弃 18 行/);
  assert.equal(state.dropped, 18);
  assert.match(state.providerTotalNote ?? '', /不是本人可见条数/);
  assert.equal(state.emptyReason, null);
  controller.destroy();
});

test('no permission is its own screen, and a failure is not retried behind the person\'s back', async () => {
  const denied = createMaterialCenterController({client: recordingClient({list: async () => {
    throw Object.assign(new Error('没有权限'), {status: 403, code: 'authorization-denied'});
  }}).client});
  await denied.refresh();
  assert.equal(denied.getState().status, 'unauthorized');
  assert.equal(denied.getState().cards.length, 0);
  denied.destroy();

  const recorder = recordingClient({list: async () => {
    throw Object.assign(new Error('供应商不可用'), {status: 502, code: 'provider-unavailable'});
  }});
  const failed = createMaterialCenterController({client: recorder.client});
  await failed.refresh();
  await flush();
  assert.equal(failed.getState().status, 'error');
  assert.equal(failed.getState().failure?.code, 'provider-unavailable');
  assert.equal(recorder.listCalls().length, 1, 'a failure is reported once; a retry is the person\'s button');
  failed.destroy();
});

test('use/download is the one costed action: one handler call per click, nothing else, and it says what it costs', async () => {
  const {client, calls} = recordingClient();
  const used:string[] = [];
  const controller = createMaterialCenterController({client, onUse: card => { used.push(card.videoId); }});
  await controller.refresh();
  const before = calls.length;
  await controller.use('a');
  assert.deepEqual(used, ['a'], 'exactly one call for one click');
  assert.equal(controller.getState().useNotice, USE_NOTICE);
  assert.match(controller.getState().useNotice ?? '', /真实下载一次到本地/);
  assert.equal(calls.length, before, 'the client is not asked for a file: there is no route for one');
  await controller.use('b');
  assert.deepEqual(used, ['a', 'b']);
  controller.destroy();
});

test('a second click while the first is unanswered does nothing', async () => {
  let release:() => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const used:string[] = [];
  const controller = createMaterialCenterController({
    client: recordingClient().client,
    onUse: async card => { used.push(card.videoId); await gate; },
  });
  await controller.refresh();
  const first = controller.use('a');
  await controller.use('a');
  assert.deepEqual(used, ['a'], 'the pending action swallows the second click');
  assert.equal(controller.getState().usePending, 'a');
  release();
  await first;
  assert.equal(controller.getState().usePending, null);
  controller.destroy();
});

test('without a use handler the button says so and still requests nothing', async () => {
  const {client, calls} = recordingClient();
  const controller = createMaterialCenterController({client});
  await controller.refresh();
  const before = calls.length;
  await controller.use('a');
  assert.equal(controller.getState().useNotice, USE_UNAVAILABLE_NOTICE);
  assert.equal(calls.length, before);
  controller.destroy();
});

test('selection is the page\'s own: "select this page" takes exactly what is shown', async () => {
  const {client} = recordingClient();
  const controller = createMaterialCenterController({client});
  await controller.refresh();
  controller.setFilters({oneLevelId: 11});
  await flush();
  assert.deepEqual(controller.getState().cards.map(card => card.videoId), [], 'a page-local filter can empty the view without a request');
  controller.clearFilters();
  await flush();
  controller.selectOnPage();
  assert.deepEqual(controller.getState().selected, ['a', 'b']);
  controller.toggleSelect('a');
  assert.deepEqual(controller.getState().selected, ['b']);
  controller.clearSelection();
  assert.deepEqual(controller.getState().selected, []);
  controller.destroy();
});

test('only a server parameter costs a request; sorting and the other page-local filters do not', async () => {
  const {client, listCalls} = recordingClient();
  const controller = createMaterialCenterController({client});
  await controller.refresh();
  assert.equal(listCalls().length, 1);

  controller.setFilters({sort: 'downloads', createdFrom: '2026-01-01', hideUnauthorized: true});
  await flush();
  assert.equal(listCalls().length, 1, 'sorting and a date window narrow the page in hand');

  controller.setFilters({search: '口播'});
  await flush();
  assert.equal(listCalls().length, 2, 'the search text is a supplier parameter, so it is one request');
  assert.equal(listCalls()[1].query.name, '口播');
  assert.equal(listCalls()[1].query.pageNo, 1, 'a new server filter starts from the first page');
  controller.destroy();
});

test('a page is requested with the contract\'s own keys and nothing else', async () => {
  const {client, listCalls} = recordingClient();
  const controller = createMaterialCenterController({client, pageSize: 20});
  await controller.refresh();
  controller.setFilters({author: {accountKey: 'ak_other'}, videoType: 2});
  await flush();
  const query = listCalls()[1].query;
  assert.deepEqual(Object.keys(query).sort(), ['pageNo', 'pageSize', 'scope', 'videoType']);
  assert.equal(query.scope, 'account:ak_other');
  assert.equal(query.videoType, 2);
  assert.equal(query.pageSize, 20);
  controller.destroy();
});

test('flipping a page is the person\'s action and asks for that page only', async () => {
  const {client, listCalls} = recordingClient();
  const controller = createMaterialCenterController({client, pageSize: 2});
  await controller.refresh();
  controller.setPage(2);
  await flush();
  assert.equal(listCalls().length, 2);
  assert.equal(listCalls()[1].query.pageNo, 2);
  assert.equal(controller.getState().pageNo, 2);
  assert.equal(client.routes.includes('/list'), true);
  controller.destroy();
});

test('a refusal keeps its status and code even when only one of them arrived', async () => {
  const zh = copyFor('zh-CN');
  const clientOf = (error: unknown): MaterialsClient => ({
    routes: ['/list', '/facets', '/labels'],
    async list() { throw error; },
    async facets() { throw error; },
    async labels() { throw error; },
  });

  /* The shape the client really sends. */
  const both = createMaterialCenterController({client: clientOf(Object.assign(new Error('越权请求'), {status: 403, code: 'authorization-denied'}))});
  await both.refresh();
  assert.deepEqual({status: both.getState().failure?.status, code: both.getState().failure?.code}, {status: 403, code: 'authorization-denied'});
  assert.equal(both.getState().status, 'unauthorized');
  assert.equal(failureCopy(zh, both.getState().failure), zh.unauthorized);
  both.destroy();

  /* A hop that kept only the code: it must not be replaced by `internal-error`, and it names its own status. */
  const codeOnly = createMaterialCenterController({client: clientOf(Object.assign(new Error('越权请求'), {code: 'authorization-denied'}))});
  await codeOnly.refresh();
  assert.equal(codeOnly.getState().failure?.code, 'authorization-denied', 'the real code is never dropped');
  assert.equal(codeOnly.getState().failure?.status, 403, 'a known refusal code names the status it means');
  assert.equal(codeOnly.getState().status, 'unauthorized');
  assert.equal(failureCopy(zh, codeOnly.getState().failure), zh.unauthorized);
  codeOnly.destroy();

  /* A hop that kept only the status: a 403 with an unreadable body is still "no permission". */
  const statusOnly = createMaterialCenterController({client: clientOf(Object.assign(new Error('refused'), {status: 403}))});
  await statusOnly.refresh();
  assert.equal(statusOnly.getState().failure?.status, 403);
  assert.equal(statusOnly.getState().status, 'unauthorized');
  assert.equal(failureCopy(zh, statusOnly.getState().failure), zh.unauthorized);
  statusOnly.destroy();

  /* And a body-carried code is read too (an ApiError keeps it in `body`). */
  const bodyCode = createMaterialCenterController({client: clientOf(Object.assign(new Error('越权请求'), {body: {code: 'authorization-denied'}}))});
  await bodyCode.refresh();
  assert.equal(bodyCode.getState().failure?.code, 'authorization-denied');
  assert.equal(bodyCode.getState().status, 'unauthorized');
  bodyCode.destroy();
});
test('the retry button really reads again, and presses while one is out do not stack', async () => {
  let listReads = 0;
  const client: MaterialsClient = {
    routes: ['/list', '/facets', '/labels'],
    async list() { listReads += 1; if (listReads === 1) throw Object.assign(new Error('open Studio from the address'), {status: 401}); return page(); },
    async facets() { return facets; },
    async labels() { return labels; },
  };
  const controller = createMaterialCenterController({client});
  await controller.refresh();
  assert.equal(listReads, 1);
  assert.equal(controller.getState().failure?.status, 401, 'the first read failed');

  await controller.retry();
  assert.equal(listReads, 2, 'a press sends a new list read on its own');
  await controller.retry();
  assert.equal(listReads, 3, 'two presses, two reads — the button is not a no-op');

  const first = controller.retry();
  const second = controller.retry();
  await Promise.all([first, second]);
  assert.equal(listReads, 4, 'a press while one is still out is ignored');
  controller.destroy();
});

test('a retry re-reads the facets too when the facets were what failed', async () => {
  let facetsReads = 0;
  const client: MaterialsClient = {
    routes: ['/list', '/facets', '/labels'],
    async list() { return page(); },
    async facets() { facetsReads += 1; if (facetsReads === 1) throw Object.assign(new Error('no facets'), {status: 501}); return facets; },
    async labels() { return labels; },
  };
  const controller = createMaterialCenterController({client});
  await controller.loadFacets();
  assert.equal(controller.getState().facetsFailure?.status, 501);
  await controller.retry();
  assert.equal(facetsReads, 2, 'the thing that failed is read again');
  assert.equal(controller.getState().facetsFailure, null);
  controller.destroy();
});