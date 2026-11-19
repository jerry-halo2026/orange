#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// 语料质量计划：从上云/回填的语料里挑出**不该进**的行，写成一份可复核的清单。
//
//   node scripts/material-quality-plan.mjs                      # 读本机库，写 .dev/material-clean/quality-plan.json
//   node scripts/material-quality-plan.mjs --tenant tenant-a    # 换租户
//   node scripts/material-quality-plan.mjs --canonical card-meta-2 --stale card-meta-1
//   node scripts/material-quality-plan.mjs --index PATH --out PATH
//
// 只读：三条 select，一条写库都没有。产出的 `quarantined[]` 给 `material-doc-index.mjs --exclude-file` 用，
// 也给上云时"哪些行不上"用——两个地方必须是同一份清单，不能各写一套过滤条件。
//
// # 三个口径，为什么是这三个
//
//  1. **quarantined = 只在旧版本里存在的 media_key**（`--stale` 有、`--canonical` 没有）。
//     这一批是清洗前那版语料里的"只有名字"的行（78 484 / 78 874 条只有名字），删不得也进不了检索：
//     没有一级/二级分类、没有标签、没有时长、没有作者、没有封面——检索命中它们等于命中一个文件名。
//     判据用**库里的既成事实**（哪个版本收了它）而不是重新跑一遍分类：分类会随规则漂移，入库结果不会。
//     它们留着、不删、向量也留着，只是 `superseded`（迁移 012 的取代语义），随时能捞回来。
//  2. **duplicateTexts = 规范版本里 text 完全相同的行**（`md5(text)` 相同的组）。
//     同一段文本给两个向量，等于同一个问题两个答案：排序会随批次抖动。所以向量只算一次、多行共用
//     （`material-doc-index.mjs` 的 vectorMemo），检索侧按 `keep` 去重。
//  3. **totals.searchable = 规范版本行数**。这是"上云灌多少条"的那个数，不是 151 030（那是三个版本叠着的物理行数）。
//
// # 为什么保留而不是删
//
//   这批行的元数据是可以**定向补抓**回来的（智尚只读接口，按 videoId 回填 videoType/时长/分类）；
//   补回来之后它们就不是 unknown 了，届时把 superseded_at 清空即可复活。删了就再也对不上号。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_FILE = path.join(ROOT, 'infra', 'docker-compose.yml');
const LOCAL_DB = 'orange';
export const PLAN_SCHEMA = 'orange/material-quality-plan/1';

export function defaultOptions() {
  return {
    tenant: 'tenant-a',
    /* 规范版本：清洗后那一版（67 156 行，只有 12 行没有卡片字段）。 */
    canonical: 'card-meta-2',
    /* 旧版本：清洗前那一版（78 874 行，其中 78 484 行只有名字）。 */
    stale: 'card-meta-1',
    out: path.join(ROOT, '.dev', 'material-clean', 'quality-plan.json'),
    indexFile: null,
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
      case '--canonical': options.canonical = value(); break;
      case '--stale': options.stale = value(); break;
      case '--out': options.out = value(); break;
      case '--index': options.indexFile = value(); break;
      case '--help':
      case '-h':
        console.log('usage: node scripts/material-quality-plan.mjs [--tenant KEY] [--canonical VER] [--stale VER] '
          + '[--out PATH] [--index PATH]');
        return null;
      default:
        if (flag.startsWith('--')) throw new Error(`未知参数 ${flag}（--help 看用法）`);
    }
  }
  return options;
}

const sqlLiteral = (value) => `'${String(value).replace(/'/g, "''")}'`;

function sh(command, args, { input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(command, args, { cwd: ROOT, windowsHide: true, maxBuffer: 256 * 1024 * 1024, timeout: 120000 },
      (error, stdout, stderr) => resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      }));
    if (input !== undefined) child.stdin?.end(input);
  });
}

/**
 * 三条 select 一趟会话（`set app.company_key` 是 010 的租户 GUC，RLS 是 FORCE 的，没有它连读都 42501）。
 * 返回原始行，解析在 `readPlanRows` 里做——SQL 只负责取数，口径写在 JS 里才可测。
 * @param {(script: string) => Promise<{ code: number, stdout: string, stderr: string }>} psql
 * @param {{ tenant: string, canonical: string, stale: string }} options
 */
export async function readRows(psql, options) {
  const script = [
    `set app.company_key = ${sqlLiteral(options.tenant)};`,
    /* 1. 隔离集：旧版本收过、规范版本没有的 media_key。
       **旧版本这一侧故意不看 `superseded_at`**：这些行一旦被取代（本脚本 `--sql` 打印的那条 update），
       从"当前存活行"里就查不到了，而清单必须是稳定的——它与"清单里有什么"无关，只与"当初哪个版本收了它"有关。 */
    'select \'q|\' || media_key from ('
      + `select media_key from public.media_doc where analyzer_ver = ${sqlLiteral(options.stale)} except `
      + `select media_key from public.media_doc where analyzer_ver = ${sqlLiteral(options.canonical)} `
      + 'and superseded_at is null) s order by 1;',
    /* 2. 计数：规范版本行数、distinct text、旧版本行数、规范版本存活行数。 */
    "select 'c|' || count(*) || '|' || count(distinct text) "
      + `|| '|' || (select count(*) from public.media_doc where analyzer_ver = ${sqlLiteral(options.stale)}) `
      + '|| \'|\' || count(*) filter (where superseded_at is null) '
      + `from public.media_doc where analyzer_ver = ${sqlLiteral(options.canonical)};`,
    /* 3. 同文组：md5(text) 相同的一组，留 media_key 字典序最小的那行（确定性，两次跑同一个答案）。 */
    "select 'd|' || md5(text) || '|' || count(*) || '|' || min(media_key) || '|' "
      + '|| string_agg(media_key, \',\' order by media_key) '
      + `from public.media_doc where analyzer_ver = ${sqlLiteral(options.canonical)} and superseded_at is null `
      + 'group by text having count(*) > 1 order by count(*) desc, 1;',
    '',
  ].join('\n');
  const result = await psql(script);
  if (result.code !== 0) {
    throw new Error(`读取语料质量数据失败：${String(result.stderr ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0]
      || `exit ${result.code}`}`);
  }
  return String(result.stdout ?? '').split(/\r?\n/).filter(Boolean);
}

