#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// 把库里的文档向量打成一个可分发的包：客户端下载它 + 模型，就能在本地比对，不再需要任何服务。
//
//   node scripts/material-vector-pack.mjs --out .dev/vector-pack
//
// # 包长什么样
//
//   vectors.f16   每行一个向量，fp16 小端，行序 = keys.txt 的行序
//   keys.txt      每行一个 media_key（客户端用它把命中的行对回目录里的素材）
//   pack.json     行数、维度、模型 id、两个文件的字节数与 sha256、构建时间、来源 analyzer_ver
//
// # 为什么是 fp16
//
// 768 × 4 字节（fp32）是 206 MB，fp16 是 103 MB —— 一半，而排序几乎不变（fp16 有 11 位有效数字，余弦在 1e-3
// 量级的差别上不改变名次）。真要更小可以 int8 + 缩放因子，但那要客户端反量化，先不做。
//
// # 版本
//
// `pack.json` 里的 `version` 由内容决定（行数 + 模型 id + 向量文件的 sha256 前 12 位）：同一批数据两次打包得到
// 同一个版本号，客户端据此判断要不要更新，而不是看时间戳。
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_FILE = path.join(ROOT, 'infra', 'docker-compose.yml');
const LOCAL_DB = 'orange';

export function defaultOptions() {
  return {
    tenant: 'tenant-a',
    analyzerVer: 'card-meta-2',
    column: 'embedding_768_bge_base',
    model: 'bge-base-zh-v1.5',
    dims: 768,
    out: path.join(ROOT, '.dev', 'vector-pack'),
    limit: 0,
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
      case '--out': options.out = value(); break;
      case '--column': options.column = value(); break;
      case '--model': options.model = value(); break;
      case '--dims': options.dims = Number(value()); break;
      case '--limit': options.limit = Number(value()); break;
      case '--tenant': options.tenant = value(); break;
      case '--help':
      case '-h':
        console.log('usage: node scripts/material-vector-pack.mjs [--out DIR] [--limit N] [--column embedding_768_bge_base]');
        return null;
      default:
        if (flag.startsWith('--')) throw new Error(`未知参数 ${flag}`);
    }
  }
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

