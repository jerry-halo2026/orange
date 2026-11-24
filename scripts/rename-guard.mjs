#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.

/**
 * Fail when a retired OpenFilm runtime identifier comes back.
 *
 * The rename is a clean break: `OPENFILM_*`, `openfilm` module specifiers, `@openfilm/`,
 * `mcp__openfilm__`, `resources/openfilm`, `~/.openfilm` and `orangefilm.json` are not allowed in
 * source. History and provenance stay readable: docs/history and docs/execution/2026-1* are exempt,
 * and so are the license/notice files.
 *
 *   node scripts/rename-guard.mjs             # exit 1 on any hit
 *   node scripts/rename-guard.mjs --warn      # report, exit 0 (for the transition)
 *   node scripts/rename-guard.mjs --json
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const RULES = [
  { id: 'env', re: /OPENFILM_[A-Z0-9_]+/g, fix: 'ORANGE_' },
  { id: 'mcp', re: /mcp__openfilm__/g, fix: 'mcp__orangefilm__' },
  { id: 'import', re: /(?:from\s*|require\(\s*|import\(\s*)['"]openfilm(?:\/[^'"]*)?['"]/g, fix: 'orangefilm' },
  { id: 'pkg-scope', re: /@openfilm\//g, fix: '@orange/' },
  { id: 'resource', re: /resources[\\/]openfilm/g, fix: 'resources/orangefilm' },
  { id: 'home', re: /(?:['"`~]|join\([^)]*?)[^\n]{0,40}\.openfilm\b/g, fix: '~/.orangefilm' },
  { id: 'data-file', re: /\bopenfilm\.json\b/g, fix: 'orangefilm.json' },
  { id: 'bin', re: /\bopenfilm\.mjs\b/g, fix: 'orangefilm.mjs' },
];

const SCAN_ROOTS = ['apps', 'packages', 'scripts', 'skills', 'workers', '.github'];
const TEXT_EXT = /\.(mjs|cjs|js|jsx|ts|tsx|json|ya?ml|toml|ps1|sh|cmd|bat|plist|nsh)$/;
const SKIP_DIRS = new Set(['node_modules', '.git', '.dev', '_scratch', 'dist', 'dist-electron', 'release', '.release', 'out', 'coverage']);

/* Files whose job is the old name: the guard's own patterns, the one-way import of the old Studio home,
   and the machine cleanup that removes what the old client left behind. */
const EXEMPT = new Set([
  'scripts/inventory-openfilm.mjs',
  'scripts/rename-guard.mjs',
  'scripts/naming-guard.mjs',
  'scripts/cleanup-legacy-openfilm.mjs',
  'packages/orangefilm/src/home-migration.mjs',
  'packages/orangefilm/src/home-migration.test.mjs',
  'packages/orangefilm/src/home-cli.mjs',
  'packages/orangefilm/src/home-cli.test.mjs',
]);

/* A rule a file may keep, because the old name is data there: a skill made before the rename still carries
   `openfilm.json`, and the reader has to name it to read it. */
const ALLOWED = new Map([
  ['packages/orangefilm/src/skills.mjs', new Set(['data-file'])],
]);

function exempt(rel) {
  if (EXEMPT.has(rel)) return true;
  if (rel.startsWith('docs/history/')) return true;
  if (/^docs\/execution\/2026-1[0-9]-/.test(rel)) return true;
  if (/^(LICENSE|THIRD_PARTY_NOTICES\.md|NOTICE)$/.test(rel)) return true;
  return false;
}

const args = new Set(process.argv.slice(2));
const WARN = args.has('--warn');
const JSON_OUT = args.has('--json');

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(path);
    } else if (entry.isFile()) {
      yield path;
    }
  }
}

const findings = [];
for (const root of SCAN_ROOTS) {
  for await (const path of walk(root)) {
    if (!TEXT_EXT.test(path)) continue;
    const rel = relative(process.cwd(), path).split(sep).join('/');
    if (exempt(rel)) continue;
    let text;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    if (!/openfilm/i.test(text)) continue;
    /* a GitHub secret's name lives in the repository's settings, not in the source: only the env var it feeds is ours */
    text = text.replace(/secrets\.OPENFILM_[A-Z0-9_]+/g, 'secrets.SECRET_NAME');
    for (const rule of RULES) {
      if (ALLOWED.get(rel)?.has(rule.id)) continue;
      rule.re.lastIndex = 0;
      let match;
      let count = 0;
      while ((match = rule.re.exec(text)) !== null) {
        count += 1;
        if (count === 1) findings.push({ rule: rule.id, file: rel, sample: match[0].slice(0, 80), fix: rule.fix });
        if (match[0].length === 0) rule.re.lastIndex += 1;
      }
      if (count > 1) findings[findings.length - 1].count = count;
    }
  }
}

if (JSON_OUT) {
  process.stdout.write(`${JSON.stringify({ findings, total: findings.length }, null, 2)}\n`);
} else if (findings.length === 0) {
  console.log('rename-guard: 干净，没有旧运行时标识。');
} else {
  console.log(`rename-guard: ${findings.length} 处旧运行时标识（每文件每规则第一条）\n`);
  for (const f of findings) console.log(`${f.rule.padEnd(9)} ${f.file}\n          ${f.sample}   → ${f.fix}`);
  console.log('\n历史证据与许可文件不在此列；在 P1–P4 阶段逐桶清零。');
}

if (findings.length > 0 && !WARN) process.exit(1);
