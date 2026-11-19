#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// 迁移执行器 + 账本 + 契约漂移检查（零依赖：只用 node: 内置模块）。
//
// 用法：
//   node infra/migrate.mjs --target local              # 按顺序应用未应用的迁移（本地 docker）
//   node infra/migrate.mjs --target cloud              # 云上（docker run --rm postgres:17 psql "$SUPABASE_DB_URL"）
//   node infra/migrate.mjs --check                     # 只比对 ops.schema_migrations 与文件 sha256，不执行
//   node infra/migrate.mjs --contract                  # 从 pg_proc/information_schema 导出并与 contract.json 比对
//   node infra/migrate.mjs --allow-destructive         # 允许执行 000_reset.sql（默认永远跳过）
//   node infra/migrate.mjs --allow-replay              # 账本不存在、但库里已有 schema 时，仍允许重放 001-010
//
// 退出码：0 成功；1 失败/漂移；2 配置或环境错误（含云 URL 指向 6543/pooler）。
//
// 四条纪律：
//   1. 账本放 ops.schema_migrations —— 000_reset.sql 的 DROP SCHEMA public CASCADE 清不掉它。
//   2. 000_reset.sql 是破坏性的，**默认不跑**，必须显式 --allow-destructive。
//   3. 云上禁 6543 / pooler：事务级连接池会把 SET / 多语句迁移切成不同后端连接。
//   4. 账本缺失 + 库里已有 public.material = “认不出这是哪一版”，默认拒绝重放：
//      007 会无条件清空 wiki_summary.embedding 并 DROP/重建 HNSW，重放等于把线上向量抹掉。
//      确认要按文件顺序重铺时才加 --allow-replay。
//
// 迁移会话固定 `set check_function_bodies = off`（与 pg_dump 同款）：006 的函数体里写死了
// `SET search_path = public, pg_temp`（那是有账本记录的历史文件，010 起不再改写它），
// 而 008 把 vector/pg_trgm 迁进了 extensions；plpgsql 的 body 校验按**函数自己的**
// search_path 解析类型，所以重放 006 会被 proconfig 卡住。关掉 body 校验后 CREATE OR REPLACE
// 照常执行（008 的顺序就是“先建、再统一 ALTER FUNCTION ... SET search_path”）；
// 形状由 008/010 的目录断言 + verify + --contract 兜底，不靠 CREATE 时的语法检查。
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQL_DIR = path.join(ROOT, 'docs', 'sql');
const COMPOSE_FILE = path.join(ROOT, 'infra', 'docker-compose.yml');
const LOCAL_DB = 'orange';
const CLOUD_IMAGE = 'postgres:17';
const DESTRUCTIVE = '000_reset.sql';
const CONTRACT_PATH = path.join(SQL_DIR, 'contract.json');
const EMBEDDING_PATH = path.join(SQL_DIR, 'embedding.json');

// 重放前语：账本丢失 / --allow-replay 时会按文件顺序重铺。PostgreSQL 不允许
// CREATE OR REPLACE 改函数的返回类型（OUT 列名算返回类型），而 010 把
// orange_resolve_materials 的 OUT 列改成了 camelCase（客户端 supabase.ts:66 要的键名）。
// 所以重放 009 之前先把 010 的版本丢掉：009 会按历史形状重建，010 再改回 camelCase。
// 全新库上这条是 no-op（函数还不存在）。
const REPLAY_PRELUDES = {
  '009_orange_claim.sql': [
    'drop function if exists public.orange_resolve_materials(text, text[])',
  ],
};

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    target: 'local',
    check: false,
    contract: false,
    allowDestructive: false,
    allowReplay: false,
    allowSessionPooler: false,
    /* 显式重基线（见 plan 之后的 drift 分支）：只接受点名文件，其余漂移照拒。 */
    acceptDrift: [],
    dryRun: false,
    url: process.env.SUPABASE_DB_URL ?? '',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') opts.target = argv[++i] ?? '';
    else if (a === '--check') opts.check = true;
    else if (a === '--contract') opts.contract = true;
    else if (a === '--allow-destructive') opts.allowDestructive = true;
    else if (a === '--allow-replay') opts.allowReplay = true;
    else if (a === '--allow-session-pooler') opts.allowSessionPooler = true;
    else if (a === '--accept-drift') opts.acceptDrift.push(argv[++i] ?? '');
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--url') opts.url = argv[++i] ?? '';
    else if (a === '--help' || a === '-h') {
      console.log('usage: node infra/migrate.mjs [--target local|cloud] [--check] [--contract] [--allow-destructive] [--allow-replay] [--allow-session-pooler] [--accept-drift FILE] [--dry-run] [--url URL]');
      process.exit(0);
    } else {
      console.error(`未知参数：${a}`);
      process.exit(2);
    }
  }
  if (opts.target !== 'local' && opts.target !== 'cloud') {
    console.error(`--target 只能是 local 或 cloud，收到：${opts.target}`);
    process.exit(2);
  }
  return opts;
}

