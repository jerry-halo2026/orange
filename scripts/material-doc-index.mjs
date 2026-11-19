#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// 素材索引 → `public.media_doc` 的回填器（零依赖：只用 node: 内置模块 + packages/openfilm 的纯函数）。
//
// 用法（本机 Docker 库，租户走会话 GUC）：
//   node scripts/material-doc-index.mjs --limit 50                 # 小样本（先验写入通道）
//   node scripts/material-doc-index.mjs                            # 全量 78 874 条，断点续跑
//   node scripts/material-doc-index.mjs --dry-run --limit 20       # 只算 text，不嵌入不写库
//   node scripts/material-doc-index.mjs --no-resume --limit 50     # 幂等复核：重写同一批
//   node scripts/material-doc-index.mjs --dims 4096 --spread --limit 5000 --all \
//        --progress .dev/material-doc/progress-4096.json           # 8B/4096 那一列，按产品轮转取样
//
// 链路：`~/.openfilm-dev/material-index/index.json`
//      → `mediaDocRow(entry)`（packages/openfilm/src/material-doc.mjs：14 个键，不含向量）
//      → `POST /v1/embeddings`（768 维，超时 20 s，并发 ≤ 4，失败重试 3 次带退避）
//      → 每 `--batch` 条一个 psql 会话：`set app.company_key` → 逐条 `select public.upsert_media_doc($json$…$json$::jsonb)`
//
// # 为什么写库是"每批一个 psql 会话 + 每行一条语句"，而不是别的两种写法
//
//  1. 不复用 HTTP（PostgREST）：本机这套库没有 PostgREST，`upsert_media_doc` 只有 psql 这一条路；
//     `infra/migrate.mjs` 也是这么连的（`docker compose exec -T db psql -U postgres -d orange`），
//     这里照抄它，不引入驱动依赖，也不新增第二个连接来源。
//  2. 不把 300 行塞进**一条** `select … from jsonb_array_elements(...)`：语句级原子性会把"某一行 22023"
//     升级成"整批回滚"，而 78k 行回填里最常见的正是个别脏行——它们该被记进失败清单，不该让整批重来。
//     一行一条语句 = 一行一个事务，失败只丢那一行（幂等重跑的代价也从"整批"降到"那一行"）。
//  3. 会话开头 `set app.company_key`（010 的做法）：`upsert_media_doc` **不从参数取租户**
//     （012:186 `v_company := public.tenant_key_required()`），而 RLS 是 `FORCE` 的，
//     没有会话租户时连读都 42501。psql 以 postgres 身份登录 → `current_setting('role')` 为 none
//     → 回落到 `session_user = postgres`，属于 010:92 的受信身份，GUC 才被采信。
//
// # 幂等（这是重跑唯一的安全依据，不是"应该没事"）
//
//   `text` + `embedding_ver` 都没变 → `upsert_media_doc` 的 `ON CONFLICT … WHERE` 不命中，
//   整行不动、`updated_at` 不刷（012:302-304 / 013:302-304）。所以本脚本的 `--no-resume` 重跑
//   是**写回同样的行**而不是"跳过"，它证明的是数据库那一侧的幂等，不是脚本这一侧的跳过。
//   `progress.json` 只是省掉重复嵌入（向量重算一次 20 ms × 78k = 26 分钟，纯浪费），
//   不是正确性的一部分：删掉它重跑，结果仍然是 78 874 行、`updated_at` 不变。
//
// # 只重算 text 变了的行（`--changed-only`，默认开）
//
//   读库内**未取代**行的 `(media_key, md5(text))`，与本次渲染出来的 text 的 md5 对比：
//   md5 相同 = 这行不用嵌入、不用写库（一次嵌入 ~20 ms，78k 行是半小时；模板升级后第一次跑几乎全变，
//   但从第二次起就不该再付一遍）。`--all` 关掉比对，回到"每一行都算"的旧行为。
//   汇总里同时打印 `changed / unchanged / written / noop` 四个数：
//   changed = text 变了（或库内没有）→ 进入重算；unchanged = text 未变 → 跳过；
//   written = RPC 报 written:true；noop = 写回去了但库没动（幂等证据，不是"没处理"）。
//
// # 失败清单的口径
//
//   * 嵌入侧：HTTP 非 2xx / 维度不是 768 / 20 s 超时 → 重试 3 次（0.3 s / 0.9 s / 2.7 s 退避）后计入失败；
//   * 写库侧：整批语句数对不上 → 立刻**逐行重放**这一批，把失败落到具体 `media_key` 与 psql 的 ERROR 行；
//   * 失败的行**不写进 progress**（下次重跑自然重试），只在本次运行的汇总里按原因聚合。
//
// 退出码：0 全部成功（含"已完成"）；1 有失败行/数据库步骤失败；2 参数或环境错误。
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_ANALYZER_VER, mediaDocRow } from '../packages/openfilm/src/material-doc.mjs';
import { entryMetaOf, parseMaterialName } from '../packages/openfilm/src/material-index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_FILE = path.join(ROOT, 'infra', 'docker-compose.yml');
const LOCAL_DB = 'orange';

/** 契约：`docs/sql/embedding.json` 的 dims。RPC 自己也会断言（012:269-271），这里先断一次免得白跑 78k 次。 */
export const EMBED_DIMS = 768;
/** 第二条向量列（014）：qwen3-embedding-8b 的 4096 维。两列并存，谁给了写谁（014 §3）。 */
export const EMBED_DIMS_4096 = 4096;
/** 实测端点（LM Studio，`analysis.md` §2 记的 `:1235`；`:1234` 不是嵌入端口）。 */
export const DEFAULT_ENDPOINT = 'http://127.0.0.1:1235/v1/embeddings';
export const DEFAULT_MODEL = 'text-embedding-nomic-embed-text-v1.5';
/** `embedding_ver` 是**模型版本**，不是管线版本（012:108-109 的注释）；带维度，换模型就是换一行新数据。 */
export const DEFAULT_EMBEDDING_VER = 'nomic-embed-text-v1.5';
/** `--dims 4096` 的三件套默认值：端点上的 LM Studio 模型 id、嵌入模型版本、产出这批文档的管线版本。 */
export const DEFAULT_MODEL_4096 = 'text-embedding-qwen3-embedding-8b';
export const DEFAULT_EMBEDDING_VER_4096 = 'qwen3-embedding-8b';
export const DEFAULT_ANALYZER_VER_4096 = 'card-meta-qwen3-8b';
/** 维度 → 载荷里的键名。768 走 012 的列，4096 走 014 的列；键名是 upsert 唯一认得的东西。 */
export const VECTOR_KEY = Object.freeze({ 768: 'embedding', 4096: 'embedding_4096' });
/** 维度 → `p_row` 里放向量的那个键。 */
export const vectorKeyOf = (dims) => VECTOR_KEY[dims] ?? VECTOR_KEY[EMBED_DIMS];
/**
 * 维度 → `p_row` 里放"这条向量的模型版本"的键（015）。
 *
 * 两条向量列各有自己的版本列：`embedding_ver` 只描述 768 那一列，`embedding_ver_4096` 只描述 4096 那一列。
 * 一个键对两列写，就是把 768 的模型标签改写成 8B 的串（run-8b.md §6 第 2 条记的那个代价），
 * 而 `upsert_media_doc` 现在是"给哪列就必须给哪列的版本"（缺了 23514）。
 */
export const VERSION_KEY = Object.freeze({ 768: 'embedding_ver', 4096: 'embedding_ver_4096' });
/** 维度 → `p_row` 里放模型版本的那个键。 */
export const versionKeyOf = (dims) => VERSION_KEY[dims] ?? VERSION_KEY[EMBED_DIMS];
/**
 * 本次写入的**取代模式**（只对 4096 有分歧，768 那条就是这一行的主向量，没有第二个选择）：
 *
 *   coexist（默认）：沿用 768 行的 analyzer_ver → 命中同一条主键 → upsert 只是把第二列写上，
 *                    768 向量与它的 live 状态**都不动**（014 允许两列同一行并存）；
 *   supersede      ：用新的 analyzer_ver → 新行落地 → 同一 media_key 的 768 行被取代
 *                    （`embedding` 置空 + `superseded_at`）：这是 014 那一批的代价，需要显式要。
 */
