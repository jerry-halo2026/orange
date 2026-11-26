// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readBrand } from './brand.mjs';
import { FLAVORS } from './flavor.mjs';

test('the packaged app, its update identity and its installer agree on one app id', () => {
  const appId = readBrand().appId;
  assert.equal(appId, 'com.orange.studio', 'the installed app and its update feed keep one stable identity');
  assert.equal(FLAVORS.release.bundleId, appId, 'the release flavour uses the packaged identity');
  const release = readFileSync(new URL('../scripts/release.mjs', import.meta.url), 'utf8');
  assert.match(release, /const APP_ID = said\(brand\.appId, 'com\.orange\.studio'\)/);
  assert.match(release, /appId: preview \? `\$\{APP_ID\}\.preview` : APP_ID/);
});
