#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// 同一个题库、同一份语料，比较两个嵌入模型（或同一模型的另一维投影）的纯向量召回。
//
//   node scripts/bench-embed-model.mjs --from-column embedding_512 --dims 512      # 8B 的基线（库里已有向量）
//   node scripts/bench-embed-model.mjs --model text-embedding-qwen3-embedding-0.6b --dims 512
//
// # 为什么用"精确扫描"而不是 RPC
//
// 要比的是**模型**，不是索引。所以这里把查询向量和每一条文档向量都放在内存里做精确余弦，
// 谁都没占便宜（RPC 那条路还会叠词法分支与 RRF，那是另一个问题——它已经在 020 里单独量过）。
//
// # 题库与语料固定
//
// 60 道题不够说明问题，200 道；题面 = 产品 + 分组（用户真会说的一句话），题行取 `md5(media_key)` 排序的前 N 条
// —— 确定性，两次跑比较的是同一批。
//
// 指标：hit@1（题行排第一）、recall@20（题行进前 20）、同组命中（前 20 里出现同产品同分组的任意一行）。
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_FILE = path.join(ROOT, 'infra', 'docker-compose.yml');
const LOCAL_DB = 'orange';

export function defaultOptions() {
  return {
    tenant: 'tenant-a',
    analyzerVer: 'card-meta-2',
    sample: 200,
    limit: 20,
    dims: 512,
    model: '',
    fromColumn: '',
    endpoint: 'http://127.0.0.1:1235/v1/embeddings',
    batch: 32,
    /* 只在前 N 条候选里排名（按 media_key 序）：两个模型用同一个子集，比较仍然公平，编码时间降到几分之一 */
    corpusLimit: 0,
    /* 给了就把算出来的向量写回这一列（新列 + 新版本号），用于换模型时的全量重算 */
    writeColumn: '',
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
      case '--dims': options.dims = Number(value()); break;
      case '--model': options.model = value(); break;
      case '--from-column': options.fromColumn = value(); break;
      case '--endpoint': options.endpoint = value(); break;
      case '--batch': options.batch = Number(value()); break;
      case '--corpus-limit': options.corpusLimit = Number(value()); break;
      case '--write-column': options.writeColumn = value(); break;
      case '--help':
      case '-h':
        console.log('usage: node scripts/bench-embed-model.mjs [--model ID --dims 512] [--from-column COLUMN] '
          + '[--sample 200] [--limit 20] [--batch 32]');
        return null;
      default:
        if (flag.startsWith('--')) throw new Error(`未知参数 ${flag}`);
    }
  }
  if (!options.model && !options.fromColumn) throw new Error('要么给 --model（现算），要么给 --from-column（库里已有）');
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

/** MRL 截断：取前 `dims` 维再归一化（余弦只看向量方向，截断后重归一才和其它向量可比）。 */
export function truncate(vector, dims) {
  if (vector.length === dims) return normalize(vector);
  return normalize(vector.slice(0, dims));
}

/** @param {ArrayLike<number>} vector */
export function normalize(vector) {
  let sum = 0;
  for (let i = 0; i < vector.length; i += 1) sum += vector[i] * vector[i];
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) out[i] = vector[i] / norm;
  return out;
}