/** Float32 向量 → 小端 fp16 的小工具（Node 没有 fp16 编码，自己写：符号/指数/尾数按 IEEE 754 收窄）。 */
export function toFloat16(/** @type {number} */ value) {
  const float = new Float32Array(1);
  float[0] = value;
  const bits = new Uint32Array(float.buffer)[0];
  const sign = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 0xff;
  let mantissa = bits & 0x7fffff;
  if (exponent === 0xff) return sign | 0x7c00 | (mantissa ? 0x0200 : 0);
  let e = exponent - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mantissa |= 0x800000;
    const shift = 14 - e;
    const half = mantissa >>> shift;
    return sign | (half + ((mantissa >>> (shift - 1)) & 1));
  }
  mantissa = mantissa + 0x1000 + ((mantissa >>> 13) & 1);
  if (mantissa & 0x800000) { mantissa = 0; e += 1; if (e >= 0x1f) return sign | 0x7c00; }
  return sign | (e << 10) | (mantissa >>> 13);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return 0;


  const cap = Number(options.limit) > 0 ? Number(options.limit) : 0;
  const startedAt = Date.now();
  /* 一次读完 67 156 行 × 768 维的文本是 1.2 GB，会把 Node 的字符串长度打爆（RangeError: Invalid string length）。
     所以先数总数、把缓冲一次分配好，再分块取（每块 1 500 行）填进去。 */
  const counted = await psql([
    `set app.company_key = ${sqlLiteral(options.tenant)};`,
    `select count(*) from public.media_doc`,
    ` where analyzer_ver = ${sqlLiteral(options.analyzerVer)}`,
    `   and superseded_at is null and ${options.column} is not null;`,
    '',
  ].join('\n'));
  if (counted.code !== 0) {
    console.error(`数行失败：${String(counted.stderr).split(/\r?\n/).filter(Boolean)[0] ?? counted.code}`);
    return 1;
  }
  const total = Math.min(Number(String(counted.stdout).trim() || 0), cap || Number.MAX_SAFE_INTEGER);
  if (!total) { console.error(`没有可打包的向量（列 ${options.column} 是空的）`); return 1; }

  const buffer = Buffer.alloc(total * options.dims * 2);
  /** @type {string[]} */
  const keys = [];
  /** 与 keys 同序：media_key / name / batch / product / gname */
  const names = [];
  let at = 0;
  const chunk = 1500;
  for (let offset = 0; offset < total; offset += chunk) {
    const part = await psql([
      `set app.company_key = ${sqlLiteral(options.tenant)};`,
      "select coalesce(json_agg(r order by media_key), '[]'::json) from (",
      `  select media_key, ${options.column}::text as vec, coalesce(name, '') as name, coalesce(batch, '') as batch, coalesce(product, '') as product, coalesce(gname, '') as gname`,
      '    from public.media_doc',
      `   where analyzer_ver = ${sqlLiteral(options.analyzerVer)}`,
      `     and superseded_at is null and ${options.column} is not null`,
      `   order by media_key limit ${chunk} offset ${offset}`,
      ') r;',
      '',
    ].join('\n'));
    if (part.code !== 0) {
      console.error(`读向量失败：${String(part.stderr).split(/\r?\n/).filter(Boolean)[0] ?? part.code}`);
      return 1;
    }
    const rows = JSON.parse(String(part.stdout).trim() || '[]');
    if (!rows.length) break;
    for (const row of rows) {
      const numbers = String(row.vec).replace(/^\[|\]$/g, '').split(',').map(Number);
      if (numbers.length !== options.dims) {
        console.error(`${row.media_key}: ${numbers.length} 维，期望 ${options.dims}`);
        return 1;
      }
      for (const value of numbers) { buffer.writeUInt16LE(toFloat16(value), at); at += 2; }
      keys.push(String(row.media_key));
      /* 名字随包走：客户端没有落地索引，也要能说清"检索到的是哪一条"（云管家的素材名很长，正是它的信息） */
      const clean = (/** @type {unknown} */ value) => String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
      names.push([String(row.media_key), clean(row.name), clean(row.batch), clean(row.product), clean(row.gname)].join('\t'));
    }
    process.stdout.write(`\r  读 ${keys.length}/${total}`);
  }
  process.stdout.write('\n');
  const rows = { length: keys.length };

  mkdirSync(options.out, { recursive: true });
  const vectorFile = path.join(options.out, 'vectors.f16');
  const keyFile = path.join(options.out, 'keys.txt');
  const namesFile = path.join(options.out, 'names.tsv');
  const manifestFile = path.join(options.out, 'pack.json');
  writeFileSync(vectorFile, buffer);
  writeFileSync(keyFile, `${keys.join('\n')}\n`);
  writeFileSync(namesFile, `${names.join('\n')}\n`);

  const digest = (/** @type {Buffer|string} */ data) => createHash('sha256').update(data).digest('hex');
  const vectorsSha = digest(buffer);
  const keysSha = digest(keys.join('\n') + '\n');
  const namesSha = digest(names.join('\n') + '\n');
  const version = `${rows.length}-${options.model}-${vectorsSha.slice(0, 12)}`;
  const manifest = {
    version,
    model: options.model,
    dims: options.dims,
    rows: rows.length,
    quantization: 'float16',
    byteOrder: 'little-endian',
    rowOrder: 'keys.txt 的行序',
    analyzerVer: options.analyzerVer,
    column: options.column,
    builtAt: new Date().toISOString(),
    files: [
      { path: 'vectors.f16', bytes: buffer.length, sha256: vectorsSha },
      { path: 'keys.txt', bytes: Buffer.byteLength(keys.join('\n') + '\n'), sha256: keysSha },
      { path: 'names.tsv', bytes: Buffer.byteLength(names.join('\n') + '\n'), sha256: namesSha },
    ],
  };
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 1)}\n`);

  console.log(`${rows.length} 行 × ${options.dims} 维（fp16）= ${(buffer.length / 1048576).toFixed(1)} MB，`
    + `用时 ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);
  console.log(`version ${version}`);
  console.log(`输出 ${path.relative(ROOT, options.out)}：vectors.f16 / keys.txt / pack.json`);
  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exit(1);
  });
}
