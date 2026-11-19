#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// 4096（qwen3-embedding-8b）vs 768（nomic）在同一份语料上的召回对照。
//
//   node scripts/bench-recall.mjs --sample 200
//   node scripts/bench-recall.mjs --sample 200 --json .dev/material-doc/recall.json
//
// # 为什么这样造题
//
// 没有人工标注的问答对，所以**用库里自己的行出题**：抽一行，拿它的 `产品 + 分组 + 二级分类`
// 拼一个短查询（不是它的全文——全文等于把答案抄进题面，词法分支会白送分），然后看这条行
// 能不能被找回来。指标三个：
//   hit@1    源行排第一的比例（最严）
//   recall@20 源行进前 20 的比例（给"同标题多文件"留余量）
//   recall@20·组  前 20 里出现**同产品同分组**的任意一行的比例（业务上等价于"找对了素材"）
//
// 两个模型各跑一遍，同一批题、同一个 RPC（只有向量列不同），差异只来自向量空间本身。
// 每题的查询向量只算一次、两个模型各自算自己的；延迟也分开记，因为 8B 慢是事实。
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_FILE = path.join(ROOT, 'infra', 'docker-compose.yml');
const LOCAL_DB = 'orange';

export const MODELS = Object.freeze({
  qwen3_4096: { dims: 4096, model: 'text-embedding-qwen3-embedding-8b', rpc: 'media_search_4096' },
  nomic_768: { dims: 768, model: 'text-embedding-nomic-embed-text-v1.5', rpc: 'media_search' },
  /* 4096 维的 MRL 前 1024 维投影：查询侧把 8B 的向量截前 1024 维，直接对列做近邻。
     不经过 RPC（RPC 断言 4096 维），这样能在不改任何迁移的前提下先把质量问出来。 */
  qwen3_1024: { dims: 4096, model: 'text-embedding-qwen3-embedding-8b', column: 'embedding_1024', truncate: 1024 },
  /* 更轻的 MRL 投影：免费额度里能装下的一档（存 139 MB + 索引 161 MB ≈ 300 MB）。 */
  qwen3_512: { dims: 4096, model: 'text-embedding-qwen3-embedding-8b', column: 'embedding_512', truncate: 512 },
  /* 512 的完整混合路径（走 media_search_512 的 RPC：向量 + 词法三路 + RRF）—— 云端实际用的就是这个。 */
  qwen3_512_hybrid: { dims: 4096, model: 'text-embedding-qwen3-embedding-8b', rpc: 'media_search_512', truncate: 512 },
});

export function defaultOptions() {
  return {
    tenant: 'tenant-a',
    analyzerVer: 'card-meta-2',
    sample: 200,
    limit: 20,
    endpoint: 'http://127.0.0.1:1235/v1/embeddings',
    timeoutMs: 60_000,
    json: '',
    hybrid: false,
    only: '',
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
      case '--sample': options.sample = Number(value()); break;
      case '--limit': options.limit = Number(value()); break;
      case '--endpoint': options.endpoint = value(); break;
      case '--json': options.json = value(); break;
      /* 走产品里的完整混合路径（把题面当 p_query 传进去），而不是只测向量分支。 */
      case '--hybrid': options.hybrid = true; break;
      /* 只跑其中一个模型（省时间：只想看某一档的时候不必把三档都跑一遍）。 */
      case '--only': options.only = value(); break;
      case '--help':
      case '-h':
        console.log('usage: node scripts/bench-recall.mjs [--sample 200] [--limit 20] [--tenant KEY] '
          + '[--analyzer-ver VER] [--json PATH]');
        return null;
      default:
        if (flag.startsWith('--')) throw new Error(`未知参数 ${flag}`);
    }
  }
  if (!Number.isInteger(options.sample) || options.sample < 1) throw new Error('--sample 必须是正整数');
  return options;
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

const sqlLiteral = (value) => `'${String(value).replace(/'/g, "''")}'`;

function psql(script) {
  return sh('docker', ['compose', '-f', COMPOSE_FILE, 'exec', '-T', 'db',
    'psql', '-U', 'postgres', '-d', LOCAL_DB, '-qAt', '-v', 'ON_ERROR_STOP=1'], { input: script });
}

