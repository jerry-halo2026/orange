// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * The cloud-steward account this installation last bound, remembered **per signed-in person**.
 *
 * Why: the binding itself lives at the provider, keyed by the signed principal — so a restart on the same machine does
 * not ask again. What it does not survive is the provider forgetting it, or the person signing in on another machine:
 * then the account has to be typed once more. The person bound it once; they should not have to remember the spelling
 * of that account.
 *
 * So the name is kept here too, beside the projects (`<shared home>/cloud-steward.json`), one entry per subject:
 *   { "<subject id>": "<account name>" }
 *
 * It is a **hint, never an authority**: the provider still decides. A remembered name is only offered back when the
 * provider says "not bound", and the claim it makes can fail (the account was renamed, or does not belong to this
 * person) — in which case the entry is dropped and the person is asked, as before. Nothing is sent to the provider
 * that the provider did not ask for.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sharedHome } from '../../src/locations.mjs';

/** The file the remembered names live in. */
export const memoryFile = () => join(sharedHome(), 'cloud-steward.json');

/**
 * The remembered account for one subject, or null.
 * @param {string | null} subject
 * @param {{file?: string, read?: (file: string) => any}} [options]
 */
export function rememberedSteward(subject, { file = memoryFile(), read = readJsonFile } = {}) {
  if (!subject) return null;
  const all = read(file);
  const value = all && typeof all === 'object' ? all[subject] : null;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Remember (or, with null, forget) one subject's account. Written atomically: a half-written file would lose every
 * other person's entry on this machine.
 * @param {string | null} subject @param {string | null} account
 * @param {{file?: string, read?: (file: string) => any}} [options]
 */
export function rememberSteward(subject, account, { file = memoryFile(), read = readJsonFile } = {}) {
  if (!subject) return;
  const all = { ...(read(file) ?? {}) };
  const name = typeof account === 'string' ? account.trim() : '';
  if (name) all[subject] = name; else delete all[subject];
  mkdirSync(join(file, '..'), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(all, null, 1)}\n`);
  renameSync(temp, file);
}

/** The file as JSON, or {} when it is missing or unreadable (a broken hint must not stop a sign-in). */
export function readJsonFile(file) {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return {};
  }
}
