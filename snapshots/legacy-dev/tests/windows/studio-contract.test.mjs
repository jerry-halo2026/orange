import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isStudioInvocationArgs,
  isStudioState,
  studioChannels,
  studioShellInset,
} from '../../apps/desktop/studio-contract.ts';

test('publishes the three exact private IPC channels and trusted 128 DIP inset', () => {
  assert.deepEqual(studioChannels, {
    state: 'orange:studio:state',
    open: 'orange:studio:open',
    close: 'orange:studio:close',
  });
  assert.equal(studioShellInset, 128);
});

for (const state of [
  { kind: 'closed', error: null },
  { kind: 'closed', error: 'auth-required' },
  { kind: 'closed', error: 'unavailable' },
  { kind: 'closed', error: 'failed' },
  { kind: 'opening', error: null },
  { kind: 'open', error: null },
]) {
  test(`accepts valid state ${JSON.stringify(state)}`, () => {
    assert.equal(isStudioState(state), true);
    assert.equal(isStudioState(Object.freeze({ ...state })), true);
  });
}

for (const [label, value] of [
  ['missing payload', undefined],
  ['null', null],
  ['array', []],
  ['string', 'closed'],
  ['number', 128],
  ['boolean', false],
  ['function', () => {}],
  ['unknown kind', { kind: 'ready', error: null }],
  ['unknown error', { kind: 'closed', error: 'network' }],
  ['missing kind', { error: null }],
  ['missing error', { kind: 'closed' }],
  ['undefined error', { kind: 'closed', error: undefined }],
  ['object error', { kind: 'closed', error: {} }],
]) {
  test(`rejects malformed state: ${label}`, () => {
    assert.equal(isStudioState(value), false);
  });
}

for (const kind of ['opening', 'open']) {
  for (const error of ['auth-required', 'unavailable', 'failed']) {
    test(`rejects non-null error ${error} while ${kind}`, () => {
      assert.equal(isStudioState({ kind, error }), false);
    });
  }
}

test('accepts actual empty invocation arrays, including frozen arrays', () => {
  assert.equal(isStudioInvocationArgs([]), true);
  assert.equal(isStudioInvocationArgs(Object.freeze([])), true);
});

for (const [label, value] of [
  ['missing payload', undefined],
  ['null', null],
  ['array-like object', { length: 0 }],
  ['string', ''],
  ['number', 0],
  ['boolean', false],
  ['function', () => {}],
  ['one undefined argument', [undefined]],
  ['one null argument', [null]],
  ['one object argument', [{}]],
  ['several arguments', ['open', 128]],
  ['sparse argument', Array(1)],
]) {
  test(`rejects invalid invocation args: ${label}`, () => {
    assert.equal(isStudioInvocationArgs(value), false);
  });
}

// Each fixture catches acceptance of non-DTO fields/prototypes or unsafe property reads.
const validState = { kind: 'closed', error: null };
const revokedState = Proxy.revocable({ ...validState }, {});
revokedState.revoke();
const revokedArgs = Proxy.revocable([], {});
revokedArgs.revoke();

for (const [label, value] of [
  ['empty record', {}],
  ['extra string key', { ...validState, token: 'not-a-capability' }],
  ['extra symbol key', { ...validState, [Symbol('extra')]: true }],
  ['extra non-enumerable key', Object.defineProperty({ ...validState }, 'extra', { value: true })],
  ['inherited fields', Object.create(validState)],
  ['custom prototype', Object.assign(Object.create({ extra: true }), validState)],
  ['null prototype', Object.assign(Object.create(null), validState)],
  ['class instance', new (class { kind = 'closed'; error = null; })()],
  ['array with state fields', Object.assign([], validState)],
  ['kind accessor', { get kind() { return 'closed'; }, error: null }],
  ['error accessor', { kind: 'closed', get error() { return null; } }],
  ['throwing kind', { get kind() { throw new Error('kind'); }, error: null }],
  ['throwing error', { kind: 'closed', get error() { throw new Error('error'); } }],
  ['throwing prototype trap', new Proxy(validState, { getPrototypeOf() { throw new Error('prototype'); } })],
  ['throwing ownKeys trap', new Proxy(validState, { ownKeys() { throw new Error('keys'); } })],
  ['throwing descriptor trap', new Proxy(validState, { getOwnPropertyDescriptor() { throw new Error('descriptor'); } })],
  ['throwing field trap', new Proxy(validState, { get() { throw new Error('field'); } })],
  ['revoked proxy', revokedState.proxy],
  ['symbol', Symbol('state')],
  ['bigint', 0n],
  ['null kind', { kind: null, error: null }],
  ['numeric kind', { kind: 0, error: null }],
  ['object kind', { kind: {}, error: null }],
  ['numeric error', { kind: 'closed', error: 0 }],
  ['boolean error', { kind: 'closed', error: false }],
]) {
  test(`rejects non-exact or hostile state without throwing: ${label}`, () => {
    assert.equal(isStudioState(value), false);
  });
}

for (const [label, value] of [
  ['extra string key', Object.assign([], { extra: true })],
  ['extra symbol key', Object.assign([], { [Symbol('extra')]: true })],
  ['extra non-enumerable key', Object.defineProperty([], 'extra', { value: true })],
  ['null prototype', Object.setPrototypeOf([], null)],
  ['custom prototype', Object.setPrototypeOf([], Object.create(Array.prototype))],
  ['array subclass', new (class extends Array {})()],
  ['throwing length field', new Proxy([], { get() { throw new Error('length'); } })],
  ['throwing prototype trap', new Proxy([], { getPrototypeOf() { throw new Error('prototype'); } })],
  ['throwing ownKeys trap', new Proxy([], { ownKeys() { throw new Error('keys'); } })],
  ['throwing descriptor trap', new Proxy([], { getOwnPropertyDescriptor() { throw new Error('descriptor'); } })],
  ['revoked proxy', revokedArgs.proxy],
  ['symbol', Symbol('args')],
  ['bigint', 0n],
]) {
  test(`rejects non-exact or hostile invocation args without throwing: ${label}`, () => {
    assert.equal(isStudioInvocationArgs(value), false);
  });
}
