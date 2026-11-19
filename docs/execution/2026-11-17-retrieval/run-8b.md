# media_doc 第二条向量列（4096 / qwen3-embedding-8b）：014 + 5 000 条真跑 + 8B vs nomic top-1

- 时间：2026-11-17 15:55–16:52 (+08:00)
- 仓库/HEAD：`D:\dev\orange` @ `2a14a6e`（分支 `chore/vendor-0.3.2`；**未 commit**）
- 写集：`docs/sql/014_media_doc_4096.sql`（新增）、`docs/sql/contract.json`、`docs/sql/README.md`、
  `docs/contracts/media-doc.schema.json`、`packages/openfilm/src/index-client.mjs`（仅 `RPC_NAMES`）、
  `scripts/material-doc-index.mjs`、本文件
- 目标库：本机 Docker `infra/docker-compose.yml` 的 `db`（`pgvector/pgvector:pg17`，`orange` 库），
  本批前已应用到 `013`；租户 `tenant-a`（会话 GUC `app.company_key`）
- 嵌入端点：`http://127.0.0.1:1235/v1/embeddings`（LM Studio；`:1234` 拒绝连接）

## 0. 先核对事实（不是假设）

| 事实 | 核对方式 | 结果 |
|---|---|---|
| 端点上有哪几个模型 | `GET /v1/models` | `text-embedding-qwen3-embedding-8b` / `…-4b` / `text-embedding-nomic-embed-text-v1.5` |
| 8B 返回 4096 维、模型回显正确 | `POST` 一条文本读 `data[0].embedding.length` 与 `model` | 4096，`model` 回显 `text-embedding-qwen3-embedding-8b` |
| 8B 单条延迟 | 3 次串行 | 795 / 625 / 643 ms（与题述 803 ms 一致） |
| **并发 4 不带来 4 倍吞吐** | 4 条并发 vs 串行 | 并发 4 合共 2 696 ms（≈675 ms/条）——LM Studio 在这台机器上串行消化，`PARALLEL 4` 只影响排队方式 |
| 库内现状（跑之前） | `count(*)` / `filter (superseded_at is null)` / `count(embedding)` | 146 018 行，其中 live 78 874，全部 768 维；`distinct media_key` 78 874；`analyzer_ver` 2 个（`card-meta-1` / `card-meta-2`） |
| pgvector 版本 | `select extversion from pg_extension where extname='vector'` | 0.8.7 |

**两处引擎事实（第一条决定了 014 的索引形状）**：

```
create temporary table t (id int, e vector(4096));  create index on t using hnsw (e vector_cosine_ops);
  ERROR:  column cannot have more than 2000 dimensions for hnsw index
create temporary table t (id int, e halfvec(4096)); create index on t using hnsw (e halfvec_cosine_ops);
  ERROR:  column cannot have more than 4000 dimensions for hnsw index
create temporary table t (id int, e halfvec(4000)); create index on t using hnsw (e halfvec_cosine_ops);   -- 成功
```

## 1. 014 做了什么（五项，只加不改）

| # | 内容 | 落点 |
|---|---|---|
| 1 | `alter table public.media_doc add column if not exists embedding_4096 vector(4096)` | 只加列；`embedding vector(768)` 原样保留（并存，不是替换） |
| 2 | 一条**部分** HNSW，谓词 `embedding_4096 is not null and superseded_at is null` | 建在 `(subvector(embedding_4096,1,4000))::halfvec(4000)` 上（见 §2） |
| 3 | `upsert_media_doc` 认 `p_row->>'embedding_4096'` | 数组或 `'[a,b,…]'` 文本都吃；维度断言 4096（不符 → `22023`）；给了就必须带 `embedding_ver`（`23514`）。冲突目标/幂等/取代语义逐条不变；取代时**两条向量一起清**；回执多一个 `vectors` 数组说清这次落了哪列 |
| 4 | 新检索函数 `media_search_4096(p_company_key, p_query, p_filters, p_embedding vector(4096), p_limit)` | 与 `media_search` 同语义：向量/ilike/trigram 三路、`match_kind`、按 `media_key` 去重 shot 优先、同一份过滤键与 11 列返回 |
| 5 | 契约同步 | `contract.json`（`tables.media_doc.vectors`、`rpc.upsert_media_doc.notes`、新增 `rpc.media_search_4096`、`budgets`）、`media-doc.schema.json`（`/2 → /3`，`$defs.row.embedding_4096`）、`index-client.mjs` 的 `RPC_NAMES`、`docs/sql/README.md`（迁移表第 14 行 + §7） |