/**
 * 抽题：按 `md5(media_key)` 排序取前 N —— 确定性（同样的库、同样的 N 永远是同一批题），
 * 又不会因为 `media_key` 前缀而只挑到同一批产品。
 *
 * 题面用 `产品 + 分组 + 二级分类`：这是用户会说的话（"柠檬宝藏茶 外包装"），
 * 又不是这行的全文（全文里还有标签、时长、作者，词法分支会因此白送分）。
 */
export function buildQuestionSql(options) {
  return [
    `set app.company_key = ${sqlLiteral(options.tenant)};`,
    "select coalesce(json_agg(q order by media_key), '[]'::json) from (",
    '  select media_key, name, product, gname,',
    "         btrim(regexp_replace(concat_ws(' ', nullif(product, ''), nullif(gname, ''), array_to_string(labels[1:2], ' '), nullif(name, '')), '\\s+', ' ', 'g')) as long_query,",
    /* 短查询只要 产品 + 分组：这是用户真会说的一句话。把标签塞进去就变成
       "宴山藏大红袍 料子 料子(配料/茶干/配料表)" 这种机器拼出来的串，评的不是检索能力。 */
    "         btrim(regexp_replace(concat_ws(' ', nullif(product, ''), nullif(gname, '')), '\\s+', ' ', 'g')) as short_query",
    '    from public.media_doc',
    `   where analyzer_ver = ${sqlLiteral(options.analyzerVer)}`,
    '     and superseded_at is null and embedding is not null and embedding_4096 is not null',
    "     and coalesce(nullif(btrim(product), ''), nullif(btrim(gname), '')) is not null",
    '   order by md5(media_key)',
    `   limit ${Number(options.sample)}`,
    ') q;',
    '',
  ].join('\n');
}

/** 一条文本 → 向量。维度不对直接抛（换模型就是换向量空间，不该悄悄降级）。 */
export async function embed(endpoint, model, dims, text, timeoutMs = 60_000) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: text }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`嵌入端点 HTTP ${response.status}：${(await response.text()).slice(0, 160)}`);
  const body = await response.json();
  const vector = body?.data?.[0]?.embedding;
  if (!Array.isArray(vector)) throw new Error('嵌入响应缺 data[0].embedding');
  if (vector.length !== dims) throw new Error(`模型 ${model} 返回 ${vector.length} 维，期望 ${dims}`);
  return vector;
}

const toLiteral = (vector) => `'[${vector.map((n) => (Number.isFinite(n) ? Number(n.toFixed(7)) : 0)).join(',')}]'::vector`;

/** 直接对某一列做近邻（MRL 投影用）：查询向量先截前 `spec.truncate` 维，与列同维。 */
export function columnSearchSql(options, spec, vector, limit) {
  const cut = spec.truncate ? vector.slice(0, spec.truncate) : vector;
  const literal = toLiteral(cut);
  return [
    `set app.company_key = ${sqlLiteral(options.tenant)};`,
    "select coalesce(json_agg(t order by ord), '[]'::json) from (",
    '  select row_number() over () as ord, media_key, product, gname',
    '    from public.media_doc',
    `   where analyzer_ver = ${sqlLiteral(options.analyzerVer)}`,
    '     and superseded_at is null',
    `     and ${spec.column} is not null`,
    `   order by ${spec.column} <=> ${literal}`,
    `   limit ${limit}`,
    ') t;',
    '',
  ].join('\n');
}
/**
 * 查一次：返回前 limit 条的 media_key / product / gname。
 *
 * `queryText` 传空串 ⇒ 只测向量分支（词法/三元组/分词全关，专门用来比向量空间）；
 * 传真实查询 ⇒ 走产品里的混合路径（向量 + ILIKE + trigram + 分词，由 RPC 自己合并去重）。
 */
export function searchSql(options, rpc, literal, limit, queryText = '') {
  return [
    `set app.company_key = ${sqlLiteral(options.tenant)};`,
    `select coalesce(json_agg(t order by ord), '[]'::json) from (`,
    '  select row_number() over () as ord, media_key, product, gname',
    `    from public.${rpc}(${sqlLiteral(options.tenant)}, ${sqlLiteral(queryText)}, '{}'::jsonb, ${literal}, ${limit})`,
    ') t;',
    '',
  ].join('\n');
}

/**
 * 一个模型的成绩。`answered` 记录每题命中情况，便于复核（哪题错的、错成什么）。
 * @param {{key: string, rows: any[]}} input
 */
