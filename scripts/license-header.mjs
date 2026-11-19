#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The copyright header, in one place, and the check that keeps it there.
 *
 * Why: the repository is proprietary, and a header that says so is the only statement a reader — or an agent that was
 * pointed at a single file — actually sees. `audit:public` fails a source file that lost it; this module owns the text
 * so the header and the check cannot drift apart.
 *
 *   node scripts/license-header.mjs --write <file...>   # put the header on top of files, in the file's own comment style
 *   node scripts/license-header.mjs --check <file...>   # exit 1 for a file without it
 *   node scripts/license-header.mjs --staged            # the files this commit touches
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The one sentence every source file carries. Keep it to three lines: it is read far more often than the LICENSE. */
export const COPYRIGHT_LINE = '© 2026 OrangeFilm. All rights reserved. Proprietary and confidential.';
export const PERMISSION_LINE = 'No modification or redistribution without the owner’s written permission.';

/** Comment styles by extension: the header goes in the file's own syntax, never in a form the parser would choke on. */
const STYLES = [
  [/\.(mjs|cjs|js|jsx|ts|tsx|mts|cts)$/, (lines) => lines.map((line) => (line ? `// ${line}` : '//'))],
  [/\.(cs)$/, (lines) => lines.map((line) => (line ? `// ${line}` : '//'))],
  [/\.(sh|ps1)$/, (lines) => lines.map((line) => (line ? `# ${line}` : '#'))],
  [/\.(css)$/, (lines) => ['/*', ...lines.map((line) => (line ? ` * ${line}` : ' *')), ' */']],
  [/\.(html|md)$/, (lines) => ['<!--', ...lines.map((line) => (line ? `  ${line}` : '')), '-->']],
];

/** @param {string} file @returns {string[]} */
export function headerLines(file) {
  return STYLES.find(([pattern]) => pattern.test(file))?.[1]([COPYRIGHT_LINE, PERMISSION_LINE]) ?? [];
}

/** @param {string} file @param {string} text */
export function hasHeader(file, text) {
  const lines = headerLines(file);
  if (!lines.length) return true;
  return text.slice(0, 400).includes(COPYRIGHT_LINE);
}

/** @param {string} file @param {string} text */
export function withHeader(file, text) {
  if (hasHeader(file, text)) return text;
  const lines = headerLines(file);
  if (!lines.length) return text;
  /* a byte-order mark and an interpreter line both have to stay first: a `#!` that is not on line 1 is not a shebang,
     and the three scripts this sweep broke on 2026-11-19 began with a BOM — Node refused to parse them afterwards */
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = bom ? text.slice(1) : text;
  const shebang = /^#!.*\n/.exec(body);
  if (shebang) return `${bom}${shebang[0]}${lines.join('\n')}\n\n${body.slice(shebang[0].length)}`;
  return `${bom}${lines.join('\n')}\n\n${body}`;
}

/* The command line, only when this file is the program: `audit-public.mjs` imports `hasHeader` from here, and a module
   that ran its own CLI on import would exit 2 the moment another script used it (which is exactly what happened the
   first time `pnpm audit:public` imported it). */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const check = args.includes('--check');
  const staged = args.includes('--staged');
  const files = staged
    ? execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    : args.filter((arg) => !arg.startsWith('--'));

  if (!write && !check) {
    console.error('usage: license-header.mjs --write|--check <file...> | --staged');
    process.exit(2);
  }

  let bad = 0;
  for (const file of files) {
    if (!/\.(mjs|cjs|js|jsx|ts|tsx|mts|cts|cs|sh|ps1|css|html)$/.test(file)) continue;
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (write) {
      const next = withHeader(file, text);
      if (next !== text) {
        writeFileSync(file, next);
        console.log(`header added: ${file}`);
      }
      continue;
    }
    if (!hasHeader(file, text)) {
      console.error(`missing header: ${file}`);
      bad += 1;
    }
  }
  process.exitCode = bad ? 1 : 0;
}