幂等：`ADD COLUMN IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` / `CREATE OR REPLACE FUNCTION`；重放 014 是 no-op。

## 2. 为什么索引是"前 4000 维 halfvec 表达式索引 + 4096 全精度重排"

题述要的是 `using hnsw (embedding_4096 vector_cosine_ops)`；§0 的两条 `ERROR` 说明这在 pgvector 0.8.7 上不存在
（稠密 `vector` ≤ 2000 维、`halfvec` ≤ 4000 维，`ivfflat` 上限同源）。三条可行形状：

| 形状 | 维度 | 代价 |
|---|---|---|
| (a) 前缀 `halfvec(4000)` 表达式索引 + 完整 4096 重排 | 候选用前 4000 维，**分数用 4096 维** | 末尾 96 维（2.3%）只影响"谁进候选" |
| (b) `sparsevec(4096)` 上的 HNSW | 全留 | 稠密向量每条 4096×8 B，66 470 行 ≈ 2 GB 索引，超出本地内容预算 |
| (c) 不建索引 | — | 5 000 行可接受，66 470 × 4096 浮点 ≈ 1 GB 顺序扫描不可接受 |

取 (a)。`media_search_4096` 的向量那一路因此拆成两段 CTE：`cand_asset` / `cand_shot` 按前缀 `halfvec` 距离
`LIMIT v_k`（表达式与索引定义逐字一致），`vec_asset` / `vec_shot` 再按 `embedding_4096 <=> p_embedding`
全精度算 `score` —— top-k 的分数与纯精确扫描同一个数，近似只发生在候选截断。

**索引真的被用上了**（5 000 行已落库后，`EXPLAIN (ANALYZE)`，取候选那一段）：

```
Limit  (cost=4.01..9.70 rows=20 width=86) (actual rows=20 loops=1)
  ->  Index Scan using media_doc_vec4096_hnsw_idx on media_doc d  (actual rows=20 loops=1)
Execution Time: 32.415 ms
```

将来 pgvector 放开稠密 4096，把索引换成题述那一句即可，函数不用改（分数本来就按 4096 算）。

## 3. 5 000 条真跑（8B / 4096 列）

```powershell
node scripts/material-doc-index.mjs --dims 4096 --spread --limit 5000 --all --batch 200 --concurrency 4 `
  --tenant tenant-a --progress .dev\material-doc\progress-4096.json
```

- `--dims 4096` 联动 `model=text-embedding-qwen3-embedding-8b`、`analyzer_ver=card-meta-qwen3-8b`、
  `embedding_ver=qwen3-embedding-8b`，向量写进 `embedding_4096`（显式给了 `--model` / `--analyzer-ver` /
  `--embedding-ver` 时**显式值赢**）。
- `--spread`：按 **产品 × 二级分类 × 分组** 轮转取样，而不是取索引前 5 000 条。实测 78 874 条落进 **570 个桶**，
  5 000 条覆盖 **12/12 个产品**、11 个分组名、521 个二级分类（最大桶 11 730 条只贡献 ≈9 条）。
  桶序与桶内序都取索引顺序 → 同一份 `index.json` + 同一个 `N` 得同一批 id（断点续跑、以及
  "同一批 id 用 nomic 再算一遍"都靠这一点）。
- `--all`：必须显式关掉 `--changed-only`。这批 `text` 与库内 768 行**逐字节相同**（模板没变），
  `--changed-only` 会把 5 000 条全判 unchanged —— 一条都不会嵌入、也不会写 4096。

真跑数字：

| 段 | 区间 | 行数 | 速率 | 结果 |
|---|---|---|---|---|
| 1 | 16:05:42 → 16:34 | 2 800 | 1.4 → 1.9/s | 第 14 批写入后 **Docker Desktop 引擎消失**（`npipe … dockerDesktopLinuxEngine` 不存在），node 报 `Error: write EOF` 退出 1 |
| 2（续跑） | 16:37:54 → 16:47:32 | 2 200 | **3.8/s** | `written=2200 noop=0 fail=0`，exit 0 |

- **总账**：5 000 条全部写入，**失败 0**。墙钟 41m50s，其中 ≈3 min 是 Docker 重启空档；
  纯运行 ≈38m50s → **≈2.2 条/s**（段 2 无干扰时 3.8/s，段 1 掉到 1.9/s 是因为我同时在跑嵌入延迟探针抢 GPU）。
- 中断没有代价：`progress.json` 每批落一次（原子替换），续跑从第 15 批接上，前 2 800 条一条不重算
  （段 2 的 `changed=2200` 就是证据 —— 只算了剩下的那些）。
- 库内现场：

```
media_doc：总行数 151018，其中未取代 78874，有 768 向量 73874，有 4096 向量 5000，distinct media_key 78874
  版本 card-meta-1：78874 行，其中未取代 11718，768 向量 11718，4096 向量 0
  版本 card-meta-2：67144 行，其中未取代 62156，768 向量 62156，4096 向量 0
  版本 card-meta-qwen3-8b：5000 行，其中未取代 5000，768 向量 0，4096 向量 5000
  本次列 4096 维：analyzer_ver=card-meta-qwen3-8b 共 5000 行，该列非空 5000
