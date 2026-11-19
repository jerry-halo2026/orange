#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// GGUF（LM Studio，量化档）与 ONNX（客户端要跑的 wasm 运行时）算出来的向量差多少。
//
//   node scripts/bench-onnx-drift.mjs --rows 500
//
// # 为什么必须量
//
// 库里 67 156 条向量是 LM Studio 的 bge-m3 GGUF 算的；客户端要跑的是 onnxruntime-web + ONNX 模型。
// 两条链的量化方式、分词实现、归一化都可能不同。如果同一段文本两边算出的余弦 < 0.99，说明它们**不是同一个
// 向量空间** —— 混着用会让召回悄悄掉，而且很难归因（"模型不是一样吗"）。
//
// 所以：从库里抽 N 条（确定性：md5(media_key) 序前 N），拿它们的 text 用 ONNX 重算，与库里存的 GGUF 向量比。
// 顺带报每条的耗时，判断客户端"编码一句话 10–30 ms"这个预期成不成立。
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_FILE = path.join(ROOT, 'infra', 'docker-compose.yml');
const LOCAL_DB = 'orange';
const LIBRARY = path.join(ROOT, 'packages', 'openfilm', 'library');

export function defaultOptions() {
  return {
    tenant: 'tenant-a',
    analyzerVer: 'card-meta-2',
    column: 'embedding_1024_bge',
    rows: 500,
    modelDir: path.join(LIBRARY, 'models', 'bge-m3-onnx'),
    runtime: path.join(LIBRARY, 'models', 'onnxruntime-web-1.31.1', 'ort.wasm.min.mjs'),
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
      case '--rows': options.rows = Number(value()); break;
      case '--column': options.column = value(); break;
      case '--model-dir': options.modelDir = value(); break;
      case '--tenant': options.tenant = value(); break;
      case '--help':
      case '-h':
        console.log('usage: node scripts/bench-onnx-drift.mjs [--rows 500] [--column embedding_1024_bge] [--model-dir DIR]');
        return null;
      default:
        if (flag.startsWith('--')) throw new Error(`未知参数 ${flag}`);
    }
  }
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

/** 余弦（两边都归一化后就是点积）。 */
export function cosine(a, b) {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) sum += a[i] * b[i];
  return sum;
}

export function normalize(vector) {
  let sum = 0;
  for (let i = 0; i < vector.length; i += 1) sum += vector[i] * vector[i];
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) out[i] = vector[i] / norm;
  return out;
}

const percentile = (sorted, at) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(at * (sorted.length - 1))))];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return 0;

  const script = [
    `set app.company_key = ${sqlLiteral(options.tenant)};`,
    "select coalesce(json_agg(r), '[]'::json) from (",
    '  select media_key, text, ' + options.column + '::text as vec',
    '    from public.media_doc',
    `   where analyzer_ver = ${sqlLiteral(options.analyzerVer)}`,
    `     and superseded_at is null and ${options.column} is not null`,
    '     and text is not null',
    '   order by md5(media_key)',
    `   limit ${Number(options.rows)}`,
    ') r;',
    '',
  ].join('\n');
  const read = await sh('docker', ['compose', '-f', COMPOSE_FILE, 'exec', '-T', 'db',
    'psql', '-U', 'postgres', '-d', LOCAL_DB, '-qAt', '-v', 'ON_ERROR_STOP=1'], { input: script });
  if (read.code !== 0) {
    console.error(`读样本失败：${String(read.stderr).split(/\r?\n/).filter(Boolean)[0] ?? read.code}`);
    return 1;
  }
  const rows = JSON.parse(String(read.stdout).trim() || '[]');
  if (!rows.length) { console.error('没有样本'); return 1; }
  console.log(`样本 ${rows.length} 条（库内 ${options.column} 是 LM Studio 的 bge-m3 GGUF 算的）`);

  const { loadEmbedder } = await import('../packages/openfilm/src/sentence-model.mjs');
  const files = {
    runtime: options.runtime,
    onnx: path.join(options.modelDir, 'model_quantized.onnx'),
    tokenizer: path.join(options.modelDir, 'tokenizer.json'),
    /* bge-m3 是 BERT 系：取第一个 token 的状态（CLS/<s>）；e5 才是平均 */
    pooling: 'cls',
    threads: Number(process.env.ONNX_THREADS ?? 1),
  };
  console.log(`ONNX：${path.relative(ROOT, files.onnx)}（${(await import('node:fs')).statSync(files.onnx).size / 1048576 | 0} MB）`);
  const startedAt = Date.now();
  let embed;
  try {
    embed = await loadEmbedder(files);
  } catch (error) {
    console.error(`ONNX 加载失败：${error?.message ?? error}`);
    return 1;
  }
  console.log(`加载 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  const scores = [];
  const times = [];
  let worst = null;
  for (const [index, row] of rows.entries()) {
    const stored = normalize(String(row.vec).replace(/^\[|\]$/g, '').split(',').map(Number));
    const at = Date.now();
    let fresh;
    try { fresh = await embed(String(row.text)); } catch (error) {
      console.error(`第 ${index + 1} 条编码失败：${error?.message ?? error}`);
      return 1;
    }
    times.push(Date.now() - at);
    const score = cosine(normalize(fresh), stored);
    scores.push(score);
    if (!worst || score < worst.score) worst = { score, key: row.media_key, text: String(row.text).slice(0, 40) };
    if ((index + 1) % 100 === 0) process.stdout.write(`\r  比对 ${index + 1}/${rows.length}`);
  }
  process.stdout.write('\n');

  const sorted = [...scores].sort((a, b) => a - b);
  const atLeast = (x) => scores.filter((s) => s >= x).length;
  const mean = scores.reduce((sum, s) => sum + s, 0) / scores.length;
  const timeSorted = [...times].sort((a, b) => a - b);
  console.log(`\n余弦（GGUF vs ONNX）：mean ${mean.toFixed(5)}  min ${sorted[0].toFixed(5)}  `
    + `p5 ${percentile(sorted, 0.05).toFixed(5)}  p50 ${percentile(sorted, 0.5).toFixed(5)}`);
  console.log(`≥0.999 ${atLeast(0.999)}/${scores.length}   ≥0.99 ${atLeast(0.99)}/${scores.length}   `
    + `≥0.95 ${atLeast(0.95)}/${scores.length}`);
  console.log(`最差一条 ${worst.score.toFixed(5)}  ${worst.key}  ${worst.text}`);
  console.log(`编码耗时 p50 ${percentile(timeSorted, 0.5)} ms，p95 ${percentile(timeSorted, 0.95)} ms（wasm，单线程）`);
  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exit(1);
  });
}
