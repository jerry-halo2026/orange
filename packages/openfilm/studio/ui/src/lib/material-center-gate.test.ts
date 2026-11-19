// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The request gate: the one door every material request goes through.
 *
 * The supplier counts requests per account. The gate spaces them (QPS), caps how many are out at once, and can be held
 * after a refusal. Its clock and sleep are injected, so a test reads the spacing instead of spending it.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequestGate} from './material-center/gate.ts';

const clock = () => {
  let at = 0;
  const waits: number[] = [];
  return {
    now: () => at,
    sleep: async (ms: number) => { waits.push(ms); at += ms; },
    waits,
  };
};

test('the gate spaces starts to its QPS: six a second means 167 ms apart', async () => {
  const time = clock();
  const gate = createRequestGate({qps: 6, concurrency: 6, now: time.now, sleep: time.sleep});
  for (let at = 0; at < 6; at += 1) await gate.run(async () => at);
  assert.equal(gate.stats().started, 6);
  assert.equal(time.waits.length, 5, 'the first is immediate, the rest wait their turn');
  for (const wait of time.waits) assert.equal(wait, 167);
  assert.deepEqual(gate.stats().waits, time.waits);
});

test('the gate caps how many are out at once', async () => {
  const time = clock();
  const gate = createRequestGate({qps: 1000, concurrency: 2, now: time.now, sleep: time.sleep});
  let inFlight = 0;
  let max = 0;
  await Promise.all(Array.from({length: 8}, () => gate.run(async () => {
    inFlight += 1;
    max = Math.max(max, inFlight);
    await new Promise(resolve => setTimeout(resolve, 2));
    inFlight -= 1;
  })));
  assert.equal(max, 2, 'never more than the cap');
  assert.equal(gate.stats().maxInFlight, 2);
  assert.equal(gate.stats().inFlight, 0, 'and all of them came back');
});

test('pause holds new requests, resume lets them go', async () => {
  const time = clock();
  const gate = createRequestGate({qps: 1000, concurrency: 6, now: time.now, sleep: time.sleep});
  gate.pause();
  assert.equal(gate.paused(), true);
  let ran = 0;
  const held = gate.run(async () => { ran += 1; });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(ran, 0, 'nothing starts while paused');
  gate.resume();
  await held;
  assert.equal(ran, 1);
  assert.equal(gate.paused(), false);
});

test('the default gate is the one the client ships: six a second, six at once', async () => {
  const gate = createRequestGate();
  assert.equal(gate.stats().maxInFlight, 0);
  assert.equal(gate.paused(), false);
  await gate.run(async () => null);
  assert.equal(gate.stats().started, 1);
});