/** 余弦（两边都已归一化时就是点积）。 */
export function cosine(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

/** 一条查询在全部候选里的前 `limit` 条（下标）。 */
export function topK(query, docs, count, limit) {
  /** @type {{index: number, score: number}[]} */
  const best = [];
  for (let i = 0; i < count; i += 1) {
    const score = cosine(query, docs[i]);
    if (best.length < limit || score > best[best.length - 1].score) {
      let at = best.length;
      while (at > 0 && best[at - 1].score < score) at -= 1;
      best.splice(at, 0, { index: i, score });
      if (best.length > limit) best.pop();
    }
  }
  return best;
}

async function embedBatch(endpoint, model, texts) {
  const response = await fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: texts }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw new Error(`embedding HTTP ${response.status}: ${(await response.text()).slice(0, 160)}`);
  const body = await response.json();
  const rows = Array.isArray(body?.data) ? body.data : [];
  if (rows.length !== texts.length) throw new Error(`端点回了 ${rows.length} 条向量，问了 ${texts.length} 条`);
  return rows.map((row) => /** @type {number[]} */ (row.embedding));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return 0;
  const label = options.fromColumn ? `列 ${options.fromColumn}（${options.dims} 维）` : `${options.model} → 截 ${options.dims} 维`;
  console.log(`语料：${options.analyzerVer} live 行；题数 ${options.sample}；每组看前 ${options.limit}；${label}`);

  const read = await psql([
    `set app.company_key = ${sqlLiteral(options.tenant)};`,
    "select coalesce(json_agg(r order by media_key), '[]'::json) from (",
    '  select media_key, text, product, gname',
    '    from public.media_doc',
    `   where analyzer_ver = ${sqlLiteral(options.analyzerVer)}`,
    '     and superseded_at is null and text is not null',
    '   order by media_key',
    ') r;',
    '',
  ].join('\n'));
  if (read.code !== 0) {
    console.error(`读语料失败：${String(read.stderr).split(/\r?\n/).filter(Boolean)[0] ?? read.code}`);
    return 1;
  }
  let rows = JSON.parse(String(read.stdout).trim() || '[]');
  if (options.corpusLimit > 0) rows = rows.slice(0, options.corpusLimit);
  if (!rows.length) { console.error('没有可用的语料行'); return 1; }
  const count = rows.length;
  console.log(`候选 ${count} 条`);

  /** @type {Float32Array[]} */
  const docs = [];
  const startedAt = Date.now();
  if (options.fromColumn) {
    /* 库里已有的向量：一次取完（67k × 512 个浮点 ≈ 137 MB 文本，分块读） */
    const chunk = 2000;
    for (let offset = 0; offset < count; offset += chunk) {
      const script = [
        `set app.company_key = ${sqlLiteral(options.tenant)};`,
        'select coalesce(json_agg(x order by media_key), \'[]\'::json) from (',
        `  select media_key, ${options.fromColumn}::text as vec`,
        '    from public.media_doc',
        `   where analyzer_ver = ${sqlLiteral(options.analyzerVer)}`,
        `     and superseded_at is null and ${options.fromColumn} is not null`,
        `   order by media_key limit ${chunk} offset ${offset}`,
        ') x;',
        '',
      ].join('\n');
      const part = await psql(script);
      if (part.code !== 0) { console.error(`读向量失败：${String(part.stderr).split(/\r?\n/)[0]}`); return 1; }
      const got = JSON.parse(String(part.stdout).trim() || '[]');
      if (!got.length) break;
      for (const row of got) {
        const numbers = String(row.vec).replace(/^\[|\]$/g, '').split(',').map(Number);
        docs.push(truncate(numbers, options.dims));
      }
      process.stdout.write(`\r  读向量 ${docs.length}/${count}`);
    }
    process.stdout.write('\n');
  } else {
    for (let offset = 0; offset < count; offset += options.batch) {
      const slice = rows.slice(offset, offset + options.batch);
      const vectors = await embedBatch(options.endpoint, options.model, slice.map((row) => String(row.text)));
      const normalized = vectors.map((vector) => truncate(vector, options.dims));
      for (const vector of normalized) docs.push(vector);
      /* `--write-column`：换模型时必须把**文档**也用新模型重算，否则查询和库里是两个空间 */
      if (options.writeColumn) {
        const values = slice.map((row, at) => `(${sqlLiteral(row.media_key)}, '[${Array.from(normalized[at]).join(',')}]'::vector(${options.dims}))`).join(',\n      ');
        const write = await psql([
          `set app.company_key = ${sqlLiteral(options.tenant)};`,
          `update public.media_doc d set ${options.writeColumn} = v.vec`,
          '  from (values',
          `      ${values}`,
          '  ) as v(media_key, vec)',
          ` where d.analyzer_ver = ${sqlLiteral(options.analyzerVer)}`,
          '   and d.superseded_at is null',
          '   and d.media_key = v.media_key;',
          '',
        ].join('\n'));
        if (write.code !== 0) { console.error(`写 ${options.writeColumn} 失败：${String(write.stderr).split(/\r?\n/)[0]}`); return 1; }
      }
      if ((offset / options.batch) % 20 === 0) {
        const rate = docs.length / Math.max(0.001, (Date.now() - startedAt) / 1000);
        process.stdout.write(`\r  编码 ${docs.length}/${count}  ${rate.toFixed(0)}/s${options.writeColumn ? `  写入 ${options.writeColumn}` : ''}`);
      }
    }
    process.stdout.write('\n');
  }
  console.log(`向量就绪：${docs.length} 条，用时 ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);

  /* 题库：md5(media_key) 序的前 N 条（确定性），题面 = 产品 + 分组 */
  const questions = [...rows].sort((a, b) => {
    const key = (/** @type {string} */ s) => {
      let h = 0;
      for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
      return h;
    };
    return key(a.media_key) - key(b.media_key);
  }).filter((row) => String(row.product ?? '').trim() || String(row.gname ?? '').trim()).slice(0, options.sample);

  const indexOf = new Map(rows.map((row, index) => [row.media_key, index]));
  let hit1 = 0;
  let in20 = 0;
  let group20 = 0;
  let answered = 0;
  for (const question of questions) {
    const text = [question.product, question.gname].filter(Boolean).join(' ').trim();
    if (!text) continue;
    let query;
    if (options.fromColumn) {
      /* 基线那条路：查询向量同样要现算（8B），用它自己的模型名 */
      const [vector] = await embedBatch(options.endpoint, 'text-embedding-qwen3-embedding-8b', [text]);
      query = truncate(vector, options.dims);
    } else {
      const [vector] = await embedBatch(options.endpoint, options.model, [text]);
      query = truncate(vector, options.dims);
    }
    const best = topK(query, docs, docs.length, options.limit);
    answered += 1;
    const at = best.findIndex((hit) => hit.index === indexOf.get(question.media_key));
    if (at === 0) hit1 += 1;
    if (at >= 0) in20 += 1;
    const sameGroup = best.some((hit) => {
      const row = rows[hit.index];
      return row.product === question.product && row.gname === question.gname;
    });
    if (sameGroup) group20 += 1;
  }

  const pct = (n) => `${((n / Math.max(1, answered)) * 100).toFixed(1)}%`;
  console.log(`\n${label}`);
  console.log(`题数 ${answered}  hit@1 ${pct(hit1)}  recall@${options.limit} ${pct(in20)}  同组 ${pct(group20)}`);
  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exit(1);
  });
}
