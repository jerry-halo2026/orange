#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// 本地基建自查：九项，全部通过才算本地库可用（W1-C 五项 + W2 三项 + 向量分支一项）。
//
//   ① vector 扩展版本 >= 0.8.0（能力底线：iterative_scan 要 0.8.0；镜像版本不算要求）
//   ② SET hnsw.iterative_scan = strict_order 成功
//   ③ 六张表齐全（material / wiki_source / wiki_summary / wiki_entity / wiki_edge / wiki_event）
//   ④ 六张表都启用了 RLS
//   ⑤ 两租户互不可见（app.company_key 切换后各只看自己那条；跨租户写入被拒；
//      无租户上下文读/写都是 42501 tenant-context-required —— 010 起策略是严格判据）
//   ⑥ sync_state 表存在（005）
//   ⑦ material.deleted_at 列存在（005）
//   ⑧ search_materials 可调用，且跨租户返回 0 行、软删除行被排除（006）；
//      无租户上下文调用是 42501 tenant-context-required（断言 no-tenant-search-42501）
//
// 另有一条**不计入 8 项**的提示行（WARN/INFO）：RPC 内部的事务级
// `set_config('hnsw.iterative_scan','strict_order',true)` 是否被接受。
// 托管 PG 若 pgvector < 0.8 会接受该 GUC 但**不生效**（自定义 GUC 会被当作占位符），
// 因此这条只作提示、绝不判失败。真正的回退办法见 docs/sql/README.md。
//
// 实现说明：本机没有 psql，也不引入任何数据库驱动。本地段走 `docker compose exec -T db psql`；
// 云端段走 `docker run --rm postgres:17 psql "$SUPABASE_DB_URL"`（session 直连 5432，禁 6543 pooler）。
// 两段跑的是**同一批断言**，`--json` 供 scripts/gate-compare.mjs 比对。
//
// 用法：node infra/verify.mjs [--target local|cloud] [--json]
// 退出码：0 全过；1 有失败；2 环境未就绪（本地容器没起 / 云端缺 SUPABASE_DB_URL / URL 指向 pooler）。
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const composeFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'docker-compose.yml');
const TABLES = ['material', 'wiki_source', 'wiki_summary', 'wiki_entity', 'wiki_edge', 'wiki_event'];
/* 能力底线，不是镜像版本：0.8.0 起才有 `hnsw.iterative_scan`（`halfvec` / `subvector` 是 0.7.0 起）。
   本机开发镜像是 0.8.7，Supabase 目前上限 0.8.2 —— 卡 0.8.7 会把一个能力齐全的云库判成不合格。 */
const REQUIRED = [0, 8, 0];
const TOTAL = 9;
const CLOUD_IMAGE = process.env.ORANGE_PSQL_IMAGE || 'postgres:17';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const at = argv.indexOf(name);
  return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : fallback;
};
const JSON_OUT = flag('--json');
const TARGET = value('--target', 'local');
const CLOUD_URL = process.env.SUPABASE_DB_URL || value('--url', '');

const refuse = (message) => {
  console.error(`verify: ${message}`);
  process.exit(2);
};
if (TARGET !== 'local' && TARGET !== 'cloud') refuse(`--target 只能是 local 或 cloud（收到 ${TARGET}）`);
if (TARGET === 'cloud') {
  if (!CLOUD_URL) refuse('--target cloud 需要 SUPABASE_DB_URL（本文件不出现在 argv 里；.dev/supabase.local.env 写好后导入）');
  if (/:6543(\/|\?|$)/.test(CLOUD_URL)) refuse('SUPABASE_DB_URL 指向 6543（事务池）：断言必须在同一会话里跑');
  /* session pooler（Supavisor 5432）与直连等价：一根客户端连接绑一个后端连接。允许，但要说出来。 */
  if (/pooler\./i.test(CLOUD_URL) || /pooler/i.test(CLOUD_URL)) {
    if (!CLOUD_URL.includes(':5432') && !/[?&]port=5432/.test(CLOUD_URL)) refuse('SUPABASE_DB_URL 是池化器但不是 5432：只有 session 模式（5432）可用于迁移与断言');
    console.warn('注意：本次走 session pooler（Supavisor 5432），语义与直连等价。');
  }
}

/** 跑一条命令，永不抛出：返回 {code, stdout, stderr}。 */
const sh = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
    resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
  });
});