```

即：`analyzer_ver='card-meta-qwen3-8b'` **5 000 行**，`embedding_4096` **非空 5 000**，
全部 `superseded_at is null`（这批就是当前答案）；**768 那侧 78 874 → 73 874**（见 §6 第 1 条）。

## 4. 召回对照：8B(4096) vs nomic(768)

查询向量现场用同一端点现算（8B 查 4096 路、nomic 查 768 路），不落盘、不缓存。
命中判据与上一轮 `.dev/probe-embed-8b.mjs` 一致：top-1 的 `product`/`name` 里出现该查询指名的产品。

nomic 基线在**写入 5 000 条之前**取过一次（那时 78 874 行全部 live、全部 768 维）——写完之后 8 条查询的
nomic top-1 **完全没变**（同样是 7 MISS + 1 HIT），所以下表用的是写完之后的那一次（同一张表还带 8B 列）。

| # | 查询（命中目标） | nomic 768 top-1 | 8B 4096 top-1 | nomic | 8B |
|---|---|---|---|---|---|
| 1 | 柠檬宝藏茶 外包装（柠檬宝藏茶） | 0.9768 `柠檬红茶-外包装 (3)` | **0.7949** `20261106-柠檬宝藏茶200g罐-外包装 (2)` | MISS | **HIT** |
| 2 | 柠檬宝藏茶 茶干（柠檬宝藏茶） | 0.9984 `冷泡茶为什么好喝` | **0.8768** `20261109-柠檬宝藏茶200g罐-茶干料子 (15)` | MISS | **HIT** |
| 3 | 油弃乌龙茶 茶汤（油弃乌龙茶） | 0.9984 `冷泡茶为什么好喝` | **0.8209** `20261109-油弃乌龙茶-汤色 (15)` | MISS | **HIT** |
| 4 | 柑普茶 包装（柑普茶） | 0.9960 `黄芪玫瑰` | **0.6850** `20261106-2024头采新会柑普茶250g罐-包装 (15)` | MISS | **HIT** |
| 5 | 茉莉飘雪 外包装（茉莉飘雪） | 0.9768 `柠檬红茶-外包装 (3)` | **0.7799** `7.19-茉莉飘雪_20` | MISS | **HIT** |
| 6 | 猴头菇丁香沙棘茶 茶干料子（猴头菇丁香沙棘） | 0.8175 `好多人碰杯1` | **0.8804** `20261107-猴头菇丁香沙棘茶80g盒-茶干料子 (29)` | MISS | **HIT** |
| 7 | 迪士尼 生晒柑（生晒柑） | 0.9195 `迪士尼生晒柑_1` | **0.7447** `20261107-迪士尼10+16生晒柑-规格 (9)` | **HIT** | **HIT** |
| 8 | 大红袍 摆设（大红袍） | 0.8732 `好大一片梨` | **0.6305** `宴山藏大红袍_25` | MISS | **HIT** |
| | **top-1 命中** | | | **1/8** | **8/8** |

- nomic 的 1/8 与题述背景一致（`nomic(768) top1 1/8`）；8B 这里是 **8/8**（题述的 7/8 是在"200 条候选 + 纯余弦"
  上测的，这一轮是"5 000 条真库 + media_search_4096 的完整三路管线"，第 7 条正是那时唯一没中的那条）。
- **注意分数不可跨模型比较**：nomic 的 0.99 是同一个错误答案上的高相似（模板里 `外包装`/`茶` 这类共享 token
  占主导），8B 的 0.63–0.88 才是"这个产品 + 这个分组"的分数。
- 两路 `match_kind` 全是 `vector`（没有一条是被 ilike/trigram 兜上来的）。
- 查询耗时（含 77 KB 向量字面量的解析）：8B **0.77–1.05 s**，nomic **1.0–4.4 s**（首条冷 3.5 s）。
  这不是向量索引的耗时 —— 取候选那一段是 32 ms（§2）；两个函数的大头都是 `base` CTE 物化 73 874/78 874 行后
  跑 ilike + trigram 两路兜底。

## 5. 门禁

| 门禁 | 命令 | 结果 |
|---|---|---|
| 账本 | `node infra/migrate.mjs --check` | **15 个文件与账本一致**（014 已记账，重放 no-op） |
| 契约 | `node infra/migrate.mjs --contract` | **通过**：19 个 RPC + 9 个 internal 双向比对、15 张表主键、向量维度 768、anon 0 权限 |
| 自检 | `node infra/verify.mjs` | **9/9 全部通过**（含 ①pgvector 0.8.7 ②`hnsw.iterative_scan` ③六表 ④RLS ⑤租户隔离 ⑥sync_state ⑦`deleted_at` ⑧`search_materials` ⑨向量分支） |
| 语法 | `node --check` | `scripts/material-doc-index.mjs` exit=0、`packages/openfilm/src/index-client.mjs` exit=0 |
| 测试 | `node --test scripts/material-doc-index.test.mjs` | `pass 30 / fail 0`（2.6 s） |
| 测试 | `node --test apps/api/src/index/client.test.ts` | `pass 12 / fail 0`（`RPC_NAMES ⇄ contract.rpc` 双向比对在这里） |
| 测试 | `node --test packages/openfilm/src/material-doc.test.mjs` | `pass 14 / fail 0`（`$defs.row` 新列是加的，原有断言不变） |
| 表现场 | `\d public.media_doc` | `embedding_4096 | vector(4096)`；索引 `"media_doc_vec4096_hnsw_idx" hnsw ((subvector(embedding_4096, 1, 4000)::halfvec(4000)) halfvec_cosine_ops) WITH (m='16', ef_construction='64') WHERE embedding_4096 IS NOT NULL AND superseded_at IS NULL` |
| 函数 | `select count(*) from public.media_search_4096(...)` | 可调用；`p_embedding` 维度不是 4096 → `22023`；`upsert_media_doc` 的 3 维 `embedding_4096` → `22023: … 维度是 3，契约要求 4096` |
| 工作区 | `git status --porcelain` | 见 §7（写集 6 个文件 + 本文件；另有 3 项**不是本批**的改动） |

## 6. 风险与遗留（都不在本批写集里改）

1. **写 8B 行会让同一 `media_key` 的 768 行被取代 —— 这是实测的代价，不是推测。**
   新 `analyzer_ver` = 新行；`upsert_media_doc` 的取代规则（012/013 起就有，014 只把两条向量一起清）把
   那 5 000 个 key 的 `card-meta-2` 行标成 `superseded_at` 并把 `embedding` 置空：
   **768 向量 78 874 → 73 874（−6.3%）**。召回对比不受影响（§4 的 nomic 列是在写之前取的完整基线，
   写完之后 8 条查询的 top-1 一个字没变），但"768 全量 corpus"少了一角。
   - 恢复这 5 000 条（约 2 分钟嵌入，`--spread` 是确定性的，取到的就是同一批 id）：
     ```powershell
     node scripts/material-doc-index.mjs --dims 768 --spread --limit 5000 --all `
       --progress .dev\material-doc\progress-restore768.json
     ```
     ```sql
     update public.media_doc d set superseded_at = null
      where d.superseded_at is not null
        and d.analyzer_ver <> 'card-meta-qwen3-8b'
        and d.embedding is not null
        and d.media_key in (select media_key from public.media_doc where analyzer_ver = 'card-meta-qwen3-8b');
     ```
