// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * A one-way, explicit move from the home OrangeFilm used before the rename (`~/.openfilm`) to the
 * new one (`~/.orangefilm`). It copies configuration, not the person's projects or the material
 * cache: those can be large and are still reachable from the old home. The old home is never
 * deleted. A marker in the target says the copy completed, so a half-finished copy is never used
 * as if it were whole.
 *
 * This module has no Electron dependency and no Studio state: the CLI and a test can drive it.
 */
import { cpSync, existsSync, mkdirSync, openSync, closeSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOME_CONFIG_ENTRIES = Object.freeze([
  'prefs.json',
  'orange-accounts',
  'orange-saved-owners.json',
  'orange-project-owners.json',
  'cloud-steward.json',
  'update.json',
  '.orangefilm-control.json',
]);

export const HOME_LIBRARY_ENTRY = 'library';
export const MIGRATION_MARKER = '.orangefilm-home-migration.json';
const LOCK = '.orangefilm-home-migration.lock';

export const defaultHomePaths = (home = homedir()) => ({
  from: join(home, '.openfilm'),
  to: join(home, '.orangefilm'),
});

const requireEntries = (dir) => {
  try { return [...HOME_CONFIG_ENTRIES, HOME_LIBRARY_ENTRY].filter((entry) => existsSync(join(dir, entry))); } catch { return []; }
};

/** What a migration would do, without touching either home. */
export function planHomeMigration({ from, to, includeLibrary = false } = {}) {
  const paths = from && to ? { from, to } : defaultHomePaths();
  if (!existsSync(paths.from)) return { ...paths, action: 'none', entries: [], reason: 'old-home-missing' };
  if (existsSync(join(paths.to, MIGRATION_MARKER))) return { ...paths, action: 'already', entries: [], reason: 'already-migrated' };
  if (existsSync(paths.to) && requireEntries(paths.to).length) return { ...paths, action: 'blocked', entries: [], reason: 'target-not-empty' };
  const entries = HOME_CONFIG_ENTRIES.filter((entry) => existsSync(join(paths.from, entry)));
  if (includeLibrary && existsSync(join(paths.from, HOME_LIBRARY_ENTRY))) entries.push(HOME_LIBRARY_ENTRY);
  return { ...paths, action: entries.length ? 'copy' : 'nothing-to-copy', entries, reason: null };
}

/**
 * Copy the configuration entries and write the marker. The source is kept. The target is created
 * only for a migration that can complete; a failure removes the partial target this call made.
 * @param {{ from?: string, to?: string, includeLibrary?: boolean, dryRun?: boolean, log?: (line: string) => void }} [options]
 */
export function migrateHome({ from, to, includeLibrary = false, dryRun = false, log = () => {} } = {}) {
  const plan = planHomeMigration({ from, to, includeLibrary });
  if (plan.action !== 'copy' && plan.action !== 'nothing-to-copy') return plan;
  if (dryRun) return { ...plan, action: 'dry-run' };
  const madeTarget = !existsSync(plan.to);
  let lock = null;
  try {
    mkdirSync(plan.to, { recursive: true });
    lock = openSync(join(plan.to, LOCK), 'wx');
    for (const entry of plan.entries) {
      cpSync(join(plan.from, entry), join(plan.to, entry), { recursive: true, verbatimSymlinks: true });
      log(`copied ${entry}`);
    }
    writeFileSync(join(plan.to, MIGRATION_MARKER), `${JSON.stringify({
      from: plan.from, at: new Date().toISOString(), entries: plan.entries,
    }, null, 2)}\n`, { mode: 0o600 });
    return { ...plan, action: 'migrated', madeTarget };
  } catch (error) {
    try { if (madeTarget) rmSync(plan.to, { recursive: true, force: true }); } catch { /* keep the old home */ }
    return { ...plan, action: 'failed', error: String(error?.message ?? error), madeTarget };
  } finally {
    if (lock !== null) { try { closeSync(lock); } catch { /* closed */ } try { rmSync(join(plan.to, LOCK), { force: true }); } catch { /* gone */ } }
  }
}

/** A line a CLI or a Settings panel can print. */
export function describeHomeMigration(result) {
  switch (result.action) {
    case 'none': return `nothing to migrate: ${result.from} is not there`;
    case 'already': return `already migrated: ${result.to} has ${MIGRATION_MARKER}`;
    case 'blocked': return `not migrating: ${result.to} already has data and no migration marker`;
    case 'copy': return `ready to migrate ${result.entries.join(', ')} from ${result.from} to ${result.to}`;
    case 'nothing-to-copy': return `nothing to copy from ${result.from}`;
    case 'dry-run': return `would copy ${result.entries.join(', ')} from ${result.from} to ${result.to}`;
    case 'migrated': return `copied ${result.entries.join(', ')} to ${result.to}; ${result.from} was kept`;
    default: return `migration failed: ${result.error}`;
  }
}
