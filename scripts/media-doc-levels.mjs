#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// 把索引里的 `oneLevel` / `twoLevel` 回填到 `media_doc.one_level` / `two_level`。
//
//   node scripts/media-doc-levels.mjs                 # 回填（幂等，可反复跑）
//   node scripts/media-doc-levels.mjs --dry-run       # 只统计能填多少，不写库
//   node scripts/media-doc-levels.mjs --batch 500     # 每批行数
//
// # 为什么不用重新嵌入
//
// 这两个值**已经在 text 里**（渲染顺序是「一级分类 二级分类 产品 分组 标签…」），所以向量是基于
// 带分类的文本算出来的，值变了不需要动向量。这也正是"分类一直都在，只是没落成列"的意思。
//
// # 为什么按 media_key 对齐
//
// `media_doc.media_key` 就是索引 entry 的 `videoId`（回填链路 `mediaDocRow` 直接用 videoId 当主键的一部分），
// 所以这里不需要猜产品名、也不需要模糊匹配：对不上就是那行不在索引里，如实计数。
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { indexEntries } from '../packages/orangefilm/src/material-clean.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_FILE = path.join(ROOT, 'infra', 'docker-compose.yml');
const LOCAL_DB = 'orange';

export function defaultOptions() {
  return {
    tenant: 'tenant-a',
    analyzerVer: 'card-meta-2',
    batch: 400,
    /* 云端：给了就走 docker run postgres:17 psql <url>，不给仍是本机 compose。 */
    dbUrl: '',
    dryRun: false,
    indexFile: path.join(homedir(), '.openfilm-dev', 'material-index', 'index.json'),
  };
}

export function parseArgs(argv) {
  const options = defaultOptions();
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    const eq = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const flag = eq === -1 ? raw : raw.slice(0, eq);
    const value = () => (eq !== -1 ? raw.slice(eq + 1) : argv[++i] ?? '');
    switch (flag) {
      case '--tenant': options.tenant = value(); break;
      case '--analyzer-ver': options.analyzerVer = value(); break;
      case '--batch': options.batch = Number(value()); break;
      case '--index': options.indexFile = value(); break;
      case '--db-url': options.dbUrl = value(); break;
      case '--dry-run': options.dryRun = true; break;
      case '--help':
      case '-h':
        console.log('usage: node scripts/media-doc-levels.mjs [--tenant KEY] [--analyzer-ver VER] [--batch 400] '
          + '[--index PATH] [--db-url URL] [--dry-run]');
        return null;
      default:
        if (flag.startsWith('--')) throw new Error(`未知参数 ${flag}`);
    }
  }
  if (!Number.isInteger(options.batch) || options.batch < 1) throw new Error('--batch 必须是正整数');
  return options;
}

const text = (value) => (value == null ? '' : String(value).trim());

/**
 * 索引 entry 数组 → `videoId → { oneLevel, twoLevel }`。
 * 只收**至少有一个非空**的条目：全是空的行写进去等于把列从 NULL 改成空串，没有意义。
 */
export function levelMap(entries) {
  const map = new Map();
  for (const entry of entries) {
    const id = text(entry?.videoId);
    if (!id) continue;
    const oneLevel = text(entry?.oneLevel ?? entry?.oneLevelVideoType);
    const twoLevel = text(entry?.twoLevel ?? entry?.twoLevelVideoType);
    if (!oneLevel && !twoLevel) continue;
    map.set(id, { oneLevel: oneLevel || null, twoLevel: twoLevel || null });
  }
  return map;
}

const sqlLiteral = (value) => (value === null ? 'NULL' : `'${String(value).replace(/'/g, "''")}'`);

