// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The last hop: the material service the window runs has to reach the Studio process, or every material route
 * answers 501 `material-service-unavailable` for that Studio's whole life.
 *
 * Two things are being held here, and both are asserted as behaviour rather than as source text:
 *  - Studio's environment carries the upstream and the internal-hop secret (`materialsServiceFromEnv` reads both
 *    when it composes the routes);
 *  - the service is already up when Studio is built, and a Studio started again (a restart) is given the new
 *    service's environment, because a restart builds the routes again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MaterialServiceError, startStudioBesideMaterials, studioMaterialEnvironment } from './material-service.mjs';

test('the pair Studio needs is the service\'s own origin and secret, and nothing is invented when it is missing', () => {
  const env = studioMaterialEnvironment({ origin: 'http://127.0.0.1:60018', secret: 'f'.repeat(64) });
  assert.deepEqual(env, { MATERIALS_UPSTREAM: 'http://127.0.0.1:60018', MATERIALS_SECRET: 'f'.repeat(64) });
  for (const broken of [{}, { origin: '' , secret: 'f'.repeat(64) }, { origin: 'http://127.0.0.1:1', secret: '' }, null]) {
    assert.throws(() => studioMaterialEnvironment(broken), (error) => error instanceof MaterialServiceError && /未就绪/.test(error.message));
  }
});

test('the service is up before Studio is built, and Studio is handed its environment', async () => {
  const order = [];
  const studio = await startStudioBesideMaterials({
    env: { ORANGE_HOME: 'home' },
    materials: async () => { order.push('materials'); return { origin: 'http://127.0.0.1:60018', secret: 'e'.repeat(64) }; },
    launch: async (env) => { order.push('studio'); return { env }; },
  });
  assert.deepEqual(order, ['materials', 'studio'], 'the order is the whole fix');
  assert.equal(studio.env.MATERIALS_UPSTREAM, 'http://127.0.0.1:60018');
  assert.equal(studio.env.MATERIALS_SECRET, 'e'.repeat(64));
  assert.equal(studio.env.ORANGE_HOME, 'home', 'the rest of the environment is passed through untouched');
});

test('a Studio started again is given the new service\'s environment as well', async () => {
  const launched = [];
  for (let round = 0; round < 2; round += 1) {
    await startStudioBesideMaterials({
      env: {},
      materials: async () => ({ origin: `http://127.0.0.1:${60000 + round}`, secret: String(round).repeat(64) }),
      launch: async (env) => launched.push(env),
    });
  }
  assert.deepEqual(launched.map((env) => env.MATERIALS_UPSTREAM), ['http://127.0.0.1:60000', 'http://127.0.0.1:60001'],
    'a restart must not fall back to the 501 skeleton');
  assert.ok(launched.every((env) => env.MATERIALS_SECRET.length === 64));
});

test('a service that could not start leaves Studio starting anyway, without an upstream', async () => {
  const quiet = await startStudioBesideMaterials({ env: { A: '1' }, materials: async () => null, launch: async (env) => ({ env }) });
  assert.deepEqual(quiet.env, { A: '1' }, 'no library, but a window');
  const threw = await startStudioBesideMaterials({
    env: { A: '1' }, materials: async () => { throw new Error('refused'); }, launch: async (env) => ({ env }),
  });
  assert.deepEqual(threw.env, { A: '1' }, 'and a start that threw is the same degradation');
});

test('the window hands the pair over as an environment and still never spells the secret variable itself', () => {
  const main = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
  assert(!/MATERIALS_SECRET/.test(main), 'main.mjs names no secret variable: the module does');
  assert.match(main, /startStudioBesideMaterials\(\{/, 'the window goes through the one wiring that orders the two starts');
  assert.match(main, /materials: \(\) => startMaterials\(\[\]\)/, 'a server-side call, so no browser origin is passed');
  assert(!/void startMaterials\(\[studio\.origin\]\)/.test(main), 'the old "start it after Studio" path is gone');
});