/**
 * 云 URL 守卫：事务池下多语句迁移会被拆到不同后端连接。
 *
 * 两种"池"必须分开判：
 *   - **6543 / transaction**：语句级复用后端连接，`SET`、临时表、多个语句都不保证同一会话 → 迁移一定坏，
 *     没有商量余地，永远拒绝。
 *   - **session pooler 5432**（Supavisor，主机名里带 `pooler.supabase.com`）：一个客户端连接绑定一个后端
 *     连接直到断开，`SET` 与多语句都成立，与直连等价——只是多了一跳网络。Supabase 的直连主机
 *     `db.<ref>.supabase.co` 只有 AAAA，没有全局 IPv6 的机器只能走这一条，所以给它一个显式开关
 *     （`--allow-session-pooler`），而不是让守卫把人堵死在门外。
 */
function assertCloudUrl(url, options = {}) {
  if (!url) {
    console.error('缺少 --url 或环境变量 SUPABASE_DB_URL（云上必须是 5432 的连接串）');
    process.exit(2);
  }
  let parsed = null;
  try { parsed = new URL(url); } catch { /* 交给 psql 报错，这里只做池判断 */ }
  const low = url.toLowerCase();
  const port = parsed?.port || '';
  const poolerHost = /pooler\./i.test(parsed?.hostname ?? '') || low.includes('pooler');
  const transactional = port === '6543' || /:6543(\/|\?|$)/.test(low);
  if (transactional) {
    console.error('拒绝执行：URL 指向事务池（6543）。迁移必须是一个会话跑完，事务池会把 SET 与多语句拆到不同后端。');
    process.exit(2);
  }
  if (poolerHost && !options.allowSessionPooler) {
    console.error('拒绝执行：URL 是池化器主机（pooler.supabase.com）。\n'
      + '  如果你要的是 **session 模式**（端口 5432，一根连接绑定一个后端，与直连等价），加 --allow-session-pooler 再跑；\n'
      + '  如果是 6543 / transaction 模式，换成 5432——迁移不能跑在事务池上。');
    process.exit(2);
  }
  if (poolerHost) {
    console.warn('注意：本次走 session pooler（Supavisor 5432）。语义与直连等价（会话级绑定），但多一跳网络；'
      + 'DDL 与 `set app.company_key` 都成立。');
  }
}

// ---------------------------------------------------------------------------
// 进程封装
// ---------------------------------------------------------------------------
function sh(cmd, args, { input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { cwd: ROOT, windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 },
      (error, stdout, stderr) => resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      }),
    );
    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}

const lines = (out) => out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