2. **全量 66 470 条要不要跑：建议跑，但换一条写入路径。** 若照本批方式（新 `analyzer_ver`）跑全量，
   66 470 个 key 的 768 行会**全部**被取代 → 768 corpus 只剩 ≈12 400 行活着，等于把 nomic 基线清空。
   014 允许两条向量**同一行**并存（同 `analyzer_ver`、只给 `embedding_4096`），实测：
   ```
   coexist|768=768|4096=4096|ver=qwen3-embedding-8b|superseded=null   （无取代、768 保留）
   ```
   所以全量应走 `--dims 4096 --analyzer-ver card-meta-2`（沿用现有行），代价是 `embedding_ver` 被改写成
   8B 那一串（768 列的模型标签就不再准确 —— 要保标签就得加一列 `embedding_ver_4096`，那是下一个决策）。
   时长按实测 **3.8 条/s（独占 GPU）** 估：66 470 ÷ 3.8 ≈ **4.9 h**；带上观测/并发干扰则 ≈ **9 h**。
   建议夜间分批跑，`progress.json` 让它随时可续。
3. **并发 4 不是加速手段。** 库里 0.8B 单条 625–795 ms、4 条并发合计 2 696 ms —— 端到端 1.4–3.8 条/s 的差别
   主要来自 GPU 是否被别的请求抢（段 1 vs 段 2），不是 `--concurrency`。要更快只有换卡或换更小的模型。
