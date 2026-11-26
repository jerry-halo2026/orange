// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

﻿/**
 * A 403 is about the identity, not the moment: the video is remembered as not-downloadable for the session, its button
 * is dead, and no later click spends another request on the same answer. Anything else (network, timeout, 5xx) stays
 * retryable.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createDeniedDownloads, deniedDownloads} from './material-center/denied.ts';
import {createMaterialUse, useFailureKind} from './material-center/use-material.ts';
import {createMaterialCenterController} from './material-center/controller.ts';
import type {MaterialCard} from './material-center/model.ts';
import type {MaterialsClient} from './material-center/client.ts';

const card = (videoId: string): MaterialCard => ({
  videoId, videoType: 1, title: '素材 ' + videoId, coverUrl: null, createdAtMs: null,
  durationMs: null, sizeBytes: null, labels: [], authorKey: null, state: null, collectCount: null,
  downloadCount: null, publishedMs: null,
} as unknown as MaterialCard);

const response = (status: number, body: unknown) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});

test('the set is per session: one entry per video, versioned for a rerender', () => {
  const denied = createDeniedDownloads();
  let ticks = 0;
  const stop = denied.subscribe(() => { ticks += 1; });
  assert.equal(denied.has('a'), false);
  denied.add('a');
  denied.add('a');
  assert.equal(denied.has('a'), true);
  assert.equal(ticks, 1, 'one change, one rerender');
  assert.equal(denied.version, 1);
  denied.clear();
  assert.equal(denied.has('a'), false);
  assert.deepEqual(denied.ids(), []);
  stop();
});

test('a 403 marks the video and a second attempt sends nothing; other videos and network errors are unaffected', async () => {
  deniedDownloads.clear();
  const calls: string[] = [];
  const fetcher = async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {videoId?: string};
    calls.push(String(body.videoId));
    if (body.videoId === 'denied') return response(403, {code: 'authorization-denied'});
    if (body.videoId === 'down') throw new TypeError('network down');
    return response(200, {landed: 'saved/素材/x.mp4', reused: false, sha256: 'ab', bytes: 1});
  };
  const use = createMaterialUse({fetch: fetcher});

  await assert.rejects(() => use(card('denied')), (error: {kind?: string}) => error.kind === 'forbidden');
  assert.equal(deniedDownloads.has('denied'), true, 'the refusal is remembered');
  await assert.rejects(() => use(card('denied')), (error: {kind?: string; status?: number}) => error.kind === 'forbidden' && error.status === 403);
  assert.deepEqual(calls, ['denied'], 'the second attempt sent no request at all');

  await assert.rejects(() => use(card('down')), (error: {kind?: string}) => error.kind === 'unavailable');
  assert.equal(deniedDownloads.has('down'), false, 'a network error says nothing about permission');
  assert.deepEqual(calls, ['denied', 'down']);

  const ok = await use(card('fine'));
  assert.equal(ok.landed, 'saved/素材/x.mp4');
  assert.deepEqual(calls, ['denied', 'down', 'fine']);
  deniedDownloads.clear();
});

test('both refusal codes mark the video', async () => {
  deniedDownloads.clear();
  for (const code of ['raw-host-not-allowed', 'authorization-denied'] as const) {
    const id = 'refused-' + code;
    const use = createMaterialUse({fetch: async () => response(403, {code})});
    await assert.rejects(() => use(card(id)));
    assert.equal(deniedDownloads.has(id), true, code);
    assert.equal(deniedDownloads.codeOf(id), code, 'the sentence can still name the right issue');
  }
  deniedDownloads.clear();
});

test('the controller refuses a denied video before any handler runs', async () => {
  deniedDownloads.clear();
  deniedDownloads.add('blocked');
  let handled = 0;
  const client: MaterialsClient = {
    routes: ['/list', '/facets', '/labels'],
    async list() { return {authorization: {layer: 'self', reason: 's'}, providerScope: 's', pageNo: 1, pageSize: 20, items: [], total: null, providerTotal: null, totalIsProviderTotal: true, filtered: {inspected: 0, dropped: 0}, grants: false}; },
    async facets() { throw Object.assign(new Error('no'), {status: 501, code: 'material-service-unavailable'}); },
    async labels() { throw Object.assign(new Error('no'), {status: 501, code: 'material-service-unavailable'}); },
  };
  const controller = createMaterialCenterController({client, onUse: async () => { handled += 1; return {landed: 'saved/x'}; }});
  await controller.refresh();
  await controller.use('blocked');
  assert.equal(handled, 0, 'no download attempted');
  assert.equal(controller.getState().useError?.kind, 'forbidden');
  controller.destroy();
  deniedDownloads.clear();
});

test('a forbidden failure is classified as such, so the page can grey the card', () => {
  assert.equal(useFailureKind({status: 403, code: 'authorization-denied'}), 'forbidden');
  assert.equal(useFailureKind({status: 403, code: 'raw-host-not-allowed'}), 'forbidden');
  assert.equal(useFailureKind({status: 504}), 'timeout', 'a timeout stays retryable');
});

test('the card is disabled and the retry button is not offered for a refusal', () => {
  const page = readFileSync(new URL('../components/material-center/MaterialCenterPage.tsx', import.meta.url), 'utf8');
  assert.match(page, /canUse: entry\.source === 'cloud' \? .*!deniedNow\.has\(entry\.card\.videoId\)/, 'the cloud button is dead once refused');
  assert.match(page, /deniedNow\.has\(entry\.card\.videoId\) \? useFailureCopy\(copy, 'forbidden', deniedDownloads\.codeOf\(entry\.card\.videoId\) \?\? undefined\) : copy\.download/, 'and says why, with the code it was refused by');
  assert.match(page, /state\.useError\.kind !== 'unsupported' && state\.useError\.kind !== 'forbidden' && state\.lastUse/, 'no retry for a refusal');
  assert.match(page, /React\.useSyncExternalStore\(deniedDownloads\.subscribe, \(\) => deniedDownloads\.version\)/, 'the page follows the session set');
});