export const modeOf = (options) => (options.dims !== EMBED_DIMS_4096
  ? 'write'
  : (options.supersede ? 'supersede' : 'coexist'));

/**
 * 这一趟写的是哪个库（`local` 本机 docker / `cloud` 云端连接串）。
 *
 * 为什么要进进度文件的 meta：本地全量与云端灌库是**两笔账**。同一份 progress 混用，本机写完的行会让云端
 * 那趟直接跳过——库里明明没这些行，进度却显示"已完成"，这是最难发现的一类静默残缺。
 */
export const backendOf = (options) => (String(options?.dbUrl ?? '').trim() ? 'cloud' : 'local');

/** 连接串打码：只留 scheme / 用户 / 主机 / 端口 / 库名，**口令永远不出现在输出里**。 */
export function maskUrl(url) {
  const text = String(url ?? '').trim();
  if (!text) return '';
  try {
    const parsed = new URL(text);
    const user = parsed.username ? `${parsed.username}@` : '';
    return `${parsed.protocol}//${user}${parsed.host}${parsed.pathname}`;
  } catch {
    return text.replace(/:\/\/([^:/@]+):[^@]*@/, '://$1:***@');
  }
}
/** 题述：并发 ≤ 4。再多也只是把单卡 LM Studio 排成一队，还会把 p99 拖过 20 s。 */
export const MAX_CONCURRENCY = 4;
export const DEFAULT_CONCURRENCY = 4;
/** 题述：每批 200–500 条。300 是"一批 30 s 内落库 + 失败重放代价可接受"的中点。 */
export const DEFAULT_BATCH = 300;
export const MIN_BATCH = 200;
export const MAX_BATCH = 500;
export const DEFAULT_TIMEOUT_MS = 20_000;
/** 题述：失败重试 3 次带退避。 */
export const DEFAULT_RETRIES = 3;
const RETRY_BASE_MS = 300;
export const PROGRESS_SCHEMA = 'orange/material-doc-progress/1';
/** 本地库的进度文件（默认）。云端另起一份：两份进度混用 = "本机做完的"被当成"云上也灌了"。 */
export const DEFAULT_PROGRESS_LOCAL = path.join(ROOT, '.dev', 'material-doc', 'progress.json');
export const DEFAULT_PROGRESS_CLOUD = path.join(ROOT, '.dev', 'material-doc', 'progress-cloud.json');
/** 云端 psql 用容器里的客户端：本机没装 psql，也不为此引入驱动依赖（`infra/verify.mjs` 同一条路子）。 */
export const CLOUD_PSQL_IMAGE = 'postgres:17';
/** 一次 upsert 的返回信封是 jsonb 对象 —— 用行首字符就能把它和 psql 的 `SET` 回显之类区分开。 */
const RESULT_PREFIX = '{';

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
/** 默认参数，也是桩测试构造 `options` 的唯一来源（别在测试里手抄一份，抄的那份一定会漂）。 */
export function defaultOptions() {
  return {
    limit: 0,
    dryRun: false,
    resume: true,
    /* 只重算 text 变了的行：库内已有 `(media_key, md5(text))`，相同的行不嵌入、不写库。`--all` 关掉它。 */
    changedOnly: true,
    batch: DEFAULT_BATCH,
    concurrency: DEFAULT_CONCURRENCY,
    tenant: 'tenant-a',
    endpoint: DEFAULT_ENDPOINT,
    model: DEFAULT_MODEL,
    /* 768（012 的 embedding 列，nomic）或 4096（014 的 embedding_4096 列，qwen3-embedding-8b）。 */
    dims: EMBED_DIMS,
    /* 默认还是"索引里的前 N 条"；`--spread` 改成按 产品×分组 轮转取样（覆盖不同产品，见 spreadByProduct）。 */
    spread: false,
    analyzerVer: DEFAULT_ANALYZER_VER,
    embeddingVer: DEFAULT_EMBEDDING_VER,
    /* 取代：默认关。`--dims 4096` 默认 coexist（同 analyzer_ver、同一行两列并存，768 不动）；
       `--supersede` 才回到 014 那一批的行为（新 analyzer_ver = 新行 → 768 行被取代）。 */
    supersede: false,
    indexFile: path.join(homedir(), '.openfilm-dev', 'material-index', 'index.json'),
    progressFile: DEFAULT_PROGRESS_LOCAL,
    /* 质量闸：这些 media_key 连嵌入都不做（`scripts/material-quality-plan.mjs` 产出的 quarantined 清单）。 */
    excludeFile: null,
    /* 云端库：给了它就走 `docker run --rm postgres:17 psql <url>`，不给就是本机 docker compose 那套。
       **session 直连 5432**，不是 6543 transaction pooler（会话级 set 与断言都要求一个真会话）。 */
    dbUrl: '',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    retries: DEFAULT_RETRIES,
  };
}

