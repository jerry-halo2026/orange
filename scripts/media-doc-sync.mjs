#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// 把本机已经算好的向量**搬到云上**，不重算。
//
//   node scripts/media-doc-sync.mjs --dry-run --limit 5
//   node scripts/media-doc-sync.mjs --db-url postgresql://… --limit 200      # 冒烟
//   node scripts/media-doc-sync.mjs --db-url postgresql://…                  # 全量（可反复跑）
//
// # 为什么不直接再跑一次 material-doc-index.mjs
//
// 那个脚本是"索引 → 文本 → 嵌入 → 写库"。上云这一步**不需要也没有理由重算向量**：
// 4096 维一次约 400 ms，67 156 条就是七小时；而本机库里已经躺着了。所以这里只做
// "读本机 → 拼 upsert 语句 → 写云库"，一模一样的主键与 `upsert_media_doc`，因此可重入。
//
// # 幂等
//
// 走的是同一个 `public.upsert_media_doc`：text + embedding_ver 都没变 → `ON CONFLICT … WHERE` 不命中，
// 整行不动。所以"跑一半断了再跑"是安全的，代价只是把已经写过的行再比一次。
//
// # 只搬 4096 那一列
//
// 云上不灌 768：省一半空间（约 1 GB），也避免"两条向量列谁说了算"的歧义。
// 没有向量时 `media_search` 的词法分支照常工作，向量分支走 `media_search_4096`。
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { maskUrl, parsePsqlOutput, toPsqlScript } from './material-doc-index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_FILE = path.join(ROOT, 'infra', 'docker-compose.yml');
const LOCAL_DB = 'orange';
const CLOUD_IMAGE = 'postgres:17';
const SYNC_SCHEMA = 'orange/media-doc-sync/1';

export function defaultOptions() {
  return {
    tenant: 'tenant-a',
    analyzerVer: 'card-meta-2',
    dbUrl: '',
    batch: 200,
    limit: 0,
    dryRun: false,
    progressFile: path.join(ROOT, '.dev', 'material-doc', 'sync-cloud.json'),
    /* 增量补传：只搬 `ops.cloud_uploaded` 里没有的 media_key（默认整表重扫，幂等但慢）。 */
    missingOnly: false,
    uploadedTable: 'ops.cloud_uploaded',
    metadataOnly: false,
    vectorColumn: '',
    dims: 4096,
    embeddingVer: 'qwen3-embedding-8b',
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
      case '--db-url': options.dbUrl = value(); break;
      case '--batch': options.batch = Number(value()); break;
      case '--limit': options.limit = Number(value()); break;
      case '--progress': options.progressFile = value(); break;
      case '--dry-run': options.dryRun = true; break;
      /* 只补云上还缺的那些：靠 `ops.cloud_uploaded` 这张对照表（由 psql 从云上 key 列表灌进来）。 */
      case '--missing-only': options.missingOnly = true; break;
      /* 轻量档两段式的第一段：只建行、不带向量（upsert_media_doc 不认 512 列）。 */
      case '--metadata-only': options.metadataOnly = true; break;
      /* 第二段：把某一列向量按 media_key 补上去（--vector-column embedding_512 --dims 512）。 */
      case '--vector-column': options.vectorColumn = value(); break;
      case '--dims': options.dims = Number(value()); break;
      case '--embedding-ver': options.embeddingVer = value(); break;
      case '--uploaded-table': options.uploadedTable = value(); break;
      case '--help':
      case '-h':
        console.log('usage: node scripts/media-doc-sync.mjs [--db-url URL] [--tenant KEY] [--analyzer-ver VER] '
          + '[--batch 50..500] [--limit N] [--progress PATH] [--dry-run]');
        console.log('  只搬 embedding_4096（本机已算好），走 public.upsert_media_doc，可重入。');
        return null;
      default:
        if (flag.startsWith('--')) throw new Error(`未知参数 ${flag}（--help 看用法）`);
    }
  }
  if (!Number.isInteger(options.batch) || options.batch < 1 || options.batch > 500) throw new Error('--batch 取 1..500');
  if (!Number.isFinite(options.limit) || options.limit < 0) throw new Error('--limit 必须是 ≥0 的整数');
  return options;
}