export function scoreRows(key, rows) {
  const hits = rows.filter((row) => row.hit1).length;
  const rec20 = rows.filter((row) => row.rank !== null).length;
  const group20 = rows.filter((row) => row.groupIn20).length;
  const latency = rows.map((row) => row.latencyMs).sort((a, b) => a - b);
  const p50 = latency.length ? latency[Math.floor(latency.length / 2)] : 0;
  const p95 = latency.length ? latency[Math.min(latency.length - 1, Math.floor(latency.length * 0.95))] : 0;
  return {
    key,
    questions: rows.length,
    hit1: hits,
    hit1Rate: rows.length ? hits / rows.length : 0,
    recall20: rec20,
    recall20Rate: rows.length ? rec20 / rows.length : 0,
    group20,
    group20Rate: rows.length ? group20 / rows.length : 0,
    p50Ms: Math.round(p50),
    p95Ms: Math.round(p95),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return 0;

  const read = await psql(buildQuestionSql(options));
  if (read.code !== 0) {
    console.error(`抽题失败：${String(read.stderr).split(/\r?\n/).filter(Boolean)[0] ?? read.code}`);
    return 1;
  }
  const questions = JSON.parse(String(read.stdout).trim() || '[]');
  if (!questions.length) {
    console.error('没有可用的题（库里需要有带 768 与 4096 两列向量的 live 行）');
    return 1;
  }
  console.log(`题数 ${questions.length}（按 md5(media_key) 取前 N，确定性），每题看前 ${options.limit} 条`);

  const results = {};
  for (const [key, spec] of Object.entries(MODELS)) {
    if (options.only && options.only !== key) continue;
    const answered = [];
    for (const [index, question] of questions.entries()) {
      const query = question.short_query || question.long_query;
      let vector;
      try {
        vector = await embed(options.endpoint, spec.model, spec.dims, query, options.timeoutMs);
      } catch (error) {
        console.error(`${key} 第 ${index + 1} 题嵌入失败：${error.message}`);
        return 1;
      }
      const startedAt = Date.now();
      /* `column` 的模型走直接近邻（不经 RPC），因为 RPC 断言的是 4096 维；
         `truncate` 表示这是 MRL 投影：查询向量也截前 N 维，两边同维才可比。 */
      const queryVector = spec.truncate ? vector.slice(0, spec.truncate) : vector;
      const sql = spec.column
        ? columnSearchSql(options, spec, vector, options.limit)
        : searchSql(options, spec.rpc, toLiteral(queryVector), options.limit, options.hybrid || spec.truncate ? question.short_query || question.long_query : '');
      const found = await psql(sql);
      const latencyMs = Date.now() - startedAt;
      if (found.code !== 0) {
        console.error(`${key} 第 ${index + 1} 题检索失败：${String(found.stderr).split(/\r?\n/).filter(Boolean)[0]}`);
        return 1;
      }
      const rows = JSON.parse(String(found.stdout).trim() || '[]');
      const position = rows.findIndex((row) => row.media_key === question.media_key);
      const sameGroup = Boolean(question.product)
        && rows.some((row) => row.product === question.product && row.gname === question.gname);
      answered.push({
        mediaKey: question.media_key,
        query,
        rank: position === -1 ? null : position + 1,
        hit1: position === 0,
        groupIn20: sameGroup,
        latencyMs,
        topKeys: rows.slice(0, 3).map((row) => row.media_key),
      });
      if ((index + 1) % 25 === 0) process.stdout.write(`  ${key}: ${index + 1}/${questions.length}\n`);
    }
    results[key] = { ...scoreRows(key, answered), answered };
  }

  const pct = (value) => `${(value * 100).toFixed(1)}%`;
  console.log('\n模型 | hit@1 | recall@20 | recall@20·同组 | p50 | p95');
  console.log('- | - | - | - | - | -');
  for (const summary of Object.values(results)) {
    console.log(`${summary.key} | ${pct(summary.hit1Rate)} | ${pct(summary.recall20Rate)} | `
      + `${pct(summary.group20Rate)} | ${summary.p50Ms} ms | ${summary.p95Ms} ms`);
  }

  if (options.json) {
    mkdirSync(path.dirname(options.json), { recursive: true });
    writeFileSync(options.json, JSON.stringify({
      generatedAt: new Date().toISOString(),
      tenant: options.tenant,
      analyzerVer: options.analyzerVer,
      sample: questions.length,
      limit: options.limit,
      results,
    }, null, 2));
    console.log(`\n明细 → ${options.json}`);
  }
  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exit(1);
  });
}
