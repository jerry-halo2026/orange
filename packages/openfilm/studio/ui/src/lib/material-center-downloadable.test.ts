// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeCard } from './material-center/model.ts';

const row = (observation: Record<string, unknown>) => ({
  videoId: { value: '100140553', sourceType: 'string', source: '100140553' },
  observation: { name: '油弃乌龙茶', videoUrl: 'https://cdn.example/clip.mp4', ...observation },
}) as never;

test('a transcoded, playable, non-recycled row is downloadable', () => {
  const card = decodeCard(row({ state: { sourceType: 'number', source: '2' } }));
  assert.equal(card?.downloadable, true);
});

test('a row still transcoding is not downloadable', () => {
  const card = decodeCard(row({ state: { sourceType: 'number', source: '8' } }));
  assert.equal(card?.downloadable, false);
});

test('a recycled or URL-less row is not downloadable', () => {
  assert.equal(decodeCard(row({ state: { sourceType: 'number', source: '2' }, recycleTime: '2026-01-01' }))?.downloadable, false);
  assert.equal(decodeCard(row({ state: { sourceType: 'number', source: '2' }, videoUrl: '' }))?.downloadable, false);
});