function sh(command, args, { input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(command, args, { cwd: ROOT, windowsHide: true, maxBuffer: 512 * 1024 * 1024, timeout: 30 * 60 * 1000 },
      (error, stdout, stderr) => resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      }));
    if (input !== undefined) {
      /* 同 material-doc-index.mjs：容器被 OOM 杀掉时 stdin 会 EPIPE，没有监听者就会带崩进程。 */
      child.stdin?.on('error', () => {});
      child.stdin?.end(input);
    }
  });
}

/** 本机库：一个会话一个租户 GUC（010 的租户判据），读一批待搬的行。 */
export function makeLocalPsql() {
  return (script) => sh('docker', ['compose', '-f', COMPOSE_FILE, 'exec', '-T', 'db',
    'psql', '-U', 'postgres', '-d', LOCAL_DB, '-qAt', '-v', 'ON_ERROR_STOP=0'], { input: script });
}

/** 云库：同样的会话模式，但客户端在容器里（本机没有 psql）。 */
export function makeCloudPsql(options) {
  const url = String(options.dbUrl ?? '').trim();
  if (!url) throw new Error('缺少 --db-url（云端 session 直连 5432 的连接串）');
  return (script) => sh('docker', ['run', '--rm', '-i', CLOUD_IMAGE, 'psql', url, '-qAt', '-v', 'ON_ERROR_STOP=0'], { input: script });
}

const sqlLiteral = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * 一行库内记录 → `upsert_media_doc` 的载荷。**只带 4096 那一列的向量**（云上不灌 768）。
 * 键名与 012/014 的 `p_row` 完全一致；多一个键会被 RPC 忽略，少一个就是丢字段。
 *
 * `--metadata-only` 时载荷里不带任何向量：轻量档（512）走"先建行、再单独 update 512 列"两段式，
 * 因为 `upsert_media_doc` 只认 768 / 4096 两列，硬塞第三列会被它忽略（看起来成功、实际什么都没写）。
 */
export function payloadOf(row, options) {
  const payload = {
    media_key: row.media_key,
    analyzer_ver: row.analyzer_ver ?? options.analyzerVer,
    gran: row.gran ?? 'asset',
    video_id: row.video_id,
    shot_index: row.shot_index ?? 0,
    name: row.name,
    batch: row.batch,
    product: row.product,
    gname: row.gname,
    labels: Array.isArray(row.labels) ? row.labels : [],
    duration_ms: row.duration_ms,
    author: row.author,
    source_kind: row.source_kind ?? 'cloud',
    text: row.text,
  };
  if (options.metadataOnly) return payload;
  return {
    ...payload,
    one_level: row.one_level,
    two_level: row.two_level,
    embedding_ver_4096: row.embedding_ver_4096,
    embedding_4096: row.embedding_4096,
  };
}

/**
 * 一批 `(media_key, 向量)` → 一条多行 `update … from (values …)`。
 *
 * 为什么用 update 而不是 upsert：`upsert_media_doc` 只认 768 / 4096 两列，512 那列它不认识。
 * 行先由 `--metadata-only` 建好，这里只补向量；`is distinct from` 守卫让重跑变成 no-op。
 */
export function vectorUpdateSql(options, column, dims, rows) {
  const values = rows
    .map((row) => `(${sqlLiteral(row.media_key)}, ${sqlLiteral(row[column])}::vector(${dims}))`)
    .join(',\n    ');
  return [
    `set app.company_key = ${sqlLiteral(options.tenant)};`,
    'update public.media_doc d',
    `   set ${column} = v.vec, ${column.replace('embedding', 'embedding_ver')} = ${sqlLiteral(options.embeddingVer ?? 'qwen3-embedding-8b')}`,
    '  from (values',
    `    ${values}`,
    '  ) as v(media_key, vec)',
    ` where d.analyzer_ver = ${sqlLiteral(options.analyzerVer)}`,
    '   and d.superseded_at is null',
    '   and d.media_key = v.media_key',
    `   and d.${column} is distinct from v.vec;`,
    '',
  ].join('\n');
}

/**
 * 断点是 **offset** 而不是 lastKey。
 *
 * 为什么不能按 media_key 做 keyset：本机这张表是"边跑边填"的——回填按索引顺序写，写进来的 key
 * 在 media_key 序上是散落的。从最小的 key 往后翻，一旦翻过当前已写的最大 key 就"没有下一行"了，
 * 而实际上还有上万行躺在更小的 key 上（第一次跑就在 600 条处提前收工）。
 * offset 分页对"集合仍在长大"的源也成立：多搬的会被 upsert 变成 noop，漏掉的由最终一遍补齐。
 */
