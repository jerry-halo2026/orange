// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The material reads and the Studio guard: the session travels with every request, and the guard's own 401 (a page
 * opened without the key/cookie, typically after a port or host change) is retried before anyone is told to sign in.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMaterialsClient} from './material-center/client.ts';
import {createRequestGate} from './material-center/gate.ts';
import {copyFor, failureCopy} from './material-center/copy.ts';

const zh = copyFor('zh-CN');

const pageBody = {
  authorization: {layer: 'self', reason: 'own-account-key'}, providerScope: 's', pageNo: 1, pageSize: 20,
  items: [], total: null, providerTotal: null, totalIsProviderTotal: true, filtered: {inspected: 0, dropped: 0}, grants: false,
};

type Step = {status?: number; body?: unknown; reject?: Error};

function recordingFetch(steps: Step[] = [{}]) {
  const calls: {url: string; init: RequestInit | undefined}[] = [];
  let index = 0;
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push({url, init});
    const step = steps[Math.min(index, steps.length - 1)] ?? {};
    index += 1;
    if (step.reject) throw step.reject;
    return new Response(JSON.stringify(step.body ?? pageBody), {status: step.status ?? 200, headers: {'content-type': 'application/json'}});
  };
  return {fetcher, calls};
}

const query = {pageNo: 1, pageSize: 20, videoType: 1, scope: 'company'};
const guard401 = {status: 401, body: {error: 'open Studio from the address it printed'}};

test('every material read carries the Studio session: credentials same-origin, never omit', async () => {
  const facetsBody = {authorization: {layer: 'self', reason: 's'}, providerScope: 's', videoType: 1, oneLevel: [], twoLevel: [], states: [], publicLabels: [], labelTotal: null};
  const labelsBody = {authorization: {layer: 'self', reason: 's'}, providerScope: 's', pageNo: 1, pageSize: 20, labels: [], total: null};
  const recorder = recordingFetch([{body: pageBody}, {body: facetsBody}, {body: labelsBody}]);
  const client = createMaterialsClient({fetch: recorder.fetcher});
  await client.list(query);
  await client.facets({videoType: 1, scope: 'company'});
  await client.labels(query);
  assert.equal(recorder.calls.length, 3);
  for (const call of recorder.calls) {
    assert.equal(call.init?.credentials, 'same-origin', 'the guard reads the session cookie (or the launch key)');
    assert.notEqual(call.init?.credentials, 'omit', 'omit made every cloud read 401 "open Studio from the address"');
    assert.notEqual(call.init?.credentials, 'include', 'same-origin is enough: the cookie does not travel to other hosts');
  }
});

test('the guard\'s own 401 is retried twice, with no failure sentence while it is being retried', async () => {
  const recorder = recordingFetch([guard401, guard401, guard401]);
  const retries: {retrying: boolean; callsSoFar: number}[] = [];
  const client = createMaterialsClient({
    fetch: recorder.fetcher,
    guardRetryDelayMs: 0,
    onSessionRetry: retrying => retries.push({retrying, callsSoFar: recorder.calls.length}),
  });
  await assert.rejects(() => client.list(query), (error: {status?: number}) => error.status === 401);
  assert.equal(recorder.calls.length, 3, 'one attempt and two retries');
  assert.deepEqual(retries.map(entry => entry.retrying), [true, false]);
  assert.equal(retries[0]!.callsSoFar, 1, 'the warming notice starts before the second attempt is sent');
  /* Only after the retries does it become a sentence: a 401 is "sign in", never a mid-retry failure. */
  assert.equal(failureCopy(zh, {status: 401}), zh.authRequired);
  assert.notEqual(zh.studioSessionWarming, zh.error);
});

test('a guard 401 that clears on a retry is a success, not a failure', async () => {
  const recorder = recordingFetch([guard401, {body: pageBody}]);
  const retries: boolean[] = [];
  const client = createMaterialsClient({fetch: recorder.fetcher, guardRetryDelayMs: 0, onSessionRetry: retrying => retries.push(retrying)});
  const page = await client.list(query);
  assert.equal(recorder.calls.length, 2);
  assert.equal(page.items.length, 0);
  assert.deepEqual(retries, [true, false]);
});

test('a real 401 with a code, and a 403, are not guard warm-ups and are not retried', async () => {
  const coded = recordingFetch([{status: 401, body: {code: 'authentication-required'}}]);
  await assert.rejects(() => createMaterialsClient({fetch: coded.fetcher, guardRetryDelayMs: 0}).list(query), (error: {code?: string}) => error.code === 'authentication-required');
  assert.equal(coded.calls.length, 1);

  const denied = recordingFetch([{status: 403, body: {code: 'authorization-denied'}}]);
  await assert.rejects(() => createMaterialsClient({fetch: denied.fetcher, guardRetryDelayMs: 0}).list(query), (error: {code?: string; status?: number}) => error.status === 403 && error.code === 'authorization-denied');
  assert.equal(denied.calls.length, 1, 'a permission refusal is about the person, not about a warming session');
});

test('only the guard\'s JSON shape is retried: a 401 without its {error} body is not guessed at', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return new Response('open Studio from the address it printed', {status: 401, headers: {'content-type': 'text/plain'}});
  };
  await assert.rejects(() => createMaterialsClient({fetch: fetcher, guardRetryDelayMs: 0}).list(query), (error: {status?: number}) => error.status === 401);
  assert.equal(calls, 1, 'no JSON body, no code: not the shape the guard is known to send');
});
test('every request goes through the gate: the client spends its QPS, not the page', async () => {
  const recorder = recordingFetch([{body: pageBody}, {body: pageBody}]);
  let slept = 0;
  const gate = createRequestGate({qps: 2, concurrency: 6, now: () => slept, sleep: async (ms: number) => { slept += ms; }});
  const client = createMaterialsClient({fetch: recorder.fetcher, gate});
  await client.list(query);
  await client.list(query);
  assert.equal(recorder.calls.length, 2);
  assert.equal(gate.stats().started, 2, 'the gate saw both');
  assert.deepEqual(gate.stats().waits, [500], 'and spaced them at the gate\'s QPS (2 a second)');
});

test('a 429 gets exactly one backed-off retry, then the failure is the person\'s to retry', async () => {
  const throttled = {status: 429, body: {code: 'provider-rate-limited'}};
  const succeeds = recordingFetch([throttled, {body: pageBody}]);
  const client = createMaterialsClient({fetch: succeeds.fetcher, backoffMs: 0});
  const page = await client.list(query);
  assert.equal(page.items.length, 0, 'the retry landed');
  assert.equal(succeeds.calls.length, 2, 'one pause, one retry');

  const impossible = recordingFetch([throttled, throttled, throttled]);
  const failing = createMaterialsClient({fetch: impossible.fetcher, backoffMs: 0});
  await assert.rejects(() => failing.list(query), (error: {status?: number; code?: string}) => error.status === 429 && error.code === 'provider-rate-limited');
  assert.equal(impossible.calls.length, 2, 'one retry, never a loop');
});