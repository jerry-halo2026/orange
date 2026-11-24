// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/** `openfilm home`: inspect or copy the old Studio home into the new one. */
import { describeHomeMigration, migrateHome, planHomeMigration } from './home-migration.mjs';

export function homeCommand(args = [], opts = {}) {
  const sub = args[0] ?? 'status';
  const check = args.includes('--check') || opts.check === true;
  const dryRun = args.includes('--dry-run') || opts['dry-run'] === true;
  const includeLibrary = args.includes('--include-library') || opts['include-library'] === true;
  if (sub === 'status' || check) {
    const plan = planHomeMigration({ includeLibrary });
    return { ok: true, lines: [describeHomeMigration(plan)] };
  }
  if (sub !== 'migrate') {
    return { ok: false, lines: [`openfilm home: unknown "${sub}": use status, migrate, --check or --dry-run`] };
  }
  const result = migrateHome({ includeLibrary, dryRun, log: (line) => console.error(line) });
  return { ok: result.action !== 'failed', lines: [describeHomeMigration(result)] };
}