/** 跑 psql；若干 -c 共用一个连接（SET / SET ROLE 才有效）。local 与 cloud 用同一套语句。 */
async function psql(...statements) {
  const args = TARGET === 'cloud'
    ? ['run', '--rm', '-i', CLOUD_IMAGE, 'psql', CLOUD_URL, '-v', 'ON_ERROR_STOP=1', '-At']
    : ['compose', '-f', composeFile, 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'orange', '-v', 'ON_ERROR_STOP=1', '-At'];
  for (const sql of statements) args.push('-c', sql);
  return sh('docker', args);
}

/** 所有非空输出行（去掉 psql 的命令标签如 SET/DO）。 */
const lines = (out) => out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const lastValue = (out) => lines(out).filter((l) => !/^(SET|RESET|DO|BEGIN|COMMIT|INSERT \d+|DELETE \d+)$/i.test(l)).pop() ?? '';

const results = [];
const record = (id, ok, detail) => { results.push({ id, ok, detail }); };
const notes = [];
const note = (level, detail) => notes.push({ level, detail });

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    const r = await psql('select 1');
    if (r.code === 0 && lastValue(r.stdout) === '1') return true;
    await new Promise((res) => setTimeout(res, 1000));
  }
  return false;
}

const versionOk = (text) => {
  const got = String(text).trim().split('.').map((n) => Number.parseInt(n, 10));
  if (got.length < 3 || got.some((n) => !Number.isInteger(n))) return false;
  for (let i = 0; i < 3; i++) {
    if (got[i] > REQUIRED[i]) return true;
    if (got[i] < REQUIRED[i]) return false;
  }
  return true;
};

/** Zero vector of the dimension the contract declares, for one call to the vector branch (callable, not recall). */
const DIMS = (() => {
  try {
    const json = JSON.parse(readFileSync(new URL('../docs/sql/embedding.json', import.meta.url), 'utf8'));
    const dims = Number(json?.dims);
    return Number.isInteger(dims) && dims > 0 ? dims : 768;
  } catch {
    return 768;
  }
})();
const ZERO_VEC = `[${'0,'.repeat(DIMS - 1)}0]`;

