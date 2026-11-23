// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.

/**
 * Naming guard for the convergence: the desktop's own modules are `orangefilm-*`, and the Studio
 * UI's human text says OrangeFilm. Technical identifiers (`OPENFILM_*`, package `openfilm`,
 * `~/.openfilm`) stay allowed until their compatibility phase.
 *
 * Run: node scripts/naming-guard.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const failures = [];
const walk = (dir, visit) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.release') continue;
    const at = join(dir, entry.name);
    if (entry.isDirectory()) walk(at, visit);
    else visit(at);
  }
};

walk('apps/desktop/src', (file) => {
  if (/^openfilm-(agent|command|models|mcp)(\.test)?\.mjs$/.test(file.split(/[\\/]/).pop() ?? '')) {
    failures.push(`${file}: desktop module still starts with openfilm-`);
  }
});
walk('packages/openfilm/studio/ui/src', (file) => {
  if (!/\.(ts|tsx)$/.test(file)) return;
  const text = readFileSync(file, 'utf8');
  if (/\bOpenFilm\b/.test(text)) failures.push(`${file}: human text still says OpenFilm`);
});

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log('naming guard: ok');
}
