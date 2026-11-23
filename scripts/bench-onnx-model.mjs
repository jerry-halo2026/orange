#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// 用一个 **ONNX 模型**（客户端要跑的那条路）在本地语料上排名，量和 bge-m3 同样的题。
//
//   node scripts/bench-onnx-model.mjs --model-dir packages/orangefilm/library/models/bge-small-zh-onnx --dims 512
//   node scripts/bench-onnx-model.mjs --model-dir … --query-prefix "为这个句子生成表示以用于检索相关文章："
//
// # 为什么单独一个脚本
//
// `bench-embed-model.mjs` 走 LM Studio 的 HTTP 端点（GGUF）。客户端用的是 onnxruntime-web + ONNX，
// 两条链的分词、池化、量化都不同 —— 要回答"客户端那个模型够不够"，必须在 ONNX 这条链上量，
// 而不是拿 LM Studio 的数当数。
//
// 题与语料的口径与 bench-embed-model 完全一致：题面 = 产品 + 分组；题行取 `md5(media_key)` 序前 N 条；
// 精确余弦（不叠词法、不叠 RRF），看 hit@1 / recall@L / 同组命中。
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_FILE = path.join(ROOT, 'infra', 'docker-compose.yml');
const LOCAL_DB = 'orange';

export function defaultOptions() {
  return {
    tenant: 'tenant-a',
    analyzerVer: 'card-meta-2',
    modelDir: path.join(ROOT, 'packages', 'openfilm', 'library', 'models', 'bge-small-zh-onnx'),
    runtime: path.join(ROOT, 'packages', 'openfilm', 'library', 'models', 'onnxruntime-web-1.31.1', 'ort.wasm.min.mjs'),
    dims: 512,
    pooling: 'cls',
    threads: 1,
    sample: 200,
    limit: 20,
    corpusLimit: 12000,
    queryPrefix: '',
    /* unigram（e5/bge-m3）或 wordpiece（bge-small-zh 这类 BERT 模型）；auto 按 tokenizer.json 的 model.type 判 */
    tokenizer: 'auto',
    writeColumn: '',
    /* 只编码还没有向量的行：日常增量用它（全量重算时不要给） */
    pending: false,
    /* 写回时同时记下模型标签列，日常增量据此判断"这行是谁算的" */
    verColumn: '',
    label: '',
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
      case '--model-dir': options.modelDir = value(); break;
      case '--dims': options.dims = Number(value()); break;
      case '--pooling': options.pooling = value(); break;
      case '--threads': options.threads = Number(value()); break;
      case '--sample': options.sample = Number(value()); break;
      case '--limit': options.limit = Number(value()); break;
      case '--corpus-limit': options.corpusLimit = Number(value()); break;
      case '--query-prefix': options.queryPrefix = value(); break;
      case '--label': options.label = value(); break;
      case '--tokenizer': options.tokenizer = value(); break;
      case '--write-column': options.writeColumn = value(); break;
      case '--ver-column': options.verColumn = value(); break;
      case '--pending': options.pending = true; break;
      case '--tenant': options.tenant = value(); break;
      case '--help':
      case '-h':
        console.log('usage: node scripts/bench-onnx-model.mjs [--model-dir DIR] [--dims 512] [--pooling cls|mean] '
          + '[--threads 1] [--sample 200] [--limit 20] [--corpus-limit 12000] [--query-prefix TEXT]');
        return null;
      default:
        if (flag.startsWith('--')) throw new Error(`未知参数 ${flag}`);
    }
  }
  return options;
}