async function main() {
  // stdout stays parseable in --json mode: the prose goes to stderr.
  const say = JSON_OUT ? (line) => console.error(line) : (line) => console.log(line);
  say(`verify —— ${TARGET} Postgres + pgvector + RPC 自查`);
  say(`compose: ${composeFile}`);

  if (!(await waitReady())) {
    console.error('\n环境未就绪：连不上本地库。先执行\n  docker compose -f infra/docker-compose.yml up -d\n然后再按 docs/sql/README.md 依次 psql -f。');
    process.exit(2);
  }

  // ① vector 扩展版本
  {
    const r = await psql("select extversion from pg_extension where extname = 'vector'");
    const v = lastValue(r.stdout);
    record('① vector 扩展版本 >= 0.8.0（能力底线）', r.code === 0 && versionOk(v), r.code === 0 ? `extversion=${v || '(缺)'}` : r.stderr.trim());
  }

  // ② hnsw.iterative_scan
  {
    const r = await psql('set hnsw.iterative_scan = strict_order', 'show hnsw.iterative_scan');
    const v = lastValue(r.stdout);
    record('② SET hnsw.iterative_scan=strict_order', r.code === 0 && v === 'strict_order', r.code === 0 ? `show -> ${v}` : r.stderr.trim());
  }

  // ③ 六张表齐全
  {
    const list = TABLES.map((t) => `'${t}'`).join(', ');
    const r = await psql(`select tablename from pg_tables where schemaname = 'public' and tablename in (${list}) order by tablename`);
    const found = lines(r.stdout);
    const missing = TABLES.filter((t) => !found.includes(t));
    record('③ 六张表齐全', r.code === 0 && missing.length === 0, `找到 ${found.length}/6${missing.length ? `，缺：${missing.join(', ')}` : ''}`);
  }

  // ④ 六张表都启用 RLS
  {
    const list = TABLES.map((t) => `'${t}'`).join(', ');
    const r = await psql(`select c.relname || ':' || (case when c.relrowsecurity then 'on' else 'off' end) || (case when c.relforcerowsecurity then '/force' else '' end) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relname in (${list}) order by c.relname`);
    const rows = lines(r.stdout);
    const off = rows.filter((x) => x.endsWith(':off'));
    record('④ RLS 已启用（六张表）', r.code === 0 && rows.length === TABLES.length && off.length === 0, rows.join(' ') || r.stderr.trim());
  }

  // ⑤ 两租户互不可见 + 跨租户写入被拒 + 无租户上下文读/写都是 42501
  //    （010 起策略用严格判据 tenant_key_required()：没有租户上下文时读也是 42501，
  //     不再是“静默 0 行”；断言名 no-tenant-read-42501 / no-tenant-write-42501）
  {
    const seed = await psql(
      `insert into material (company_key, env_id, video_id, name) values ('verify-a', 'local', 'verify-a', 'tenant A'), ('verify-b', 'local', 'verify-b', 'tenant B') on conflict (company_key, env_id, video_id) do update set name = excluded.name, deleted_at = null`,
    );
    const seeA = await psql("set role orange_app", "set app.company_key = 'verify-a'", "select coalesce(string_agg(video_id, ',' order by video_id), '-') from material where video_id like 'verify-%'");
    const seeB = await psql("set role orange_app", "set app.company_key = 'verify-b'", "select coalesce(string_agg(video_id, ',' order by video_id), '-') from material where video_id like 'verify-%'");
    const crossWrite = await psql("set role orange_app", "set app.company_key = 'verify-a'", "insert into material (company_key, env_id, video_id, name) values ('verify-b', 'local', 'verify-b2', 'should fail')");

    // 无租户上下文：读与写各跑一次，把 SQLSTATE 与 message 抓出来（断言 no-tenant-read/write-42501）
    const probe = await psql(
      'set role orange_app',
      'reset app.company_key',
      `do $$ declare r_state text; r_msg text; w_state text; w_msg text; begin
         begin
           perform count(*) from material where video_id like 'verify-%';
         exception when others then
           get stacked diagnostics r_state = returned_sqlstate, r_msg = message_text;
         end;
         begin
           insert into material (company_key, env_id, video_id, name)
           values ('verify-a', 'local', 'verify-no-tenant', 'should fail');
         exception when others then
           get stacked diagnostics w_state = returned_sqlstate, w_msg = message_text;
         end;
         perform set_config('verify.no_tenant',
           coalesce(r_state, 'none') || '/' || coalesce(r_msg, '') || '|' ||
           coalesce(w_state, 'none') || '/' || coalesce(w_msg, ''), false);
       end $$`,
      "select current_setting('verify.no_tenant', true)",
    );

    const a = lastValue(seeA.stdout), b = lastValue(seeB.stdout);
    const [readState, writeState] = (lastValue(probe.stdout) || 'none/|none/').split('|');
    const readOk = readState === '42501/tenant-context-required';
    const writeOk = writeState === '42501/tenant-context-required';
    const ok = seed.code === 0
      && seeA.code === 0 && a === 'verify-a'
      && seeB.code === 0 && b === 'verify-b'
      && readOk && writeOk
      && crossWrite.code !== 0;
    record('⑤ 两租户互不可见（含跨租户写入被拒 + 无租户 42501）', ok,
      `A 看到 [${a}] / B 看到 [${b}] / no-tenant-read-42501 [${readState}] / no-tenant-write-42501 [${writeState}] / 跨租户写入 ${crossWrite.code !== 0 ? '被拒' : '竟然成功'}`);
  }

  // ⑥ sync_state 存在（005）
  {
    const r = await psql("select count(*) from pg_tables where schemaname = 'public' and tablename = 'sync_state'");
    const pk = await psql("select coalesce(string_agg(a.attname, ',' order by a.attnum), '-') from pg_constraint c join pg_class t on t.oid = c.conrelid join lateral unnest(c.conkey) k(attnum) on true join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum where c.contype = 'p' and t.relname = 'sync_state'");
    const exists = lastValue(r.stdout) === '1';
    record('⑥ sync_state 表存在', r.code === 0 && exists, exists ? `PK(${lastValue(pk.stdout)})` : `未找到 sync_state；${r.stderr.trim()}`);
  }

  // ⑦ material.deleted_at 存在（005）
  {
    const r = await psql("select coalesce(data_type, '(缺)') from information_schema.columns where table_schema = 'public' and table_name = 'material' and column_name = 'deleted_at'");
    const v = lastValue(r.stdout);
    record('⑦ material.deleted_at 列存在', r.code === 0 && v === 'timestamp with time zone', `deleted_at -> ${v || '(缺)'}`);
  }

  // ⑧ search_materials 可调用 + 跨租户 0 行 + 软删除被排除（006）
  {
    const exists = await psql("select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'search_materials'");
    const seeded = await psql(
      `insert into material (company_key, env_id, video_id, name, deleted_at) values
         ('verify-a', 'local', 'verify-a', 'tenant A live', null),
         ('verify-a', 'local', 'verify-a-gone', 'tenant A deleted', now()),
         ('verify-b', 'local', 'verify-b', 'tenant B live', null)
       on conflict (company_key, env_id, video_id) do update set name = excluded.name, deleted_at = excluded.deleted_at`,
    );
    // 会话租户 = verify-a：只能拿到自己那条，且软删除那条不出现
    const own = await psql("set role orange_app", "set app.company_key = 'verify-a'", "select coalesce(string_agg(video_id, ',' order by video_id), '-') from search_materials('verify-a', null, '{}'::jsonb, 100)");
    // 同一会话里用**别人的 company_key 参数**再查一次：必须 0 行（租户不可被参数覆盖 + RLS 兜底）
    const cross = await psql("set role orange_app", "set app.company_key = 'verify-a'", "select count(*) from search_materials('verify-b', null, '{}'::jsonb, 100)");
    // 不设租户直接调：010 起是 42501 tenant-context-required（断言 no-tenant-search-42501），
    // 不再是“0 行”——策略是严格判据，读也会 fail closed。
    const none = await psql(
      'set role orange_app',
      'reset app.company_key',
      `do $$ declare s_state text; s_msg text; begin
         begin
           perform count(*) from search_materials('verify-a', null, '{}'::jsonb, 100);
         exception when others then
           get stacked diagnostics s_state = returned_sqlstate, s_msg = message_text;
         end;
         perform set_config('verify.search_no_tenant',
           coalesce(s_state, 'none') || '/' || coalesce(s_msg, ''), false);
       end $$`,
      "select current_setting('verify.search_no_tenant', true)",
    );
    await psql("delete from material where video_id like 'verify-%'");

    const ownRows = lastValue(own.stdout), crossRows = lastValue(cross.stdout), noneState = lastValue(none.stdout);
    const ok = exists.code === 0 && lastValue(exists.stdout) === '1'
      && seeded.code === 0
      && own.code === 0 && ownRows === 'verify-a'
      && cross.code === 0 && crossRows === '0'
      && noneState === '42501/tenant-context-required';
    record('⑧ search_materials 可调用且跨租户 0 行（无租户 42501）', ok,
      `自己 [${ownRows}] / 跨租户参数 [${crossRows} 行] / no-tenant-search-42501 [${noneState}]`);

    // ⑨ 向量分支：dimension from docs/sql/embedding.json must reach the RPC, and the transaction-scoped
    //    `hnsw.iterative_scan` must be accepted. A red here means the function and the column disagree —
    //    exactly the state 006+007 can leave behind when a replay stops in the middle.
    const embed = await psql(
      'begin',
      `select count(*) from search_materials('verify-a', null, jsonb_build_object('embedding', '${ZERO_VEC}'::text), 5)`,
      "select coalesce(current_setting('hnsw.iterative_scan', true), '(unset)')",
      'commit',
    );
    if (embed.code !== 0) {
      record('⑨ 向量分支可调用（' + DIMS + ' 维）', false,
        `向量分支调用失败：${embed.stderr.trim().split(/\r?\n/)[0]}`);
    } else {
      const after = lines(embed.stdout).filter((l) => l === 'strict_order' || l === '(unset)').pop() ?? '(unset)';
      record('⑨ 向量分支可调用（' + DIMS + ' 维）', after === 'strict_order',
        `search_materials(filters.embedding) 返回 0 行（无摘要行）；事务内 hnsw.iterative_scan=${after}`);
    }
    note('INFO', '⑨ 只证明“维度一致 + 可调用 + GUC 被接受”，不证明 recall / 索引命中；recall 由 scripts/bench-search.mjs（G06 性能段）负责。');
  }

  let failed = 0;
  for (const r of results) if (!r.ok) failed++;
  const ok = failed === 0 && results.length === TOTAL;

  if (JSON_OUT) {
    // One line on stdout for scripts/gate-compare.mjs; everything a person reads goes to stderr.
    console.log(JSON.stringify({
      schema: 'verify/1',
      surface: 'db',
      target: TARGET,
      ok,
      checks: results.map((r) => ({ id: r.id, ok: r.ok, detail: r.detail })),
      notes,
    }));
    for (const r of results) if (!r.ok) console.error(`FAIL  ${r.id}: ${r.detail}`);
    process.exit(ok ? 0 : 1);
  }

  console.log('');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id}`);
    console.log(`      ${r.detail}`);
  }
  for (const n of notes) {
    console.log(`${n.level}  （提示，不计入 ${TOTAL} 项）`);
    console.log(`      ${n.detail}`);
  }
  console.log('');
  console.log(`target=${TARGET}`);
  console.log(failed === 0 ? `全部通过（${results.length}/${TOTAL}）` : `失败 ${failed}/${results.length}`);
  process.exit(ok ? 0 : 1);
}

await main();
