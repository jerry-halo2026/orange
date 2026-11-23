// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

﻿import {test} from 'node:test';
import assert from 'node:assert/strict';
import {copyFor, failureCopy} from './material-center/copy.ts';

const zh = copyFor('zh-CN');
const en = copyFor('en');

test('a read with no service behind it says the service is not connected', () => {
    const sentence = failureCopy(zh, {status: 501, code: 'material-service-unavailable'});
    assert.equal(sentence, zh.unavailable);
    assert.match(sentence, /未接通/);
    // 与“读到了但不可用”必须能区分开
    assert.notEqual(sentence, zh.error);
    assert.notEqual(sentence, zh.providerFault);
});

test('the status alone is enough when a code is missing', () => {
    assert.equal(failureCopy(en, {status: 501}), en.unavailable);
    assert.equal(failureCopy(en, {status: 403}), en.unauthorized);
    assert.equal(failureCopy(en, {status: 401}), en.authRequired);
});

test('a 401 is "sign in", whatever the body says — never the server\'s internal-error shown as a failure', () => {
    for (const failure of [{status: 401}, {status: 401, code: 'internal-error'}, {status: 401, code: 'authentication-required'}]) {
        const sentence = failureCopy(zh, failure);
        assert.equal(sentence, zh.authRequired);
        assert.match(sentence, /登录/);
        assert.notEqual(sentence, zh.error, 'a session that ran out is not an unexplained failure');
        assert.notEqual(sentence, zh.unauthorized, 'sign-in and "not allowed" are different things to do');
        assert.notEqual(sentence, zh.unavailable);
        assert.equal(sentence.includes('internal-error'), false);
    }
    assert.equal(failureCopy(en, {status: 401}), en.authRequired);
});

test('authentication-required wins over a plain 403: the person can sign in and fix it', () => {
    /* The chosen tier: `authentication-required` (on a 403 or with no status) reads as "sign in"; the other 403s stay
       "this identity may not", because signing in again would not help there. */
    assert.equal(failureCopy(zh, {status: 403, code: 'authentication-required'}), zh.authRequired);
    assert.equal(failureCopy(zh, {code: 'authentication-required'}), zh.authRequired);
    assert.equal(failureCopy(zh, {status: 403, code: 'authorization-denied'}), zh.unauthorized);
    assert.equal(failureCopy(zh, {status: 403, code: 'origin-rejected'}), zh.unauthorized);
    assert.notEqual(zh.authRequired, zh.unauthorized);
});

test('a provider answer that cannot be used is not the same as an outage', () => {
    assert.equal(failureCopy(zh, {status: 502, code: 'provider-response-unconfirmed'}), zh.providerFault);
    assert.equal(failureCopy(zh, {status: 429, code: 'provider-rate-limited'}), zh.providerFault);
});

test('a permission refusal is "no permission" whether its status or its code survived the hop', () => {
    /* The real thing: the four read routes answer 403 authorization-denied, and the sentence must be 「当前身份没有查看权限」.
       The three shapes below are the ones a lost field can leave behind — none may become 「读取失败」. */
    for (const failure of [
        {status: 403, code: 'authorization-denied'},
        {code: 'authorization-denied'},
        {status: 403},
    ]) {
        const sentence = failureCopy(zh, failure);
        assert.equal(sentence, zh.unauthorized, JSON.stringify(failure));
        assert.notEqual(sentence, zh.error);
        assert.equal(sentence.includes('internal-error'), false);
        assert.match(sentence, /没有查看/);
    }
    assert.notEqual(zh.unauthorized, zh.authRequired, 'no permission is not the same as signing in again');
});

test('a server that refuses the session is not the same as a service that is not mounted', () => {
    assert.equal(failureCopy(zh, {status: 500, code: 'material-service-unavailable'}), zh.unavailable, 'the code decides when it is there');
    assert.notEqual(zh.unavailable, zh.authRequired);
    assert.notEqual(zh.unavailable, zh.error);
});

test('anything unrecognised falls back to the plain failure sentence', () => {
    assert.equal(failureCopy(zh, {status: 500, code: 'internal-error'}), zh.error);
    assert.equal(failureCopy(zh, null), zh.error);
});
