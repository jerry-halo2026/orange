// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { takeSavedWithClaim } from './saved-claim.ts';

test('a foreign Saved library is claimed only after the person confirms, then the take is retried', async () => {
  let takes = 0;
  const claimed: string[] = [];
  const taken = await takeSavedWithClaim('saved/云素材/a.mov', {
    take: async (path) => {
      takes += 1;
      if (takes === 1) throw Object.assign(new Error('other account'), { code: 'saved-access-denied' });
      return { path };
    },
    ownership: async () => ({ refs: [{ ref: 'foreign-ref', current: false }] }),
    claim: async (ref) => { claimed.push(ref); },
    confirm: () => true,
  });
  assert.deepEqual(taken, { path: 'saved/云素材/a.mov' });
  assert.deepEqual(claimed, ['foreign-ref']);
  assert.equal(takes, 2);
});

test('no claim happens when the person declines, and other failures are not retried', async () => {
  const denied = Object.assign(new Error('other account'), { code: 'saved-access-denied' });
  await assert.rejects(() => takeSavedWithClaim('saved/a.mov', {
    take: async () => { throw denied; },
    ownership: async () => ({ refs: [{ ref: 'foreign-ref', current: false }] }),
    claim: async () => { throw new Error('must not claim'); },
    confirm: () => false,
  }), denied);
  await assert.rejects(() => takeSavedWithClaim('saved/a.mov', {
    take: async () => { throw Object.assign(new Error('broken'), { code: 'other' }); },
    ownership: async () => ({ refs: [] }),
    claim: async () => {},
    confirm: () => true,
  }), /broken/);
});