/** 一批 `(media_key, one_level, two_level)` → 一条 `update … from (values …)`。 */
export function batchSql(tenant, analyzerVer, pairs) {
  const values = pairs
    .map(([key, level]) => `(${sqlLiteral(key)}, ${sqlLiteral(level.oneLevel)}, ${sqlLiteral(level.twoLevel)})`)
    .join(',\n    ');
  return [
    `set app.company_key = ${sqlLiteral(tenant)};`,
    'update public.media_doc d',
    '   set one_level = v.one_level, two_level = v.two_level',
    '  from (values',
    `    ${values}`,
    '  ) as v(media_key, one_level, two_level)',
    ` where d.analyzer_ver = ${sqlLiteral(analyzerVer)}`,
    '   and d.superseded_at is null',
    '   and d.media_key = v.media_key',
    '   and (d.one_level is distinct from v.one_level or d.two_level is distinct from v.two_level);',
    '',
  ].join('\n');
}

function sh(command, args, { input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(command, args, { cwd: ROOT, windowsHide: true, maxBuffer: 256 * 1024 * 1024, timeout: 10 * 60 * 1000 },
      (error, stdout, stderr) => resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      }));
    if (input !== undefined) {
      child.stdin?.on('error', () => {});
      child.stdin?.end(input);
    }
  });
}

function psql(script, dbUrl = '') {
  if (String(dbUrl).trim()) {
    /* 云端：客户端在容器里（本机没有 psql），与 material-doc-index / media-doc-sync 同一条路子。 */
    return sh('docker', ['run', '--rm', '-i', 'postgres:17', 'psql', String(dbUrl).trim(),
      '-At', '-v', 'ON_ERROR_STOP=1'], { input: script });
  }
  return sh('docker', ['compose', '-f', COMPOSE_FILE, 'exec', '-T', 'db',
    /* 不要 -q：`UPDATE n` 这个命令标签是本脚本唯一的上报口径，静默掉它只会得到"更新 0 行"的假象。 */
    'psql', '-U', 'postgres', '-d', LOCAL_DB, '-At', '-v', 'ON_ERROR_STOP=1'], { input: script });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return 0;
  if (!existsSync(options.indexFile)) {
    console.error(`索引不存在：${options.indexFile}`);
    return 1;
  }

  const entries = indexEntries(JSON.parse(readFileSync(options.indexFile, 'utf8')));
  const levels = levelMap(entries);
  const ones = [...levels.values()].filter((level) => level.oneLevel).length;
  const twos = [...levels.values()].filter((level) => level.twoLevel).length;
  console.log(`索引 ${entries.length} 条 → 可回填 ${levels.size} 条（一级 ${ones}，二级 ${twos}）`);

  if (options.dryRun) {
    const sample = [...levels.entries()].slice(0, 5)
      .map(([key, level]) => `${key} → ${level.oneLevel ?? '-'} / ${level.twoLevel ?? '-'}`);
    for (const line of sample) console.log(`  ${line}`);
    return 0;
  }

  const pairs = [...levels.entries()];
  let updated = 0;
  let batches = 0;
  const startedAt = Date.now();
  for (let offset = 0; offset < pairs.length; offset += options.batch) {
    const slice = pairs.slice(offset, offset + options.batch);
    const result = await psql(batchSql(options.tenant, options.analyzerVer, slice), options.dbUrl);
    if (result.code !== 0) {
      console.error(`第 ${batches + 1} 批失败：${String(result.stderr).split(/\r?\n/).filter(Boolean)[0] ?? result.code}`);
      return 1;
    }
    const count = Number(String(result.stdout).trim().match(/UPDATE (\d+)/)?.[1] ?? 0);
    updated += count;
    batches += 1;
    if (batches % 20 === 0) {
      const rate = updated / Math.max(0.001, (Date.now() - startedAt) / 1000);
      console.log(`[${batches}] 扫描 ${offset + slice.length}/${pairs.length}，更新 ${updated}，${rate.toFixed(0)} 行/秒`);
    }
  }
  console.log(`\n完成：${batches} 批，实际更新 ${updated} 行（其余是值本来就对的），`
    + `耗时 ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);
  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exit(1);
  });
}
