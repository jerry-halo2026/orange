#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * `pnpm test`, with the fixture roots the integration suites require.
 *
 * Why: a dozen suites in `packages/openfilm` refuse to run without an explicit, canonical test root outside `C:`
 * (`providers-isolation`, `saved-library-ownership`, `installed-services-boundary`, `person-edits-worker-lifecycle`,
 * and the two Fission suites) — they assert it before their first line of setup, so a plain `pnpm test` was red on
 * every machine, which is how a red suite stops being read. `packages/openfilm/src/test-roots.mjs` already owns the
 * rule for a root that satisfies them; this wrapper exports the same answers as environment variables, once, and then
 * runs the workspace's own test scripts unchanged.
 *
 * A suite that needs more than a root (a published Fission worker sidecar, a headless browser) still asserts it and
 * still fails — that is deliberate: "needs a real binary" is a condition to see, not to hide behind a skip.
 *
 *   node scripts/test-workspace.mjs            # every package's test script, fail-fast like pnpm -r
 *   node scripts/test-workspace.mjs --list     # the environment it would set, then exit
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { repositoryRoot } from '../packages/openfilm/src/test-roots.mjs';

/** The roots the suites name, and the variable each reads. One directory per suite, all under the checkout's `.dev/`. */
const ROOTS = {
  ORANGE_TEST_ROOT: '.dev/test-roots',
  ORANGE_SERVICES_TEST_ROOT: '.dev/test-roots/services',
  ORANGE_LIBRARY_TEST_ROOT: '.dev/test-roots/library',
  ORANGE_WORKER_TEST_ROOT: '.dev/test-roots/worker',
};

const environment = {};
for (const [name, relative] of Object.entries(ROOTS)) {
  const dir = resolve(repositoryRoot, relative);
  mkdirSync(dir, { recursive: true });
  environment[name] = dir;
}

/**
 * ffmpeg is deliberately **not** provided here.
 *
 * The suites that need it spawn a bare `ffmpeg` and assume a build with every codec they name (ProRes, HEVC, VP9,
 * loudness peaks) — the repository's own copy does not satisfy them on this machine, and pointing them at it turned
 * honest `no ffmpeg` skips into dozens of failures about codecs and alpha. A machine whose `PATH` has the right build
 * runs them; a machine without one skips them, by name. `ORANGE_TEST_FFMPEG` is left to whoever knows they have the
 * right binary.
 */

if (process.argv.includes('--list')) {
  for (const [name, value] of Object.entries(environment)) console.log(`${name}=${value}`);
  process.exit(0);
}

const run = spawnSync('pnpm', ['-r', '--workspace-concurrency=1', '--if-present', 'run', 'test'], {
  cwd: repositoryRoot,
  // the workspace's own scripts, with these roots: nothing else about the environment is changed
  env: { ...process.env, ...environment },
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
process.exit(run.status ?? 1);
