#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// 每日增量：把"新增素材"这一小段跑完就退出，绝不常驻、绝不重算。
//
//   node scripts/media-daily.mjs                 # 增量（默认上限 2 000 条/次）
//   node scripts/media-daily.mjs --dry-run       # 只打印每一步会做什么
//   node scripts/media-daily.mjs --only embed    # 只跑其中一步（scan|embed|levels|push）
//   node scripts/media-daily.mjs --limit 500     # 本次最多处理 500 条
//   node scripts/media-daily.mjs --cloud         # 第 4 步推云端（默认不推，需要显式开）
//
// # 为什么这样切
//
// 全量贯通（7 万条 × 4096 维）是本机跑一次 1.5 小时的活，日常不该天天做。日常真正变的是
// **新增几十到几百条素材**，所以四步各自只处理"还没做的"：
//
//   1. scan   索引 → 索引条目（按 videoId 合并，已有的不动）
//   2. embed  只嵌入 text 变了的行（`--changed-only`：库内 md5 比对），并发 2、每批 200
//   3. levels 回填 one_level/two_level（带 `is distinct from` 守卫，第二遍 0 次更新）
//   4. push   只推云端缺的（`--missing-only` + 512 向量），2 KB/条
//
// 每一步都可以单独重跑、都可以中途打断；进度分别记在
// `.dev/material-doc/progress*.json`、`sync-metadata.json`、`sync-512.json`。
//
// # 资源纪律（这是"电脑吃得消"的关键）
//
//   · 并发固定 2（不是 4）：LM Studio 单卡排队，4 并发只会把 p99 抬过超时线，重试变多；
//   · 单次上限 2 000 条：跑完就退出，不霸占 GPU/内存；没跑完的下一轮继续（断点续跑）；
//   · 第 4 步默认关闭：云端推送要开直连窗口（本机 5432 被代理挡着），不该每天自动开；
//   · 全部只读本地库 + 追加式写云端，任何一步失败都不影响其它步。
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function defaultOptions() {
  return {
    limit: 2000,
    concurrency: 2,
    batch: 200,
    tenant: 'tenant-a',
    analyzerVer: 'card-meta-2',
    cloud: false,
    pack: false,
    packDir: path.join('.dev', 'vector-pack'),
    dryRun: false,
    only: '',
    indexFile: path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.openfilm-dev', 'material-index', 'index.json'),
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
      case '--limit': options.limit = Number(value()); break;
      case '--concurrency': options.concurrency = Number(value()); break;
      case '--batch': options.batch = Number(value()); break;
      case '--tenant': options.tenant = value(); break;
      case '--analyzer-ver': options.analyzerVer = value(); break;
      case '--index': options.indexFile = value(); break;
      case '--only': options.only = value(); break;
      case '--cloud':
        /* 停用了但参数还认：给一句可读的话，而不是静默照跑或者"未知参数" */
        console.error('--cloud 已停用：Supabase 的数据面已删，向量现在打成包随客户端分发'
          + '（scripts/material-vector-pack.mjs → scripts/material-pack-publish.mjs）');
        options.cloud = false;
        break;
      case '--dry-run': options.dryRun = true; break;
      case '--pack': options.pack = true; break;
      case '--pack-dir': options.packDir = value(); break;
      case '--help':
      case '-h':
        console.log('usage: node scripts/media-daily.mjs [--limit 2000] [--concurrency 2] [--batch 200] '
          + '[--tenant KEY] [--analyzer-ver VER] [--only scan|embed|levels|push] [--cloud] [--dry-run]');
        return null;
      default:
        if (flag.startsWith('--')) throw new Error(`未知参数 ${flag}（--help 看用法）`);
    }
  }
  if (!Number.isInteger(options.limit) || options.limit < 1) throw new Error('--limit 必须是正整数');
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 4) {
    throw new Error('--concurrency 取 1..4（>4 只是把 LM Studio 排队拉长）');
  }
  return options;
}

