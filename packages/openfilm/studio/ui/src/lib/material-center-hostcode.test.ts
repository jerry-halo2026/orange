// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * Two 403s, two different people to ask.
 *
 * `authorization-denied` is about the person; `raw-host-not-allowed` is about the storage host's allow-list — a
 * configuration fix for an administrator, not a permission the person can be granted. Both stop the download, but the
 * sentence must not send anyone to the wrong desk.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {copyFor, useFailureCopy} from './material-center/copy.ts';
import {createMaterialUse, useFailureKindOf} from './material-center/use-material.ts';
import {createDeniedDownloads, deniedDownloads} from './material-center/denied.ts';
import type {MaterialCard} from './material-center/model.ts';

const zh = copyFor('zh-CN');
const en = copyFor('en');
const card = (videoId: string): MaterialCard => ({
  videoId, videoType: 1, title: '素材 ' + videoId, coverUrl: null, createdAtMs: null,
  durationMs: null, sizeBytes: null, labels: [], authorKey: null, state: null, collectCount: null,
  downloadCount: null, publishedMs: null,
} as unknown as MaterialCard);
const response = (status: number, body: unknown) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});

test('the two refusal codes keep their own sentence, in both languages', () => {
  assert.equal(useFailureCopy(zh, 'forbidden', 'authorization-denied'), zh.useForbidden);
  assert.equal(useFailureCopy(zh, 'forbidden', 'raw-host-not-allowed'), zh.useStorageBlocked);
  assert.notEqual(zh.useStorageBlocked, zh.useForbidden, 'no permission and no allow-list are not the same sentence');
  assert.match(zh.useStorageBlocked, /配置问题/);
  assert.match(zh.useStorageBlocked, /管理员/);

  assert.equal(useFailureCopy(en, 'forbidden', 'authorization-denied'), en.useForbidden);
  assert.equal(useFailureCopy(en, 'forbidden', 'raw-host-not-allowed'), en.useStorageBlocked);
  assert.notEqual(en.useStorageBlocked, en.useForbidden);
  assert.match(en.useStorageBlocked, /configuration/);
});

test('a plain forbidden code (or none) still says "no permission"', () => {
  assert.equal(useFailureCopy(zh, 'forbidden'), zh.useForbidden);
  assert.equal(useFailureCopy(zh, 'forbidden', 'origin-rejected'), zh.useForbidden);
});

test('both codes still mark the video for the session, each with its code', async () => {
  deniedDownloads.clear();
  const seen: string[] = [];
  for (const code of ['authorization-denied', 'raw-host-not-allowed'] as const) {
    const id = 'host-' + code;
    const use = createMaterialUse({fetch: async () => { seen.push(code); return response(403, {code}); }});
    await assert.rejects(() => use(card(id)), (error: {kind?: string}) => error.kind === useFailureKindOf(403, code));
    assert.equal(deniedDownloads.has(id), true, code + ' is remembered');
    assert.equal(deniedDownloads.codeOf(id), code, 'and remembered with its reason');
  }
  /* The denied set is about "do not ask again", not about the wording: both stay refused. */
  const calls: string[] = [];
  const use = createMaterialUse({fetch: async (_url: string, init?: RequestInit) => { calls.push(String(init?.body)); return response(403, {code: 'raw-host-not-allowed'}); }});
  await assert.rejects(() => use(card('host-raw-host-not-allowed')));
  assert.deepEqual(calls, [], 'no second request for either refusal');
  assert.deepEqual(seen.length, 2);
  deniedDownloads.clear();
});

test('the card label follows the remembered code, so a storage refusal never reads as "no permission"', () => {
  const denied = createDeniedDownloads();
  denied.add('a', 'authorization-denied');
  denied.add('b', 'raw-host-not-allowed');
  assert.equal(useFailureCopy(zh, 'forbidden', denied.codeOf('a') ?? undefined), zh.useForbidden);
  assert.equal(useFailureCopy(zh, 'forbidden', denied.codeOf('b') ?? undefined), zh.useStorageBlocked);
});
