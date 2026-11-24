#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.

/**
 * Rename inventory: every place the retired OpenFilm identifier still lives.
 *
 * Read-only. Prints a markdown report grouping hits by rename bucket so the
 * clean-break plan (docs/execution/orangefilm-clean-break/plan.md) can be
 * executed bucket by bucket with a test gate per bucket.
 *
 * Usage: node scripts/inventory-openfilm.mjs [--json] [--root DIR]
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

const TEXT_EXT = new Set([
  '.mjs', '.cjs', '.js', '.jsx', '.ts', '.tsx', '.json', '.jsonc', '.md', '.mdx',
  '.yml', '.yaml', '.toml', '.txt', '.html', '.css', '.scss', '.ps1', '.sh',
  '.cmd', '.bat', '.plist', '.nsh', '.rs', '.cs', '.csproj', '.sln', '.pem', '.entitlements',
]);

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.dev', '_scratch', 'dist', 'dist-electron', 'release',
  '.release', 'out', 'obj', 'bin', 'coverage', '.turbo', '.pnpm-store',
]);

/** Buckets ordered by blast radius; each is one codemod pass. */
const BUCKETS = [
  { id: 'env', title: '环境变量 OPENFILM_*', re: /OPENFILM_[A-Z0-9_]+/g },
  { id: 'mcp', title: 'MCP 工具前缀 mcp__openfilm__', re: /mcp__openfilm__/g },
  { id: 'import', title: "模块说明符 'openfilm' / 'openfilm/…'", re: /(?:from\s*|require\(\s*|import\(\s*)['"]openfilm(?:\/[^'"]*)?['"]/g },
  { id: 'pkg-scope', title: '@openfilm/ 工作区别名', re: /@openfilm\/[a-z0-9._-]+/g },
  { id: 'css-class', title: 'CSS 类/选择器前缀 openfilm-', re: /\bopenfilm-[a-z0-9-]+/g },
  { id: 'data-file', title: '技能元数据文件 openfilm.json', re: /\bopenfilm\.json\b/g },
  { id: 'home', title: '~/.openfilm 主目录与本地状态', re: /\.openfilm\b/g },
  { id: 'resource', title: '打包资源路径 resources/openfilm', re: /resources[\\/]openfilm/g },
  { id: 'url', title: '外部 URL (github.com/openfilm, openfilm.dev)', re: /(?:github\.com\/openfilm|openfilm\.dev)/g },
  { id: 'ident', title: '裸标识符 openfilm (包名/脚本名/字段值)', re: /\bopenfilm\b/g },
  { id: 'product', title: '产品文案 OpenFilm', re: /OpenFilm/g },
];

function parseArgs(argv) {
  const out = { json: false, root: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') out.json = true;
    else if (argv[i] === '--root') out.root = resolve(argv[++i]);
  }
  return out;
}

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(join(dir, entry.name));
    } else if (entry.isFile()) {
      yield join(dir, entry.name);
    }
  }
}

function countMatches(text, re) {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(text) !== null) n += 1;
  return n;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = args.root;
  const files = [];
  const renamedFiles = [];
  const buckets = new Map(BUCKETS.map((b) => [b.id, { ...b, files: new Map(), total: 0 }]));

  for await (const path of walk(root)) {
    const rel = relative(root, path).split(sep).join('/');
    if (rel.startsWith('..')) continue;
    if (/openfilm/i.test(rel)) renamedFiles.push(rel);
    const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
    if (!TEXT_EXT.has(ext)) continue;
    let info;
    try {
      info = await stat(path);
      if (info.size > 2 * 1024 * 1024) continue;
    } catch {
      continue;
    }
    let text;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    if (!/openfilm/i.test(text)) continue;
    files.push(rel);
    for (const bucket of BUCKETS) {
      const n = countMatches(text, bucket.re);
      if (n === 0) continue;
      const entry = buckets.get(bucket.id);
      entry.files.set(rel, n);
      entry.total += n;
    }
  }

  const summary = BUCKETS.map((b) => {
    const entry = buckets.get(b.id);
    return { id: b.id, title: b.title, files: entry.files.size, hits: entry.total };
  });

  if (args.json) {
    const payload = {
      root,
      filesWithLegacyText: files.length,
      filesWithLegacyName: renamedFiles.length,
      buckets: summary,
      perFile: Object.fromEntries(
        BUCKETS.map((b) => [b.id, [...buckets.get(b.id).files.entries()].sort((x, y) => y[1] - x[1])]),
      ),
      renamedFiles: renamedFiles.sort(),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  const lines = [];
  lines.push('# OpenFilm → OrangeFilm 全量清单');
  lines.push('');
  lines.push(`扫描根目录：\`${root}\``);
  lines.push('');
  lines.push(`- 含旧标识文本的文件：**${files.length}**`);
  lines.push(`- 路径含旧标识的文件：**${renamedFiles.length}**`);
  lines.push('');
  lines.push('| 桶 | 文件数 | 出现次数 |');
  lines.push('| --- | ---: | ---: |');
  for (const row of summary) lines.push(`| \`${row.id}\` ${row.title} | ${row.files} | ${row.hits} |`);
  lines.push('');
  for (const b of BUCKETS) {
    const entry = buckets.get(b.id);
    lines.push(`## ${b.id} — ${b.title}`);
    lines.push('');
    lines.push(`文件 ${entry.files.size} 个，出现 ${entry.total} 次。`);
    lines.push('');
    const top = [...entry.files.entries()].sort((x, y) => y[1] - x[1]).slice(0, 40);
    for (const [file, n] of top) lines.push(`- \`${file}\` ×${n}`);
    if (entry.files.size > top.length) lines.push(`- …另有 ${entry.files.size - top.length} 个文件`);
    lines.push('');
  }
  lines.push('## 路径含 openfilm 的文件');
  lines.push('');
  for (const file of renamedFiles.sort()) lines.push(`- \`${file}\``);
  process.stdout.write(`${lines.join('\n')}\n`);
}

await main();