function parseArgs(argv) {
  const opts = defaultOptions();
  const numbers = new Set(['limit', 'batch', 'concurrency', 'timeoutMs', 'retries', 'dims']);
  /* 三个"模型三件套"能不能被 --dims 覆盖，取决于用户有没有显式给过它们：`--dims 4096` 定默认，
     显式 `--analyzer-ver X` 仍然赢（不然两个 flag 的在先在后会决定结果，那是坑）。 */
  const explicit = new Set();
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    /* 同时吃 `--key value` 与 `--key=value`：后者是回填脚本被别的脚本调用时最常见的形式。 */
    const eq = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const flag = eq === -1 ? raw : raw.slice(0, eq);
    const inline = eq === -1 ? undefined : raw.slice(eq + 1);
    const value = () => {
      if (inline !== undefined) return inline;
      const next = argv[++i];
      return next === undefined ? '' : next;
    };
    switch (flag) {
      case '--limit': opts.limit = Number(value()); break;
      case '--batch': opts.batch = Number(value()); break;
      case '--concurrency': opts.concurrency = Number(value()); break;
      case '--tenant': opts.tenant = value(); break;
      case '--endpoint': opts.endpoint = value(); break;
      case '--model': opts.model = value(); explicit.add('model'); break;
      case '--dims': opts.dims = Number(value()); break;
      case '--analyzer-ver': opts.analyzerVer = value(); explicit.add('analyzerVer'); break;
      case '--embedding-ver': opts.embeddingVer = value(); explicit.add('embeddingVer'); break;
      case '--index': opts.indexFile = value(); break;
      case '--progress': opts.progressFile = value(); break;
      case '--exclude-file': opts.excludeFile = value(); break;
      case '--db-url': opts.dbUrl = value(); break;
      case '--timeout-ms': opts.timeoutMs = Number(value()); break;
      case '--retries': opts.retries = Number(value()); break;
      case '--dry-run': opts.dryRun = true; break;
      case '--resume': opts.resume = true; break;
      case '--no-resume': opts.resume = false; break;
      case '--changed-only': opts.changedOnly = true; break;
      case '--all': opts.changedOnly = false; break;
      case '--spread': opts.spread = true; break;
      case '--supersede': opts.supersede = true; break;
      case '--help':
      case '-h':
        console.log('usage: node scripts/material-doc-index.mjs [--limit N] [--dry-run] [--no-resume] [--all] '
          + '[--spread] [--batch 200..500] [--concurrency 1..4] [--tenant KEY] [--endpoint URL] [--model NAME] '
          + '[--dims 768|4096] [--supersede] [--analyzer-ver VER] [--embedding-ver VER] [--index PATH] [--progress PATH] '
          + '[--exclude-file PATH]');
        console.log('  --changed-only  默认：只对 text 变了的行重新嵌入 + upsert（库内 md5(text) 对比）');
        console.log('  --all           不比对，库里每一行都重算（等于旧行为）');
        console.log('  --dims 768      写 embedding（768 维 nomic，012 的列）');
        console.log('  --dims 4096     写 embedding_4096（4096 维 qwen3-embedding-8b，014 的列）；'
          + '默认联动 ' + DEFAULT_MODEL_4096 + ' / ' + DEFAULT_EMBEDDING_VER_4096);
        console.log('  --supersede     只对 --dims 4096 有意义：默认 coexist（沿用 768 行的 analyzer_ver，'
          + '同一行两列并存、不取代 768）；给了它才改用 ' + DEFAULT_ANALYZER_VER_4096
          + '（新行 → 同一 media_key 的 768 行被取代）');
        console.log('  --spread        --limit N 时按 产品×分组 轮转取样（覆盖不同产品），而不是取索引里的前 N 条');
        console.log('  --exclude-file  质量闸：文件里的 media_key 一律不嵌入、不写库（'
          + '`scripts/material-quality-plan.mjs` 产出的 quarantined 清单）；被闸掉的不进 progress，也不算失败');
        console.log('  --db-url        云端 session 直连（5432）连接串；不给就是本机 docker compose。'
          + '云端默认进度文件 ' + DEFAULT_PROGRESS_CLOUD + '，与本地那份分开记账');
        process.exit(0);
        break;
      default:
        console.error(`未知参数：${raw}`);
        process.exit(2);
    }
  }

  if (opts.dims !== EMBED_DIMS && opts.dims !== EMBED_DIMS_4096) {
    console.error(`--dims 只能是 ${EMBED_DIMS} 或 ${EMBED_DIMS_4096}（收到 ${opts.dims}）`);
    process.exit(2);
  }
  /* `--dims 4096` = "调 8B 写第二条向量列"：模型与嵌入版本一起换成 8B 那一套（显式给了的仍然赢）。
     analyzer_ver 的分歧在后面：默认 coexist（沿用 768 行的那一个），`--supersede` 才换新的。 */
  if (opts.dims === EMBED_DIMS_4096) {
    if (!explicit.has('model')) opts.model = DEFAULT_MODEL_4096;
    if (!explicit.has('embeddingVer')) opts.embeddingVer = DEFAULT_EMBEDDING_VER_4096;
    if (opts.supersede) {
      /* 014 那一批的行为：新 analyzer_ver = 新行 → 同一 media_key 的 768 行被取代（run-8b.md §6 第 1 条）。 */
      if (!explicit.has('analyzerVer')) opts.analyzerVer = DEFAULT_ANALYZER_VER_4096;
    } else if (!explicit.has('analyzerVer')) {
      /* 默认 coexist：沿用 768 行的 analyzer_ver，于是 upsert 命中同一主键，只把 embedding_4096 写上去 ——
         两列并存、不取代任何行。显式 `--analyzer-ver X` 仍然赢（那条路一定是新行）。 */
      opts.analyzerVer = DEFAULT_ANALYZER_VER;
    }
  } else if (opts.supersede) {
    /* 768 那条写的就是这一行的主向量，没有"并存/取代"的分歧：给了也没有第二种行为，明说一句别让它静默生效。 */
    console.warn('--supersede 只对 --dims 4096 有意义（--dims 768 写的是本行的主向量，不受取代模式影响），已忽略');
    opts.supersede = false;
  }
  if (!Number.isFinite(opts.limit) || opts.limit < 0) { console.error('--limit 必须是 ≥ 0 的整数（0 = 全量）'); process.exit(2); }
  if (!Number.isInteger(opts.batch) || opts.batch < 1) { console.error('--batch 必须是正整数'); process.exit(2); }
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) { console.error('--concurrency 必须是正整数'); process.exit(2); }
  if (!opts.tenant) { console.error('--tenant 不能为空（租户只从会话解，参数传进去毫无作用）'); process.exit(2); }
  if (!opts.analyzerVer || !opts.embeddingVer) { console.error('--analyzer-ver / --embedding-ver 不能为空'); process.exit(2); }
  if (opts.dbUrl) {
    /* 三种"看着像云端、实际不能用"的串，先在这里拦掉，别等灌了 3 千行才发现 GUC 不生效。 */
    if (!/^postgres(ql)?:\/\//.test(opts.dbUrl)) {
      console.error('--db-url 必须是 postgres:// 或 postgresql:// 连接串');
      process.exit(2);
    }
    if (/6543|pooler/i.test(opts.dbUrl)) {
      console.error('--db-url 指向 6543/pooler：灌库与断言必须走 session 直连 5432（transaction 模式下 set 会丢）');
      process.exit(2);
    }
    /* 云端的进度文件必须与本地那份分开，否则"本机写完"会被当成"云上也灌了"。 */
    if (opts.progressFile === DEFAULT_PROGRESS_LOCAL) opts.progressFile = DEFAULT_PROGRESS_CLOUD;
  }

  opts.limit = Math.floor(opts.limit);
  /* 并发上限不是"风格建议"：LM Studio 单机排队，>4 只是把 p99 抬过超时线，净效果是重试变多。 */
  if (opts.concurrency > MAX_CONCURRENCY) {
    console.warn(`--concurrency ${opts.concurrency} 超过上限，按 ${MAX_CONCURRENCY} 跑`);
    opts.concurrency = MAX_CONCURRENCY;
  }
  if (opts.batch < MIN_BATCH || opts.batch > MAX_BATCH) {
    console.warn(`--batch ${opts.batch} 不在建议区间 ${MIN_BATCH}–${MAX_BATCH}，照给定值执行`);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// 索引 → 待处理条目
// ---------------------------------------------------------------------------
const str = (value) => (typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim());

/**
 * 索引里的全部素材条目：`batches[].products[].groups[].entries[]`（解析成三层的那 390 条）
 * 加 `unclassified[]`（其余 78 484 条）。两处合计等于 `totals.videos`。
 *
 * 索引文件有两层信封：外层是构建器自己的记账（`orange/material-index-build/1`，`unclassified` 在那里是**数字**
 * 而不是数组），树在 `index` 键底下（`orange/material-index/1`）。两种形状都吃：
 * 有 `index` 对象就用它，否则按树本身处理（桩测试与手工样本都是后者）。
 *
 * 去重在这里做而不是靠 upsert：同一个 `videoId` 落到同一个主键上，第二次写只会得到一个
 * `written:false`，把它算进"进度"会让 `done/total` 说谎。缺 `videoId` 的条目没有身份，
 * 由 `mediaDocRow` 抛 TypeError（012:81 的 media_key 非空约束），这里先计数再排除。
 *
 * 老版本索引的 group 只有 `videoIds`（没有 `entries`）时退化成 `{videoId}`：那样 text 只能是
 * `asset:<id>`（mediaDocText 的兜底），仍可写、仍可检索，但会在日志上说清楚有多少条走了这条路。
 * @param {any} index
 */
export function collectEntries(index) {
  const tree = index && typeof index.index === 'object' && index.index ? index.index : (index ?? {});
  const entries = [];
  const seen = new Set();
  const skipped = { noIdentity: 0, duplicateId: 0, idOnly: 0 };

  const push = (entry) => {
    const videoId = str(entry?.videoId ?? entry?.mediaKey);
    if (!videoId) { skipped.noIdentity += 1; return; }
    if (seen.has(videoId)) { skipped.duplicateId += 1; return; }
    seen.add(videoId);
    /* 六个卡片字段原样带过去（labels / durationMs / author / coverUrl / oneLevel / twoLevel）：丢掉它们，文本就退回
       「产品 + 分组 + 名称」，也就是 `card-meta-2` 要修的那个问题。旧索引没有这些键时 `entryMetaOf` 给空值。 */
    entries.push({
      videoId,
      name: typeof entry?.name === 'string' ? entry.name : '',
      md5: str(entry?.md5),
      ...entryMetaOf(entry),
    });
  };

  for (const batch of tree?.batches ?? []) {
    for (const product of batch?.products ?? []) {
      for (const group of product?.groups ?? []) {
        if (Array.isArray(group?.entries)) {
          for (const entry of group.entries) push(entry);
        } else {
          for (const videoId of group?.videoIds ?? []) { skipped.idOnly += 1; push({ videoId }); }
        }
      }
    }
  }
  /* 外层信封里 `unclassified` 是计数（number）；树里才是数组。只认数组，别把数字当列表遍历。 */
  if (Array.isArray(tree?.unclassified)) for (const entry of tree.unclassified) push(entry);

  return { entries, skipped, total: Number(tree?.totals?.videos ?? index?.videos ?? entries.length) };
}

// ---------------------------------------------------------------------------
// 行与语句
// ---------------------------------------------------------------------------
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * 768 维浮点数组 → pgvector 的文本字面量 `[a,b,c]`。
 *
 * `upsert_media_doc` 是 `(p_row ->> 'embedding')::vector`（012:264），所以向量必须以**文本**进 JSON，
 * 不能是数组（数组会先被 `->>` 转成 `[1,2,3]` 的 JSON 文本，pgvector 恰好也认这一层，但多一次
 * 序列化/反序列化的歧义没必要）。维度与"全是有限数字"在这里断言：坏向量不该走到数据库再被 22023 打回。
 * @param {unknown} values
 * @param {number} [dims]
 */
export function toVectorLiteral(values, dims = EMBED_DIMS) {
  if (!Array.isArray(values)) throw new TypeError(`embedding 不是数组（收到 ${typeof values}）`);
  if (values.length !== dims) throw new TypeError(`embedding 维度是 ${values.length}，契约要求 ${dims}`);
  for (const value of values) {
    if (!isFiniteNumber(value)) throw new TypeError(`embedding 含非有限数：${String(value)}`);
  }
  return `[${values.join(',')}]`;
}

/**
 * 一个索引条目 → `p_row`（14 个键，来自 `mediaDocRow`）+ 向量三件套。
 *
 * 向量键只在真给了向量时加：`--dry-run` 产出的载荷必须和真跑时**少两键**，
 * 而不是带一对 `embedding: null` 让人以为"算过但没结果"。
 *
 * 键名按维度走（`embedding` / `embedding_4096`）：014 起两条向量列并存，upsert 是"谁给了写谁"，
 * 所以**维度决定键**，不是"哪个键都行"——写错键会让 4096 的向量落进 768 的列并被 22023 打回。
 * @param {{ videoId: string, name?: string, md5?: string }} entry
 * @param {{ analyzerVer?: string, embeddingVer?: string, embedding?: number[] | null, dims?: number }} options
 */
export function buildPayload(entry, options = {}) {
  const {
    analyzerVer = DEFAULT_ANALYZER_VER,
    embeddingVer = DEFAULT_EMBEDDING_VER,
    embedding = null,
    dims = EMBED_DIMS,
  } = options;
  const row = mediaDocRow(entry, { analyzerVer, sourceKind: 'cloud' });
  if (embedding === null || embedding === undefined) return row;
  row[vectorKeyOf(dims)] = toVectorLiteral(embedding, dims);
  /* 版本落到**这一列的**版本键上（015）：768 → embedding_ver，4096 → embedding_ver_4096。
     写错键的两种后果都是真的：给 768 写了 8B 的串是"标签说谎"，给 4096 写成 embedding_ver 是 23514。 */
  row[versionKeyOf(dims)] = embeddingVer;
  return row;
}

/**
 * 按 **产品 × 分组** 轮转取样：`--limit N --spread` 用。
 *
 * 为什么不是 `slice(0, N)`（原行为）：索引是按 批次 → 产品 → 分组 排的，取前 5 000 条等于
 * 把整批整批的产品吃掉、后面的产品一条不进 —— 那样"5 000 条的召回"只证明了**一个产品**的召回，
 * 而 8 条验收查询横跨柠檬宝藏茶 / 油弃乌龙茶 / 柑普茶 / 茉莉飘雪 / 猴头菇丁香沙棘茶 / 迪士尼生晒柑 / 大红袍。
 * 轮转的桶是 `产品·二级分类·分组`（能用到的三层都用上），每轮每桶取一条，直到凑够 N 或取完：
 *   * 覆盖率优先：桶数 ≥ N 时每个桶至少一条，桶数 < N 时每桶一条后再按同样顺序补第二轮；
 *   * 确定性：桶的顺序、桶内的顺序都是索引顺序，同一份 index.json + 同一个 N 得同一批 id
 *     （断点续跑与"两次跑的是同一批"都靠这一点）；
 *   * 没有产品/分组可解析的条目（`unclassified`、老索引只有 id）落在 `''` 桶里，照样参与轮转，
 *     不会因为"名字不像产品名"就永远排到最后。
 * @param {Array<{videoId: string, name?: string}>} entries
 * @param {number} limit
 */
export function spreadByProduct(entries, limit) {
  const buckets = new Map();
  for (const entry of entries) {
    const parsed = parseMaterialName(str(entry?.name));
    const twoLevel = str(entryMetaOf(entry).twoLevel);
    /* `parseMaterialName` 对"名字不像素材名"的条目返回 null（相机文件名、导出名、只有 id 的老索引）：
       它们落在 `''` 桶里照样参与轮转，而不是被丢掉。 */
    const key = `${parsed?.product || ''}\u0000${twoLevel}\u0000${parsed?.groupLabel || ''}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(entry);
  }
  const lists = [...buckets.values()];
  const picked = [];
  for (let round = 0; picked.length < limit; round++) {
    let took = false;
    for (const list of lists) {
      if (round >= list.length) continue;
      picked.push(list[round]);
      took = true;
      if (picked.length >= limit) break;
    }
    if (!took) break;
  }
  return picked;
}

/**
 * 一条文本的 md5（32 位十六进制）。与 PostgreSQL 的 `md5()` 是同一个串（两边都是 UTF-8 字节的 MD5），
 * 所以库里的摘要与这里算的可以直接比较 —— 这是"text 没变就不重算"能成立的唯一前提。
 * @param {unknown} text
 */
export const textDigest = (text) => createHash('md5').update(String(text ?? ''), 'utf8').digest('hex');

/**
 * 库内**未取代**行的 `media_key → md5(text)`（`--changed-only` 的比对表）。
 *
 * 读不到就抛：把"读不到"当成"全都变了"会把 78 874 行白重算一遍（≈半小时的嵌入），
 * 把"读不到"当成"全都没变"会一条都不写。两种静默都比一次失败更贵。
 * @param {(script: string) => Promise<{code: number, stdout: string, stderr: string}>} psql
 * @param {string} tenant
 */
export async function readLiveDigests(psql, tenant) {
  const script = [
    `set app.company_key = ${sqlLiteral(tenant)};`,
    "select 'doc|' || media_key || '|' || md5(text) from public.media_doc where superseded_at is null;",
    '',
  ].join('\n');
  const result = await psql(script);
  if (result.code !== 0) {
    throw new Error(`读取库内 text 摘要失败（exit ${result.code}）：${firstError(result.stderr) || '无 stderr'}`);
  }
  const digests = new Map();
  for (const line of String(result.stdout ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('doc|')) continue;
    const [, mediaKey, digest] = trimmed.split('|');
    if (mediaKey && digest) digests.set(mediaKey, digest);
  }
  return digests;
}

/** 一个不可能出现在载荷里的 dollar-quote 标签（JSON 里真出现 `$mdoc$` 就换一个，不赌）。 */
function dollarTag(payloads) {
  for (let i = 0; i < 50; i++) {
    const tag = i === 0 ? '$mdoc$' : `$mdoc${i}$`;
    if (!payloads.some((payload) => payload.includes(tag))) return tag;
  }
  throw new Error('找不到安全的 dollar-quote 标签：载荷里塞满了 $mdoc$ 变体');
}

const sqlLiteral = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * 一批载荷 → 一个 psql 会话脚本。
 *
 * 第一行是 `set app.company_key`（会话级，不是 `set local`）：`psql -c` 的多条语句共享一个会话，
 * 而每一批本来就是一次进程，这个 SET 的生命周期正好等于这一批。
 *
 * `ON_ERROR_STOP` 由调用方设为 off：一行失败不该让后面 299 行一起丢，
 * 语句与结果的对应关系靠"成功才有输出行"来数（见 parsePsqlOutput）。
 * @param {object[]} payloads
 * @param {string} tenant
 */
export function toPsqlScript(payloads, tenant) {
  const bodies = payloads.map((payload) => JSON.stringify(payload));
  const tag = dollarTag(bodies);
  const statements = [`set app.company_key = ${sqlLiteral(tenant)};`];
  for (const body of bodies) statements.push(`select public.upsert_media_doc(${tag}${body}${tag}::jsonb);`);
  return `${statements.join('\n')}\n`;
}

/**
 * psql `-qAt` 的 stdout → 每行一个 `upsert_media_doc` 信封。
 *
 * 只认以 `{` 开头的行：`-q` 已经压掉了 `SET` 的命令标签，但 psql 的 NOTICE 走 stderr、
 * `\pset` 之类的杂音将来也可能混进来，用"是不是解析得动的 jsonb 对象"当过滤条件最稳。
 * 行数与语句数对不上 = 有语句失败（psql 对失败的语句不输出任何行）。
 */
export function parsePsqlOutput(stdout) {
  const results = [];
  const noise = [];
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!trimmed.startsWith(RESULT_PREFIX)) { noise.push(trimmed); continue; }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && 'ok' in parsed) { results.push(parsed); continue; }
    } catch { /* 不是我们的信封，落到 noise */ }
    noise.push(trimmed);
  }
  return { results, noise };
}

/** psql 的 stderr 里第一行 `ERROR:`/`错误:`，给失败清单用（整段 stderr 会淹掉日志）。 */
export function firstError(stderr) {
  const lines = String(stderr ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const hit = lines.find((line) => /^(ERROR|FATAL|错误|致命错误)\b/i.test(line)) ?? lines[0] ?? '';
  return hit.replace(/^docker\s*:\s*/i, '').slice(0, 300);
}

// ---------------------------------------------------------------------------
// 嵌入
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * 一条文本 → `dims` 维向量（768 = nomic / 4096 = qwen3-embedding-8b）。失败重试 `retries` 次，退避 300/900/2700 ms。
 *
 * 维度不对**不重试**：模型没换、端点没换，重试只会重复同一个错；这类错误必须让整批停下去看模型名。
 * 期望维度来自 `options.dims`（默认 768），所以"拿 nomic 去写 4096 列"会在第一次响应就被拦住，
 * 而不是等 5 000 行落库后被 upsert 的 4096 断言逐条打回。
 * 超时用 `AbortSignal.timeout`（node ≥ 18），每次尝试一个新 signal —— 复用同一个已 abort 的 signal
 * 会让第 2 次尝试立刻失败，看起来像"端点坏了"。
 * @param {{ endpoint: string, model: string, timeoutMs?: number, retries?: number, dims?: number, fetchImpl?: typeof fetch }} options
 */
export function makeEmbedder(options) {
  const {
    endpoint, model, timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES,
    dims = EMBED_DIMS, fetchImpl = fetch,
  } = options;

  return async function embed(text) {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(RETRY_BASE_MS * (3 ** (attempt - 1)));
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, input: text }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        lastError = new Error(`嵌入请求失败（第 ${attempt + 1} 次）：${error?.message ?? String(error)}`);
        continue;
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        lastError = new Error(`嵌入端点 HTTP ${response.status}（第 ${attempt + 1} 次）：${body.slice(0, 200)}`);
        /* 4xx 里除了 429 都是"这条请求本身有问题"，重试无意义，但保留重试也无害（次数有限）。 */
        continue;
      }
      let body;
      try {
        body = await response.json();
      } catch (error) {
        lastError = new Error(`嵌入响应不是 JSON（第 ${attempt + 1} 次）：${error?.message ?? String(error)}`);
        continue;
      }
      const vector = body?.data?.[0]?.embedding;
      if (!Array.isArray(vector)) {
        lastError = new Error(`嵌入响应缺 data[0].embedding（第 ${attempt + 1} 次）`);
        continue;
      }
      if (vector.length !== dims) {
        throw new Error(`模型 ${model} 返回 ${vector.length} 维，契约要求 ${dims}（换模型就是在换 embedding_ver，换维度就是在换列）`);
      }
      return vector;
    }
    throw lastError ?? new Error('嵌入失败');
  };
}

/**
 * 定长并发池：保持输入顺序，任何一项抛错都会让整池停（回填里"一条文本失败"就是要停下来说清楚）。
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
export async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------------------
// 质量闸：被隔离的 media_key（不嵌入、不写库、不占 progress）
// ---------------------------------------------------------------------------
/**
 * 读隔离清单。三种形状都吃，因为产出它的脚本会先写一份人读的、再写一份机读的：
 *   `["videoId", …]`（裸数组）、`{ quarantined: ["videoId", …] }`（`material-quality-plan.mjs` 的写法）、
 *   `{ mediaKeys: [...] }` 或 `{ excluded: [...] }`（手工维护时的同义写法）。
 *
 * 空清单**是合法输入**（"这次没有要闸的"），文件不存在才是错：静默当成空清单，等于让人以为闸开了。
 * @param {string} file
 * @returns {Set<string>}
 */
export function readExcludeFile(file) {
  if (!existsSync(file)) throw new Error(`隔离清单不存在：${file}（先跑 scripts/material-quality-plan.mjs）`);
  const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const list = Array.isArray(raw)
    ? raw
    : (raw?.quarantined ?? raw?.mediaKeys ?? raw?.excluded ?? []);
  if (!Array.isArray(list)) throw new Error(`隔离清单 ${file} 里没有数组（认 quarantined / mediaKeys / excluded / 裸数组）`);
  return new Set(list.map((value) => String(value).trim()).filter(Boolean));
}

// ---------------------------------------------------------------------------
// 进度文件（原子替换）
// ---------------------------------------------------------------------------
export function readProgressFile(file, expected) {
  if (!existsSync(file)) return { done: new Set(), meta: null };
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const meta = {
    schema: raw.schema,
    tenant: raw.tenant,
    analyzerVer: raw.analyzerVer,
    embeddingVer: raw.embeddingVer,
    dims: raw.dims,
    backend: raw.backend,
  };
  /* 换租户/换模型/换维度/换库后复用旧进度 = 用 A 的向量冒充 B 的答案。宁可报错让人显式删文件。
     一个例外：coexist 模式下 `analyzer_ver` 取的是**库里那一行已有的版本**，同一次全量跑可能先记成
     card-meta-2、下次解析成 card-meta-qwen3-8b（两者指向同一列 embedding_4096 的同一批行）。那不代表换了向量空间，
     只代表这个模式没有唯一的版本名，所以这一对视为同一个空间，只提示不报错。
     `backend` 只在新文件里（老进度文件没有这个键）：缺就不比对，等于向后兼容。 */
  const SAME_4096_SPACE = new Set(['card-meta-2', DEFAULT_ANALYZER_VER_4096]);
  for (const key of ['tenant', 'analyzerVer', 'embeddingVer', 'dims', 'backend']) {
    if (expected?.[key] && meta[key] && meta[key] !== expected[key]) {
      const sameSpace = key === 'analyzerVer' && SAME_4096_SPACE.has(meta[key]) && SAME_4096_SPACE.has(expected[key]);
      if (sameSpace) continue;
      throw new Error(`进度文件 ${file} 是给 ${key}=${meta[key]} 的，本次是 ${expected[key]}；换个 --progress 或先删掉它`);
    }
  }
  const done = new Set(Array.isArray(raw.done) ? raw.done.map((key) => String(key)) : []);
  return { done, meta };
}

/** 先写 `.tmp` 再 rename：中途被打断不会留下半份 JSON（rename 在同一磁盘上是原子的）。 */
export function writeProgressFile(file, done, meta) {
  mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify({
    schema: PROGRESS_SCHEMA,
    tenant: meta.tenant,
    analyzerVer: meta.analyzerVer,
    embeddingVer: meta.embeddingVer,
    dims: meta.dims,
    backend: meta.backend,
    total: meta.total,
    updatedAt: new Date().toISOString(),
    done: [...done].sort(),
  });
  const temp = `${file}.tmp`;
  writeFileSync(temp, body);
  renameSync(temp, file);
}

// ---------------------------------------------------------------------------
// 人读的速率与剩余时间
// ---------------------------------------------------------------------------
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

/** 失败原因聚合：同一个原因只留一条计数 + 前 5 个例子（78k 行跑完没人读 300 行同样的 ERROR）。 */
export function addFailure(bucket, reason, mediaKey) {
  const key = str(reason) || 'unknown';
  const slot = bucket.get(key) ?? { reason: key, count: 0, samples: [] };
  slot.count += 1;
  if (slot.samples.length < 5 && mediaKey) slot.samples.push(mediaKey);
  bucket.set(key, slot);
  return bucket;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
/**
 * 回填主循环。所有外部能力都在 `deps` 里，桩测试因此不连真库、不连真端点。
 *
 * @param {ReturnType<typeof parseArgs>} options
 * @param {{
 *   readIndex: () => any,
 *   embed: (text: string) => Promise<number[]>,
 *   psql: (script: string) => Promise<{ code: number, stdout: string, stderr: string }>,
 *   readDigests?: () => Promise<Map<string, string>> | Map<string, string>,
 *   readExcludes?: () => Set<string>,
 *   readProgress?: (expected: object) => { done: Set<string>, meta: any },
 *   writeProgress?: (done: Set<string>, meta: object) => void,
 *   log?: (line: string) => void,
 *   warn?: (line: string) => void,
 *   now?: () => number,
 * }} deps
 */
export async function runBackfill(options, deps) {
  const log = deps.log ?? ((line) => console.log(line));
  const warn = deps.warn ?? ((line) => console.warn(line));
  const now = deps.now ?? (() => Date.now());

  const startedAt = now();
  const index = await deps.readIndex();
  const collected = collectEntries(index);
  const known = new Set(collected.entries.map((entry) => entry.videoId));

  /* `--limit` 先切候选集、再按进度过滤：这样 `--limit 50` 永远指"索引里的前 50 条"，
     而不是"进度之后剩下的前 50 条"——后者会让小样本的边界随进度漂移，两次跑的不是同一批。
     `--spread` 把"前 N 条"换成"按 产品×分组 轮转的 N 条"（同样确定性，见 spreadByProduct）。 */
  /* 质量闸（`--exclude-file`）**先于 `--limit`**：`--limit 50` 要的是"前 50 条要处理的"，
     不是"前 50 条再闸掉一半"。被闸掉的行既不算 done 也不算失败——它们是"不该进这个语料"的行。 */
  const excluded = options.excludeFile
    ? (deps.readExcludes ?? (() => readExcludeFile(options.excludeFile)))()
    : null;
  const gated = excluded ? collected.entries.filter((entry) => !excluded.has(entry.videoId)) : collected.entries;
  let candidates = gated;
  if (options.limit > 0) {
    candidates = options.spread
      ? spreadByProduct(candidates, options.limit)
      : candidates.slice(0, options.limit);
  }
  const total = candidates.length;

  const meta = {
    tenant: options.tenant,
    analyzerVer: options.analyzerVer,
    embeddingVer: options.embeddingVer,
    dims: options.dims,
    /* 本地全量与云端灌库是两笔账：进度文件混用会让"本机写完"冒充"云上也灌了"。 */
    backend: backendOf(options),
    total,
  };
  const progress = options.resume
    ? (deps.readProgress ?? ((expected) => readProgressFile(options.progressFile, expected)))({
      tenant: meta.tenant, analyzerVer: meta.analyzerVer, embeddingVer: meta.embeddingVer,
      dims: meta.dims, backend: meta.backend,
    })
    : { done: new Set(), meta: null };
  const done = progress.done;
  const pending = candidates.filter((entry) => !done.has(entry.videoId));

  const summary = {
    total,
    entries: collected.entries.length,
    indexVideos: collected.total,
    skipped: collected.skipped,
    /* excluded：被质量闸挡掉的条数（这些 media_key 不嵌入、不写库、不进 progress）。 */
    excluded: excluded ? collected.entries.length - gated.length : 0,
    /* shared：文本一模一样的行共用一条向量（同 text 给两个向量 = 同一问题两个答案，排序会抖）。 */
    shared: 0,
    resumed: { alreadyDone: total - pending.length, pending: pending.length, known: known.size },
    batches: 0,
    /* changed：text 与库内不同（或库内没有这行）→ 这次要重新嵌入 + upsert；
       unchanged：text 与库内逐字节相同 → 这次不嵌入、不写库；
       written：RPC 报 written:true；noop：写回去了但库没动（012/013 的幂等证据）。 */
    changed: 0,
    unchanged: 0,
    written: 0,
    noop: 0,
    failures: new Map(),
    dryRun: options.dryRun,
    elapsedMs: 0,
    rowsPerSecond: 0,
    sampleTexts: [],
  };

  log(`索引 ${options.indexFile}`);
  log(`条目 ${collected.entries.length} 条（索引 totals.videos=${collected.total}；`
    + `缺 videoId ${collected.skipped.noIdentity}，重复 videoId ${collected.skipped.duplicateId}`
    + `${collected.skipped.idOnly ? `，仅 id 无 name ${collected.skipped.idOnly}` : ''}）`);
  log(`本次处理 ${total} 条；断点续跑：已完成 ${summary.resumed.alreadyDone}，待写 ${pending.length}`
    + `（progress=${options.resume ? options.progressFile : 'off'}）`);
  if (excluded) {
    log(`质量闸：隔离清单 ${options.excludeFile} 共 ${excluded.size} 个 media_key，本次挡掉 ${summary.excluded} 条`
      + `（不嵌入、不写库；清单里不在索引上的 ${Math.max(0, excluded.size - summary.excluded)} 个忽略）`);
  }
  /* `mode=` 是这一批"到底动了谁"的一句话（D 的验收点）：
     mode=write     768 那条（写本行主向量）；
     mode=coexist   4096 写进 768 那一行，两列并存，不取代任何行（默认）；
     mode=supersede 4096 走新 analyzer_ver → 同 media_key 的 768 行被取代（需显式 --supersede）。 */
  log(options.dryRun
    ? `模式：--dry-run mode=${modeOf(options)}（只算 text，不嵌入、不写库、不动 progress）`
    : `模式：写入 mode=${modeOf(options)} tenant=${options.tenant} analyzer_ver=${options.analyzerVer}`
      + ` 版本列=${versionKeyOf(options.dims)}(${options.embeddingVer})`
      + ` 列=${vectorKeyOf(options.dims)}(${options.dims} 维) model=${options.model}`
      + ` batch=${options.batch} concurrency=${options.concurrency}`
      + ` backend=${backendOf(options)}${options.dbUrl ? ` (${maskUrl(options.dbUrl)})` : ''}`
      + `${options.changedOnly ? ' changed-only' : ' --all'}${options.spread ? ' spread' : ''}`);

  if (!options.dryRun && pending.length === 0) {
    log('没有待写条目（全部已完成）。要重写同一批请加 --no-resume（幂等复核）。');
  }

  /* 一个真会咬人的组合：changed-only 只比对 **text**，看不见"4096 列还是空的"。
     于是"给已有语料补第二条向量列"在 changed-only 下等于什么都不做（text 早就一样了）—— 说出来，别静默 0 条。 */
  if (!options.dryRun && options.dims === EMBED_DIMS_4096 && options.changedOnly) {
    warn(`--dims ${EMBED_DIMS_4096} 与 changed-only 同时开：text 没变的行会被跳过，`
      + 'embedding_4096 不会补上。补这一列请加 --all');
  }

  /* --dry-run 只走"条目 → 文本"这一段：它要回答的是"这批名字渲染出来的文档长什么样"，不是"能不能连库"。 */
  if (options.dryRun) {
    for (const entry of candidates.slice(0, 10)) {
      const payload = buildPayload(entry, { analyzerVer: options.analyzerVer });
      summary.sampleTexts.push({ mediaKey: payload.media_key, text: payload.text });
    }
    for (const sample of summary.sampleTexts) log(`  ${sample.mediaKey}  ${sample.text}`);
    summary.elapsedMs = now() - startedAt;
    return summary;
  }

  /* text 很便宜（微秒级），嵌入很贵（一次 ~20 ms）：先把每条候选的 text 与它的 md5 算出来，再决定谁要重算。 */
  const planned = pending.map((entry) => {
    const row = buildPayload(entry, { analyzerVer: options.analyzerVer });
    return { entry, row, digest: textDigest(row.text) };
  });
  const liveDigests = options.changedOnly && typeof deps.readDigests === 'function'
    ? await deps.readDigests()
    : null;
  const work = liveDigests ? planned.filter((item) => liveDigests.get(item.entry.videoId) !== item.digest) : planned;
  summary.changed = work.length;
  summary.unchanged = planned.length - work.length;
  log(liveDigests
    ? `text 比对：changed ${work.length}，unchanged ${summary.unchanged}`
      + `（库内 ${liveDigests.size} 条未取代行的 md5(text)；相同的行不嵌入、不写库）`
    : options.changedOnly
      ? 'text 比对：没有库内摘要（deps.readDigests 未提供），本次按全部重算'
      : 'text 比对：--all，库内摘要未参与比对（每一行都重算）');
  if (work.length === 0) log('text 与库内逐字节相同，本次没有要重算的行。');

  /* 同 text 只嵌一次：`work` 里 digest 相同的行共用同一条向量（同一段文本给两个向量 = 同一个问题两个答案，
     排序会随批次抖动）。memo **只对重复的 digest 建** —— 64k 条 4096 维字面量约 2 GB，全量缓存会把内存吃光；
     库里的重复集只有 1 729 组 / 2 804 行，memo 的上限就是那几千条。 */
  const dupDigests = new Map();
  for (const item of work) dupDigests.set(item.digest, (dupDigests.get(item.digest) ?? 0) + 1);
  const vectorMemo = new Map();

  for (let offset = 0; offset < work.length; offset += options.batch) {
    const slice = work.slice(offset, offset + options.batch);
    summary.batches += 1;

    const payloads = await mapPool(slice, options.concurrency, async (item) => {
      if (summary.sampleTexts.length < 5) summary.sampleTexts.push({ mediaKey: item.entry.videoId, text: item.row.text });
      const shareable = (dupDigests.get(item.digest) ?? 0) > 1;
      let pending = shareable ? vectorMemo.get(item.digest) : undefined;
      if (pending) {
        summary.shared += 1;
      } else {
        /* 先入 memo 再 await：同一批里并发撞上同一段文本时，后来者等第一条，而不是各发一次嵌入。 */
        pending = deps.embed(item.row.text).then((embedding) => toVectorLiteral(embedding, options.dims));
        if (shareable) vectorMemo.set(item.digest, pending);
      }
      let vector;
      try {
        vector = await pending;
      } catch (error) {
        /* 同一 digest 的失败不能让后面的行跟着挂：撤掉这条 memo，下一行自己重试。 */
        if (shareable && vectorMemo.get(item.digest) === pending) vectorMemo.delete(item.digest);
        addFailure(summary.failures, `embed: ${error?.message ?? String(error)}`, item.entry.videoId);
        return null;
      }
      /* 键名由维度决定（768 → embedding / 4096 → embedding_4096）：014 的两条列是"谁给了写谁"，
         写错键名等于把 4096 的向量递给 768 的列，会被 upsert 的维度断言逐条打回。
         版本键同理（015）：每一列带自己的模型版本。 */
      return {
        ...item.row,
        [vectorKeyOf(options.dims)]: vector,
        [versionKeyOf(options.dims)]: options.embeddingVer,
      };
    });

    const { results, failures } = await writeBatch(deps, payloads.filter(Boolean), options);
    for (const result of results) {
      if (result.written) summary.written += 1; else summary.noop += 1;
      done.add(result.mediaKey);
    }
    for (const failure of failures) addFailure(summary.failures, `db: ${failure.reason}`, failure.mediaKey);

    if (deps.writeProgress || options.resume) {
      (deps.writeProgress ?? ((set, md) => writeProgressFile(options.progressFile, set, md)))(done, meta);
    }

    const elapsed = now() - startedAt;
    const processed = Math.min(offset + slice.length, work.length);
    const rate = processed / Math.max(1, elapsed / 1000);
    const remaining = work.length - processed;
    const eta = rate > 0 ? (remaining / rate) * 1000 : Number.POSITIVE_INFINITY;
    log(`[${summary.batches}/${Math.ceil(work.length / options.batch)}] `
      + `done=${done.size}/${total} (${((done.size / Math.max(1, total)) * 100).toFixed(1)}%) `
      + `${rate.toFixed(1)}/s eta=${formatDuration(eta)} `
      + `changed=${summary.changed} unchanged=${summary.unchanged} written=${summary.written} `
      + `noop=${summary.noop} shared=${summary.shared} fail=${countFailures(summary.failures)}`);
  }

  summary.elapsedMs = now() - startedAt;
  summary.rowsPerSecond = (summary.written + summary.noop) / Math.max(0.001, summary.elapsedMs / 1000);
  return summary;
}

const countFailures = (bucket) => [...bucket.values()].reduce((total, slot) => total + slot.count, 0);

/**
 * 一批载荷 → 数据库，失败的落到具体 `media_key`。
 *
 * 快路径：一个 psql 会话跑完整批。语句数与返回信封数一致，就是"全部成功"。
 * 慢路径（只在数量对不上时）：逐行重放这一批，一条一个会话 —— 代价是 300 次 psql 启动，
 * 换来的是"哪个 media_key、什么 ERROR"，而不是"这批有 1 行失败"。
 */
export async function writeBatch(deps, payloads, options) {
  if (payloads.length === 0) return { results: [], failures: [] };

  const script = toPsqlScript(payloads, options.tenant);
  const attempt = await deps.psql(script);
  if (attempt.code !== 0 && parsePsqlOutput(attempt.stdout).results.length === 0) {
    /* 会话根本没跑起来（docker 没起、租户解析失败…）：这不是"某一行脏"，整批都是环境问题。 */
    throw new Error(`psql 会话失败（exit ${attempt.code}）：${firstError(attempt.stderr) || '无 stderr'}`);
  }

  const parsed = parsePsqlOutput(attempt.stdout);
  if (parsed.results.length === payloads.length) return { results: parsed.results, failures: [] };

  const results = [];
  const rowFailures = [];
  for (const payload of payloads) {
    const single = await deps.psql(toPsqlScript([payload], options.tenant));
    const one = parsePsqlOutput(single.stdout);
    if (one.results.length === 1) results.push(one.results[0]);
    else rowFailures.push({ mediaKey: payload.media_key, reason: firstError(single.stderr) || `无输出（exit ${single.code}）` });
  }
  return { results, failures: rowFailures };
}

// ---------------------------------------------------------------------------
// 数据库：与 infra/migrate.mjs 同一个连接方式
// ---------------------------------------------------------------------------
function sh(cmd, args, { input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { cwd: ROOT, windowsHide: true, maxBuffer: 256 * 1024 * 1024, timeout: 10 * 60 * 1000 },
      (error, stdout, stderr) => resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      }),
    );
    /* stdin 写失败（EPIPE/EOF）必须当场吞掉：底下的容器被 OOM 杀掉时，'error' 事件没有监听者
       会把整个进程带崩（真实踩到：一次 300 行的批，psql 容器中途没了，回填直接抛 write EOF 退出）。
       吞掉之后 psql 的退出码仍然会回到调用方，走"整批失败/逐行重放"那条正常路径。 */
    if (input !== undefined) {
      child.stdin?.on('error', () => {});
      child.stdin?.end(input);
    }
  });
}

/** 一次 psql 会话：脚本走 stdin（78k 行里最长的批也就几百行，远低于命令行长度上限）。
 *
 * 两个后端，唯一区别是客户端怎么起：
 *   local（默认）：`docker compose exec -T db psql`——库和客户端同一个容器；
 *   cloud（`--db-url`）：`docker run --rm -i postgres:17 psql <url>`——本机没装 psql，也不为此引驱动依赖。
 * 共同点（也是正确性依据）：都是**一个会话一个租户 GUC**（010 的 `set app.company_key`），
 * 所以绝不能换成 6543 transaction pooler —— 那里 `set` 与语句不在同一会话，租户会丢。
 */
export function makePsql(options = {}) {
  const { command, args } = psqlCommandFor(options);
  return (script) => sh(command, args, { input: script });
}

/** `makePsql` 的纯函数版：只算命令行，不执行——这样"云端到底怎么连"可以被测，而不是只能靠跑一次。 */
export function psqlCommandFor(options = {}) {
  const dbUrl = String(options?.dbUrl ?? '').trim();
  const tail = [
    '-qAt',
    /* 一行失败不该带走整批：失败靠"没有输出行"被发现，再逐行定位（见 writeBatch）。 */
    '-v', 'ON_ERROR_STOP=0',
  ];
  if (dbUrl) {
    return { command: 'docker', args: ['run', '--rm', '-i', CLOUD_PSQL_IMAGE, 'psql', dbUrl, ...tail] };
  }
  return {
    command: 'docker',
    args: ['compose', '-f', COMPOSE_FILE, 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', LOCAL_DB, ...tail],
  };
}

/** 跑完之后的现场：行数、向量覆盖率、抽 5 条。这是 run.md 要贴的证据，不另写一段 SQL 手抄。 */
export async function report(deps, options) {
  const dims = options.dims ?? EMBED_DIMS;
  const script = [
    `set app.company_key = ${sqlLiteral(options.tenant)};`,
    "select 'total|' || count(*) || '|' || count(*) filter (where superseded_at is null) "
      + '|| \'|\' || count(embedding) || \'|\' || count(embedding_4096) || \'|\' || count(distinct media_key) '
      + 'from public.media_doc;',
    /* 版本分布：`card-meta-2` 写完以后，`card-meta-1` 应该全部被取代（superseded_at 非空）——这是"旧向量没有
       留在检索里"的证据，不是好看的行数。014 起一行两列向量并存，所以每行再报 768 / 4096 各自的非空数。 */
    "select 'ver|' || analyzer_ver || '|' || count(*) || '|' || count(*) filter (where superseded_at is null) "
      + '|| \'|\' || count(embedding) || \'|\' || count(embedding_4096) '
      + 'from public.media_doc group by analyzer_ver order by analyzer_ver;',
    /* 本次这一列到底落地了多少：`--dims` 指哪列就数哪列，别把另一列的覆盖率读成本次的成绩。 */
    `select 'dims|' || ${dims} || '|' || count(*) || '|' || count(${vectorKeyOf(dims)}) `
      + `|| '|' || count(*) filter (where analyzer_ver = ${sqlLiteral(options.analyzerVer)}) `
      + `from public.media_doc where analyzer_ver = ${sqlLiteral(options.analyzerVer)};`,
    "select 'sample|' || media_key || '|' || length(text) || '|' || (embedding is not null)::text || '|' "
      + '|| (embedding_4096 is not null)::text || \'|\' || coalesce(batch, \'-\') || \'|\' || left(text, 60) '
      + 'from public.media_doc where superseded_at is null order by media_key limit 5;',
  ].join('\n');
  const result = await deps.psql(`${script}\n`);
  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
}

// ---------------------------------------------------------------------------
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const embedder = options.dryRun ? null : makeEmbedder(options);
  const psql = makePsql(options);
  const deps = {
    readIndex: () => JSON.parse(readFileSync(options.indexFile, 'utf8')),
    embed: embedder,
    psql,
    /* `--changed-only` 的比对表：库内未取代行的 md5(text)。dry-run 不连库，所以只在真跑时给。 */
    readDigests: options.dryRun ? undefined : () => readLiveDigests(psql, options.tenant),
    log: (line) => console.log(line),
    warn: (line) => console.warn(line),
  };

  if (!options.dryRun && !existsSync(options.indexFile)) {
    console.error(`索引不存在：${options.indexFile}（先跑 node packages/openfilm/scripts/material-index-bootstrap.mjs）`);
    return 2;
  }

  const summary = await runBackfill(options, deps);

  if (summary.dryRun) {
    console.log(`\n--dry-run：可处理 ${summary.entries} 条（本次取前 ${summary.total} 条），`
      + '文本已渲染，未嵌入、未写库、未动 progress');
    return 0;
  }

  console.log('\n—— 汇总 ——');
  console.log(`条目 ${summary.resumed.pending + summary.resumed.alreadyDone} 条`
    + `（索引 totals.videos=${summary.indexVideos}，缺 videoId ${summary.skipped.noIdentity}，重复 ${summary.skipped.duplicateId}）`);
  console.log(`written=${summary.written} unchanged=${summary.unchanged} changed=${summary.changed}`
    + ` noop=${summary.noop} fail=${countFailures(summary.failures)}`
    + ` 批次=${summary.batches} 耗时=${formatDuration(summary.elapsedMs)} 速率=${summary.rowsPerSecond.toFixed(1)}/s`);
  for (const slot of summary.failures.values()) {
    console.log(`  FAIL ×${slot.count}  ${slot.reason}${slot.samples.length ? `  例：${slot.samples.join(', ')}` : ''}`);
  }

  const live = await report(deps, options);
  if (live.code !== 0) {
    console.error(`现场查询失败（exit ${live.code}）：${firstError(live.stderr)}`);
    return 1;
  }
  for (const line of String(live.stdout).split(/\r?\n/).filter(Boolean)) {
    const [kind, ...rest] = line.split('|');
    if (kind === 'total') {
      console.log(`media_doc：总行数 ${rest[0]}，其中未取代 ${rest[1]}，有 768 向量 ${rest[2]}，`
        + `有 4096 向量 ${rest[3]}，distinct media_key ${rest[4]}`);
    } else if (kind === 'ver') {
      console.log(`  版本 ${rest[0]}：${rest[1]} 行，其中未取代 ${rest[2]}，768 向量 ${rest[3]}，4096 向量 ${rest[4]}`);
    } else if (kind === 'dims') {
      console.log(`  本次列 ${rest[0]} 维：analyzer_ver=${options.analyzerVer} 共 ${rest[1]} 行，`
        + `该列非空 ${rest[2]}`);
    } else if (kind === 'sample') {
      console.log(`  抽样 ${rest[0]} text=${rest[1]}字 768=${rest[2] === 'true' ? '非空' : '空'} `
        + `4096=${rest[3] === 'true' ? '非空' : '空'} batch=${rest[4]} ${rest[5]}`);
    }
  }

  return countFailures(summary.failures) === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = await main();
  process.exit(code);
}
