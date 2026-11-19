// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

﻿/**
 * Claiming the one cloud-steward account "my materials" is scoped to, held without a DOM or a network.
 *
 * The counter-proofs are the point: nothing is asked until the person presses the claim button; an empty form is said
 * before any socket; and an unbound page starts on the company view, so it never queries `scope=own` for a claim that
 * does not exist.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  BINDING_ROUTE, bindingFailureCopy, bindingRefreshPlan, createMaterialBinding, normalizeBindingAccount,
  bindingReadCopy, ownScopeAvailable, type MaterialBinding,
} from './material-center/binding.ts';
import {copyFor} from './material-center/copy.ts';
import {DEFAULT_FILTERS} from './material-center/filters.ts';
import {createMaterialCenterController} from './material-center/controller.ts';
import type {MaterialsClient} from './material-center/client.ts';
import type {MaterialPage} from './material-center/contract.ts';

const zh = copyFor('zh-CN');
const CLAIMED: MaterialBinding = {account: 'zhangqinyuan', accountKey: 'ak_claimed', status: 'claimed'};

type Step = {status?: number; body?: unknown; reject?: Error};

function recordingFetch(steps: Step[] = [{}]) {
  const calls: {url: string; init: RequestInit | undefined}[] = [];
  let index = 0;
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push({url, init});
    const step = steps[Math.min(index, steps.length - 1)] ?? {};
    index += 1;
    if (step.reject) throw step.reject;
    return new Response(JSON.stringify(step.body ?? {binding: CLAIMED}), {status: step.status ?? 200, headers: {'content-type': 'application/json'}});
  };
  return {fetcher, calls, bodyOf: (at = 0) => JSON.parse(String(calls[at]?.init?.body ?? '{}'))};
}

test('the claim is read from one route, and an empty answer means nobody claimed one', async () => {
  const empty = recordingFetch([{body: {binding: null}}]);
  const client = createMaterialBinding({fetch: empty.fetcher});
  assert.equal(await client.read(), null);
  assert.equal(empty.calls.length, 1);
  assert.equal(empty.calls[0]!.url, BINDING_ROUTE);
  assert.equal(empty.calls[0]!.init?.method, 'GET');
  assert.equal(empty.calls[0]!.init?.credentials, 'same-origin', 'the Studio session is the authorization');

  const one = recordingFetch([{body: {binding: CLAIMED}}]);
  assert.deepEqual(await createMaterialBinding({fetch: one.fetcher}).read(), CLAIMED);

  const broken = recordingFetch([{body: {binding: {account: 'a'}}}]);
  await assert.rejects(() => createMaterialBinding({fetch: broken.fetcher}).read(), (error: {status?: number; code?: string}) => error.status === 502);
});

test('claiming is one POST with the trimmed account; nothing typed is not a request at all', async () => {
  const recorder = recordingFetch();
  const client = createMaterialBinding({fetch: recorder.fetcher});
  assert.deepEqual(await client.claim('  zhangqinyuan  '), CLAIMED);
  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0]!.init?.method, 'POST');
  assert.deepEqual(recorder.bodyOf(), {account: 'zhangqinyuan'}, 'trimmed, and only what the route takes');

  for (const bad of ['', '   ', 'x'.repeat(201), 'a\u0000b', null, 3]) {
    await assert.rejects(() => client.claim(bad as never), (error: {status?: number; code?: string}) => error.status === 400 && error.code === 'invalid-query');
  }
  assert.equal(recorder.calls.length, 1, 'a form that says nothing sends nothing');
  assert.equal(normalizeBindingAccount('  a  '), 'a');
});

test('the route\'s refusal keeps its status and code, and each tier gets its own sentence', async () => {
  for (const [status, code] of [[400, 'invalid-query'], [401, 'authentication-required'], [501, 'material-service-unavailable'], [500, 'internal-error']] as const) {
    const recorder = recordingFetch([{status, body: {code}}]);
    await assert.rejects(() => createMaterialBinding({fetch: recorder.fetcher}).claim('a'), (error: {status?: number; code?: string}) => {
      assert.equal(error.status, status);
      assert.equal(error.code, code);
      return true;
    });
  }
  assert.equal(bindingFailureCopy(zh, {status: 400, code: 'invalid-query'}), zh.bindingAccountNotFound);
  assert.match(zh.bindingAccountNotFound, /账号不存在/);
  assert.equal(bindingFailureCopy(zh, {status: 401}), zh.authRequired);
  assert.equal(bindingFailureCopy(zh, {status: 401, code: 'authentication-required'}), zh.authRequired);
  assert.equal(bindingFailureCopy(zh, {status: 501}), zh.unavailable);
  assert.equal(bindingFailureCopy(zh, {status: 404}), zh.unavailable, 'a route this Studio did not mount yet is "not connected", not the person\'s fault');
  assert.equal(bindingFailureCopy(zh, {status: 500, code: 'internal-error'}), zh.error);
  assert.equal(bindingFailureCopy(zh, null), zh.error);
  /* The tiers must not collapse into one another: a wrong name is not an outage, and neither is a lost session. */
  assert.notEqual(zh.bindingAccountNotFound, zh.error);
  assert.notEqual(zh.bindingAccountNotFound, zh.unavailable);
  assert.notEqual(zh.authRequired, zh.error);
});

