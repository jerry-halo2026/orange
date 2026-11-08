import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAutoVersions } from './auto-versions.mjs';

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/** Auto versions over fake projects: what was saved, when, of which kind. */
function setup({ on = true, idleMs = 40, maxMs = 120 } = {}) {
  const state = { on, working: new Set(), open: new Set(['/film']) };
  const saved = [];
  const auto = createAutoVersions({
    on: () => state.on,
    working: (root) => state.working.has(root),
    roots: () => [...state.open],
    save: async (root, kind) => { saved.push([root, kind]); },
    idleMs, maxMs, pollMs: 1000,
  });
  return { state, saved, auto };
}

test('off by default for the person: nothing is saved on its own while it is off', async () => {
  const { saved, auto } = setup({ on: false });
  auto.changed('/film');
  await wait(80);
  auto.poll();
  assert.deepEqual(saved, []);
  auto.stop();
});

test('on: a version once the folder rests, one for a burst of changes', async () => {
  const { saved, auto } = setup();
  auto.changed('/film');
  await wait(20);
  auto.changed('/film');
  await wait(20);
  assert.deepEqual(saved, [], 'not while it is still changing');
  await wait(50);
  assert.deepEqual(saved, [['/film', 'auto']]);
  auto.stop();
});

test('a stretch of work that never rests is saved at most MAX_MS after it began', async () => {
  const { saved, auto } = setup({ idleMs: 50, maxMs: 100 });
  for (let i = 0; i < 8; i++) { auto.changed('/film'); await wait(20); }
  assert.ok(saved.length >= 1, 'saved without a rest');
  auto.stop();
});

test('an app\'s agent: what was there before its turn, and what it did once the turn ends; its writes wait for that', async () => {
  const { state, saved, auto } = setup();
  auto.poll();
  state.working.add('/film');
  auto.poll();
  assert.deepEqual(saved, [['/film', 'agent']]);
  auto.changed('/film');
  await wait(60);
  assert.equal(saved.length, 1, 'no version mid-turn');
  state.working.delete('/film');
  auto.poll();
  assert.deepEqual(saved, [['/film', 'agent'], ['/film', 'auto']]);
  auto.stop();
});

test('a project closed with changes still awaiting a rest is saved then', async () => {
  const { state, saved, auto } = setup({ idleMs: 10_000 });
  auto.changed('/film');
  state.open.delete('/film');
  auto.poll();
  assert.deepEqual(saved, [['/film', 'auto']]);
  auto.stop();
});

// These tests drive the original producer with real callback promises, not a model of its scheduler.
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function pendingSetup(save, overrides = {}) {
  const calls = { on: 0, roots: 0, working: 0, save: [] };
  const state = { working: false, open: ['/film'] };
  const auto = createAutoVersions({
    on: () => { calls.on++; return true; },
    roots: () => { calls.roots++; return state.open; },
    working: () => { calls.working++; return state.working; },
    save: (root, kind) => { calls.save.push([root, kind]); return save(root, kind); },
    idleMs: 5, maxMs: 30, pollMs: 5,
    ...overrides,
  });
  const trigger = () => { auto.poll(); state.working = true; auto.poll(); };
  return { auto, calls, state, trigger };
}

const turn = () => new Promise((done) => setImmediate(done));

test('stop and drain wait for actual save settlement and returned cleanup, with synchronous save effects preserved', async () => {
  const io = deferred(), cleanup = deferred();
  const order = [];
  const { auto, calls, trigger } = pendingSetup(() => {
    order.push('save');
    return io.promise.then(() => { order.push('io'); return cleanup.promise; }).then(() => { order.push('cleanup'); });
  });
  trigger();
  assert.deepEqual(order, ['save'], 'save still starts synchronously in poll');
  const stopped = auto.stop();
  assert.ok(stopped instanceof Promise, 'stop exposes real completion');
  assert.strictEqual(auto.stop(), stopped, 'one stable stop promise per lifecycle');
  let stoppedDone = false, drained = false;
  stopped.then(() => { stoppedDone = true; });
  const draining = auto.drain().then(() => { drained = true; });
  await turn();
  assert.equal(stoppedDone, false);
  assert.equal(drained, false);
  io.resolve();
  await turn();
  assert.deepEqual(order, ['save', 'io']);
  assert.equal(stoppedDone, false, 'a returned cleanup chain is part of the save');
  assert.equal(drained, false);
  cleanup.resolve();
  await Promise.all([stopped, draining]);
  assert.deepEqual(order, ['save', 'io', 'cleanup']);
  assert.equal(calls.save.length, 1);
  assert.strictEqual(auto.stop(), stopped);
  await auto.drain();
});

test('closed changed and poll do not call any external callback, even when start is attempted during drain', async () => {
  const io = deferred();
  const { auto, calls, trigger } = pendingSetup(() => io.promise);
  trigger();
  auto.start();
  const stopped = auto.stop();
  const before = structuredClone(calls);
  auto.start();
  auto.changed('/other');
  auto.poll();
  await wait(25);
  assert.deepEqual(calls, before, 'closed admission includes preference and project callbacks');
  io.resolve();
  await stopped;
});

test('save reentering stop is registered before the callback and cannot start another save', async () => {
  const io = deferred();
  let stopping, auto, settled = false;
  const fixture = pendingSetup(() => {
    stopping = auto.stop();
    auto.start();
    auto.changed('/escape');
    auto.poll();
    return io.promise;
  });
  auto = fixture.auto;
  fixture.trigger();
  assert.ok(stopping instanceof Promise);
  stopping.then(() => { settled = true; });
  assert.equal(fixture.calls.save.length, 1);
  await turn();
  assert.equal(settled, false, 'the callback cannot escape the pending set through stop reentry');
  io.resolve();
  await stopping;
});