4. **索引不是题述那一句。** 4096 维稠密 HNSW 在 pgvector 0.8.7 上不存在（§0/§2）。当前形状是
   "前 4000 维 halfvec 候选取 top-k + 4096 全精度重排"，top-k 分数与精确扫描一致；将来引擎放开再把索引换掉。
5. **`spreadByProduct` 没有桩测试。** 本批写集不含 `scripts/material-doc-index.test.mjs`（它在本批之前就已被
   别人改过、仍在工作区里未提交），所以新取样函数只用实测背书：570 桶、5 000 取样覆盖 12/12 产品、
   同参数两次取到同一批 id（段 2 的 `changed=2200` 与段 1 不重叠即为证据）。
6. **一次 Docker Desktop 崩溃。** 段 1 在第 14 批写入后被引擎消失打断（`npipe:////./pipe/dockerDesktopLinuxEngine`
   不存在，node 报 `write EOF` 退出 1），重启引擎后从 progress 续跑，**数据无损**（2 800 行在库里、
   2 200 行续上）。长跑任务要么挂 `--progress`（本脚本默认就挂），要么别把 stdout 接到会断的管道上
   （段 2 改成直接重定向到文件，没有再断）。
7. **没验的**：`gran='shot'` 的 4096 检索（库里 78 874 行全是 asset，没有镜头文档）、
   HNSW 在高并发/大 `v_k` 下的 recall（`hnsw.iterative_scan` 已开，但没有压测）、云端维度上限
   （托管 PG 的 pgvector 版本可能更旧，`--contract` 与 014 的收尾断言会在那时报错，属于预期）。

## 7. 写集与工作区状态

本批的写集（6 个文件 + 本文件）：

```
 M docs/contracts/media-doc.schema.json           ← 本批
 M docs/sql/README.md                             ← 本批
 M docs/sql/contract.json                         ← 本批
 M packages/openfilm/src/index-client.mjs         ← 本批（仅 RPC_NAMES 加一行）
 M scripts/material-doc-index.mjs                 ← 本批
?? docs/sql/014_media_doc_4096.sql                ← 本批（新增）
?? docs/execution/2026-11-17-retrieval/run-8b.md  ← 本批（该目录里 analysis.md / clean-report.md / run.md
                                                     早已存在但未跟踪）
```

**同一个工作区里还有别人/并行的改动，都不是本批**（本批一个字节都没碰）：

| 条目 | 说明 |
|---|---|
| `M apps/desktop/src/openfilm-mcp.test.mjs`、`M scripts/material-doc-index.test.mjs` | 本批开始前就已是 modified（`material.search` 那一批的测试） |
| `?? docs/execution/2026-11-17-collections/` | 本批开始前就在工作区 |
| `M packages/openfilm/library/index.json`、`M …/library/search.json`、`?? docs/research/HyperFrames与动效素材源研究.md`、`?? docs/research/hyperframes-catalog.json`、`?? packages/openfilm/library/text/hf-*/` | **本批跑到一半时才出现**（16:31–16:50 的时间戳），是并行的另一条任务在写 —— 与本批的 SQL/脚本/契约无关 |

`git status --porcelain` 因此**不等于**"只有写集"：本批能保证的是上面那张表里的 7 项，
其余条目属于别的批次。未 commit、未 push。`.dev/` 已 gitignore：
`progress-4096.json`、`backfill-5000*.log`、`recall-nomic-pre.json`、`recall-post.json`、
`recall-4096.mjs` 都在那里，不进写集、不进库。

## 8. 复现命令

```powershell
# 014（只追加，重放是 no-op）
node infra/migrate.mjs --target local
node infra/migrate.mjs --check          # 15 个文件与账本一致
node infra/migrate.mjs --contract       # 19 个 RPC + 9 个 internal 双向比对
node infra/verify.mjs                   # 9/9

# 表与索引现场
docker compose -f infra/docker-compose.yml exec -T db psql -U postgres -d orange -c "\d public.media_doc"

# 5 000 条 8B 回填（断点续跑；中断后重跑同一条命令）
node scripts/material-doc-index.mjs --dims 4096 --spread --limit 5000 --all --batch 200 --concurrency 4 `
  --tenant tenant-a --progress .dev\material-doc\progress-4096.json

# 8 条查询 × 两条通路（nomic 768 + 8B 4096），落盘 .dev/recall-<stage>.json
node .dev\recall-4096.mjs post --4096
```
