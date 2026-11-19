// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * Who a Studio installation's Saved library belongs to.
 *
 * The branded session alone is not enough: `assertActive()` only proves *an account is signed in*.
 * A library on disk belongs to the account that claimed it, and this file records that claim next
 * to the project owners (`orange-project-owners.json`) in the same owned home, in the same shape:
 *
 *   <home>/orange-saved-owners.json
 *   {"version":1,"saved":[{"environmentId":"…","subjectId":"…","windowScope":"<sha256 hex>","claimedAt":"…"}]}
 *
 * The key is the account pair; `windowScope` (the session's own hash, from desktop-auth) is accepted
 * as an equivalent key.
 *
 * Claiming:
 *   - an **empty** library has nothing to take over, so the first signed-in session claims it;
 *   - a library that already holds media is refused (503) until the explicit claim action
 *     (`POST /api/saved/claim`, with its confirmation) names an owner;
 *   - an owner never loses the library to another account.
 *
 * Refusals, in this order:
 *   no session            → 403 `authentication-required`
 *   session, no record,
 *   media in the library  → 503 `saved-ownership-required`   (never release by default)
 *   record of another     → 403 `saved-access-denied`
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from './http.mjs';

export const SAVED_OWNERS_FILE = 'orange-saved-owners.json';

/** @param {unknown} value */
const text = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200;

/**
 * @param {{ home?: string | null, desktopAuth?: { assertActive?: () => any, windowScope?: () => string } | null,
 *   file?: string | null, libraryRoot?: (() => string) | null }} options
 */
export function createSavedAccess({ home = null, desktopAuth = null, file = null, libraryRoot = null }) {
  const path = file ?? (text(home) ? join(/** @type {string} */ (home), SAVED_OWNERS_FILE) : null);
  /** @returns {never} */
  const unauthenticated = () => { throw new HttpError(403, 'Sign in is required.', { code: 'authentication-required' }); };
  /** @returns {never} */
  const unowned = () => { throw new HttpError(503, 'This library is not yet connected to the signed-in account.', { code: 'saved-ownership-required' }); };
  /** @returns {never} */
  const foreign = () => { throw new HttpError(403, 'This library belongs to another account.', { code: 'saved-access-denied' }); };

  /** The signed-in session (or null when this installation has no accounts at all). */
  function session() {
    if (!desktopAuth) return null;
    if (typeof desktopAuth.assertActive !== 'function') unauthenticated();
    /** @type {any} */
    let active;
    try { active = desktopAuth.assertActive(); } catch { unauthenticated(); }
    if (!active || !text(active.environmentId) || !text(active.subjectId)) unauthenticated();
    return active;
  }
  const scopeOf = () => (typeof desktopAuth?.windowScope === 'function' ? desktopAuth.windowScope() : null);

  /** The claims recorded for this library; [] when the file is simply not there. */
  function owners() {
    if (!path) return [];
    if (!existsSync(path)) return [];
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024) foreign();
    /** @type {any} */
    let raw;
    try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { foreign(); }
    if (!raw || raw.version !== 1 || Object.keys(raw).sort().join() !== 'saved,version' || !Array.isArray(raw.saved)) foreign();
    return raw.saved.filter((/** @type {any} */ item) => item
      && Object.keys(item).sort().join() === 'claimedAt,environmentId,subjectId,windowScope'
      && text(item.environmentId) && text(item.subjectId) && text(item.windowScope) && text(item.claimedAt));
  }

  /** Both keys this library accepts for one session. */
  const matches = (/** @type {any} */ record, /** @type {any} */ active, /** @type {string | null} */ scope) =>
    record.environmentId === active.environmentId
    && (record.subjectId === active.subjectId || (scope !== null && record.windowScope === scope));

  /**
   * Whether the library holds anything at all: dot entries (the sidecars) do not count, and neither
   * does a folder merely existing. An empty library has nothing to take over.
   */
  function isEmpty() {
    const root = libraryRoot ? libraryRoot() : null;
    if (!root || !existsSync(root)) return true;
    /** @param {string} dir @param {number} depth */
    const holds = (dir, depth) => {
      /** @type {string[]} */
      let names;
      try { names = readdirSync(dir); } catch { return false; }
      for (const name of names) {
        if (name.startsWith('.')) continue;
        const at = join(dir, name);
        let info;
        try { info = lstatSync(at); } catch { continue; }
        if (info.isFile()) return true;
        if (info.isDirectory() && depth > 0 && holds(at, depth - 1)) return true;
      }
      return false;
    };
    return !holds(root, 4);
  }

  /** Whether this session may act on the library at all (empty and unclaimed counts as yes). */
  function mine() {
    const active = session();
    if (!active) return false;
    const list = owners();
    if (!list.length) return true;
    const scope = scopeOf();
    return list.some((/** @type {any} */ record) => matches(record, active, scope));
  }

  /**
   * Record this session as an owner of the library. Used by the explicit claim action, and by the
   * first signed-in session when the library is still empty (nothing can be taken over then).
   */
  function claim() {
    const active = session();
    if (!active) unauthenticated();
    if (!path) unowned();
    const scope = scopeOf() ?? createHash('sha256').update(`${active.environmentId}\0${active.subjectId}`).digest('hex');
    const list = owners();
    const record = { environmentId: active.environmentId, subjectId: active.subjectId, windowScope: scope, claimedAt: new Date().toISOString() };
    const next = [...list.filter((/** @type {any} */ item) => !(item.environmentId === record.environmentId && item.subjectId === record.subjectId)), record];
    mkdirSync(/** @type {string} */ (home), { recursive: true });
    const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ version: 1, saved: next }) + '\n', { flag: 'wx', mode: 0o600 });
      renameSync(temp, path);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
    return record;
  }

  /**
   * The gate every Saved entry point calls. Returns the session it allowed (null without accounts).
   * @returns {any}
   */
  function assertOwned() {
    const active = session();
    if (!active) return null;
    const list = owners();
    if (!list.length) {
      if (!isEmpty()) unowned();
      claim();
      return active;
    }
    const scope = scopeOf();
    if (!list.some((/** @type {any} */ record) => matches(record, active, scope))) foreign();
    return active;
  }

  return {
    path,
    session,
    owners,
    isEmpty,
    mine,
    claim,
    assertOwned,
    /** The explicit claim action's own gate: one account never claims another's library. */
    assertMine() {
      const active = session();
      if (!active) unauthenticated();
      if (!mine()) foreign();
      return active;
    },
    /**
     * The `server.mjs:419-423` template: who was allowed, and a check that it is still the same
     * person and the same claim after a long operation.
     */
    fence() {
      const active = assertOwned();
      if (!active) return () => {};
      const scope = scopeOf();
      return () => {
        const now = session();
        if (now.environmentId !== active.environmentId || now.subjectId !== active.subjectId) foreign();
        if (scope !== null && scopeOf() !== scope) foreign();
        assertOwned();
      };
    },
  };
}

/** @typedef {ReturnType<typeof createSavedAccess>} SavedAccess */
