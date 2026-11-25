#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * Build the material index from a running dev Studio.
 *
 *   node packages/orangefilm/scripts/material-index-build.mjs              # asks the Studio, writes the index
 *   node packages/orangefilm/scripts/material-index-build.mjs --dry-run    # asks, prints, writes nothing
 *   node packages/orangefilm/scripts/material-index-build.mjs --dir D:\\work\\idx --json
 *   node packages/orangefilm/scripts/material-index-build.mjs --dry-run --video-types 2,4
 *
 * The dev Studio writes where it listens and its launch key to `~/.orangefilm-dev/run.json` (`origin`, `key`); this reads
 * them, asks `/api/materials/list` once per page, and hands the pages to `buildMaterialIndexFromApi`.
 *
 * `--scope` defaults to `company`, not `own`: this account's `own` list answers every row as `dropped` (the supplier's
 * own filter, `filtered: {inspected: n, dropped: n}`), and the business materials the index is for are the company's.
 * `--scope own` is there for an account whose own list has rows.
 *
 * `--dry-run` still asks the Studio (that is the point: it proves the feed), it just lands nothing. The page reader is
 * a parameter, so a test can drive the whole CLI with a stub and no network at all.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MATERIAL_VIDEO_TYPES, PAGE_SIZE, buildMaterialIndexFromApi, defaultIndexDir, orangefilmDevHome, writeMaterialIndex,
} from '../src/material-index-build.mjs';

/** The scopes the Studio's material list accepts; `company` is the one this account's materials live in. */
export const SCOPES = Object.freeze(['company', 'own']);

/** `~/.orangefilm-dev/run.json`, as the dev Studio leaves it: `{pid, origin, filmOrigin, key}`. */
export const runFile = (home) => join(orangefilmDevHome(home), 'run.json');

/**
 * What the Studio says about itself, or an error saying which file was missing/why it cannot be used. The key is
 * never printed: the message names the file, not its content.
 * @param {{home?: string, read?: (path: string, encoding: 'utf8') => string}} [options]
 */
export function readRunFile({ home, read = readFileSync } = /** @type {any} */ ({})) {
  const file = runFile(home);
  let text;
  try { text = read(file, 'utf8'); }
  catch { throw Object.assign(new Error(`没有找到 ${file}：先起一个 dev Studio（pnpm dev），或用 --from 提供 origin/key`), { code: 'run-file-missing', file }); }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw Object.assign(new Error(`${file} 不是 JSON`), { code: 'run-file-invalid', file }); }
  const origin = typeof parsed?.origin === 'string' ? parsed.origin.trim() : '';
  const key = typeof parsed?.key === 'string' ? parsed.key.trim() : '';
  if (!origin || !key) throw Object.assign(new Error(`${file} 里没有 origin 或 key`, { code: 'run-file-incomplete', file }));
  return { origin, key, file };
}

/**
 * One page from the Studio's own material route, in the shape `buildMaterialIndexFromApi` documents. The row decoder
 * lives in `material-index-build.mjs` (`rowOf`), so this only has to carry `items` and `total` across.
 * @param {{origin: string, key: string, scope?: string, fetchImpl?: typeof fetch, timeoutMs?: number}} options
 */
export function fetchPageFromStudio({ origin, key, scope = 'company', fetchImpl = fetch, timeoutMs = 30_000 }) {
  const base = String(origin).replace(/\/+$/, '');
  return async ({ videoType, pageNo, pageSize, extra }) => {
    const query = new URLSearchParams({ scope, pageNo: String(pageNo), pageSize: String(pageSize), videoType: String(videoType) });
    for (const [name, value] of Object.entries(extra ?? {})) query.set(name, String(value));
    const url = `${base}/api/materials/list?${query}`;
    const response = await fetchImpl(url, {
      method: 'GET',
      /* the Studio's guard wants its launch key; the origin header is the page origin the guard compares against */
      headers: { accept: 'application/json', 'x-studio-key': key, origin: base },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); }
    catch { throw new Error(`GET ${url} 返回的不是 JSON（HTTP ${response.status}）`); }
    if (!response.ok) {
      const said = typeof body?.message === 'string' ? body.message : typeof body?.error === 'string' ? body.error : text.slice(0, 200);
      throw new Error(`GET ${url} → HTTP ${response.status}: ${said}`);
    }
    if (!Array.isArray(body?.items)) throw new Error(`GET ${url} 的响应里没有 items 数组`);
    return { items: body.items, total: body.total ?? body.providerTotal ?? null };
  };
}

