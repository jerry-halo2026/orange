#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// G04: every tracked test file must be run by some workspace's `test` script.
//
// The repo has 13 tracked test files that no `pnpm test` reaches (apps/desktop/bench/**.test.mjs,
// packages/openfilm/bin/openfilm-auth.test.mjs). Treating them as "passing" is the current biggest
// consistency lie, so this gate fails until each one is either run or explicitly exempted below.
//
// Usage: node scripts/gate-test-coverage.mjs [--json]
// Exit:  0 every tracked test file is covered; 1 uncovered (listed); 2 cannot read the repo.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Test files that are deliberately out of the default gate, with the reason. Keep this list tiny. */
const EXEMPT = new Map([
  ...[
    'activity-layout', 'agent-outdated', 'agent-setup', 'agent-sign-in', 'agent-startup', 'attachment-preview',
    'conversation-agent', 'media-menu', 'model-options', 'model-popover-layout', 'prompt-pills', 'turn-log',
  ].map((name) => [`apps/desktop/bench/${name}.test.mjs`, 'slow Electron bench (~20 s each); run by `pnpm --filter @openfilm/desktop test:bench` (G05)']),
  ['packages/openfilm/bin/openfilm-auth.test.mjs', 'needs ORANGE_LOGIN_TEST_ROOT (owned scratch); run via `pnpm --filter openfilm test:login`'],
]);

const TEST_FILE = /\.(test|spec)\.(mjs|cjs|js|ts|tsx)$/;

const sh = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', windowsHide: true });

const tracked = () => sh('git', ['ls-files']).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

const workspaces = () => {
  const out = [];
  for (const parent of ['apps', 'packages']) {
    const dir = join(root, parent);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.')) continue;
      const pkg = join(dir, name, 'package.json');
      if (!existsSync(pkg)) continue;
      try {
        const json = JSON.parse(readFileSync(pkg, 'utf8'));
        if (json.scripts?.test) out.push({ name: json.name ?? `${parent}/${name}`, dir: join(dir, name), test: json.scripts.test });
      } catch { /* an unreadable package is reported by the caller below */ }
    }
  }
  return out;
};

/** The globs a `node --test ...` command hands the test runner. Flags and file arguments are dropped. */
const globsOf = (script) => {
  const tokens = script.split(/\s+/).map((token) => token.replace(/^["']|["']$/g, '')).filter(Boolean);
  const at = tokens.indexOf('--test');
  const tail = at === -1 ? tokens : tokens.slice(at + 1);
  return tail.filter((token) => !token.startsWith('-') && !token.startsWith('--import') && token !== 'tsx' && !token.startsWith('--test-'));
};

const SKIP = new Set(['node_modules', '.git', '.pnpm-store', '.dev', 'dist', 'out', 'build', '.cache', 'dev-isolation']);

const walk = (dir) => {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
};

/** Minimal glob: segments, `**` for any depth, `*` inside a segment. */
const matches = (pattern, file) => {
  const p = pattern.split('/');
  const f = file.split('/');
  const go = (pi, fi) => {
    if (pi === p.length) return fi === f.length;
    const seg = p[pi];
    if (seg === '**') {
      for (let skip = fi; skip <= f.length; skip++) if (go(pi + 1, skip)) return true;
      return false;
    }
    if (fi === f.length) return false;
    if (!new RegExp(`^${seg.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`).test(f[fi])) return false;
    return go(pi + 1, fi + 1);
  };
  return go(0, 0);
};

const main = () => {
  const all = tracked();
  const tests = all.filter((file) => TEST_FILE.test(file));
  if (!tests.length) {
    console.error('gate-test-coverage: no tracked test files found — is this the repo root?');
    process.exit(2);
  }
  const covered = new Set();
  const packages = workspaces();
  // The repo root runs its own tool tests through `test:scripts` (pnpm -r does not reach the root).
  try {
    const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    if (rootPackage.scripts?.['test:scripts']) packages.push({ name: rootPackage.name ?? 'root', dir: root, test: rootPackage.scripts['test:scripts'] });
  } catch { /* an unreadable root package is the caller's problem, not this gate's */ }
  for (const pkg of packages) {
    for (const glob of globsOf(pkg.test)) {
      for (const file of walk(pkg.dir)) {
        const rel = relative(pkg.dir, file).split('\\').join('/');
        if (!TEST_FILE.test(rel)) continue;
        if (matches(glob, rel)) covered.add(relative(root, file).split('\\').join('/'));
      }
    }
  }
  const uncovered = tests.filter((file) => !covered.has(file) && !EXEMPT.has(file));
  const exempted = tests.filter((file) => EXEMPT.has(file));
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ schema: 'gate/1', gate: 'G04', ok: uncovered.length === 0, tracked: tests.length, covered: covered.size, uncovered, exempted: [...EXEMPT.keys()] }));
  } else {
    console.log(`gate-test-coverage: tracked tests ${tests.length}, covered ${covered.size}, uncovered ${uncovered.length}, exempt ${exempted.length}`);
    for (const file of uncovered) console.log(`  UNCOVERED  ${file}`);
    for (const file of exempted) console.log(`  exempt     ${file} — ${EXEMPT.get(file)}`);
  }
  process.exit(uncovered.length ? 1 : 0);
};

main();