/** 四步的完整清单。`needs` 说明这一步依赖什么，缺了就跳过（并说清为什么）。 */
export function steps(options) {
  return [
    {
      key: 'scan',
      title: '索引（供应商 → 索引条目）',
      when: () => existsSync(options.indexFile),
      skipReason: `索引文件不存在：${options.indexFile}（先跑一次 material-index-bootstrap）`,
      command: ['node', ['packages/openfilm/scripts/material-index-bootstrap.mjs']],
      note: '按 videoId 合并，已有条目不动；这一条不会重算向量',
    },
    {
      key: 'embed',
      title: `向量（bge-base-zh，只补还没有向量的行，本次上限 ${options.limit} 条）`,
      when: () => existsSync(options.indexFile),
      skipReason: `索引文件不存在：${options.indexFile}`,
      /* 换了模型之后，日常增量要走**客户端同一条 ONNX 管线**（同一个模型、CLS 池化、WordPiece 分词），
         否则库里是新行用新模型、老行用老模型 —— 那就是两个向量空间混在一列里。 */
      command: ['node', ['scripts/bench-onnx-model.mjs',
        '--model-dir', 'packages/openfilm/library/models/bge-base-zh-onnx',
        '--dims', '768', '--tokenizer', 'auto', '--pooling', 'cls',
        '--pending', '--write-column', 'embedding', '--ver-column', 'embedding_ver_768_bge_base',
        '--label', 'bge-base-zh-v1.5', '--corpus-limit', String(options.limit),
        '--analyzer-ver', options.analyzerVer, '--tenant', options.tenant,
        '--sample', '1', '--limit', '1']],
      note: '`--pending` 只挑 `embedding is null` 的行；全量重算去掉它（67k 约 2 小时）',
    },
    {
      key: 'levels',
      title: '分类（one_level / two_level 回填）',
      when: () => existsSync(options.indexFile),
      skipReason: `索引文件不存在：${options.indexFile}`,
      command: ['node', ['scripts/media-doc-levels.mjs',
        '--analyzer-ver', options.analyzerVer, '--tenant', options.tenant, '--batch', '400']],
      note: '幂等：值没变就不写（`is distinct from` 守卫）',
    },
    {
      /* 云端数据面已经删了（Supabase 只留 auth）。这一步换成"打包"：客户端拿到的就是这一份，
         再配合 `scripts/material-pack-publish.mjs` 发布成可分块增量的形态。
         旧的 `--cloud` 仍然认，只回一句"已停用"，指着这两条命令。 */
      key: 'push',
      title: '打向量包（客户端分发的那一份）',
      when: () => options.pack,
      skipReason: '默认不打（加 --pack；它要读全表 67k 行，几十秒到两分钟，不该每天自动跑）',
      command: ['node', ['scripts/material-vector-pack.mjs', '--out', options.packDir]],
      note: '产物 vectors.f16 + keys.txt + pack.json；发布用 scripts/material-pack-publish.mjs',
    },
  ];
}

function run(command, args) {
  return new Promise((resolve) => {
    const child = execFile(command, args, { cwd: ROOT, windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 6 * 60 * 60 * 1000 },
      (error, stdout, stderr) => resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      }));
    child.stdout?.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  });
}

/** 从最后一行汇总里抠出几个关键数字，用于结尾的一行总结（拿不到就标 —）。 */
export function summarize(stepKey, stdout) {
  const tail = String(stdout).split(/\r?\n/).filter(Boolean).slice(-6).join('\n');
  if (stepKey === 'embed') {
    const m = tail.match(/written=(\d+).*?noop=(\d+).*?fail=(\d+)/);
    return m ? `written=${m[1]} noop=${m[2]} fail=${m[3]}` : '—';
  }
  if (stepKey === 'levels') {
    const m = tail.match(/实际更新 (\d+) 行/);
    return m ? `更新 ${m[1]} 行` : '—';
  }
  if (stepKey === 'push') {
    const m = tail.match(/同步结束：(\d+) 条/);
    return m ? `推送 ${m[1]} 条` : '—';
  }
  return '—';
}

export function readOffset(file, key = 'offset') {
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return raw?.[key] ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return 0;

  const plan = steps(options).filter((step) => !options.only || step.key === options.only);
  if (!plan.length) {
    console.error(`--only ${options.only} 不匹配任何步骤（scan|embed|levels|push）`);
    return 2;
  }

  console.log(`media-daily：${plan.length} 步，本次上限 ${options.limit} 条，并发 ${options.concurrency}`
    + `${options.dryRun ? '（--dry-run）' : ''}`);
  const results = [];
  for (const step of plan) {
    if (!step.when()) {
      console.log(`\n== ${step.key}：跳过 —— ${step.skipReason}`);
      results.push({ key: step.key, status: 'skipped', detail: step.skipReason });
      continue;
    }
    const commands = step.key === 'push' ? step.command : [step.command];
    console.log(`\n== ${step.key}：${step.title}`);
    if (options.dryRun) {
      for (const [cmd, args] of commands) console.log(`   ${cmd} ${args.join(' ')}`);
      results.push({ key: step.key, status: 'planned', detail: 'dry-run' });
      continue;
    }
    let status = 'ok';
    let detail = '—';
    for (const [cmd, args] of commands) {
      const result = await run(cmd, args);
      if (result.code !== 0) {
        status = 'failed';
        detail = `${cmd} 退出 ${result.code}`;
        break;
      }
      detail = summarize(step.key, result.stdout);
    }
    results.push({ key: step.key, status, detail });
  }

  console.log('\n—— 本轮小结 ——');
  for (const result of results) {
    const mark = { ok: 'OK  ', skipped: 'SKIP', planned: 'PLAN', failed: 'FAIL' }[result.status] ?? '    ';
    console.log(`${mark} ${result.key.padEnd(7)} ${result.detail}`);
  }
  return results.some((result) => result.status === 'failed') ? 1 : 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exit(1);
  });
}