/** `--dry-run`, `--dir`, `--page-size`, `--scope`, `--video-types`, `--json`, `--help`. A flag that needs a value eats the next word. */
export function parseArgs(argv = []) {
  const parsed = {
    dryRun: false, json: false, help: false, dir: null, pageSize: PAGE_SIZE,
    scope: 'company', videoTypes: [...MATERIAL_VIDEO_TYPES],
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = String(argv[index]);
    if (arg === '--dry-run') parsed.dryRun = true;
    else if (arg === '--json') parsed.json = true;
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--dir') parsed.dir = argv[++index] ?? null;
    else if (arg === '--page-size') {
      const size = Number(argv[++index]);
      if (!Number.isInteger(size) || size < 1 || size > PAGE_SIZE) throw new Error(`--page-size 要在 1-${PAGE_SIZE} 之间`);
      parsed.pageSize = size;
    } else if (arg === '--scope') {
      const scope = String(argv[++index] ?? '');
      if (!SCOPES.includes(scope)) throw new Error(`--scope 只能是 ${SCOPES.join(' / ')}`);
      parsed.scope = scope;
    } else if (arg === '--video-types') {
      const wanted = String(argv[++index] ?? '').split(',').map((part) => part.trim()).filter(Boolean);
      const types = wanted.map(Number);
      if (!types.length || types.some((type) => !MATERIAL_VIDEO_TYPES.includes(type))) {
        throw new Error(`--video-types 只能是 ${MATERIAL_VIDEO_TYPES.join(',')} 的组合`);
      }
      parsed.videoTypes = [...new Set(types)];
    } else throw new Error(`不认识的参数：${arg}`);
  }
  return parsed;
}

/** `videos/parsed/unclassified/sourceTotal` as one line, then each batch's first `take` materials. */
export function summaryLines(result, { take = 3, file = null } = {}) {
  const lines = [
    `videos/parsed/unclassified/sourceTotal: ${result.videos}/${result.parsed}/${result.unclassified}/${result.sourceTotal}`,
  ];
  if (file) lines.push(`index: ${file}`);
  for (const batch of result.index?.batches ?? []) {
    const names = batch.products
      .flatMap((/** @type {any} */ product) => product.groups.flatMap((/** @type {any} */ group) => group.entries ?? []))
      .slice(0, take)
      .map((/** @type {any} */ entry) => `${entry.name || `素材 #${entry.videoId}`} (${entry.videoId})`);
    lines.push(`${batch.id} 共 ${batch.count} 条: ${names.length ? names.join(' | ') : '（无名称）'}`);
  }
  for (const warning of result.warnings ?? []) lines.push(`warning ${warning.code}: ${warning.message}`);
  return lines;
}

/**
 * The whole CLI as a function: read one page at a time, build, and land the index unless `dryRun`. `fetchPage` is
 * required — a caller that has none gets the Studio's, which needs `run.json`.
 * @param {{
 *   dryRun?: boolean,
 *   json?: boolean,
 *   dir?: string | null,
 *   pageSize?: number,
 *   scope?: string,
 *   videoTypes?: readonly number[],
 *   home?: string,
 *   fetchPage?: Function | null,
 *   write?: typeof writeMaterialIndex,
 *   out?: (line: string) => void,
 *   log?: (line: string) => void,
 * }} [options]
 */
export async function runMaterialIndexBuild({
  dryRun = false,
  json = false,
  dir = null,
  pageSize = PAGE_SIZE,
  scope = 'company',
  videoTypes = MATERIAL_VIDEO_TYPES,
  home,
  fetchPage = null,
  write = writeMaterialIndex,
  out = (line) => console.log(line),
  log = (line) => console.error(line),
} = {}) {
  const read = fetchPage ?? fetchPageFromStudio({ ...readRunFile({ home }), scope });
  const result = await buildMaterialIndexFromApi({ fetchPage: read, pageSize, videoTypes });
  const target = dir ?? defaultIndexDir({ home });

  if (dryRun) {
    if (json) {
      out(JSON.stringify({
        dryRun: true, directory: target, scope, videoTypes, ...countsOf(result), warnings: result.warnings,
      }, null, 2));
    } else for (const line of summaryLines(result, { take: 3, file: null })) out(line);
    if (!json) out(`dry-run: 未落盘（目标 ${target}）`);
    return { ...result, written: null, dryRun: true };
  }

  const written = await write(target, result);
  if (json) {
    out(JSON.stringify({
      ...countsOf(result), scope, videoTypes, file: written.file, bytes: written.bytes, warnings: result.warnings,
    }, null, 2));
  } else for (const line of summaryLines(result, { take: 3, file: written.file })) out(line);
  log(`material-index: ${written.file} (${written.bytes} B)`);
  return { ...result, written, dryRun: false };
}

const countsOf = (result) => ({
  videos: result.videos, parsed: result.parsed, unclassified: result.unclassified, sourceTotal: result.sourceTotal,
});

const isMain = () => {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return fileURLToPath(import.meta.url) === entry; } catch { return false; }
};

if (isMain()) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log([
        '用法: node packages/orangefilm/scripts/material-index-build.mjs [--dry-run] [--dir DIR] [--page-size N]',
        `      [--scope ${SCOPES.join('|')}] [--video-types ${MATERIAL_VIDEO_TYPES.join(',')}] [--json]`,
        '  --scope        默认 company（own 在本账号被供应商全量过滤）',
        '  --video-types  只扫其中几类，默认全部',
      ].join('\n'));
    } else {
      await runMaterialIndexBuild({
        dryRun: args.dryRun, json: args.json, dir: args.dir, pageSize: args.pageSize,
        scope: args.scope, videoTypes: args.videoTypes,
      });
    }
    /* a build that ran is not a failure; the warnings it printed are the numbers, not an exit code */
    process.exitCode = 0;
  } catch (error) {
    console.error(`material-index-build: ${String(/** @type {any} */ (error)?.message ?? error)}`);
    process.exitCode = 1;
  }
}
