// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * OrangeFilm is an **account**, not a service: no verbs, no models, no media proxy.
 *
 * What this file pins is the shape that keeps the account working while keeping it out of the services board:
 *   · it declares no verbs — so no verb's provider list can pick it to make anything;
 *   · it is marked to be left out of Settings → Services;
 *   · its key (`ofk_`) and its sign-in are still there, because `account.mjs` reads the key and `sign-in.mjs` runs the
 *     sign-in;
 *   · running it throws a sentence a person can act on, rather than returning an empty result.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import orangefilm from './orangefilm.mjs';

test('OrangeFilm 不再做任何媒体：verbs 为空、models 为空、出现在服务列表之外', () => {
  assert.deepEqual(orangefilm.verbs, [], '一个动词都不能有：任何动词的 provider 列表都不该选中它');
  assert.deepEqual(orangefilm.models, {});
  assert.equal(/** @type {any} */ (orangefilm).accountOnly, true);
  assert.equal(/** @type {any} */ (orangefilm).hideInServices, true);
});

test('账号那半还在：env / keysUrl / signIn / checkKey', () => {
  assert.equal(orangefilm.id, 'orangefilm');
  assert.equal(orangefilm.env, 'ORANGE_API_KEY', 'providerKey() 靠它找 ofk_ key');
  assert.match(String(orangefilm.keysUrl), /^https:\/\//);
  assert.ok(orangefilm.signIn && typeof orangefilm.signIn === 'object', '登录这条路必须留着（account.mjs 与 sign-in.mjs 都用它）');
  assert.throws(() => orangefilm.checkKey('sk-123'), /ofk_/);
  assert.doesNotThrow(() => orangefilm.checkKey('ofk_test'));
});

test('被调用就是一句能照做的话，不是空结果', async () => {
  await assert.rejects(() => orangefilm.run('tts', {}, /** @type {any} */ ({})), /does not make tts.*Settings → Services/s);
});
