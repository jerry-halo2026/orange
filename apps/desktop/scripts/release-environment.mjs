// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The environment an installer signs people into — resolved at build time, from one of three places, or the build
 * stops.
 *
 * Why this file exists: until 2026-11-19 the only source was `.dev/auth-runtime.json`, a git-ignored file that exists on
 * one developer's machine. Every build from a clean tree (a `git archive` sent to another computer, a CI runner, a
 * colleague) therefore produced an installer with no environment at all, and the app could only say
 * `configuration-required` — an app that installs and cannot be used. The environment is a build input like the app
 * icon: it must come from the repository, and a build without it must fail here, before electron-builder runs.
 *
 * Order, highest first:
 *   1. `ORANGE_AUTH_ENV` — the JSON itself, for a build that must use another environment than the committed one
 *   2. `ORANGE_AUTH_CONFIG_FILE` — a file, the shape `.dev/auth-runtime.json` has
 *   3. `release/environment.json` in this package — the environment our installers ship, committed and reviewed
 *
 * `.dev/auth-runtime.json` is deliberately **not** in that list. It stays what it always was: the pointer a development
 * run (`pnpm dev:all`, the bench) uses. Packaging is not a development run.
 *
 * Only three fields ever leave here — `environmentId`, `authOrigin`, `publishableKey` — and a fourth key, an `http`
 * origin or a privileged key (`sb_secret_…`, a JWT whose role is `service_role`) is refused: the file is on its way
 * into the installer's resources, so what must never be in it is checked here rather than discovered by a user.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENVIRONMENT_FIELDS, environmentProblems } from '../../../packages/orangefilm/src/auth-environment.mjs';
import { isPrivilegedKey } from '../src/auth-service.mjs';

/** Where the committed description lives, relative to `apps/desktop`. */
export const COMMITTED_ENVIRONMENT = join('release', 'environment.json');

const text = (value) => (typeof value === 'string' ? value.trim() : '');

/** @typedef {{ environmentId: string, authOrigin: string, publishableKey: string }} EnvironmentDescription */

/**
 * Why a description cannot be shipped, or an empty list. The three fields are the app's own rule
 * (`environmentProblems`), plus the two this build adds: an origin the auth service refuses anyway, and a key that must
 * never leave the server.
 * @param {unknown} value @returns {string[]}
 */
export function packagingProblems(value) {
  const problems = environmentProblems(value);
  if (problems.length) return problems;
  const at = /** @type {Record<string, unknown>} */ (value);
  const extra = [];
  if (Object.keys(at).length !== ENVIRONMENT_FIELDS.length) extra.push(`keys must be exactly ${ENVIRONMENT_FIELDS.join(', ')}`);
  if (!/^https:\/\//.test(text(at.authOrigin))) extra.push('authOrigin must be https (the auth service refuses http)');
  if (isPrivilegedKey(text(at.publishableKey))) extra.push('publishableKey is a privileged key (it must never ship)');
  return extra;
}

/** @param {unknown} value @returns {EnvironmentDescription} */
function description(value) {
  const at = /** @type {Record<string, unknown>} */ (value);
  return Object.fromEntries(ENVIRONMENT_FIELDS.map((field) => [field, text(at[field])]));
}

/**
 * The environment this build packages.
 * @param {{ desktop?: string, env?: Record<string, string | undefined> }} [options]
 * @returns {{ description: EnvironmentDescription, origin: string }}
 */
export function releaseEnvironment(options = {}) {
  const desktop = options.desktop ?? dirname(dirname(fileURLToPath(import.meta.url)));
  const env = options.env ?? process.env;
  const committed = join(desktop, COMMITTED_ENVIRONMENT);

  /** @type {{ source: string, file: string|null, value: unknown }[]} */
  const candidates = [];
  const inline = text(env.ORANGE_AUTH_ENV);
  if (inline) {
    let parsed;
    try {
      parsed = JSON.parse(inline);
    } catch {
      throw new Error('ORANGE_AUTH_ENV is not JSON: the environment to package cannot be read');
    }
    candidates.push({ source: 'ORANGE_AUTH_ENV', file: null, value: parsed });
  }
  const named = text(env.ORANGE_AUTH_CONFIG_FILE);
  if (named) {
    const file = resolve(named);
    if (!existsSync(file)) throw new Error(`ORANGE_AUTH_CONFIG_FILE names ${file}, which does not exist`);
    candidates.push({ source: 'ORANGE_AUTH_CONFIG_FILE', file, value: JSON.parse(readFileSync(file, 'utf8')) });
  }
  if (existsSync(committed)) {
    candidates.push({ source: 'the committed environment', file: committed, value: JSON.parse(readFileSync(committed, 'utf8')) });
  }

  if (!candidates.length) {
    throw new Error(
      `No environment to package. Write ${committed} (${ENVIRONMENT_FIELDS.join(', ')}), or set ORANGE_AUTH_ENV, ` +
        'or point ORANGE_AUTH_CONFIG_FILE at a file with those three fields. An installer without one installs and ' +
        'cannot sign anyone in, so this build stops here.',
    );
  }
  const found = candidates[0];
  const problems = packagingProblems(found.value);
  if (problems.length) {
    throw new Error(`The environment to package is unusable (${found.source}${found.file ? ` ${found.file}` : ''}): ${problems.join('; ')}`);
  }
  return { description: description(found.value), origin: found.file ? `${found.source} ${found.file}` : found.source };
}