function sh(command, args, { input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(command, args, { cwd: ROOT, windowsHide: true, maxBuffer: 256 * 1024 * 1024, timeout: 30 * 60 * 1000 },
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

export function normalize(vector) {
  let sum = 0;
  for (let i = 0; i < vector.length; i += 1) sum += vector[i] * vector[i];
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) out[i] = vector[i] / norm;
  return out;
}

export function cosine(a, b) {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) sum += a[i] * b[i];
  return sum;
}

export function topK(query, docs, limit) {
  /** @type {{index: number, score: number}[]} */
  const best = [];
  for (let i = 0; i < docs.length; i += 1) {
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

const percentile = (sorted, at) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(at * (sorted.length - 1))))];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return 0;
  const label = options.label || path.basename(options.modelDir);
  console.log(`${label}：ONNX（pooling=${options.pooling}, threads=${options.threads}），`
    + `前 ${options.corpusLimit} 条候选、${options.sample} 道题、看前 ${options.limit}`);

  const read = await sh('docker', ['compose', '-f', COMPOSE_FILE, 'exec', '-T', 'db',
    'psql', '-U', 'postgres', '-d', LOCAL_DB, '-qAt', '-v', 'ON_ERROR_STOP=1'], { input: [
    `set app.company_key = ${sqlLiteral(options.tenant)};`,
    "select coalesce(json_agg(r order by media_key), '[]'::json) from (",
    '  select media_key, text, product, gname',
    '    from public.media_doc',
    `   where analyzer_ver = ${sqlLiteral(options.analyzerVer)}`,
    '     and superseded_at is null and text is not null',
    ...(options.pending ? [`     and ${options.writeColumn || 'embedding'} is null`] : []),
    '   order by media_key',
    `   limit ${options.corpusLimit}`,
    ') r;',
    '',
  ].join('\n') });
  if (read.code !== 0) {
    console.error(`读语料失败：${String(read.stderr).split(/\r?\n/).filter(Boolean)[0] ?? read.code}`);
    return 1;
  }
  const rows = JSON.parse(String(read.stdout).trim() || '[]');
  if (!rows.length) { console.error('没有语料'); return 1; }

  const { loadEmbedder } = await import('../packages/orangefilm/src/sentence-model.mjs');
  const onnx = path.join(options.modelDir, 'model_quantized.onnx');
  console.log(`模型 ${(statSync(onnx).size / 1048576).toFixed(1)} MB`);
  const startedAt = Date.now();
  const tokenizerFile = path.join(options.modelDir, 'tokenizer.json');
  const kind = options.tokenizer === 'auto'
    ? (JSON.parse((await import('node:fs')).readFileSync(tokenizerFile, 'utf8'))?.model?.type === 'WordPiece' ? 'wordpiece' : 'unigram')
    : options.tokenizer;
  const files = { runtime: options.runtime, onnx, pooling: options.pooling, threads: options.threads };
  if (kind === 'wordpiece') {
    const { readWordPiece, tokenizeWordPiece } = await import('../packages/orangefilm/src/wordpiece.mjs');
    const vocab = readWordPiece(tokenizerFile);
    files.tokenize = (/** @type {string} */ text) => tokenizeWordPiece(vocab, text);
    console.log('分词器 WordPiece');
  } else {
    files.tokenizer = tokenizerFile;
    console.log('分词器 SentencePiece unigram');
  }
  const embed = await loadEmbedder(files);
  console.log(`加载 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  /** 写回库里的目标列（换模型时把文档向量一起重算） */
  const psqlWrite = async (/** @type {string} */ script) => sh('docker', ['compose', '-f', COMPOSE_FILE, 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', LOCAL_DB, '-qAt', '-v', 'ON_ERROR_STOP=1'], { input: script });
  /** @type {Float32Array[]} */
  const docs = [];
  /** @type {string[]} */
  const pendingKeys = [];
  let writeFrom = 0;
  const encodeTimes = [];
  for (const [index, row] of rows.entries()) {
    const at = Date.now();
    const vector = normalize(await embed(String(row.text)));
    docs.push(vector);
    if ((index + 1) % 1000 === 0) {
      const rate = (index + 1) / Math.max(0.001, (Date.now() - startedAt) / 1000);
      process.stdout.write(`\r  编码 ${index + 1}/${rows.length}  ${rate.toFixed(0)}/s`);
    }
  }
  process.stdout.write('\n');

  /* 写回列：**先算完再写**。每批都开一次 psql 的话，docker exec 的启动开销把吞吐从 40 条/秒压到 9 条/秒
     （实测）；67k 条向量在内存里也就 137 MB，最后分几块写干净。 */
  if (options.writeColumn) {
    const writeStartedAt = Date.now();
    const psqlWrite = async (/** @type {string} */ script) => sh('docker', ['compose', '-f', COMPOSE_FILE, 'exec', '-T', 'db',
      'psql', '-U', 'postgres', '-d', LOCAL_DB, '-qAt', '-v', 'ON_ERROR_STOP=1'], { input: script });
    const chunk = 4000;
    for (let from = 0; from < rows.length; from += chunk) {
      const values = rows.slice(from, from + chunk)
        .map((row, at) => `(${sqlLiteral(row.media_key)}, '[${Array.from(docs[from + at]).join(',')}]'::vector(${docs[from + at].length}))`)
        .join(',\n      ');
      const write = await psqlWrite([
        `set app.company_key = ${sqlLiteral(options.tenant)};`,
        `update public.media_doc d set ${options.writeColumn} = v.vec`
          + (options.verColumn ? `, ${options.verColumn} = ${sqlLiteral(options.label || options.model || 'local')}` : ''),
        '  from (values',
        `      ${values}`,
        '  ) as v(media_key, vec)',
        ` where d.analyzer_ver = ${sqlLiteral(options.analyzerVer)}`,
        '   and d.superseded_at is null',
        '   and d.media_key = v.media_key;',
        '',
      ].join('\n'));
      if (write.code !== 0) {
        console.error(`写 ${options.writeColumn} 失败：${String(write.stderr).split(/\r?\n/)[0]}`);
        return 1;
      }
      process.stdout.write(`\r  写入 ${Math.min(from + chunk, rows.length)}/${rows.length}`);
    }
    process.stdout.write(`\n写库用时 ${((Date.now() - writeStartedAt) / 1000).toFixed(0)}s\n`);
  }

  /* 题库：与 bench-embed-model 同一套（md5(media_key) 序的前 N 条里、有产品/分组的那些） */
  const hash = (/** @type {string} */ s) => { let h = 0; for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0; return h; };
  const questions = [...rows]
    .sort((a, b) => hash(a.media_key) - hash(b.media_key))
    .filter((row) => String(row.product ?? '').trim() || String(row.gname ?? '').trim())
    .slice(0, options.sample);
  const indexOf = new Map(rows.map((row, index) => [row.media_key, index]));

  let hit1 = 0;
  let inTop = 0;
  let group = 0;
  const queryTimes = [];
  for (const question of questions) {
    const text = [question.product, question.gname].filter(Boolean).join(' ').trim();
    if (!text) continue;
    const at = Date.now();
    const vector = normalize(await embed(options.queryPrefix + text));
    queryTimes.push(Date.now() - at);
    const best = topK(vector, docs, options.limit);
    const position = best.findIndex((hit) => hit.index === indexOf.get(question.media_key));
    if (position === 0) hit1 += 1;
    if (position >= 0) inTop += 1;
    if (best.some((hit) => rows[hit.index].product === question.product && rows[hit.index].gname === question.gname)) group += 1;
  }

  const total = Math.max(1, questions.length);
  const pct = (n) => `${((n / total) * 100).toFixed(1)}%`;
  const querySorted = [...queryTimes].sort((a, b) => a - b);
  const encodeSorted = [...encodeTimes].sort((a, b) => a - b);
  console.log(`\n${label}  题数 ${questions.length}  hit@1 ${pct(hit1)}  recall@${options.limit} ${pct(inTop)}  同组 ${pct(group)}`);
  console.log(`查询编码 p50 ${percentile(querySorted, 0.5)} ms  p95 ${percentile(querySorted, 0.95)} ms；`
    + `文档编码 p50 ${percentile(encodeSorted, 0.5)} ms`);
  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exit(1);
  });
}