/**
 * psql 的 `-qAt` 输出 → 计划对象。**解析与判定都在这儿**，所以测试不需要连库。
 * @param {string[]} lines
 * @param {{ canonical: string, stale: string, tenant: string }} options
 */
export function buildPlan(lines, options) {
  const quarantined = [];
  const duplicateTexts = [];
  let canonicalRows = 0;
  let distinctText = 0;
  let staleRows = 0;
  let liveRows = 0;

  for (const line of lines) {
    const parts = line.split('|');
    if (parts[0] === 'q') {
      const key = parts.slice(1).join('|').trim();
      if (key) quarantined.push(key);
    } else if (parts[0] === 'c') {
      canonicalRows = Number(parts[1] ?? 0);
      distinctText = Number(parts[2] ?? 0);
      staleRows = Number(parts[3] ?? 0);
      liveRows = Number(parts[4] ?? 0);
    } else if (parts[0] === 'd') {
      const keys = String(parts[4] ?? '').split(',').map((key) => key.trim()).filter(Boolean);
      duplicateTexts.push({
        digest: parts[1],
        rows: Number(parts[2] ?? 0),
        keep: parts[3],
        drop: keys.filter((key) => key !== parts[3]),
      });
    }
  }

  return {
    schema: PLAN_SCHEMA,
    generatedAt: new Date().toISOString(),
    tenant: options.tenant,
    canonical: options.canonical,
    stale: options.stale,
    totals: {
      canonicalRows,
      distinctText,
      duplicateTextRows: duplicateTexts.reduce((sum, group) => sum + group.rows, 0),
      duplicateTextGroups: duplicateTexts.length,
      staleRows,
      liveRows,
      quarantined: quarantined.length,
      searchable: canonicalRows,
    },
    quarantined,
    duplicateTexts,
  };
}

/** 清单与索引对不对得上：索引里有多少条落在隔离集里（对不上不是错，但要说出来）。 */
export function indexOverlap(indexFile, quarantined) {
  if (!indexFile) return null;
  if (!existsSync(indexFile)) return { file: indexFile, error: '索引不存在', entries: null, overlap: null };
  const document = JSON.parse(readFileSync(indexFile, 'utf8'));
  const index = document?.index && typeof document.index === 'object' ? document.index : document;
  const keys = new Set();
  for (const batch of index?.batches ?? []) {
    for (const product of batch?.products ?? []) {
      for (const group of product?.groups ?? []) {
        for (const entry of group?.entries ?? []) if (entry?.videoId) keys.add(String(entry.videoId));
        for (const id of group?.videoIds ?? []) if (id) keys.add(String(id));
      }
    }
  }
  for (const entry of index?.unclassified ?? []) if (entry?.videoId) keys.add(String(entry.videoId));
  let overlap = 0;
  for (const key of quarantined) if (keys.has(key)) overlap += 1;
  return { file: indexFile, error: '', entries: keys.size, overlap };
}

function makePsql() {
  return (script) => sh('docker', ['compose', '-f', COMPOSE_FILE, 'exec', '-T', 'db',
    'psql', '-U', 'postgres', '-d', LOCAL_DB, '-qAt', '-v', 'ON_ERROR_STOP=1'], { input: script });
}

/** 清单落盘：先写 `.tmp` 再 rename（中途被打断不会留半份 JSON）。 */
export function writePlan(file, plan) {
  mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify(plan, null, 2);
  const temp = `${file}.tmp`;
  writeFileSync(temp, body);
  const readBack = JSON.parse(readFileSync(temp, 'utf8'));
  if (readBack?.quarantined?.length !== plan.quarantined.length) {
    throw new Error(`清单写回自检失败（${readBack?.quarantined?.length} ≠ ${plan.quarantined.length}），旧清单未动`);
  }
  renameSync(temp, file);
  return body.length;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return 0;
  const lines = await readRows(makePsql(), options);
  const plan = buildPlan(lines, options);
  const overlap = indexOverlap(options.indexFile, plan.quarantined);
  if (overlap) plan.index = overlap;
  const bytes = writePlan(options.out, plan);

  console.log(`质量计划 → ${options.out}（${bytes} 字节）`);
  console.log(`  规范版本 ${options.canonical}：${plan.totals.canonicalRows} 行，distinct text ${plan.totals.distinctText}`
    + `（同文 ${plan.totals.duplicateTextGroups} 组 / ${plan.totals.duplicateTextRows} 行）`);
  console.log(`  旧版本 ${options.stale}：${plan.totals.staleRows} 行`);
  console.log(`  隔离（旧版本有、规范版本没有）：${plan.totals.quarantined} 条 —— 不嵌入、不写库、不上云、检索不返回`);
  if (overlap) {
    console.log(`  与索引对账：索引 ${overlap.entries ?? '—'} 个 videoId，其中 ${overlap.overlap ?? '—'} 个在隔离集里`
      + `${overlap.error ? `（${overlap.error}）` : ''}`);
  }
  console.log('  下一步：node scripts/material-doc-index.mjs --dims 4096 --all --exclude-file ' + options.out);
  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exit(1);
  });
}
