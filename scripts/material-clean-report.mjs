#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// 素材清洗报表：把 `~/.openfilm-dev/material-index/index.json` 全量过一遍 `material-clean.mjs`，
// 打印上云前要看的每一个数字（A 清单、C 前后对照），并给出 10 组「前 → 后」真实样本。
//
//   node scripts/material-clean-report.mjs                 # 全量，含库侧只读对照
//   node scripts/material-clean-report.mjs --no-db         # 不连库（只读索引 + 缓存）
//   node scripts/material-clean-report.mjs --no-cache      # 不读供应商页缓存（videoType 一律"未采集"）
//   node scripts/material-clean-report.mjs --index PATH    # 换一份索引
//
// 只读：索引文件是读的，`media_doc` 只跑 4 条 `select`，供应商页缓存只解析 JSON。**不写库、不动 media_doc、
// 不算向量**——这份报表的用途是"让 Lead 决定上云灌多少条、要不要重算向量"，不是执行灌库。
//
// # 三个数据源，各自负责一段
//
//  1. `index.json` —— 权威行集（78 874 条 entry）与 md5 / labels / duration / author / 分类。`A` 里的绝大多数
//     数字来自它，`C` 是把它全量喂给 `summarizeClean`。
//  2. 供应商页缓存 `~/.openfilm-dev/material-cache/materials/meta/*.json` —— **只有它带 `videoType`**
//     （索引的 entry 不存这个字段，构建外壳的 `pages.perType` 在缓存回放模式下是空的）。索引就是这批缓存回放的，
//     所以按 videoId 对上是同一批素材、不是第二个来源。没对上的行如实报"未采集"，不猜。
//  3. 本机库 `media_doc`（`docker compose exec db psql`，与 `scripts/material-doc-index.mjs` 同一条通道）——
//     只做**库侧对照**：未取代行数、distinct text、`analyzer_ver` 分布。连不上就整段标"未采集"，不影响 A/C。
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyEntry,
  cleanEntry,
  contentCounts,
  indexEntries,
  NAME_REPAIR_ISSUES,
  nameTextKey,
  splitIdentity,
  summarizeClean,
  trailingNameRule,
} from '../packages/openfilm/src/material-clean.mjs';
import { classifyUnparsedName } from '../packages/openfilm/src/material-index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_FILE = path.join(ROOT, 'infra', 'docker-compose.yml');
const HOME_DIR = path.join(homedir(), '.openfilm-dev');
const DEFAULT_INDEX = path.join(HOME_DIR, 'material-index', 'index.json');
const DEFAULT_CACHE = path.join(HOME_DIR, 'material-cache', 'materials', 'meta');

/** 一个数字，带千分位（报表要贴进 md，三目可读）。 */
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US') : String(value));
const pct = (part, whole) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : '—');
const pad = (text, width) => String(text).padEnd(width, ' ');

/* ── 参数 ──────────────────────────────────────────────────────────────────────────────────────────────────── */

export function parseArgs(argv) {
  const options = {
    indexFile: DEFAULT_INDEX,
    cacheDir: DEFAULT_CACHE,
    tenant: 'tenant-a',
    useDb: true,
    useCache: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    const eq = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const flag = eq === -1 ? raw : raw.slice(0, eq);
    const value = () => (eq !== -1 ? raw.slice(eq + 1) : argv[++i] ?? '');
    switch (flag) {
      case '--index': options.indexFile = value(); break;
      case '--cache': options.cacheDir = value(); break;
      case '--tenant': options.tenant = value(); break;
      case '--no-db': options.useDb = false; break;
      case '--no-cache': options.useCache = false; break;
      case '--help':
      case '-h':
        console.log('usage: node scripts/material-clean-report.mjs [--index PATH] [--cache DIR] [--tenant KEY] '
          + '[--no-db] [--no-cache]');
        return null;
      default:
        if (flag.startsWith('--')) throw new Error(`未知参数 ${flag}（--help 看用法）`);
    }
  }
  return options;
}

/* ── 源 2：供应商页缓存里的 videoType ─────────────────────────────────────────────────────────────────────────── */

/** 线上一层的标量：`{sourceType:'number', source:'0'}` → `0`。 */
const scalar = (value) => (value && typeof value === 'object' ? value.source ?? value.value : value);

