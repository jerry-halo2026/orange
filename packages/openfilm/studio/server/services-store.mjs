// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * Settings → Services in an **installed** Studio: one store per signed-in account.
 *
 * An installed Studio runs without an isolation profile, so there is no profile home to hang a store
 * on. The store therefore lives in Studio's own folder, one file per account:
 *
 *   <studioHome>/services/<companyKey | acct-<sha256(environmentId, subjectId)>>.json
 *   { "keys": { "<provider id>": "<key>" }, "use": {…}, "model": {…}, … }   (see keys.mjs)
 *
 * The file is written whole and atomically by `changeSettings` (keys.mjs), 0600 in a 0700 folder, one
 * write at a time in this process. A session without an account identity (not signed in, or signed in
 * to something that cannot name its environment) gets 403 and no file is touched — the shared
 * `providers.json` of a plain checkout is never read on its behalf.
 *
 * The provider logic itself is untouched: this module only decides *which file* `readSettings` and
 * `changeSettings` act on, by binding it with `withAccountProviderSettings` for one request.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError } from './http.mjs';
import { withAccountProviderSettings } from './keys.mjs';
import { ordinaryControlPath } from './project-control-guard.mjs';
import { studioHome } from './projects.mjs';

/** Studio's folder for per-account Service stores. */
export const SERVICES_DIR = 'services';
/** A company key or an account id has to survive as one file name. */
const SAFE_KEY = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The account's name on disk: the desktop's company key when the session carries one, else a hash of
 * the identity it does carry. Never a guess: a session that cannot name both its environment and its
 * subject has no store here at all.
 * @param {any} evidence
 * @returns {string}
 */
export function accountServiceKey(evidence) {
  const company = typeof evidence?.companyKey === 'string' ? evidence.companyKey.trim() : '';
  if (SAFE_KEY.test(company)) return company;
  const environment = typeof evidence?.environmentId === 'string' ? evidence.environmentId.trim() : '';
  const subject = typeof evidence?.subjectId === 'string' ? evidence.subjectId.trim() : '';
  if (!environment || !subject) throw new HttpError(403, 'Sign in is required.', { code: 'authentication-required' });
  return `acct-${createHash('sha256').update(`${environment}\u0000${subject}`).digest('hex').slice(0, 32)}`;
}

/** Where this account's Services store is (the folder may not exist yet). @param {any} evidence */
export function servicesStoreFile(evidence) {
  return join(studioHome(), SERVICES_DIR, `${accountServiceKey(evidence)}.json`);
}

/** Studio's own folder, made once, readable by this user only. */
export async function ensureServicesFolder() {
  const folder = join(studioHome(), SERVICES_DIR);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  ordinaryControlPath(folder);
  return folder;
}

/**
 * Run one request's Services work against the signed-in account's own store.
 *
 * `check` is the session guard the store already relies on (keys.mjs): it runs before and after each
 * read and immediately before the committing rename, so a sign-out or an account switch mid-request
 * cannot land a write in another account's file.
 * @template T
 * @param {{ assertActive: () => any }} desktopAuth
 * @param {() => T} work
 * @returns {Promise<T>}
 */
export async function withAccountServices(desktopAuth, work) {
  const evidence = desktopAuth.assertActive();
  const file = servicesStoreFile(evidence);
  await ensureServicesFolder();
  ordinaryControlPath(file);
  const check = () => {
    const now = desktopAuth.assertActive();
    if (!now || now.environmentId !== evidence.environmentId || now.subjectId !== evidence.subjectId) {
      throw new HttpError(403, 'Sign in is required.', { code: 'authentication-required' });
    }
  };
  check();
  return withAccountProviderSettings(file, check, work);
}

/** Whether this account has a store at all (for diagnostics; never reads it). @param {any} evidence */
export function hasServicesStore(evidence) {
  try { return existsSync(servicesStoreFile(evidence)); } catch { return false; }
}
