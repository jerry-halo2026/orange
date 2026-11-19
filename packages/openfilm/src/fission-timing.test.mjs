// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

﻿import test from 'node:test';
import assert from 'node:assert/strict';
import { alignedVisualSpans } from './fission-timing.mjs';

const sources = () => [{ kind: 'video' }, { kind: 'video' }, { kind: 'sound' }, { kind: 'still' }];
const footage = () => [
  { source: 0, startSec: 0, durationSec: 2, speed: 1, hflip: false },
  { source: 1, startSec: 0, durationSec: 2, speed: 1, hflip: false },
];
const tailVisual = { source: 3, startSec: 0, durationSec: 0.1, speed: 1, hflip: false };

/** A plan shaped like the real C# edit plan once the tail is described by a still outro. */
const plan = (visuals, durationSec) => ({
  durationSec,
  alignment: { action: 'trim', inputDurationSec: durationSec, outputDurationSec: 4, tempo: 1, loops: 1 },
  visuals,
  sources: sources(),
});
/** nativeOps widens outputDurationSec to the probed duration when the container keeps a tail. */
const widened = p => ({ ...p, alignment: { ...p.alignment, outputDurationSec: p.durationSec } });

test('a still outro lets the native timeline reach the real duration', () => {
  const p = plan([...footage(), tailVisual], 4.1);
  const { target, spans } = alignedVisualSpans(widened(p));
  assert.equal(target, 4.1);
  assert.equal(spans.length, 3);
  const last = spans.at(-1);
  assert.equal(last.still, true);
  assert.equal(last.fromSec, 0, 'a still records no source start');
  assert.ok(Math.abs(last.toSec - 0.1) < 1e-9, 'the still lasts exactly the tail');
  assert.equal(last.at, 4, 'the still starts where the footage ends');
  assert.equal(Number((last.at + last.length).toFixed(6)), 4.1, 'the timeline ends exactly on durationSec');
});

test('without the still the same plan cannot reach the real duration', () => {
  const p = plan(footage(), 4.1);
  const { target, spans } = alignedVisualSpans(widened(p));
  assert.equal(target, 4.1);
  const last = spans.at(-1);
  assert.equal(last.still, false);
  assert.equal(Number((last.at + last.length).toFixed(6)), 4, 'footage alone stops a packet tail short');
  assert.ok(target - (last.at + last.length) > 1 / 30);
});

test('a fractional tail still lands exactly on the duration', () => {
  const p = plan([...footage(), { ...tailVisual, durationSec: 0.067 }], 4.067);
  const { target, spans } = alignedVisualSpans(widened(p));
  const last = spans.at(-1);
  assert.equal(target, 4.067);
  assert.ok(Math.abs(last.at + last.length - target) < 1e-9);
});