/**
 * 从缓存页里读出 `videoId → videoType`。缓存是**索引回放的同一批行**（`provenance.mode` =
 * `studio-provider-cache-replay`），所以这不是第二个数据源，而是索引里没落库的那个字段的原始出处。
 * 读不到就返回空 Map，调用方据此报"未采集"。
 * @param {string} dir
 * @returns {{ types: Map<string, number>, pages: number, rows: number, error: string }}
 */
export function readCachedVideoTypes(dir) {
  const types = new Map();
  if (!existsSync(dir)) return { types, pages: 0, rows: 0, error: `缓存目录不存在：${dir}` };
  let pages = 0;
  let rows = 0;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    let page;
    try {
      page = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      continue;
    }
    const items = page?.body?.items;
    if (!Array.isArray(items) || !items.length) continue;
    pages += 1;
    for (const item of items) {
      const observation = item?.observation;
      if (!observation) continue;
      rows += 1;
      const videoId = String(scalar(observation.videoId) ?? scalar(item.videoId) ?? '').trim();
      const type = Number(scalar(observation.videoType));
      if (videoId && Number.isInteger(type)) types.set(videoId, type);
    }
  }
  return { types, pages, rows, error: '' };
}

/* ── 源 3：本机库（只读） ───────────────────────────────────────────────────────────────────────────────────── */

function sh(command, args, { input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(command, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 120000 },
      (error, stdout, stderr) => resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      }));
    if (input !== undefined) child.stdin?.end(input);
  });
}

/**
 * `media_doc` 只读对照。4 条 select，每条都带 `set app.company_key`（010 的租户 GUC，RLS 是 FORCE 的，
 * 没有它连读都 42501）。返回 `{ ok:false, error }` 而不是抛——报表不能因为库没起来就交白卷。
 */
export async function readLocalDocStats(tenant) {
  const script = [
    `set app.company_key = '${String(tenant).replace(/'/g, "''")}';`,
    "select 'total|' || count(*) || '|' || count(*) filter (where superseded_at is null) "
      + '|| \'|\' || count(distinct text) filter (where superseded_at is null) from public.media_doc;',
    "select 'ver|' || analyzer_ver || '|' || count(*) || '|' || count(*) filter (where superseded_at is null) "
      + 'from public.media_doc group by analyzer_ver order by analyzer_ver;',
    "select 'empty|' || count(*) filter (where batch is null or batch = '') || '|' "
      + '|| count(*) filter (where gname is null or gname = \'\') '
      + '|| \'|\' || count(*) filter (where duration_ms is null) from public.media_doc where superseded_at is null;',
    '',
  ].join('\n');
  const result = await sh('docker', ['compose', '-f', COMPOSE_FILE, 'exec', '-T', 'db',
    'psql', '-U', 'postgres', '-d', 'orange', '-qAt', '-v', 'ON_ERROR_STOP=1'], { input: script });
  if (result.code !== 0) {
    const line = String(result.stderr ?? '').split(/\r?\n/).map((text) => text.trim()).filter(Boolean)[0] ?? '';
    return { ok: false, error: line.replace(/^docker\s*:\s*/i, '').slice(0, 200) || `exit ${result.code}` };
  }
  const out = { ok: true, total: null, live: null, distinctText: null, versions: [], emptyBatch: null, emptyGroup: null, emptyDuration: null };
  for (const line of String(result.stdout ?? '').split(/\r?\n/)) {
    const parts = line.trim().split('|');
    if (parts[0] === 'total') {
      out.total = Number(parts[1]);
      out.live = Number(parts[2]);
      out.distinctText = Number(parts[3]);
    } else if (parts[0] === 'ver') {
      out.versions.push({ ver: parts[1], rows: Number(parts[2]), live: Number(parts[3]) });
    } else if (parts[0] === 'empty') {
      out.emptyBatch = Number(parts[1]);
      out.emptyGroup = Number(parts[2]);
      out.emptyDuration = Number(parts[3]);
    }
  }
  return out;
}

/* ── A：清单里的名称形态分布 ───────────────────────────────────────────────────────────────────────────────── */

