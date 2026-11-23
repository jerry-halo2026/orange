#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * `pnpm check:pack`: packs the package npm gets (`openfilm`) as the release publishes it,
 * lists every file in each tarball, and fails when one holds what it must not or lacks what it needs.
 *
 * It packs with `pnpm pack`, not `npm pack --dry-run`: the release publishes with `pnpm publish` (changesets uses the
 * workspace's package manager), which packs the same way: it runs prepack and postpack and replaces `workspace:` ranges.
 *
 *   every package   no tests, fixtures, tsconfigs, dev state or scripts; no `workspace:` range; not private; every
 *                   file its package.json points at (main, types, bin, exports) is in the tarball
 *   openfilm        product.json is the official one (prepack), and the checkout's own is back afterwards (postpack);
 *                   Studio's built editor is in
 *
 *   node scripts/check-pack.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const PACKAGES = [
  { name: 'openfilm', dir: 'packages/orangefilm' },
];

/** What a published package never holds. */
const FORBIDDEN = [
  [/(^|\/)(test|tests|fixtures?|__fixtures__)\//, 'a test folder'],
  [/\.test\.[cm]?[jt]sx?$/, 'a test'],
  [/(^|\/)tsconfig[^/]*\.json$/, 'a tsconfig'],
  [/\.tsbuildinfo$/, 'a TypeScript build cache'],
  [/(^|\/)(\.dev|\.release|node_modules)\//, 'dev state or scripts'],
  [/^scripts\//, 'dev state or scripts'],
  [/(^|\/)\.env/, 'an env file'],
  [/(^|\/)\.DS_Store$/, 'a Finder file'],
  [/(^|\/)product\.official\.json$/, 'the official product file (it goes in as product.json)'],
];

const problems = [];
const problem = (pkg, text) => problems.push(`${pkg}: ${text}`);
const tar = (args) => execFileSync('tar', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** The files a package.json points at, as tarball paths (patterns with `*` are left out). */
function pointedAt(manifest) {
  const out = new Set();
  const add = (value) => {
    if (typeof value === 'string') { if (!value.includes('*')) out.add(value.replace(/^\.\//, '')); }
    else if (value && typeof value === 'object') Object.values(value).forEach(add);
  };
  for (const field of ['main', 'module', 'types', 'bin', 'exports']) add(manifest[field]);
  return out;
}

/* `pnpm pack` writes the tarball into a folder this run owns, under the checkout's `.dev/`: `os.tmpdir()` is
   `C:\Users\<short-name>\AppData\Local\Temp` on Windows, and `pnpm pack --pack-destination` there leaves nothing to
   read back — the check then reported every file of the package as absent. `.dev/` is git-ignored and on the same
   volume as the package, so this reads back the tarball the packer actually wrote. */
mkdirSync(join(ROOT, '.dev'), { recursive: true });
const tmp = mkdtempSync(join(ROOT, '.dev', 'check-pack-'));
try {
  for (const { name, dir } of PACKAGES) {
    const pkgDir = join(ROOT, dir);
    const productBefore = name === 'openfilm' ? readFileSync(join(pkgDir, 'product.json')) : null;
    const dest = join(tmp, name.replace(/[@/]/g, '_'));
    execFileSync('pnpm', ['pack', '--pack-destination', dest], { cwd: pkgDir, stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' });
    const tgz = join(dest, readdirSync(dest).find((f) => f.endsWith('.tgz')));
    /* `tar` on Windows writes CRLF: split on both, or every name keeps a trailing `\r` and the check reads the whole
       package as absent (the first Windows run of this script reported exactly that) */
    const files = tar(['-tzf', tgz]).trim().split(/\r?\n/).map((f) => f.replace(/^package\//, ''));
    const read = (file) => tar(['-xzOf', tgz, `package/${file}`]);
    const manifest = JSON.parse(read('package.json'));

    console.log(`\n${manifest.name}@${manifest.version}: ${files.length} files`);
    for (const file of [...files].sort()) console.log(`  ${file}`);

    for (const file of files) {
      for (const [pattern, what] of FORBIDDEN) if (pattern.test(file)) problem(name, `${file} is ${what}`);
    }
    /* the repository is proprietary and this package is never published: a manifest that could be published is the
       failure, not the absence of one (`private: true` is what makes `npm publish` and `pnpm publish` refuse) */
    if (!manifest.private) problem(name, 'package.json is publishable (no "private": true)');
    if (manifest.license !== 'UNLICENSED') problem(name, `package.json says license ${JSON.stringify(manifest.license)}, not "UNLICENSED"`);
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
        if (String(range).startsWith('workspace:')) problem(name, `${field}: ${dep}@${range}`);
      }
    }
    const listed = new Set(files);
    for (const file of pointedAt(manifest)) if (!listed.has(file)) problem(name, `package.json points at ${file}, which is not in the package`);

    if (name === 'openfilm') {
      const packed = JSON.parse(read('product.json'));
      const official = JSON.parse(readFileSync(join(pkgDir, 'product.official.json'), 'utf8'));
      if (!isDeepStrictEqual(packed, official)) problem(name, 'product.json in the package is not product.official.json');
      else console.log(`  product.json: official (updates ${packed.desktop.updates})`);
      if (!readFileSync(join(pkgDir, 'product.json')).equals(productBefore)) problem(name, "the checkout's product.json was not restored after packing");
      if (!listed.has('studio/ui/dist/index.html')) problem(name, "Studio's editor is not built (studio/ui/dist)");
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (problems.length) {
  console.error(`\n${problems.length} problems:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  process.exit(1);
}
console.log('\nThe packages hold what they should.');
