// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The one place that says which environment this build signs people into.
 *
 * Before this module there were four answers to that question — the desktop's runtime config, the bench's
 * `.dev/bench-auth.env`, whatever a developer exported, and the packaged resources — and nothing compared them, so dev,
 * bench and a hand-clicked window could each believe a different environment and refuse the other's session with
 * "this sign-in is not active". Every reader now goes through `resolveEnvironment()`.
 *
 * Order, highest first:
 *   1. an explicit override (`ORANGE_AUTH_ENV`, or a config file named by `ORANGE_AUTH_CONFIG_FILE`) — the escape hatch
 *   2. the build's own description (`resources/auth-environment.json`, written at packaging time)
 *   3. the local Docker stack, for development with nothing exported at all
 *
 * A description that is present but incomplete, or ones that disagree, is an error with the missing pieces named: the
 * app must stop and say what is wrong, not limp into a login that cannot succeed.
 */
import { existsSync, readFileSync } from 'node:fs';

/** The three fields a sign-in needs; `instanceId`/`epoch` belong to the runtime, not to the description. */
export const ENVIRONMENT_FIELDS = ['environmentId', 'authOrigin', 'publishableKey'];

/**
 * Local development: the compose stack this repository starts with `pnpm dev:all`. The port is the one
 * `infra/docker-compose.yml` publishes (55432), not Supabase's usual 54321 — a mismatch here is a config that
 * resolves but cannot be reached.
 *
 * `authOrigin` stays plain http on purpose until the local auth service exists: `auth-service.mjs` is https-only, so
 * a local origin has to be terminated with TLS before this may point at it. Until then the resolver's answer is
 * useful for the database and the diagnostics, and the desktop still needs an explicit override to sign in.
 */
export const LOCAL_DOCKER = Object.freeze({
  environmentId: 'orange-local-docker',
  authOrigin: 'http://127.0.0.1:55432',
  publishableKey: 'local-anon-key',
});

const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/;

export class AuthEnvironmentError extends Error {
  /** @param {string} code @param {string} message @param {string[]} missing */
  constructor(code, message, missing = []) {
    super(message);
    this.name = 'AuthEnvironmentError';
    this.code = code;
    this.missing = missing;
  }
}

/** @param {unknown} value */
const text = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * Why a description cannot be used, or an empty list when it can. Empty strings count as missing: a key that is
 * present but blank is the failure that used to surface much later as a refused sign-in.
 * @param {Record<string, unknown> | null | undefined} value
 */
export function environmentProblems(value) {
  if (!value || typeof value !== 'object') return [...ENVIRONMENT_FIELDS];
  const at = /** @type {Record<string, unknown>} */ (value);
  const problems = ENVIRONMENT_FIELDS.filter((field) => !text(at[field]));
  if (!problems.length && !STABLE_ID.test(text(at.environmentId))) problems.push('environmentId');
  if (!problems.length && !/^https?:\/\//.test(text(at.authOrigin))) problems.push('authOrigin');
  return problems;
}

/** @param {Record<string, unknown>} value */
function freeze(value) {
  return Object.freeze({
    environmentId: text(value.environmentId),
    authOrigin: text(value.authOrigin).replace(/\/+$/, ''),
    publishableKey: text(value.publishableKey),
  });
}

/** @param {string} file @param {string} source */
function readDescription(file, source) {
  if (!existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new AuthEnvironmentError('auth-environment-unreadable', `${source} cannot be read as JSON: ${file}`, ENVIRONMENT_FIELDS);
  }
  const problems = environmentProblems(parsed);
  if (problems.length) {
    throw new AuthEnvironmentError('auth-environment-incomplete', `${source} is missing ${problems.join(', ')}: ${file}`, problems);
  }
  return freeze(parsed);
}

/**
 * The environment this process signs into. `options` exists for tests and for the bench, which point at a fixture file
 * instead of the developer's own export; production callers pass nothing.
 * @param {{ env?: Record<string, string | undefined>, resourcesDir?: string, requireDescription?: boolean }} [options]
 */
export function resolveEnvironment(options = {}) {
  const env = options.env ?? process.env;
  const sources = [];

  const explicitFile = text(env.ORANGE_AUTH_CONFIG_FILE);
  if (explicitFile) {
    const found = readDescription(explicitFile, 'ORANGE_AUTH_CONFIG_FILE');
    if (found) sources.push({ source: 'override-file', value: found });
  }
  const inline = text(env.ORANGE_AUTH_ENV);
  if (inline) {
    let parsed;
    try {
      parsed = JSON.parse(inline);
    } catch {
      throw new AuthEnvironmentError('auth-environment-unreadable', 'ORANGE_AUTH_ENV is not JSON', ENVIRONMENT_FIELDS);
    }
    const problems = environmentProblems(parsed);
    if (problems.length) {
      throw new AuthEnvironmentError('auth-environment-incomplete', `ORANGE_AUTH_ENV is missing ${problems.join(', ')}`, problems);
    }
    sources.push({ source: 'override-inline', value: freeze(parsed) });
  }

  if (options.resourcesDir) {
    const found = readDescription(`${options.resourcesDir}/auth-environment.json`, 'the packaged environment');
    if (found) sources.push({ source: 'packaged', value: found });
  }

  const distinct = new Map(sources.map((entry) => [entry.value.environmentId, entry]));
  if (distinct.size > 1) {
    const names = [...distinct.keys()].join(', ');
    throw new AuthEnvironmentError('auth-environment-conflict', `two environments are configured at once (${names}); keep one`, [...distinct.keys()]);
  }
  if (sources.length) return Object.freeze({ ...sources[0].value, source: sources[0].source, local: false });

  if (options.requireDescription) {
    throw new AuthEnvironmentError(
      'auth-environment-missing',
      'this build carries no environment description: the installer is incomplete and should be installed again',
      ENVIRONMENT_FIELDS,
    );
  }
  return Object.freeze({ ...LOCAL_DOCKER, source: 'local-docker', local: true });
}

/**
 * Whether a token minted for `tokenEnvironmentId` belongs to `environment` — the check that used to fail as
 * "this sign-in is not active" without saying why.
 * @param {{ environmentId: string }} environment @param {string | null | undefined} tokenEnvironmentId
 */
export function belongsToEnvironment(environment, tokenEnvironmentId) {
  if (!tokenEnvironmentId) return false;
  return text(tokenEnvironmentId) === environment.environmentId;
}