/** 严格批次形状：`20261109-油弃乌龙茶-外包装 (24)`。 */
const BATCH_SHAPE = /^(\d{8})-(.+?)-([^-/]+?)\s*\((\d+)\)$/;

/**
 * 名称形态，**一条行只落一个桶**，按下面的优先级取第一个成立的。桶的定义写在报表里，所以这个函数就是口径本身：
 *  1. `empty` —— 空名；
 *  2. `batch` —— 严格批次形状（`parseMaterialName` 认的）；
 *  3. `date` —— 名字开头是日期/数字（`classifyUnparsedName` 的 derived batch：`12.13_…`、`12月18日 …`）；
 *  4. `number` —— 整个名字就是一串数字；
 *  5. `trailing-name` —— 末尾挂着一个孤立姓名段（`trailingNameRule` 说该剥的）；
 *  6. `separator` —— 分隔符异常：连续空白、首尾分隔符、两个以上同类分隔符连写、或 `- _ / + 、` 里混用 ≥2 种；
 *  7. `plain` —— 其余（有产品/分组词但没有日期、没有异常的普通名字）。
 * @param {any} entry
 */
export function nameShapeOf(entry) {
  const name = typeof entry?.name === 'string' ? entry.name : '';
  if (!name.trim()) return 'empty';
  if (BATCH_SHAPE.test(name.trim())) return 'batch';
  const derived = classifyUnparsedName(name);
  if (derived.kind === 'batch') return 'date';
  if (/^\d+$/.test(name.trim())) return 'number';
  if (trailingNameRule(name, entry?.author).strip) return 'trailing-name';
  const half = name.replace(/[\uFF01-\uFF5E]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
  const doubles = /(\s{2,}|^[\s\-_/+、]|[\s\-_/+、]$|[-_/、]{2,})/.test(half);
  const kinds = ['-', '_', '/', '+', '、'].filter((mark) => half.includes(mark)).length;
  if (doubles || kinds >= 2) return 'separator';
  return 'plain';
}

/** A 段全部数字。纯计算，输入是 entry 数组 + 两件外部事实（videoType、库侧行数）。 */
export function inventory(entries, { types = new Map(), shapeLabel = '未采集' } = {}) {
  const counts = contentCounts(entries);
  const md5 = new Map();
  const names = new Map();
  const shapes = new Map();
  const typesSeen = new Map();
  let md5Empty = 0;
  let typeKnown = 0;
  const meta = { labels: 0, durationMs: 0, author: 0, coverUrl: 0, oneLevel: 0, twoLevel: 0 };
  for (const entry of entries) {
    const identity = splitIdentity(entry);
    if (identity.md5) md5.set(identity.md5, (md5.get(identity.md5) ?? 0) + 1);
    else md5Empty += 1;
    const key = nameTextKey(entry?.name);
    if (key) names.set(key, (names.get(key) ?? 0) + 1);
    const shape = nameShapeOf(entry);
    shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
    const type = types.get(identity.videoId);
    if (type !== undefined) {
      typeKnown += 1;
      typesSeen.set(type, (typesSeen.get(type) ?? 0) + 1);
    }
    if (Array.isArray(entry?.labels) && entry.labels.length) meta.labels += 1;
    if (typeof entry?.durationMs === 'number' && entry.durationMs > 0) meta.durationMs += 1;
    if (String(entry?.author ?? '').trim()) meta.author += 1;
    if (String(entry?.coverUrl ?? '').trim()) meta.coverUrl += 1;
    if (String(entry?.oneLevel ?? '').trim()) meta.oneLevel += 1;
    if (String(entry?.twoLevel ?? '').trim()) meta.twoLevel += 1;
  }
  const dupMd5Groups = [...md5.entries()].filter(([, count]) => count > 1);
  const dupNameGroups = [...names.entries()].filter(([, count]) => count > 1);
  return {
    total: entries.length,
    md5Empty,
    md5Filled: entries.length - md5Empty,
    dupMd5Groups: dupMd5Groups.length,
    dupMd5Rows: dupMd5Groups.reduce((sum, [, count]) => sum + count, 0),
    dupNameGroups: dupNameGroups.length,
    dupNameRows: dupNameGroups.reduce((sum, [, count]) => sum + count, 0),
    distinctNames: names.size,
    shapes,
    typeKnown,
    typesSeen,
    shapeLabel,
    contentDupGroups: [...counts.values()].filter((count) => count > 1).length,
    contentDupRows: [...counts.values()].filter((count) => count > 1).reduce((sum, count) => sum + count, 0),
    meta,
  };
}

/* ── C：10 组「前 → 后」样本（顺序固定，可复现） ──────────────────────────────────────────────────────────────── */

/**
 * 10 个按类型点名的样本：每种脏形态各取**索引顺序里的第一条**。顺序与选择条件都写死，所以同一份索引给出的
 * 永远是同样这 10 行——报告里的对照表可以被人拿索引复核。
 * @param {any[]} entries
 */
export function pickSamples(entries) {
  const counts = contentCounts(entries);
  /* 同文计数先算一次：finder 里每行都去 filter 一遍就是 O(n²)（78 874²），这里用一次 Map 顶掉。 */
  const nameCount = new Map();
  for (const entry of entries) {
    const key = nameTextKey(entry?.name);
    if (key) nameCount.set(key, (nameCount.get(key) ?? 0) + 1);
  }
  const md5Count = new Map();
  for (const entry of entries) {
    const digest = splitIdentity(entry).md5;
    if (digest) md5Count.set(digest, (md5Count.get(digest) ?? 0) + 1);
  }
  const cleanOf = (entry) => cleanEntry(entry, counts);
  const seen = new Set();
  const picked = [];
  const take = (label, find) => {
    for (let i = 0; i < entries.length; i += 1) {
      if (seen.has(i)) continue;
      if (!find(entries[i], i)) continue;
      seen.add(i);
      picked.push({ label, before: entries[i], after: cleanOf(entries[i]) });
      return true;
    }
    return false;
  };

  take('空 md5 + 批次形状 + 尾部序号', (entry) => !splitIdentity(entry).md5 && BATCH_SHAPE.test(String(entry?.name ?? '').trim()));
  take('同 md5（同一份字节两行）', (entry) => {
    const digest = splitIdentity(entry).md5;
    return Boolean(digest) && (md5Count.get(digest) ?? 0) > 1;
  });
  take('全角括号 + 双空格 + 人名列尾', (entry) => /[\uFF01-\uFF5E]/.test(String(entry?.name ?? '')) && /\s{2,}/.test(String(entry?.name ?? '')));
  take('括号只有左半', (entry) => {
    const half = String(entry?.name ?? '').replace(/[\uFF01-\uFF5E]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
    return (half.match(/\(/g) ?? []).length > (half.match(/\)/g) ?? []).length;
  });
  take('无批次形状 + 尾部 _n', (entry) => /_\d{1,4}$/.test(String(entry?.name ?? '').trim()) && !BATCH_SHAPE.test(String(entry?.name ?? '').trim()));
  take('日期形状 + 人名列尾', (entry) => trailingNameRule(String(entry?.name ?? ''), entry?.author).strip);
  take('纯数字名', (entry) => /^\d+$/.test(String(entry?.name ?? '').trim()));
  take('只有名字（无卡片字段）', (entry) => classifyEntry(entry).evidence === 'name-only');
  take('同一名字多行（同文）', (entry) => (nameCount.get(nameTextKey(entry?.name)) ?? 0) > 3);
  take('采集原名（`IMG_…`，`_n` 不许剥）', (entry) => /^(IMG|VID|WechatIMG|mmexport)/i.test(String(entry?.name ?? '').trim()));
  return picked;
}

/* ── 报表 ──────────────────────────────────────────────────────────────────────────────────────────────────── */

const quote = (value) => String(value ?? '').replace(/\|/g, '\\|').trim();

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return 0;
  if (!existsSync(options.indexFile)) {
    console.error(`索引不存在：${options.indexFile}`);
    return 2;
  }
  const document = JSON.parse(readFileSync(options.indexFile, 'utf8'));
  const entries = indexEntries(document);
  if (!entries.length) {
    console.error(`索引里没有 entry：${options.indexFile}（先跑 material-index-build.mjs）`);
    return 2;
  }

  const cache = options.useCache ? readCachedVideoTypes(options.cacheDir) : { types: new Map(), pages: 0, rows: 0, error: '--no-cache' };
  const db = options.useDb ? await readLocalDocStats(options.tenant) : { ok: false, error: '--no-db' };
  const inv = inventory(entries, { types: cache.types });
  const summary = summarizeClean(entries);
  const samples = pickSamples(entries);

  /* 同文：只折叠空白/全角、去尾部 ` (n)`——用户给的口径（62 373 / 78 874）就是这个，用来对齐。 */
  const nameKeys = new Map();
  for (const entry of entries) {
    const key = nameTextKey(entry?.name);
    if (key) nameKeys.set(key, (nameKeys.get(key) ?? 0) + 1);
  }

  console.log('══ 素材清洗报表 ═════════════════════════════════════════════════════════════════════════════════');
  console.log(`索引 ${options.indexFile}`);
  console.log(`  schema ${document.schema ?? '—'}，generatedAt ${document.generatedAt ?? document.index?.generatedAt ?? '—'}`
    + `${document.provenance?.mode ? `，provenance ${document.provenance.mode}` : ''}`);
  if (document.warnings?.length) for (const warning of document.warnings) console.log(`  ! ${warning.code}: ${warning.message}`);

  console.log('\n── A. 清单 ─────────────────────────────────────────────────────────────────────────────────────');
  console.log(`总数（entry 行）                ${num(inv.total)}`
    + `${document.index?.totals ? `（索引自报 parsed ${num(document.index.totals.parsed)} + unclassified ${num(document.index.totals.unclassified)}）` : ''}`);
  console.log(`按 videoType 0–4                ${[...inv.typesSeen.entries()].sort((a, b) => a[0] - b[0])
    .map(([type, count]) => `${type}: ${num(count)}`).join('  /  ') || '未采集'}`);
  console.log(`  videoType 已采集              ${num(inv.typeKnown)}（${pct(inv.typeKnown, inv.total)}）；未采集 ${num(inv.total - inv.typeKnown)}`
    + '——索引 entry 不存 videoType，值按 videoId 取自索引回放的那批供应商页缓存');
  if (!cache.types.size) console.log(`  videoType 缓存               未采集（${cache.error}）`);
  else console.log(`  videoType 缓存               ${num(cache.pages)} 页 / ${num(cache.rows)} 行 → ${num(cache.types.size)} 个 videoId`);
  console.log(`md5 空 / 非空                  ${num(inv.md5Empty)} / ${num(inv.md5Filled)}（非空 ${pct(inv.md5Filled, inv.total)}）`);
  console.log(`md5 重复                       ${num(inv.dupMd5Groups)} 组，涉及 ${num(inv.dupMd5Rows)} 行（多出 ${num(inv.dupMd5Rows - inv.dupMd5Groups)} 行）`);
  console.log(`同名不同 id                    ${num(inv.dupNameGroups)} 个名字对应 ${num(inv.dupNameRows)} 行（多出 ${num(inv.dupNameRows - inv.dupNameGroups)} 行），distinct 名 ${num(inv.distinctNames)}`);
  console.log(`  contentKey 重复              ${num(inv.contentDupGroups)} 组，涉及 ${num(inv.contentDupRows)} 行（md5 优先，空 md5 退回 videoId）`);
  console.log('名称形态（一行一桶，优先级 fixed）');
  for (const shape of ['batch', 'date', 'number', 'trailing-name', 'separator', 'plain', 'empty']) {
    const count = inv.shapes.get(shape) ?? 0;
    console.log(`  ${pad(shape, 14)}${num(count).padStart(8)}  ${pct(count, inv.total)}`);
  }
  console.log('字段非空率');
  for (const [field, count] of Object.entries(inv.meta)) {
    console.log(`  ${pad(field, 14)}${num(count).padStart(8)}  ${pct(count, inv.total)}`);
  }
  console.log(`库侧 media_doc                ${db.ok
    ? `总 ${num(db.total)}，未取代 ${num(db.live)}，distinct text ${num(db.distinctText)}`
      + `；版本 ${db.versions.map((v) => `${v.ver} ${num(v.live)}`).join(' / ')}`
      + `；batch 空 ${num(db.emptyBatch)}、gname 空 ${num(db.emptyGroup)}、duration_ms 空 ${num(db.emptyDuration)}`
      + `（查询时刻 ${new Date().toISOString().slice(11, 19)}Z，库可能正在被别的进程回填——索引侧数字才是准的）`
    : `未采集（${db.error}）`}`);

  console.log('\n── C. 前后对照（全量） ───────────────────────────────────────────────────────────────────────');
  console.log(`保留（kind=material）           ${num(summary.kept)}`);
  console.log(`丢弃（kind≠material）           ${num(summary.dropped)}：`
    + `text ${num(summary.byKind.text)} / subtitle ${num(summary.byKind.subtitle)} / unknown ${num(summary.byKind.unknown)}`);
  console.log(`修复（名字/标签真的被改）        ${num(summary.repaired)}（只带诊断、一个字没改 ${num(summary.total - summary.repaired)}）`);
  console.log(`去重（同 contentKey 多行）       ${num(summary.dupGroups)} 组 / ${num(summary.dupRows)} 行`
    + ` → material 内去重掉 ${num(summary.dupRemoved)} 行`);
  console.log(`去重后可用于检索                ${num(summary.retrievable)}`);
  console.log(`有 md5（可去重/可本机命中）      ${num(summary.withMd5)}（${pct(summary.withMd5, summary.total)}）`);
  console.log(`元数据五级全齐                  ${num(summary.completeMeta)}（${pct(summary.completeMeta, summary.total)}）`
    + `；缺 ${num(summary.missingMeta)}（${pct(summary.missingMeta, summary.total)}）`);
  console.log(`同文（折叠空白+去尾部序号）      distinct ${num(nameKeys.size)} / ${num(summary.total)}`
    + `，重复 ${num(summary.total - nameKeys.size)} 行`);
  console.log(`文件名证据（kind 的判据）        ${summary.byEvidence.map(([kind, count]) => `${kind}:${num(count)}`).join('  ')}`);
  console.log('issue 分布（前 12）');
  for (const [issue, count] of summary.byIssue.slice(0, 12)) {
    const tag = NAME_REPAIR_ISSUES.includes(issue) ? '修复' : '诊断';
    console.log(`  ${pad(issue, 20)}${num(count).padStart(8)}  ${tag}`);
  }
  console.log(`修复口径                        ${NAME_REPAIR_ISSUES.join(', ')}`);

  console.log('\n── D. 判断 ─────────────────────────────────────────────────────────────────────────────────────');
  const retrievableMd5 = summary.rows.filter((row) => row.kind === 'material' && row.md5).length;
  const retrievableComplete = summary.rows.filter((row) => row.kind === 'material' && row.labels.length
    && row.durationMs && row.author && row.oneLevel && row.twoLevel).length;
  console.log(`可检索 ${num(summary.retrievable)} 条；其中 md5 非空 ${num(retrievableMd5)}（${pct(retrievableMd5, summary.retrievable)}）`);
  console.log(`其中元数据五级齐全 ${num(retrievableComplete)}（${pct(retrievableComplete, summary.retrievable)}），`
    + `缺 ${num(summary.retrievable - retrievableComplete)}（${pct(summary.retrievable - retrievableComplete, summary.retrievable)}）`);

  console.log('\n── 采样：前 → 后（直接贴进报告的 markdown 表格） ─────────────────────────────────────────────');
  console.log('| # | 形态 | 前（索引原文） | 后（规范行） | issues |');
  console.log('| - | - | - | - | - |');
  samples.forEach((sample, index) => {
    const before = sample.before ?? {};
    const after = sample.after;
    const beforeText = `${quote(before.name)}｜md5=${before.md5 ? `${String(before.md5).slice(0, 8)}…` : '空'}`;
    const afterText = `${quote(after.name)}｜${after.kind}｜batch=${after.batch || '-'}｜group=${after.group || '-'}｜contentKey=${after.contentKey}`;
    console.log(`| ${index + 1} | ${sample.label} | ${beforeText} | ${afterText} | ${after.issues.join(' ') || '—'} |`);
  });
  console.log('\n（样本按固定规则各取索引顺序第一条：空 md5 批次形状 / 同 md5 / 全角+双空格 / 缺右括号 / 无形状+_n /'
    + ' 日期+人名 / 纯数字 / 只有名字 / 同文 / 采集原名）');
  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exit(1);
  });
}