test('parallel project saves all settle before stop, including rejection and finally cleanup', async () => {
  const first = deferred(), second = deferred(), cleanup = deferred();
  const events = [];
  const { auto, calls, state } = pendingSetup((root) => root === '/one'
    ? first.promise.finally(() => { events.push('first-finally'); return cleanup.promise; })
    : second.promise);
  state.open = ['/one', '/two'];
  auto.poll(); state.working = true; auto.poll();
  assert.deepEqual(calls.save, [['/one', 'agent'], ['/two', 'agent']]);
  const stopped = auto.stop();
  let done = false;
  stopped.then(() => { done = true; });
  second.resolve(); first.reject(new Error('private save failure'));
  await turn();
  assert.deepEqual(events, ['first-finally']);
  assert.equal(done, false);
  cleanup.resolve();
  await stopped;
  assert.equal(done, true);
  await auto.drain();
});

test('sync save throw is contained and cannot strand a reentrant stop', async () => {
  let stopping, auto;
  const fixture = pendingSetup(() => { stopping = auto.stop(); throw new Error('private sync failure'); });
  auto = fixture.auto;
  assert.doesNotThrow(fixture.trigger);
  assert.ok(stopping instanceof Promise);
  await stopping;
  await auto.drain();
});

test('a rejected save is sunk without exposing its error or stranding future lifecycle saves', async () => {
  let count = 0;
  const { auto, trigger, state } = pendingSetup(() => {
    count++;
    return Promise.reject(new Error('private rejected save'));
  });
  trigger();
  assert.equal(await auto.stop(), undefined);
  await auto.drain();
  auto.start();
  state.working = false;
  auto.poll(); state.working = true; auto.poll();
  await auto.stop();
  await turn(); // Node's test runner would fail this test on an unhandled rejection.
  assert.equal(count, 2);
});

for (const callback of ['on', 'roots', 'working']) {
  test(`${callback} reentering stop/start cannot resurrect scheduling or invoke a later callback`, async () => {
    let auto, stopping, armed = true;
    const callbacks = [];
    const invoke = (name, value) => {
      callbacks.push(name);
      if (name === callback && armed) {
        armed = false;
        stopping = auto.stop();
        auto.start();
      }
      return value;
    };
    auto = createAutoVersions({
      on: () => invoke('on', true), roots: () => invoke('roots', ['/film']),
      working: () => invoke('working', false),
      save: async () => { callbacks.push('save'); }, idleMs: 5, pollMs: 5,
    });
    if (callback === 'roots') auto.poll(); else auto.changed('/film');
    assert.ok(stopping instanceof Promise);
    const before = callbacks.slice();
    auto.changed('/other'); auto.poll();
    await wait(20);
    assert.deepEqual(callbacks, before, 'no late work or closed callback invocation');
    assert.equal(callbacks.at(-1), callback, 'the current stack stops immediately after the reentrant callback');
    await stopping;
  });
}

test('poll stops traversing projects if a transition save reenters stop', async () => {
  let auto, stopping;
  const { state, calls, auto: instance } = pendingSetup(() => { stopping = auto.stop(); return Promise.resolve(); });
  auto = instance;
  state.open = ['/one', '/two'];
  auto.poll(); state.working = true; auto.poll();
  assert.deepEqual(calls.save, [['/one', 'agent']]);
  await stopping;
});

test('closing-project save reentering stop cannot reach the following on or open-project callbacks', async () => {
  let auto, stopping;
  const fixture = pendingSetup(() => { stopping = auto.stop(); return Promise.resolve(); }, { idleMs: 10_000 });
  auto = fixture.auto;
  auto.changed('/film');
  fixture.state.open = ['/other'];
  auto.poll();
  assert.deepEqual(fixture.calls.save, [['/film', 'auto']]);
  const before = structuredClone(fixture.calls);
  auto.poll();
  assert.deepEqual(fixture.calls, before);
  await stopping;
});

test('explicit start only after completed stop creates a fresh usable lifecycle', async () => {
  const { auto, calls, state } = pendingSetup(() => Promise.resolve());
  const oldStop = auto.stop();
  await oldStop;
  auto.changed('/film'); auto.poll();
  assert.deepEqual(calls, { on: 0, roots: 0, working: 0, save: [] });
  auto.start();
  auto.start();
  auto.poll(); state.working = true; auto.poll();
  assert.deepEqual(calls.save, [['/film', 'agent']]);
  const newStop = auto.stop();
  assert.notStrictEqual(newStop, oldStop);
  assert.strictEqual(auto.stop(), newStop);
  await newStop;
});

test('queued old timer callbacks cannot save after stop or interfere with a fresh generation', async (t) => {
  const timers = [], intervals = [];
  t.mock.method(globalThis, 'setTimeout', (callback) => {
    const handle = { unref() {} }; timers.push({ callback, handle }); return handle;
  });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  t.mock.method(globalThis, 'setInterval', (callback) => {
    const handle = { unref() {} }; intervals.push({ callback, handle }); return handle;
  });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const { auto, calls } = pendingSetup(() => Promise.resolve());
  auto.start(); auto.changed('/film');
  await auto.stop();
  const before = structuredClone(calls);
  timers[0].callback(); intervals[0].callback();
  assert.deepEqual(calls, before, 'already queued callbacks remain closed');
  auto.start(); auto.changed('/film');
  const fresh = structuredClone(calls);
  timers[0].callback(); intervals[0].callback();
  assert.deepEqual(calls, fresh, 'old callbacks cannot act on fresh project state');
  timers[1].callback();
  assert.deepEqual(calls.save, [['/film', 'auto']]);
  await auto.stop();
});