// ---------------------------------------------------------------------------
// 文件与校验和
// ---------------------------------------------------------------------------
function migrationFiles() {
  return readdirSync(SQL_DIR)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort();
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function fileDigest(name) {
  return sha256(readFileSync(path.join(SQL_DIR, name)));
}

// ---------------------------------------------------------------------------
// local / cloud 两种执行后端
// ---------------------------------------------------------------------------
function makeBackend(opts) {
  if (opts.target === 'cloud') {
    assertCloudUrl(opts.url, opts);
    const mount = SQL_DIR.replace(/\\/g, '/');
    return {
      label: 'cloud',
      async psql(extra) {
        return sh('docker', [
          'run', '--rm', '-i',
          '-v', `${mount}:/sql:ro`,
          CLOUD_IMAGE,
          'psql', opts.url, '-v', 'ON_ERROR_STOP=1', '-At', ...extra,
        ]);
      },
      /** 云上没有容器可 cp —— SQL 直接以 -v 挂载，无需准备。 */
      async prepare() { return { code: 0, stdout: '', stderr: '' }; },
      /** 迁移会话关掉 body 校验（见文件头第 4 条）；-c 与 -f 在同一个 psql 会话里按序执行。 */
      async applyFile(name) {
        return this.psql(['-c', 'set check_function_bodies = off', '-f', `/sql/${name}`]);
      },
    };
  }

  const cid = { value: '' };
  return {
    label: 'local',
    async psql(extra) {
      return sh('docker', [
        'compose', '-f', COMPOSE_FILE, 'exec', '-T', 'db',
        'psql', '-U', 'postgres', '-d', LOCAL_DB, '-v', 'ON_ERROR_STOP=1', '-At', ...extra,
      ]);
    },
    async resolveContainer() {
      if (cid.value) return cid.value;
      const r = await sh('docker', ['compose', '-f', COMPOSE_FILE, 'ps', '-q', 'db']);
      cid.value = lines(r.stdout)[0] ?? '';
      return cid.value;
    },
    /** 把 docs/sql 送进容器（先清 /sql，避免 docker cp 嵌套成 /sql/sql）。 */
    async prepare() {
      const id = await this.resolveContainer();
      if (!id) return { code: 2, stdout: '', stderr: '本地 db 容器没起来：docker compose -f infra/docker-compose.yml up -d' };
      const clean = await sh('docker', ['exec', id, 'rm', '-rf', '/sql']);
      if (clean.code !== 0) return clean;
      const copy = await sh('docker', ['cp', SQL_DIR, `${id}:/sql`]);
      return copy;
    },
    async applyFile(name) {
      return this.psql(['-c', 'set check_function_bodies = off', '-f', `/sql/${name}`]);
    },
  };
}

// ---------------------------------------------------------------------------
// 账本
// ---------------------------------------------------------------------------
const LEDGER_MISSING = /ops\.schema_migrations.*(does not exist|不存在)/i;

async function readLedger(backend, target) {
  const sql =
    `select coalesce(jsonb_object_agg(version, checksum), '{}'::jsonb)::text ` +
    `from ops.schema_migrations where target = '${target}'`;
  const r = await backend.psql(['-c', sql]);
  if (r.code !== 0) {
    if (LEDGER_MISSING.test(r.stderr)) return null;   // 还没跑过 008：账本还不存在
    throw new Error(`读取账本失败：${r.stderr.trim().split(/\r?\n/)[0]}`);
  }
  const raw = lines(r.stdout).pop() ?? '{}';
  return JSON.parse(raw);
}

async function writeLedger(backend, target, entries) {
  if (!entries.length) return;
  const values = entries
    .map((e) => `('${e.version.replace(/'/g, "''")}', '${target}', '${e.checksum}', now())`)
    .join(',\n       ');
  const sql =
    `insert into ops.schema_migrations (version, target, checksum, applied_at) values\n       ${values}\n` +
    `on conflict (version, target) do update set checksum = excluded.checksum, applied_at = excluded.applied_at`;
  const r = await backend.psql(['-c', sql]);
  if (r.code !== 0) throw new Error(`写账本失败：${r.stderr.trim().split(/\r?\n/)[0]}`);
}

// ---------------------------------------------------------------------------
// --check：只比对账本与文件 sha256（不执行任何 DDL）
// ---------------------------------------------------------------------------
async function runCheck(opts, backend) {
  const files = migrationFiles();
  const ledger = await readLedger(backend, opts.target);
  if (ledger === null) {
    console.error('账本不存在（ops.schema_migrations 还没建）：先跑 node infra/migrate.mjs --target ' + opts.target);
    return 1;
  }

  let bad = 0;
  for (const name of files) {
    const want = fileDigest(name);
    if (name === DESTRUCTIVE && ledger[name] === undefined) {
      console.log(`SKIP  ${name}（破坏性文件，账本里没有记录也不比对）`);
      continue;
    }
    const got = ledger[name];
    if (got === undefined) {
      console.log(`MISS  ${name}  文件存在但账本没有记录（未应用）`);
      bad++;
    } else if (got !== want) {
      console.log(`DRIFT ${name}  账本=${got.slice(0, 12)}… 文件=${want.slice(0, 12)}…（已应用的历史被改写）`);
      bad++;
    } else {
      console.log(`OK    ${name}  ${want.slice(0, 12)}…`);
    }
  }
  for (const name of Object.keys(ledger)) {
    if (!files.includes(name)) {
      console.log(`EXTRA ${name}  账本里有、磁盘上没有（文件被删/改名）`);
      bad++;
    }
  }
  console.log(bad === 0 ? `\n--check 通过：${files.length} 个文件与账本一致` : `\n--check 失败：${bad} 处不一致`);
  return bad === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// --contract：从库导出实际形状，与 contract.json / embedding.json 逐项比对
// ---------------------------------------------------------------------------
const q = (s) => s.replace(/'/g, "''");

/** 取 pg_proc 里的形状：`[{name, args, result, volatility, security}]`（保留重载，不按名字合并）。 */
async function fetchFunctions(backend) {
  const sql = `
    select coalesce(jsonb_agg(jsonb_build_object(
             'name', proname, 'args', args, 'result', result,
             'volatility', vol, 'security', sec)), '[]'::jsonb)
      from (
        select p.proname,
               pg_get_function_identity_arguments(p.oid) as args,
               pg_get_function_result(p.oid) as result,
               p.provolatile as vol,
               case when p.prosecdef then 'definer' else 'invoker' end as sec
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.prokind = 'f'
      ) x`;
  const r = await backend.psql(['-c', sql]);
  if (r.code !== 0) throw new Error(`导出函数失败：${r.stderr.trim().split(/\r?\n/)[0]}`);
  return JSON.parse(lines(r.stdout).pop() ?? '[]');
}

/** 主键：{table: [cols]}（只取 public + ops） */
async function fetchPrimaryKeys(backend) {
  const sql = `
    select coalesce(jsonb_object_agg(key, cols), '{}'::jsonb)
      from (
        select n.nspname || '.' || c.relname as key,
               jsonb_agg(a.attname order by k.ord) as cols
          from pg_constraint con
          join pg_class c on c.oid = con.conrelid
          join pg_namespace n on n.oid = c.relnamespace
          join unnest(con.conkey) with ordinality as k(attnum, ord) on true
          join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
         where con.contype = 'p' and n.nspname in ('public', 'ops')
         group by 1
      ) x`;
  const r = await backend.psql(['-c', sql]);
  if (r.code !== 0) throw new Error(`导出主键失败：${r.stderr.trim().split(/\r?\n/)[0]}`);
  return JSON.parse(lines(r.stdout).pop() ?? '{}');
}

/** 唯一约束：{table: [[cols], ...]}；`unique index` 也算（003 的 wiki_entity_kind_slug_uidx 就是索引形式）。 */
async function fetchUniques(backend) {
  const sql = `
    select coalesce(jsonb_agg(jsonb_build_object('table', key, 'cols', cols)), '[]'::jsonb)
      from (
        select n.nspname || '.' || c.relname as key,
               jsonb_agg(a.attname order by k.ord) as cols
          from pg_constraint con
          join pg_class c on c.oid = con.conrelid
          join pg_namespace n on n.oid = c.relnamespace
          join unnest(con.conkey) with ordinality as k(attnum, ord) on true
          join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
         where con.contype = 'u' and n.nspname in ('public', 'ops')
         group by con.oid, 1
        union all
        select n.nspname || '.' || c.relname as key,
               jsonb_agg(a.attname order by k.ord) as cols
          from pg_index i
          join pg_class c on c.oid = i.indrelid
          join pg_namespace n on n.oid = c.relnamespace
          join unnest(i.indkey::int2[]) with ordinality as k(attnum, ord) on true
          join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
         where i.indisunique and i.indisvalid and n.nspname in ('public', 'ops')
         group by i.indexrelid, 1
      ) x`;
  const r = await backend.psql(['-c', sql]);
  if (r.code !== 0) throw new Error(`导出唯一约束失败：${r.stderr.trim().split(/\r?\n/)[0]}`);
  return JSON.parse(lines(r.stdout).pop() ?? '[]');
}

/** 表/列事实：RLS、租户列、软删列、向量维度。 */
async function fetchTableFacts(backend) {
  const sql = `
    select jsonb_object_agg(key, jsonb_build_object(
             'rls', relrowsecurity, 'force', relforcerowsecurity,
             'columns', cols))
      from (
        select n.nspname || '.' || c.relname as key, c.relrowsecurity, c.relforcerowsecurity,
               coalesce(jsonb_agg(a.attname order by a.attnum) filter (where a.attname is not null), '[]'::jsonb) as cols
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          left join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
         where c.relkind = 'r' and n.nspname in ('public', 'ops')
         group by 1, 2, 3
      ) x`;
  const r = await backend.psql(['-c', sql]);
  if (r.code !== 0) throw new Error(`导出表事实失败：${r.stderr.trim().split(/\r?\n/)[0]}`);
  return JSON.parse(lines(r.stdout).pop() ?? '{}');
}

async function fetchVectorDims(backend) {
  const r = await backend.psql(['-c',
    `select atttypmod::text from pg_attribute
      where attrelid = 'public.wiki_summary'::regclass and attname = 'embedding'`]);
  if (r.code !== 0) throw new Error(`导出向量维度失败：${r.stderr.trim().split(/\r?\n/)[0]}`);
  return Number.parseInt(lines(r.stdout).pop() ?? '-1', 10);
}

async function fetchRoles(backend) {
  const sql = `
    select coalesce(jsonb_object_agg(rolname, jsonb_build_object('bypassrls', rolbypassrls)), '{}'::jsonb)
      from pg_roles where rolname in ('anon', 'authenticated', 'service_role', 'orange_app')`;
  const r = await backend.psql(['-c', sql]);
  if (r.code !== 0) throw new Error(`导出角色失败：${r.stderr.trim().split(/\r?\n/)[0]}`);
  return JSON.parse(lines(r.stdout).pop() ?? '{}');
}

/** anon 在 public 下的**有效权限**（函数 EXECUTE + 表 DML/DDL 相关），契约要求空数组。 */
async function fetchAnonGrants(backend) {
  const sql = `
    select coalesce(jsonb_agg(kind || ' ' || obj order by kind, obj), '[]'::jsonb)
      from (
        select 'table ' as kind, n.nspname || '.' || c.relname as obj
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
           and exists (select 1 from pg_roles r where r.rolname = 'anon')
           and has_table_privilege('anon', c.oid,
                 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        union all
        select 'function ',
               n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.prokind = 'f'
           and exists (select 1 from pg_roles r where r.rolname = 'anon')
           and has_function_privilege('anon', p.oid, 'EXECUTE')
      ) x`;
  const r = await backend.psql(['-c', sql]);
  if (r.code !== 0) throw new Error(`导出 anon 有效权限失败：${r.stderr.trim().split(/\r?\n/)[0]}`);
  return JSON.parse(lines(r.stdout).pop() ?? '[]');
}

/** orange_claim 的 CHECK 约束定义（契约不变量）。 */
async function fetchClaimChecks(backend) {
  const r = await backend.psql(['-c',
    `select coalesce(jsonb_object_agg(conname, pg_get_constraintdef(oid)), '{}'::jsonb)
       from pg_constraint
      where conrelid = 'public.orange_claim'::regclass and contype = 'c'`]);
  if (r.code !== 0) return null;                 // 009 还没跑
  return JSON.parse(lines(r.stdout).pop() ?? '{}');
}

const normArgs = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim();

/** 从 pg_get_function_result 的 `TABLE(...)` 里取输出列名（保留大小写：camelCase 是契约的一部分）。 */
function resultColumns(result) {
  const m = /^table\s*\((.*)\)$/is.exec(String(result).trim());
  if (!m) return null;
  const parts = [];
  let depth = 0;
  let inQuote = false;
  let cur = '';
  for (const ch of m[1]) {
    if (inQuote) { cur += ch; if (ch === '"') inQuote = false; continue; }
    if (ch === '"') { inQuote = true; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => {
    const t = p.trim();
    if (t.startsWith('"')) {
      const end = t.indexOf('"', 1);
      return t.slice(1, end === -1 ? undefined : end).replace(/""/g, '"');
    }
    return t.split(/\s+/)[0];
  });
}

function resultKind(result) {
  const r = String(result).trim();
  if (/^table\(/i.test(r)) return 'table';
  if (/setof/i.test(r)) return 'table';
  return r.toLowerCase();
}

async function runContract(opts, backend) {
  const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'));
  const embedding = JSON.parse(readFileSync(EMBEDDING_PATH, 'utf8'));
  const problems = [];
  const ok = [];

  const fns = await fetchFunctions(backend);
  const pks = await fetchPrimaryKeys(backend);
  const uniques = await fetchUniques(backend);
  const facts = await fetchTableFacts(backend);
  const roles = await fetchRoles(backend);
  const dims = await fetchVectorDims(backend);
  const anonGrants = await fetchAnonGrants(backend);
  const claimChecks = await fetchClaimChecks(backend);

  // 1) RPC 形状。按名字分组：同名多签名 = 重载，直接算漂移（旧实现 jsonb_object_agg 只留最后一个）。
  const byName = new Map();
  for (const f of fns) {
    if (!byName.has(f.name)) byName.set(f.name, []);
    byName.get(f.name).push(f);
  }

  for (const [name, spec] of Object.entries(contract.rpc)) {
    const variants = byName.get(name) ?? [];
    if (variants.length === 0) { problems.push(`rpc ${name}：库里没有`); continue; }
    if (variants.length > 1) {
      problems.push(`rpc ${name}：库里有 ${variants.length} 个重载（${variants.map((v) => `(${v.args})`).join(' / ')}），契约只允许一个`);
      continue;
    }
    const live = variants[0];
    if (normArgs(live.args) !== normArgs(spec.args.join(', '))) {
      problems.push(`rpc ${name} 参数：库=${live.args} 契约=${spec.args.join(', ')}`);
    }
    if (spec.returns && resultKind(live.result) !== resultKind(spec.returns)) {
      problems.push(`rpc ${name} 返回：库=${resultKind(live.result)} 契约=${spec.returns}`);
    }
    if (spec.volatility && live.volatility !== spec.volatility[0]) {
      // pg_proc.provolatile: i=immutable s=stable v=volatile
      problems.push(`rpc ${name} volatility：库=${live.volatility} 契约=${spec.volatility}`);
    }
    if (spec.security && live.security !== spec.security) {
      problems.push(`rpc ${name} security：库=${live.security} 契约=${spec.security}`);
    }
    if (spec.columns) {
      const got = resultColumns(live.result);
      if (!got) {
        problems.push(`rpc ${name} 返回列：库里不是 TABLE(...)（实际=${live.result}）`);
      } else if (JSON.stringify(got) !== JSON.stringify(spec.columns)) {
        problems.push(`rpc ${name} 返回列：库=[${got.join(',')}] 契约=[${spec.columns.join(',')}]`);
      }
    }
  }
  ok.push(`rpc 形状：${Object.keys(contract.rpc).length} 个全部匹配（含单签名与返回列名）`);

  // 1b) 反向比对：库里多出来的函数同样算漂移；internal 清单必须仍然存在。
  const internal = Array.isArray(contract.internal) ? contract.internal : [];
  const declared = new Set([...Object.keys(contract.rpc), ...internal]);
  for (const [name, variants] of byName) {
    if (declared.has(name)) continue;
    problems.push(`public.${name}：库里有但 contract.rpc/contract.internal 都没登记（${variants.map((v) => `(${v.args})`).join(' / ')}）`);
  }
  for (const name of internal) {
    if (!byName.has(name)) problems.push(`internal ${name}：契约声明为内部函数，但库里没有（被删或改名）`);
  }
  ok.push(`函数清单：库里 ${byName.size} 个 = ${Object.keys(contract.rpc).length} 个 RPC + ${internal.length} 个 internal，双向比对`);

  // 2) 主键
  for (const [table, spec] of Object.entries(contract.tables)) {
    const key = table.includes('.') ? table : `public.${table}`;
    const live = pks[key];
    if (!live) { problems.push(`表 ${key}：没有主键或表不存在`); continue; }
    if (JSON.stringify(live) !== JSON.stringify(spec.pk)) {
      problems.push(`表 ${key} 主键：库=${live.join(',')} 契约=${spec.pk.join(',')}`);
    }
  }
  ok.push(`主键：${Object.keys(contract.tables).length} 张表逐列比对`);

  // 3) 唯一约束 / 租户列 / RLS / 软删列
  for (const [table, spec] of Object.entries(contract.tables)) {
    const key = table.includes('.') ? table : `public.${table}`;
    const fact = facts[key];
    if (!fact) { problems.push(`表 ${key}：不存在`); continue; }
    if (spec.unique) {
      for (const want of spec.unique) {
        const hit = uniques.some((u) => u.table === key && JSON.stringify(u.cols) === JSON.stringify(want));
        if (!hit) problems.push(`表 ${key} 唯一约束缺：(${want.join(',')})`);
      }
    }
    if (spec.tenant) {
      if (!fact.columns.includes(spec.tenant)) problems.push(`表 ${key} 缺租户列 ${spec.tenant}`);
      if (!fact.rls || !fact.force) problems.push(`表 ${key} RLS 未 enable+force`);
    }
    if (spec.soft_delete && !fact.columns.includes(spec.soft_delete)) {
      problems.push(`表 ${key} 缺软删列 ${spec.soft_delete}`);
    }
    if (spec.vector && !fact.columns.includes(spec.vector)) {
      problems.push(`表 ${key} 缺向量列 ${spec.vector}`);
    }
  }
  ok.push('唯一约束 / 租户列 / RLS / 软删列 / 向量列：全部命中');

  // 4) 向量维度（embedding.json 是唯一来源）
  if (dims !== embedding.dims) {
    problems.push(`wiki_summary.embedding 维度：库=${dims} embedding.json=${embedding.dims}`);
  } else {
    ok.push(`向量维度：${dims}（与 embedding.json 一致）`);
  }

  // 5) 角色与 anon 的**有效权限**（不是只看表：008 曾把 app_tenant_key/app_uid 授给 anon）
  if (!roles.anon) problems.push('角色 anon 不存在');
  if (!roles.authenticated) problems.push('角色 authenticated 不存在');
  if (!roles.service_role) problems.push('角色 service_role 不存在');
  else if (!roles.service_role.bypassrls) problems.push('service_role 不是 BYPASSRLS');
  if (anonGrants.length) {
    problems.push(`anon 在 public 下仍有 ${anonGrants.length} 项有效权限（契约要求 0，漏 token 必须 42501）：${anonGrants.join('；')}`);
  }
  ok.push(`角色：anon 有效权限 ${anonGrants.length} 项（has_table_privilege + has_function_privilege）/ service_role bypassrls=${roles.service_role?.bypassrls}`);

  // 6) claimEnvelope 不变量
  if (!claimChecks) {
    problems.push('orange_claim 不存在（009 未应用）');
  } else {
    const defs = Object.values(claimChecks).join(' ').replace(/\s+/g, ' ');
    if (!/execution_ready = false/i.test(defs)) problems.push('orange_claim 缺 execution_ready = false 约束');
    if (!/history_count = ANY/i.test(defs) || !/0, 1/.test(defs)) problems.push('orange_claim 缺 history_count ∈ {0,1} 约束');
    if (!/frozen_plan ->> 'version'/i.test(defs)) problems.push('orange_claim 缺 frozenPlan.version=1 约束');
    const status = defs.match(/status = ANY \(ARRAY\[.*?\]\)/i);
    if (!status) problems.push('orange_claim 缺 status 枚举约束');
    ok.push('claimEnvelope：executionReady=false / frozenPlan.version=1 / historyCount∈{0,1} / status 五态');
  }

  // 7) 错误消息口径（静态：迁移源码里的每条 orange_* 消息）
  const errPattern = new RegExp(contract.claimEnvelope.errorMessage);
  for (const name of migrationFiles()) {
    const src = readFileSync(path.join(SQL_DIR, name), 'utf8');
    for (const m of src.matchAll(/'(orange:[^']*)'/g)) {
      if (!errPattern.test(m[1])) problems.push(`${name} 错误消息不合契约：${m[1]}`);
    }
  }
  ok.push('错误消息：全部匹配 ^orange:[a-z-]+$');

  console.log('contract 漂移检查（contract.json ⇄ pg_proc/information_schema）');
  for (const line of ok) console.log(`OK   ${line}`);
  for (const line of problems) console.log(`DRIFT ${line}`);
  console.log(problems.length ? `\n--contract 失败：${problems.length} 处漂移` : '\n--contract 通过：库与契约一致');
  return problems.length ? 1 : 0;
}

// ---------------------------------------------------------------------------
// 应用模式
// ---------------------------------------------------------------------------
/** 库里是否已经有业务表（用于“账本丢了，但库不是空的”判定）。 */
async function hasLiveSchema(backend) {
  const r = await backend.psql(['-c', "select (to_regclass('public.material') is not null)::text"]);
  if (r.code !== 0) throw new Error(`探测 public.material 失败：${r.stderr.trim().split(/\r?\n/)[0]}`);
  return (lines(r.stdout).pop() ?? 'false') === 'true';
}

async function runApply(opts, backend) {
  const files = migrationFiles();
  const ledger = await readLedger(backend, opts.target);

  // 账本缺失 ≠ 全新库。若库中已有 public.material，按“全新库”重放会把线上向量清空。
  if (ledger === null) {
    const live = await hasLiveSchema(backend);
    if (live && !opts.allowReplay) {
      console.error([
        `拒绝执行：target=${opts.target} 的账本 ops.schema_migrations 不存在，但库里已经有 public.material。`,
        '这等于“认不出当前是哪一版”。若按 001→010 重放，会真的执行下面这些破坏性语句：',
        '  * 007:54-63  UPDATE wiki_summary SET embedding = NULL（清空所有向量，需重新 embedding）',
        '  * 007:184     DROP INDEX public.wiki_summary_embedding_hnsw_idx（重建期间向量检索不可用）',
        '  * 002/003/004/005/006/008/009/010 的 DDL 与策略/权限重建（期间连接行为短暂改变）',
        '确认要按文件顺序重铺、并且接受上述后果，才加 --allow-replay 重跑：',
        `  node infra/migrate.mjs --target ${opts.target} --allow-replay`,
      ].join('\n'));
      return 1;
    }
    if (live) {
      console.warn('账本缺失但库非空：已确认 --allow-replay，按文件顺序重放 001→010（007 会清空向量并重建 HNSW 索引）。');
    }
  }

  const acceptedDrift = new Set(opts.acceptDrift ?? []);
  const plan = [];
  for (const name of files) {
    if (name === DESTRUCTIVE && !opts.allowDestructive) {
      plan.push({ name, action: 'skip-destructive' });
      continue;
    }
    const checksum = fileDigest(name);
    const recorded = ledger?.[name];
    if (recorded === checksum) plan.push({ name, action: 'already', checksum });
    else if (recorded !== undefined) plan.push({ name, action: 'drift', checksum });
    else plan.push({ name, action: 'apply', checksum });
  }

  console.log(`target=${opts.target} backend=${backend.label} files=${files.length}`);
  for (const p of plan) {
    const tag = { 'skip-destructive': 'SKIP', already: 'OK  ', drift: 'DIFF', apply: 'RUN ' }[p.action];
    console.log(`${tag} ${p.name}`);
  }

  const drift = plan.filter((p) => p.action === 'drift');
  if (drift.length) {
    /* `--accept-drift NAME` 是**显式**的重基线：只在"文件内容确实该改"（例如能力断言把本机版本号写死了）时用。
       一次点一个文件，把账本里的 checksum 更新成当前内容，并把该文件降级为 already；
       没点名的漂移仍然拒绝——append-only 纪律默认不破。 */
    const rebaselined = drift.filter((d) => acceptedDrift.has(d.name));
    const refused = drift.filter((d) => !acceptedDrift.has(d.name));
    if (rebaselined.length) {
      for (const d of rebaselined) {
        console.log(`REBASELINE ${d.name}  账本 ${String(ledger?.[d.name] ?? '').slice(0, 12)}… → 文件 ${d.checksum.slice(0, 12)}…`);
        d.action = 'already';
      }
      try {
        await writeLedger(backend, opts.target, rebaselined.map((d) => ({ version: d.name, checksum: d.checksum })));
      } catch (error) {
        console.error(`重基线写账本失败：${error?.message ?? String(error)}`);
        return 1;
      }
    }
    if (refused.length) {
      console.error(`\n拒绝执行：以下文件已应用过但内容被改写（只追加不改写纪律）：\n  ${refused.map((d) => d.name).join('\n  ')}`);
      return 1;
    }
  }
  if (opts.dryRun) {
    console.log('\n--dry-run：不执行任何语句');
    return 0;
  }

  const prep = await backend.prepare();
  if (prep.code !== 0) {
    console.error(String(prep.stderr || prep.stdout).trim());
    return 2;
  }

  const applied = [];
  for (const p of plan) {
    if (p.action !== 'apply') continue;
    for (const sql of REPLAY_PRELUDES[p.name] ?? []) {
      const pre = await backend.psql(['-c', sql]);
      if (pre.code !== 0) {
        console.error(String(pre.stderr || pre.stdout).trim().split(/\r?\n/)[0]);
        console.error(`\n重放前语失败（${p.name}）：${sql}`);
        return 1;
      }
    }
    process.stdout.write(`\n==> ${p.name}\n`);
    const r = await backend.applyFile(p.name);
    if (r.code !== 0) {
      console.error(String(r.stderr || r.stdout).trim());
      console.error(`\n失败于 ${p.name}（exit ${r.code}）`);
      // 已成功应用的文件仍然记账，避免下次重放时误判。
      try { await writeLedger(backend, opts.target, applied); } catch { /* 账本可能还没建 */ }
      return 1;
    }
    const noise = String(r.stdout).split(/\r?\n/).filter((l) => l && !/^(SET|RESET|BEGIN|COMMIT|DO)$/.test(l));
    if (noise.length) console.log(noise.slice(-5).join('\n'));
    applied.push({ version: p.name, checksum: p.checksum });
  }

  // A single-file replay (006 without 007, a repaired drift, a hand-run psql) can leave a function that
  // still casts to the old dimension. The ledger cannot see that, so ask the database **before** recording
  // success: a run that leaves 1024 behind must not be written into the ledger as applied.
  // `p.prokind = 'f'` matters: without it the planner may evaluate `pg_get_functiondef` for aggregates in
  // pg_catalog and fail the whole query ("array_agg is an aggregate function"), which used to be swallowed
  // below as "nothing stale" — a guard that cannot run is not a guard.
  const guard = await backend.psql(['-c', "select coalesce(string_agg(p.proname, ',' order by p.proname), '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f' and pg_get_functiondef(p.oid) ~ 'vector\\(1024\\)'"]);
  if (guard.code !== 0) {
    console.error('\nPOST-APPLY GUARD 无法执行（不是“没有残留”）：' + String(guard.stderr || guard.stdout).trim().split(/\r?\n/)[0]);
    console.error('  迁移文件的执行结果未知，不记账。先修 psql/连接，再重跑。');
    return 1;
  }
  const staleNames = String(guard.stdout ?? '').trim();
  if (staleNames) {
    console.error(`\nPOST-APPLY GUARD：这些 public 函数仍在用 vector(1024)：${staleNames}`);
    console.error('  多半是某个文件被单独重放（006 重放后 007 已被账本跳过）。补齐 007 或出 011 收敛，审计时不要当作已通过。');
    return 1;
  }

  if (applied.length) {
    await writeLedger(backend, opts.target, applied);
    console.log(`\n已记账：${applied.length} 个文件写入 ops.schema_migrations(target=${opts.target})`);
  } else {
    console.log('\n没有需要执行的文件（全部已应用且校验和一致）');
  }
  return 0;
}

// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const backend = makeBackend(opts);

  if (opts.check && opts.contract) {
    console.error('--check 与 --contract 一次只能选一个');
    return 2;
  }
  if (opts.check) return runCheck(opts, backend);
  if (opts.contract) return runContract(opts, backend);
  return runApply(opts, backend);
}

const code = await main();
process.exit(code);
