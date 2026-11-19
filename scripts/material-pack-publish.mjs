#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// 把向量包发布成"能增量下载"的形态：分块 + 清单。客户端只下变了的那几块。
//
//   node scripts/material-pack-publish.mjs --out dist/materials --base-url https://cdn.example/materials
//   node scripts/material-pack-publish.mjs --out dist/materials            # 相对路径（同域静态托管）
//
// # 为什么分块
//
// 向量包是 98.4 MB。语料每天有几条新增，整包重下就是每天 98 MB × 每个客户端 —— 这才是真实成本。
// 切成 8 MB 一块、按内容哈希命名，客户端本地留着上次的块，只补 sha256 变了的那些：
// 一条新增素材最多影响末尾一块，于是日常更新是 **8 MB 以内**，而不是整包。
//
// # 产物
//
//   <out>/materials.json                     清单：pack 版本、行数、维度、keys 与所有块
//   <out>/pack/<version>/keys.txt            每行一个 media_key（小文件，整份换）
//   <out>/pack/<version>/chunks/NNN.bin      向量切片（fp16 小端，按行序连续切，最后一块可能不满）
//
// 块名是序号而不是哈希：清单里给出每块的 sha256，客户端按"清单里的哈希 vs 本地文件的哈希"决定下不下。
// 序号名让"哪些块变了"一目了然，也不用为同一内容的两份历史块留两份文件。
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHUNK_BYTES = 8 * 1024 * 1024;

export function defaultOptions() {
  return {
    packDir: path.join(ROOT, '.dev', 'vector-pack'),
    out: path.join(ROOT, 'dist', 'materials'),
    baseUrl: '',
    chunkBytes: CHUNK_BYTES,
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
      case '--pack': options.packDir = value(); break;
      case '--out': options.out = value(); break;
      case '--base-url': options.baseUrl = value().replace(/\/+$/, ''); break;
      case '--chunk-bytes': options.chunkBytes = Number(value()); break;
      case '--help':
      case '-h':
        console.log('usage: node scripts/material-pack-publish.mjs [--pack DIR] [--out DIR] [--base-url URL] [--chunk-bytes N]');
        return null;
      default:
        if (flag.startsWith('--')) throw new Error(`未知参数 ${flag}`);
    }
  }
  return options;
}

export const sha256 = (/** @type {Buffer | string} */ data) => createHash('sha256').update(data).digest('hex');

/**
 * 把一整份向量切成块，返回每块的字节数与 sha256。纯函数：清单就是它算出来的，能单独测。
 * @param {Buffer} buffer @param {number} chunkBytes
 * @returns {{ index: number, bytes: number, sha256: string, offset: number }[]}
 */
export function planChunks(buffer, chunkBytes) {
  /** @type {{ index: number, bytes: number, sha256: string, offset: number }[]} */
  const chunks = [];
  for (let offset = 0, index = 0; offset < buffer.length; offset += chunkBytes, index += 1) {
    const slice = buffer.subarray(offset, Math.min(offset + chunkBytes, buffer.length));
    chunks.push({ index, bytes: slice.length, sha256: sha256(slice), offset });
  }
  return chunks;
}

function sh(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { cwd: ROOT, windowsHide: true, maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => resolve({
      code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
      stdout: String(stdout ?? ''),
      stderr: String(stderr ?? ''),
    }));
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return 0;

  const packManifest = JSON.parse(readFileSync(path.join(options.packDir, 'pack.json'), 'utf8'));
  const vectors = readFileSync(path.join(options.packDir, 'vectors.f16'));
  const keys = readFileSync(path.join(options.packDir, 'keys.txt'));
  if (vectors.length % (packManifest.dims * 2) !== 0) {
    console.error(`vectors.f16 的字节数 ${vectors.length} 不是 ${packManifest.dims} 维 fp16 的整数倍`);
    return 1;
  }

  const chunks = planChunks(vectors, options.chunkBytes);
  const folder = path.join(options.out, 'pack', packManifest.version);
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(path.join(folder, 'chunks'), { recursive: true });
  for (const chunk of chunks) {
    writeFileSync(path.join(folder, 'chunks', `${String(chunk.index).padStart(3, '0')}.bin`),
      vectors.subarray(chunk.offset, chunk.offset + chunk.bytes));
  }
  writeFileSync(path.join(folder, 'keys.txt'), keys);

  const rel = (/** @type {string} */ file) => {
    const pathname = `pack/${packManifest.version}/${file}`;
    return options.baseUrl ? `${options.baseUrl}/${pathname}` : pathname;
  };
  const manifest = {
    version: packManifest.version,
    model: packManifest.model,
    dims: packManifest.dims,
    rows: packManifest.rows,
    quantization: packManifest.quantization,
    byteOrder: packManifest.byteOrder,
    builtAt: packManifest.builtAt,
    publishedAt: new Date().toISOString(),
    /* 整份拼好之后的样子（客户端下完块会核对它）：大小与哈希都来自原始 vectors.f16 */
    vectors: { bytes: vectors.length, sha256: sh ? packManifest.files.find((/** @type {any} */ f) => f.path === 'vectors.f16')?.sha256 : null },
    keys: { bytes: keys.length, sha256: sha256(keys), url: rel('keys.txt') },
    chunkBytes: options.chunkBytes,
    chunks: chunks.map((chunk) => ({
      index: chunk.index,
      bytes: chunk.bytes,
      sha256: chunk.sha256,
      url: rel(`chunks/${String(chunk.index).padStart(3, '0')}.bin`),
    })),
  };
  mkdirSync(options.out, { recursive: true });
  writeFileSync(path.join(options.out, 'materials.json'), `${JSON.stringify(manifest, null, 1)}\n`);

  console.log(`pack ${manifest.version}：${manifest.rows} 行 × ${manifest.dims} 维`);
  console.log(`${chunks.length} 块，每块 ≤ ${(options.chunkBytes / 1048576).toFixed(0)} MB，共 ${(vectors.length / 1048576).toFixed(1)} MB`);
  console.log(`清单 ${path.relative(ROOT, path.join(options.out, 'materials.json'))}`);
  if (!options.baseUrl) console.log('（相对路径：把 dist/materials 整个放到静态托管的根上即可）');
  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exit(1);
  });
}