test('releasing is one DELETE, and `null` is the unbound state again', async () => {
  const recorder = recordingFetch([{body: {binding: null}}]);
  assert.equal(await createMaterialBinding({fetch: recorder.fetcher}).release(), null);
  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0]!.init?.method, 'DELETE');
  assert.equal(recorder.calls[0]!.init?.body, undefined);
});

test('"my materials" is offered only for a claimed account, and it is never the default scope', () => {
  assert.equal(ownScopeAvailable(null), false);
  assert.equal(ownScopeAvailable(CLAIMED), true);
  assert.equal(ownScopeAvailable({...CLAIMED, status: 'claimed' as const, accountKey: ''}), false, 'a claim with no key cannot scope anything');
  /* The product says material is company-wide: the first visit asks the company view, claimed or not. */
  assert.equal(DEFAULT_FILTERS.author, 'company');
});

test('a claim or release refreshes once, and a claim never moves the page to "mine"', () => {
  assert.equal(bindingRefreshPlan(null, CLAIMED, 'company'), 'refresh', 'claiming: one refresh, in the scope the person is looking at');
  assert.equal(bindingRefreshPlan(CLAIMED, null, 'own'), 'force-company', 'releasing while on "mine": the company view (one request, not two)');
  assert.equal(bindingRefreshPlan(CLAIMED, null, 'company'), 'refresh');
  assert.equal(bindingRefreshPlan(CLAIMED, CLAIMED, 'own'), 'none');
  assert.equal(bindingRefreshPlan(null, null, 'company'), 'none');
});

test('the default read is scope=company; a claim keeps it, and only an explicit pick asks for own', async () => {
  const listCalls: string[] = [];
  const client: MaterialsClient = {
    routes: ['/list', '/facets', '/labels'],
    async list(query) {
      listCalls.push(String(query.scope));
      return {
        authorization: {layer: 'self', reason: 'own'}, providerScope: 's', pageNo: 1, pageSize: 20, items: [],
        total: null, providerTotal: null, totalIsProviderTotal: true, filtered: {inspected: 0, dropped: 0}, grants: false,
      } as MaterialPage;
    },
    async facets() { throw Object.assign(new Error('no facets'), {status: 501, code: 'material-service-unavailable'}); },
    async labels() { throw Object.assign(new Error('no labels'), {status: 501, code: 'material-service-unavailable'}); },
  };
  /* ③ the default query: company, with or without a claim. */
  const fresh = createMaterialCenterController({client});
  await fresh.refresh();
  assert.deepEqual(listCalls, ['company'], 'the first read asks the company view (not own)');
  fresh.destroy();

  /* ④ a claim refreshes without switching the scope. */
  const claimed = createMaterialCenterController({client});
  await claimed.refresh();
  await claimed.refresh();
  assert.deepEqual(listCalls, ['company', 'company', 'company'], 'a claim (one refresh) keeps the company view');
  claimed.destroy();

  /* ⑤ "mine" is asked for only when the person picks it. */
  const picked = createMaterialCenterController({client});
  await picked.refresh();
  picked.setFilters({author: 'own'});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(listCalls[listCalls.length - 1], 'own', 'the person asked for "mine": that is the one own read');
  picked.destroy();
});

test('looking at the library is still free: no binding request comes from a render or a hover', async () => {
  const recorder = recordingFetch([{body: {binding: CLAIMED}}]);
  const controller = createMaterialCenterController({
    client: {
      routes: ['/list', '/facets', '/labels'],
      async list() { throw Object.assign(new Error('no list'), {status: 501, code: 'material-service-unavailable'}); },
      async facets() { throw Object.assign(new Error('no facets'), {status: 501, code: 'material-service-unavailable'}); },
      async labels() { throw Object.assign(new Error('no labels'), {status: 501, code: 'material-service-unavailable'}); },
    },
  });
  controller.hover('v1');
  controller.hover(null);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(recorder.calls.length, 0, 'the binding route is reached only by the claim/release buttons');
  controller.destroy();
});
test('a claim that cannot be read is about the binding, never "sign in to read cloud materials"', () => {
  const auth = bindingReadCopy(zh, {status: 401});
  assert.equal(auth, zh.bindingReadAuth);
  assert.notEqual(auth, zh.authRequired, 'the library may have answered 200: this sentence is about the claim');
  assert.notEqual(auth, zh.error);
  assert.match(auth, /我的素材/);
  assert.equal(bindingReadCopy(zh, {status: 501}), zh.bindingReadOffline);
  assert.equal(bindingReadCopy(zh, {status: 404}), zh.bindingReadOffline);
  assert.equal(bindingReadCopy(zh, {status: 500}), zh.bindingReadUnknown);
  assert.equal(bindingReadCopy(zh, null), zh.bindingReadUnknown);
  for (const sentence of [zh.bindingReadAuth, zh.bindingReadOffline, zh.bindingReadUnknown]) {
    assert.notEqual(sentence, zh.authRequired);
    assert.notEqual(sentence, zh.unauthorized);
  }
});