export function readProgress(file) {
  if (!existsSync(file)) return { offset: 0 };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return { offset: Number(raw.offset ?? 0) };
  } catch {
    return { offset: 0 };
  }
}

export function writeProgress(file, state) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify({ schema: SYNC_SCHEMA, updatedAt: new Date().toISOString(), ...state }));
  renameSync(temp, file);
}

/** 取一批（offset 分页；order by media_key 固定顺序，offset 就是断点）。 */
function selectBatchScript(options, offset, take) {
  return [
    `set app.company_key = ${sqlLiteral(options.tenant)};`,
    "select coalesce(json_agg(r order by media_key), '[]'::json) from (",
    '  select media_key, analyzer_ver, gran, video_id, shot_index, name, batch, product, gname, labels,',
    '         duration_ms, author, source_kind, text, one_level, two_level, embedding_ver_4096, embedding_4096::text as embedding_4096,',
    /* 轻量档：把目标列一起取出来（作为文本，pgvector 的输出可以直接再灌回去）。
       注意这一行是 SELECT 列表的最后一项，**不能带尾逗号**（多了就是 `..., from ...` 的语法错，
       而 psql 在 ON_ERROR_STOP=0 下只会把错误写进 stderr，看起来像"读到 0 行"）。 */
    options.vectorColumn
      ? `         ${options.vectorColumn}::text as ${options.vectorColumn}`
      : '         NULL::text as no_extra_vector',
    '    from public.media_doc',
    `   where analyzer_ver = ${sqlLiteral(options.analyzerVer)}`,
    '     and superseded_at is null',
    /* 4096 那列在轻量档里可以不要求（云上根本不灌它）。 */
    options.vectorColumn
      ? `     and ${options.vectorColumn} is not null`
      : '     and embedding_4096 is not null',
    options.missingOnly
      ? `     and media_key not in (select media_key from ${options.uploadedTable})`
      : '',
    '   order by media_key',
    `   limit ${take} offset ${offset}`,
    ') r;',
    '',
  ].filter(Boolean).join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return 0;

  /* 云端数据面已删（Supabase 只留 auth）。这个脚本原本只做一件事：把 media_doc 推到云端。
     现在它的用途只剩考古，所以默认直接停住，并说清替代品 —— 静默连一个不存在的库是最坏的结果。 */
  if (process.env.OPENFILM_ALLOW_RETIRED_CLOUD !== '1') {
    console.error('已停用：Supabase 的数据面在 2026-11-18 删掉了（只留 auth）。向量现在打成包随客户端分发：\n'
      + '  node scripts/material-vector-pack.mjs --out .dev/vector-pack\n'
      + '  node scripts/material-pack-publish.mjs --out dist/materials [--base-url URL]\n'
      + '确实要考古这一次推送（比如某个旧库还没删）：OPENFILM_ALLOW_RETIRED_CLOUD=1');
    return 2;
  }

  const local = makeLocalPsql();
  const progress = options.dryRun ? { offset: 0 } : readProgress(options.progressFile);
  const cloud = options.dryRun ? null : makeCloudPsql(options);

  console.log(`同步 ${options.tenant} analyzer_ver=${options.analyzerVer} 4096 维`
    + `${options.dbUrl ? ` → ${maskUrl(options.dbUrl)}` : ''}`);
  console.log(`断点：offset=${progress.offset}`
    + `${options.dryRun ? '（--dry-run：只读本机，不写云库）' : ''}`);

  let offset = progress.offset;
  let done = 0;
  let batches = 0;
  let written = 0;
  let noop = 0;
  const failures = new Map();
  const startedAt = Date.now();
  const total = options.limit || null;

  for (;;) {
    const take = options.limit ? Math.min(options.batch, options.limit - done) : options.batch;
    if (take <= 0) break;
    const batchScript = selectBatchScript(options, offset, take);
    if (process.env.SYNC_DEBUG) console.error(batchScript);
    const read = await local(batchScript);
    if (read.code !== 0) {
      console.error(`读本机失败：${String(read.stderr).split(/\r?\n/).filter(Boolean)[0] ?? read.code}`);
      return 1;
    }
    let rows;
    try {
      rows = JSON.parse(String(read.stdout).trim() || '[]');
    } catch (error) {
      console.error(`本机返回的不是 JSON：${error?.message ?? error}`);
      return 1;
    }
    if (!Array.isArray(rows) || !rows.length) break;

    const payloads = rows.map((row) => payloadOf(row, options));
    batches += 1;
    if (options.dryRun) {
      console.log(`  ${payloads[0].media_key} … ${payloads[payloads.length - 1].media_key}`
        + `（${payloads.length} 条${options.metadataOnly ? '，不带向量' : ''}）`);
    } else if (options.vectorColumn) {
      /* 第二段：只把某一列向量补上去（行已经由 --metadata-only 建好）。 */
      /* 一批一个事务：否则 300 行就是 300 次自动提交，跨区往返把吞吐压到 2–3 条/秒。 */
      const script = ['begin;', vectorUpdateSql(options, options.vectorColumn, options.dims, rows), 'commit;'].join('\n');
      const write = await cloud(script);
      if (write.code !== 0) {
        const reason = String(write.stderr).split(/\r?\n/).filter(Boolean)[0] ?? `exit ${write.code}`;
        const slot = failures.get(reason) ?? { count: 0, samples: [] };
        slot.count += payloads.length;
        slot.samples.push(payloads[0].media_key);
        failures.set(reason, slot);
      } else {
        const updated = Number(String(write.stdout).match(/UPDATE (\d+)/)?.[1] ?? 0);
        written += updated;
        noop += payloads.length - updated;
      }
    } else {
      /* 一批一条语句：把 300 行装进一个 jsonb 数组，用 `jsonb_array_elements` 逐元素调 upsert。
         为什么不像本地回填那样一行一条：本地是 unix socket、一行一次"往返"几乎免费；云端要跨区过
         Supavisor，一行一条实测被压到 2–3 条/秒（67k 要七小时）。一条语句把往返摊到整批上。
         代价是**整批原子**：某一行坏掉会带走这一批 —— 所以失败时仍回落到逐行重放（下面那段）。 */
      const script = [
        'begin;',
        `set app.company_key = ${sqlLiteral(options.tenant)};`,
        `select count(*) from jsonb_array_elements($mdocbatch$${JSON.stringify(payloads)}$mdocbatch$::jsonb) e `
          + 'where public.upsert_media_doc(e) is not null;',
        'commit;',
        '',
      ].join('\n');
      const write = await cloud(script);
      const parsed = parsePsqlOutput(write.stdout);
      /* bulk 语句只回**一行** `count(*)`（不是每行一个信封），所以这里不能用"信封数 == 行数"判成功；
         只有 psql 真的报错才回落到逐行重放（那时才需要定位到哪个 media_key 坏了）。 */
      if (write.code === 0) {
        const processed = Number(String(write.stdout).trim().match(/^(\d+)/)?.[1] ?? payloads.length);
        written += processed;
        noop += Math.max(0, payloads.length - processed);
      } else if (parsed.results.length !== payloads.length) {
        for (const payload of payloads) {
          const one = await cloud(['begin;', toPsqlScript([payload], options.tenant), 'commit;'].join('\n'));
          const result = parsePsqlOutput(one.stdout);
          if (result.results.length === 1) {
            if (result.results[0].written) written += 1; else noop += 1;
          } else {
            const reason = String(one.stderr).split(/\r?\n/).filter(Boolean)[0] ?? '无输出';
            const slot = failures.get(reason) ?? { count: 0, samples: [] };
            slot.count += 1;
            if (slot.samples.length < 3) slot.samples.push(payload.media_key);
            failures.set(reason, slot);
          }
        }
      } else {
        for (const result of parsed.results) {
          if (result.written) written += 1; else noop += 1;
        }
      }
    }

    offset += payloads.length;
    done += payloads.length;
    if (!options.dryRun) writeProgress(options.progressFile, { offset, done, batch: batches });
    const rate = done / Math.max(0.001, (Date.now() - startedAt) / 1000);
    console.log(`[${batches}] done=${done}${total ? `/${total}` : ''} ${rate.toFixed(1)}/s `
      + `written=${written} noop=${noop} fail=${[...failures.values()].reduce((s, v) => s + v.count, 0)} `
      + `offset=${offset}`);
  }

  console.log(`\n同步结束：${done} 条，written=${written} noop=${noop}，批次 ${batches}，`
    + `耗时 ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);
  for (const [reason, slot] of failures) console.log(`  FAIL ×${slot.count} ${reason}（例：${slot.samples.join(', ')}）`);
  return failures.size ? 1 : 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exit(1);
  });
}
