// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readTimelinePrefs } from './timeline-prefs.ts';

test('the editing switches start on', () => {
  assert.deepEqual(readTimelinePrefs(), { snap: true, magnet: true, linkage: true });
});
