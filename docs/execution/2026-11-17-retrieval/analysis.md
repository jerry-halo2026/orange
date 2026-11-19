# 云管家素材 + 工程视频：同一套检索的最优形态

日期 2026-11-17 ｜ 分支 `chore/vendor-0.3.2`（`8f4df8e`）｜ **只读分析**：未改任何文件、未 commit、未启停任何应用。
本机读数（Postgres `orange-w1-db`、LM Studio `:1235`、落地索引 `~/.openfilm-dev/material-index/index.json`）全部为只读查询/只读 POST 实测。

---

## 0 结论速查（六问，逐条对应 §1 的证据）

| # | 问题 | 结论（一句话） | 关键证据 |
| --- | --- | --- | --- |
| Q1 | 身份 | 不是"会不会撞"，而是**两类里有一类根本进不去**：`search_materials` 必须 `FROM material JOIN wiki_summary`，只有云素材有 `material` 行；且 `material` 主键含 `env_id`、`wiki_summary` 不含 → 现成的跨环境扇出。缺 `source_kind / asset_key / env_id / duration_ms / in_sec / out_sec / batch,product,grp` | `007_embedding_and_wiki.sql:175-179`、`:196-201`；`002_schema.sql:29` vs `:76` |
| Q2 | 写入 | 现有通道够用（本机 `:1235/v1/embeddings`，768 维，热态 20–25 ms），但 `embedding_ver` 现在被写成了 `ANALYZER_VER`（管线版本冒充模型版本）；`analyzer_ver` 必须**进主键**而不是当护栏 | `analyze-runner.mjs:283-297`（`:295`）、`007:287-300` |
| Q3 | 检索 | **一条 RPC 可以覆盖两类**，但需要新 RPC（现有 `search_materials` 的 JOIN 形态与返回列都不够）；索引选 **HNSW 部分索引**（`gran='asset'` / `gran='shot'` 各一条），不选 ivfflat | `007:158-193`；`001:17-19`；`003:27-29` |
| Q4 | 可立即使用性 | "本地有没有"**不进库**（库不是本地磁盘的真相，会被 LRU 淘汰掉）；由客户端在返回前用 `md5Of(videoId)` + `contentStore.has(md5)` 补一个 `availability`，并在 `state='local'` 时直接给出可 `timeline.insert_clip` 的 `src` | `material-media-cache.mjs:504-505`、`:584-634`；`openfilm-mcp.mjs:89-105` |
| Q5 | Qwen-VL | 它是"哪段"的唯一来源，但**只能离线按需**：全语料逐镜头 ≈ 1,074 h 且本地 0/78,874 条字节；边际收益恰好是元数据/OCR/语音都表示不了视觉谓词（挂杯/蒸汽/手部/构图）；结果写**另一批行**（`gran='shot'` + 不同 `analyzer_ver`） | `21_素材理解管线.md:14-15`、`:70-83`、`:110-125` |
| Q6 | 降级 | 检索对供应商**零依赖**（元数据已在库/索引里），所以限流不影响检索，只影响 `materials.take`；无端点/向量缺失时走 `trigram + 结构化前缀` 混合，且**必须用 `match_kind` 把"词法"写在结果里**，不许伪装成语义 | `materials-proxy.mjs:229-254`；`003:10-11`；§4.5 |

**推荐方案一句话**：把"可检索单元"从"一条视频一个向量"改成**"一条素材级文档 + N 条镜头级文档"同表共存（`media_doc`，版本进主键、粒度是行属性）**，元数据卡向量覆盖全语料（1 小时内建完），逐镜头向量按需离线补（只对你真正要用的字节），"本地/需下载"由客户端补而不入库。

---

## 1 现状事实（带 file:line）

### 1.1 数据面：表、主键、检索函数

| 事实 | 位置 |
| --- | --- |
| `material` 主键 `(company_key, env_id, video_id)`；`sha256` 存在但**同步从不填**（永远 null） | `002_schema.sql:29`、`apps/api/src/sync/catalog.ts:102` |
| `wiki_source` 主键 `(company_key, video_id, analyzer_ver)` —— **版本进主键**，换模型不覆盖 | `002_schema.sql:53`；注释 `:58` |
| `wiki_summary` 主键 `(company_key, video_id)` —— **版本不在主键**，`analyzer_ver` 只是一个受 `>=` 护栏的普通列 | `002_schema.sql:76`、`007:287-300` |
| 向量三件套要么全有要么全无；维度 768（`vector(768)` 必须带 typmod，否则 HNSW 拒绝建索引） | `002:78-81`、`007:9-13`、`007:66-107` |
| `search_materials` 向量分支：`FROM material m JOIN wiki_summary s ON company_key+video_id`，`ORDER BY s.embedding <=> v_vec`，**只判 `s.embedding IS NOT NULL`，不判 `embedding_model`** | `007:171-192` |
| 词法分支：`similarity(m.name, v_query)`，无查询词时 `0::real`，可见性口径与向量分支逐条相同 | `007:196-215` |
| 向量分支用裸 `vector` 解析 + `vector_dims(v)=768` 断言（22023），并 `set_config('hnsw.iterative_scan','strict_order')`（事务级） | `007:158-169` |
| `upsert_wiki_summary`：`ON CONFLICT (company_key, video_id) DO UPDATE` → **整行覆盖** `scenes/risks/status/analyzer_ver`，护栏是**文本**比较 `excluded.analyzer_ver >= w.analyzer_ver` | `007:267-301`（`:288-299`、`:300`） |
| `upsert_wiki_source`：`content_hash` 必须调用方给的 64 位小写 hex；同 `(video_id, ver)` 内容没变则整行不动 | `007:310-352` |
| `wiki_video / wiki_timeline(≤20 行) / wiki_shot(≤200 tokens)` 三个读 RPC；**没有任何写 `wiki_shot`/`wiki_timeline` 的代码路径** | `007:449-607`；全仓 grep 只命中读 |
| pgvector 0.8.7（`hnsw.iterative_scan` 需要 ≥0.8，这是"过滤后仍能凑够 k 条"的前提）；`pg_trgm` 同在 001 | `001:4-5`、`:17-19` |
| 向量索引只有一条：`hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=64)`，**没有 ivfflat** | `003:25-29`、`007:82-85` |
| 名称模糊：`gin (name gin_trgm_ops)`；`labels`：GIN；软删 `deleted_at` + 部分索引 | `003:10-11`、`:14-15`、`005:37-44` |

### 1.2 写入面：向量到底谁产生

| 事实 | 位置 |
| --- | --- |
| 视觉与向量走**同一个本机 LM Studio `:1235`**（不是 1234），模型 `qwen2.5-vl-7b-instruct` / `text-embedding-nomic-embed-text-v1.5` | `analyze-runner.mjs:61-65` |
| `lmStudioEmbedder` 返回 `{model, ver: ANALYZER_VER, vector}` —— **`embedding_ver` 被写成了管线版本** | `analyze-runner.mjs:283-297`（`:295`） |
| 被向量化的文本 = `oneLine` + 前 6 条帧描述 + 前 4 条 OCR，截 6000 字符 | `analyze-runner.mjs:524` |
| `EMBED_DIMS = 768` 在客户端先卡一次（`embed-dim-mismatch`），免得 007 在 `<=>` 处才报 22023 | `analyze-service.mjs:18-23`、`:74-94` |
| `wikiRowsOf` 要求 `analyzerVer` 必填（"版本由 runner 拥有，本模块不发明"），并把手写的 `sha256(video_md)` 当 `content_hash` | `analyze-service.mjs:105-143`（`:108-112`、`:139`） |
| 写回顺序：先 `upsertWikiSource`，后 `upsertWikiSummary`；任一步失败都只降级为 `uploaded:false`，本地结果仍在 | `analyze-service.mjs:186-202` |
| **`runAnalyze` 强制要求 `videoId`**，没有 videoId 直接 `video-id-required` 返回 —— 工程视频没有任何云 id，**今天进不了这条写回管道** | `analyze-service.mjs:148-160`（`:159-160`） |
| 客户端根本没有把向量传进检索的口子：`rpcFilters()` 只认 category/labels/video_types/时间/时长/account，**没有 `embedding`** | `index-client.mjs:80-92`；`index-rpc.mjs:77-91` |
| 因此 `filters.embedding` 这条分支只有一个调用者：自检脚本 | `infra/verify.mjs:259-276`（"只证明维度一致 + 可调用 + GUC 被接受，不证明 recall"） |

### 1.3 云素材：现在到底能取到哪些字段

| 事实 | 位置 |
| --- | --- |
| 卡片字段白名单 13 项 + `videoId`：`coverUrl, downloadCount, collectCount, accountName, accountKey, createTime, duration, fileSize, oneLevelVideoType, twoLevelVideoType, videoLabels, videoState, videoType` | `ui/src/lib/material-center/model.ts:11-14` |
| `duration` 是**秒**（`wireInt(row.duration)`），落库是 `duration_ms` | `model.ts:105`、`catalog.ts:94` |
| 供应商**没有 duration 查询参数**，时长筛选只能在内存里对当前页做 | `ui/src/lib/material-center/filters.ts:27` |
| 列表/维度/标签三条是**原样透传**的读，不改写 body；对供应商自己的 503「结果未知」会重试 | `materials-proxy.mjs:213-227`、`:229-254` |
| 供应商侧 `rawMd5` 是唯一可用于"是不是同一份字节"的指纹，落地索引已带 71,686/78,874（90.9%） | `material-index.mjs:127-146`；本机 index.json 实测 |
| 名称解析出 `批次-产品-分组 (序号)` 只覆盖 390 条（0.49%），其余 78,484 条走派生层（派生批次 1,726 / 未归档组 26,160 / 未归类 25,597） | `material-index.mjs:36-63`、`:159-244`；本机 index.json 实测 |
| 检索 DB 里 **`material` 当前 0 行**——78,874 条云素材只活在本地 `index.json`（12.56 MB） | 本机只读查询；`material-index-build.mjs:29-33`（落地即文件） |

### 1.4 工程视频与"本地有没有文件"

| 事实 | 位置 |
| --- | --- |
| 工程视频没有云 id；管线里唯一的身份是**内容 sha256**（`mediaDigest`：本地文件算字节哈希，URL 算 `url:`+url） | `analyze-runner.mjs:93-100` |
| 分析缓存文件名 = `<digest>-<ANALYZER_VER>.json`（身份 + 版本，天然"可重算"） | `analyze-runner.mjs:102-104` |
| 内容库按 **md5** 命名：`<root>/content/<md5>` + 同名 `.json` 旁证（sha256/bytes/ext） | `material-media-cache.mjs:433-487` |
| 判断"本地有没有"= `contentStore.has(md5)`，`md5` 来自落地索引的 `videoId → md5` 表（索引文件变了才重读） | `material-media-cache.mjs:504-505`、`:584-634` |
| 另一套本地存在性：Saved 库按 `<videoId>.<ext>` + `.meta/<videoId>.json` 落盘 | `materials-proxy.mjs:357-390`（`:382`）、`:430-431` |
| 内容库有 LRU 预算（默认 2 GB）**会淘汰**，所以"本地有"是会过期的状态 | `material-media-cache.mjs:439-467` |
| `materials.take` 是**写**工程：把字节 import 到 `assets/`，返回 `path`；未注入 `takeMaterial` 时不可用（生产未接线，只有测试注入） | `openfilm-mcp.mjs:461-490`；`openfilm-mcp.test.mjs:158` |
| `timeline.insert_clip` 需要工程相对 `src` + `at`（秒） | `openfilm-mcp.mjs:89-105` |

### 1.5 工具面：检索今天没有名额

| 事实 | 位置 |
| --- | --- |
| 硬上限 5，且 `docs/contracts/mcp-tools.schema.json` 把 5 个名字与 caps 写死（`additionalProperties:false`） | `openfilm-mcp.mjs:120-131`；`docs/contracts/mcp-tools.schema.json:1-40` |
| 出厂的 5 个 = `material.batches / material.collections / material.items / materials.take / timeline.insert_clip` | `openfilm-mcp.mjs:130` |
| `materials.search` 被"吸收进 `material.items`"（理由：名称过滤在本地索引里做，省一次云调用） | `openfilm-mcp.mjs:148-152`；`material-tools.mjs:244-245`、`:293` |
| `wiki.read` 被退役的理由写得很直白：wiki 面依赖 index RPC，本机未配置时只会答 `not-configured` | `openfilm-mcp.mjs:166-168` |
| 三个素材工具只读本地 `index.json`，返回 `videoId + name`（`md5` 在该工具的 `entriesOf` 里被丢掉了） | `material-tools.mjs:86-91`、`:173-222` |
| `material.items` 的上限：rows 200 / default 50 | `material-tools.mjs:31-33`；§1.5 契约 |

### 1.6 本机实测读数（本次只读采集）

| 项 | 读数 | 说明 |
| --- | --- | --- |
| pgvector | `0.8.7` | 满足 `hnsw.iterative_scan` |
| `material` / `wiki_summary` / `wiki_source` / `wiki_shot` / `wiki_timeline` 行数 | `0 / 0 / 0 / 0 / 0` | 本地库只有 schema；HNSW 索引存在但空 |
| 落地索引 `index.json` | 12.56 MB，`videos=78,874`、`parsed=390`、`unclassified=78,484`、`md5` 非空 71,686（90.9%） | 与题述 78,874 一致 |
| 供应商口径 | `sourceTotal=230,030`、`pageable=79,099`、`unreachable=150,931`、`duplicates=225` | 78,874 就是**全部可达素材** |
| 嵌入端点 | `:1235/v1/embeddings` → `dims=768`；冷启 **6.8 s**，热态 **20–25 ms** | 与 `embedding.json:4-6` 一致 |
| 视觉端点 | `:1235` 在线（`qwen2.5-vl-7b-instruct`），单帧 4.1 s @512 长边（历史实测） | `21_素材理解管线.md:14` |

---

## 2 第一性原理拆解

检索的本质只有四条，缺一条就会在某个具体查询上塌：

### 2.1 身份（Identity）
一个候选必须有一个**跨同步、跨重分析、跨导入都稳定**的键，且两类语料不能共享命名空间。
- 云素材：`videoId`（数字串，如 `129678963`，见 `material-index-run.md:108-110`）+ `env_id`（同 id 在不同 env 是不同行，`002:40`）。
- 工程视频：没有云 id，唯一稳定身份是**内容 sha256**（`analyze-runner.mjs:93-100`）+ 工程内相对路径（`insert_clip` 要的就是它）。
- 二者**不可能靠命名撞车**（前缀不同），但今天的 schema 让工程视频**结构性不可见**（`FROM material JOIN wiki_summary`），并且 `material` 有 `env_id`、`wiki_summary` 没有，JOIN 会扇出。
→ 结论：身份必须是**显式列**（`source_kind` + `asset_key` + `env_id`），不是靠"id 长得不一样"来区分。

### 2.2 可表示性（Representability）
向量只能表示**你喂给它的那段文本**。今天喂的是"卡片文本"（`analyze-runner.mjs:524`：一句话 + 6 条帧描述 + OCR）。
- 卡片向量能回答"哪个素材"——它知道了产品、场景、文字。
- 卡片向量**永远不能回答"哪一段"**——时间轴在卡片里不存在。这是零信息，不是召回率问题。
- 逐镜头后才存在"时间轴上的可检索单元"。而逐镜头需要**字节**：本机 0/78,874 条有字节（§1.6）。
→ 结论：粒度必须是**行属性**（`gran='asset'|'shot'`），不能是"表的属性"，否则你只能二选一，而现实是"云语料只有卡片、工程视频有镜头"。

### 2.3 可验证性（Verifiability）
结果里的每一项，agent 在动刀前都必须能自证：
- 文件在不在（本地 LRU 会淘汰，所以这个答案是**会变的**，不能存库）；
- in/out 点在不在真实时长内（`duration_ms` 必须随候选一起回来）；
- 是不是当初索引的那份字节（`rawMd5`/`sha256`）。
→ 结论：**"本地可用性"的正确位置是客户端**（它同时握着 `md5Of` 与 `contentStore`），不是 PG 的一列。写成冗余列等于给一个会过期的状态做第二份真相。

### 2.4 可演进性（Evolvability）
换模型、换提示词、换抽帧参数都必须满足：① 不覆盖别人的答案；② 旧答案仍可读；③ 任意旧答案可重算。
- 今天的 `wiki_summary` 用**一行 + 文本比较护栏**（`007:288-300`）实现"不覆盖"，两个致命后果：
  1. 它把"管线版本"和"模型版本"混成一个字符串，`'qwen-vl-shots-1' > 'analyze-runner-2'`（字典序 `q > a`）→ 逐镜头结果一旦写进这一行，**卡片的 `scenes/risks/status` 被整行覆盖**（`007:288-299`）；
  2. 文本比较只在"版本串等长"时正确：`'analyze-runner-10' < 'analyze-runner-9'`，跨十位就翻车。历史上已验证过 `a1.0` 挡 `a0.9`（`2026-11-12-fission-integration.md:953`、`:981`），但这只是运气。
- `wiki_source` 因为**版本在主键里**（`002:53`），天然满足三件事。
→ 结论：派生数据（摘要/镜头/向量）的正确形态是**版本进主键**；"当前版本"由**排序规则**裁决（`produced_at`），不由字符串比较裁决。而向量本身是**可丢弃的导数**：正文留着，向量随时可重算（热态 25 ms），所以"新版本落地就把旧向量置空"既省索引又完全可逆。

### 2.5 推论（这四条推出的唯一形态）
1. 一张**派生索引表**，一行 = 一个"可检索文档" = `(素材|镜头) × analyzer_ver`；
2. 主键含 `source_kind`、`asset_key`、`gran`、`shot_index`、`analyzer_ver`；
3. 向量只有一列，但**两条部分索引**按 `gran` 分开（同类可比，跨类不混排）；
4. 正文 `body` 必须落库（可重算向量的唯一依据）+ `body_hash`（变更检测）；
5. "本地可用性"由客户端补；
6. 检索**一条 RPC** 同时喂向量与词法，并用 `match_kind` 说清这条是怎么命中的。

---

## 3 候选方案 A / B / C 与代价

### 3.1 方案 A：不新增表，把 `wiki_summary` 撑大（最省事的错解）
做法：给 `wiki_summary` 加 `source_kind/asset_key/duration_ms/batch/product/grp`，逐镜头结果塞进 `scenes` jsonb 或写 `wiki_shot`（不带向量）。

| 维度 | 结果 |
| --- | --- |
| 能回答"哪段" | **不能**。`scenes` 是 jsonb，不可 ANN；`wiki_shot` 无向量列，`search_materials` 也不读它 |
| 身份 | 主键仍是 `(company_key, video_id)`：工程视频没有 `video_id`，**写不进去**（`analyze-service.mjs:159-160` 先拦一次） |
| 可演进 | 最差：`analyzer_ver` 不在主键 + 文本比较 → 换管线覆盖卡片；逐镜头与卡片抢同一行 |
| 一次性成本 | 1 个迁移，~0 |
| 稳态成本 | 0（但仍要跑逐镜头才有内容） |
| 迁移面 | 小，但**每一次后续演进都被这行卡住** |
| 结论 | **更差**：省下的迁移量会在第一个"哪一段"的查询上全额还回来，且把未来的版本化空间烧掉 |

### 3.2 方案 B：全语料逐镜头（"正确但不可执行"）
做法：78,874 条全部下载 → 场景切分 → Qwen-VL 每镜头一帧 → 每镜头一行 + 向量。

| 维度 | 结果 |
| --- | --- |
| 能回答"哪段" | 能，且最彻底 |
| 数据前提 | **不成立**：本机 0/78,874 有字节；要 78,874 次下载（供应商 1 QPS，见 `19_素材索引与检索.md:87`），字节量按 100 MB/条 ≈ 7.7 TB |
| 算力 | 4.1 s/帧 @512（`21:14`）× 12 镜头/条 ≈ **1,074 h ≈ 45 天不间断**；20 镜头/条 ≈ 1,796 h |
| 存储 | 946k 行 ≈ 1.2 GB 文本 + 946k×3.2 KB ≈ **3.0 GB 向量 + ~3 GB HNSW**，桌面机内存吃紧 |
| 可演进 | 好（如果版本进主键） |
| 结论 | **更差**：不是成本高，而是被"你并不拥有那些字节"物理否决。任何把它写成"一期目标"的方案都会变成一句空话 |

### 3.3 方案 C：一张派生索引表 + 两档粒度 + 按需逐镜头（推荐）
做法见 §4。核心是承认：**卡片向量覆盖全语料（便宜，1 小时内建完），镜头向量只覆盖你拥有的字节（按需，过夜）**，两者同一张表、同一条 RPC、同一套返回结构。

### 3.4 代价对照

| 项 | A | B | **C** |
| --- | --- | --- | --- |
| 迁移面 | 改 1 张既有表（破坏契约 PK） | 1 新表 + 全量管道 | **1 新表 + 2 RPC + 回填脚本** |
| 全语料可语义检索 | 可以（卡片） | 可以 | **可以（卡片，≈33 min / 78,874 条 @25 ms）** |
| 回答"哪一段" | ✗ | ✓（全量） | **✓（按需覆盖；工程视频天然覆盖）** |
| 工程视频可进入 | ✗（无 video_id） | ✓ | **✓（`source_kind='project'`）** |
| 换模型不覆盖 | ✗ | ✓ | **✓（版本进主键 + 旧向量置空可重算）** |
| 一次性算力 | ~0 | 1,074 h + 7.7 TB 下载 | **33 min（全语料卡片）+ 27 h/2,000 条（按需镜头）** |
| 稳态存储 | 0.5 GB | ~6 GB | **0.5 GB（全卡片）+ 0.1 GB（2,000 条镜头）** |
| 回滚 | 改回列定义（不可逆，数据已覆盖） | 删除新表 | **删除新表 + 停队列；既有 `wiki_*` 一个字节未动** |

---

## 4 推荐方案（C）

### 4.1 迁移草案：`docs/sql/012_media_doc.sql`

> 命名与登记：`infra/migrate.mjs:130-134` 按文件名自动发现，已应用文件的 sha256 被账本锁定（`:251` DRIFT），所以**只能新建 012**，不能追加到 007。同时需要：`docs/sql/contract.json` 加 1 表 + 2 RPC、`docs/sql/README.md` 迁移表加一行、`infra/verify.mjs` 加一项（新表 RLS 与 RPC 可调用）。

```sql
-- 012 一套检索的派生索引层：素材级 + 镜头级同表共存，版本进主键。
-- 契约：contract.json（新增 media_doc / media_index_upsert / media_search）；
--       维度不在本文件出现——embedding.json 是唯一来源（007:22-23 的规矩）。
-- 幂等：IF NOT EXISTS / CREATE OR REPLACE；回填 ON CONFLICT DO NOTHING。

create table if not exists public.media_doc (
  company_key     text        not null,
  source_kind     text        not null check (source_kind in ('cloud','project')),
  asset_key       text        not null check (length(asset_key) > 0),   -- 云=video_id；工程=sha256:<hex>
  analyzer_ver    text        not null check (length(analyzer_ver) > 0),
  gran            text        not null check (gran in ('asset','shot')),
  shot_index      integer     not null default -1 check (shot_index >= -1), -- -1=素材级，0..=镜头
  env_id          text,                                                  -- 云素材必填（material 主键含 env）
  video_id        text,                                                  -- 云素材：供应商 id
  project_id      text,                                                  -- 工程：项目 id
  asset_rel       text,                                                  -- 工程：assets/ 下相对路径
  in_sec          numeric(12,3) check (in_sec  is null or in_sec  >= 0),
  out_sec         numeric(12,3),
  name            text,
  duration_ms     bigint      check (duration_ms is null or duration_ms >= 0),
  batch           text,
  product         text,
  grp             text,
  category1_id    text,
  category2_id    text,
  labels          text[]      not null default '{}',
  body            text        not null,        -- 被向量化的原文（可重算的唯一依据）
  body_hash       text        not null check (body_hash ~ '^[0-9a-f]{64}$'),
  embedding       vector(768),                 -- 必须带 typmod（007:9-13 的理由同样适用）
  embedding_model text,
  embedding_ver   text,                        -- 模型+版本，不再冒充管线版本
  source_table    text        not null,        -- 'wiki_summary' | 'wiki_shot' | 'material'
  source_ref      text        not null,
  superseded_at   timestamptz,                 -- 被更新版本取代；取代时向量置空（可重算）
  produced_at     timestamptz not null default now(),
  status          text        not null default 'candidate'
                    check (status in ('candidate','trusted','disputed')),
  constraint media_doc_pk primary key
    (company_key, source_kind, asset_key, analyzer_ver, gran, shot_index),
  constraint media_doc_gran_shape check
    ((gran = 'asset' and shot_index = -1) or (gran = 'shot' and shot_index >= 0)),
  constraint media_doc_cut_shape check
    ((gran = 'asset' and in_sec is null and out_sec is null)
     or (gran = 'shot' and in_sec is not null and out_sec is not null and out_sec > in_sec)),
  constraint media_doc_cloud_identity   check (source_kind <> 'cloud'   or (video_id is not null and env_id is not null)),
  constraint media_doc_project_identity check (source_kind <> 'project' or (project_id is not null and asset_rel is not null)),
  constraint media_doc_body_len         check (length(body) between 1 and 6000),
  constraint media_doc_embedding_complete check (        -- 与 002:78-81 同一条规矩
    (embedding is null and embedding_model is null and embedding_ver is null)
    or (embedding is not null and embedding_model is not null and embedding_ver is not null)),
  constraint media_doc_superseded_no_vec check (superseded_at is null or embedding is null)
);

-- 两条部分 HNSW：同类可比，跨类不混排；且只索引"当前行"，索引体积恒等于语料规模。
create index if not exists media_doc_asset_vec_idx on public.media_doc
  using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64)
  where gran = 'asset' and superseded_at is null;
create index if not exists media_doc_shot_vec_idx on public.media_doc
  using hnsw (embedding vector_cosine_ops) with (m = 32, ef_construction = 128)
  where gran = 'shot'  and superseded_at is null;

-- 过滤走 B-tree（company_key 在最左，规矩见 19_素材索引与检索.md:152）
create index if not exists media_doc_scope_idx on public.media_doc
  (company_key, source_kind, gran, batch, product, grp, duration_ms)
  where superseded_at is null;
create index if not exists media_doc_name_trgm_idx on public.media_doc
  using gin (name gin_trgm_ops) where superseded_at is null;
create index if not exists media_doc_body_trgm_idx on public.media_doc
  using gin (body gin_trgm_ops) where superseded_at is null;
create index if not exists media_doc_labels_gin_idx on public.media_doc
  using gin (labels) where superseded_at is null;

-- 租户隔离：与 010 之后所有策略同一判据（严格版，没有租户上下文 fail closed）
grant select, insert, update, delete on public.media_doc to orange_app;
alter table public.media_doc enable row level security;
alter table public.media_doc force  row level security;
drop policy if exists media_doc_tenant on public.media_doc;
create policy media_doc_tenant on public.media_doc
  using      (company_key = public.tenant_key_required())
  with check (company_key = public.tenant_key_required());

-- 收尾断言：维度、两条 HNSW、RLS 都在（失败信息直接指向要查的地方，同 007:622-646 的风格）
do $$
declare v_dims integer;
begin
  select a.atttypmod into v_dims from pg_attribute a
   where a.attrelid = 'public.media_doc'::regclass and a.attname = 'embedding';
  if v_dims is distinct from 768 then
    raise exception '012: media_doc.embedding typmod=%（要求 768）', v_dims using errcode = '22023';
  end if;
  if to_regclass('public.media_doc_asset_vec_idx') is null
     or to_regclass('public.media_doc_shot_vec_idx') is null then
    raise exception '012: HNSW 部分索引缺失';
  end if;
end $$;
```

回填（**当前库上是 no-op**，因为 `material` 0 行；它的价值在于"以后某一刻 material 有行了照样能补齐"）：

```sql
insert into public.media_doc (
  company_key, source_kind, asset_key, analyzer_ver, gran, shot_index,
  env_id, video_id, name, duration_ms, category1_id, category2_id, labels,
  body, body_hash, embedding, embedding_model, embedding_ver,
  source_table, source_ref, produced_at)
select s.company_key, 'cloud', m.video_id, s.analyzer_ver, 'asset', -1,
       m.env_id, m.video_id, m.name, m.duration_ms, m.category1_id, m.category2_id, m.labels,
       coalesce(s.one_line, m.name, m.video_id),
       encode(sha256(convert_to(coalesce(s.one_line, m.name, m.video_id), 'UTF8')), 'hex'),
       s.embedding, s.embedding_model, s.embedding_ver,
       'wiki_summary', m.video_id, s.updated_at
  from public.wiki_summary s
  join public.material m
    on m.company_key = s.company_key and m.video_id = s.video_id and m.deleted_at is null
on conflict do nothing;
```

### 4.2 写入管道（三条来源，一个函数）

```
① 云语料卡片（全量，一次性 + 增量）
   apps/api/src/sync/*（已有，写 material：catalog.ts:81-113，content_hash 见 hash.ts:35-38）
        └─▶ card text = name + 分类名 + labels + accountName + 时长        （元数据文本，不需要字节）
              └─▶ lmStudioEmbedder（:1235，热态 20–25 ms）→ media_index_upsert(gran='asset')

② 工程视频（本地已有字节，按项目增量）
   runAnalyze(project, media)（analyze-runner.mjs:351）
        └─▶ 场景切分（select=gt(scene,0.3)，21:110-125；必须校验帧数）
              ├─▶ asset 文档：oneLine + 前 6 帧描述 + OCR（= 今天 :524 的口径）
              └─▶ shot 文档：每镜头 caption + in/out         → media_index_upsert(gran='shot', analyzer_ver='qwen-vl-shots-1')

③ 云素材被真正用到时（下载后 / materials.take 命中内容库时）
   同一份字节 = 同一个 sha256 → 与 ② 完全相同的管道，asset_kind='cloud' 但 gran='shot'
```

`media_index_upsert` 的语义（一个 RPC，一个事务，一次往返）：

```sql
create or replace function public.media_index_upsert(p_company_key text, p_row jsonb)
returns jsonb language plpgsql security invoker
set search_path = public, extensions, pg_temp set statement_timeout = '30s'
as $$
declare
  v_tenant text := public.app_tenant_key();
  v_ver    text := nullif(btrim(coalesce(p_row->>'analyzer_ver','')), '');
  v_emb    vector; v_dims integer; v_superseded integer := 0;
begin
  -- 写侧沿用 007 的口径：租户不符抛 42501（007:243-245），不静默
  if v_tenant is not null and v_tenant <> p_company_key then
    raise exception 'media_index_upsert: tenant mismatch' using errcode = '42501';
  end if;
  -- 三件套 + 维度断言（与 007:250-265 同一条，只是错误码前缀不同）
  if p_row ? 'embedding' and jsonb_typeof(p_row->'embedding') <> 'null' then
    if nullif(btrim(coalesce(p_row->>'embedding_model','')),'') is null
       or nullif(btrim(coalesce(p_row->>'embedding_ver','')),'') is null then
      raise exception 'media_index_upsert: embedding needs model and ver' using errcode = '23514';
    end if;
    v_emb  := (p_row->>'embedding')::vector;
    v_dims := vector_dims(v_emb);
    if v_dims <> 768 then
      raise exception 'media_index_upsert: dims=% 要求 768', v_dims using errcode = '22023';
    end if;
  end if;

  insert into public.media_doc as d (company_key, source_kind, asset_key, analyzer_ver, gran,
    shot_index, env_id, video_id, project_id, asset_rel, in_sec, out_sec, name, duration_ms,
    batch, product, grp, category1_id, category2_id, labels, body, body_hash,
    embedding, embedding_model, embedding_ver, source_table, source_ref, status)
  values ( /* 逐字段取自 p_row，粒度相关的空值由 CHECK 兜底 */ )
  on conflict (company_key, source_kind, asset_key, analyzer_ver, gran, shot_index) do update
     set body = excluded.body,
         body_hash = excluded.body_hash,
         embedding = coalesce(excluded.embedding, d.embedding),
         embedding_model = coalesce(excluded.embedding_model, d.embedding_model),
         embedding_ver   = coalesce(excluded.embedding_ver,   d.embedding_ver),
         superseded_at = null,
         produced_at = now()
   where d.body_hash is distinct from excluded.body_hash or d.superseded_at is not null;

  -- 新版本落地 → 旧版本的向量置空（正文与行都留着：向量是导数，25 ms 可重算）
  update public.media_doc
     set embedding = null, embedding_model = null, embedding_ver = null, superseded_at = now()
   where company_key = p_company_key
     and source_kind = p_row->>'source_kind'
     and asset_key   = p_row->>'asset_key'
     and gran        = p_row->>'gran'
     and analyzer_ver <> v_ver
     and superseded_at is null
     and embedding is not null;
  get diagnostics v_superseded = row_count;

  return jsonb_build_object('ok', true, 'superseded', v_superseded, 'analyzerVer', v_ver);
end $$;
```

**`analyzer_ver` 怎么取值**（这是 Q2 的正面回答）：

| 产出 | `analyzer_ver` 取值 | 为什么 |
| --- | --- | --- |
| 云语料元数据卡（无字节） | `card-meta-1` | 只由 `material` 字段与分类名构成；换分类名规则才 +1 |
| 云素材/工程视频整片理解（今天 `analyze-runner-2`） | `analyze-runner-N` | 抽帧参数、提示词、判定器都在里面；`ANALYZER_VER` 已经是这个语义（`analyze-runner.mjs:42-48`） |
| 逐镜头（Qwen-VL） | `qwen-vl-shots-1` | 独立管道；与整片理解不是同一份答案，绝不互相覆盖 |
| 向量模型 | `embedding_ver = 'nomic-embed-text-v1.5@768'`（**不再取 `ANALYZER_VER`**） | 现在 `analyze-runner.mjs:295` 把管线版本当模型版本写，换抽帧参数会被误读成"换了嵌入模型" |

### 4.3 检索 RPC 签名

```sql
create or replace function public.media_search(
  p_company_key text,
  p_query       text    default null,        -- 词法兜底（trigram + 结构化前缀）
  p_filters     jsonb   default '{}'::jsonb, -- source_kind/gran/batch/product/group/labels/category2/
                                             -- min_duration_ms/max_duration_ms/env_id/asset_keys/status
  p_embedding   jsonb   default null,        -- {model, ver, vector:[768]}；模型必填，否则拒绝
  p_limit       integer default 20
) returns table (
  source_kind text, asset_key text, video_id text, project_id text, asset_rel text, env_id text,
  gran text, shot_index integer, in_sec numeric, out_sec numeric,
  name text, duration_ms bigint, batch text, product text, grp text, labels text[],
  score real, match_kind text,               -- 'vector' | 'trigram' | 'prefix'
  analyzer_ver text, body text, source_table text, source_ref text
) language plpgsql stable security invoker
set search_path = public, extensions, pg_temp set statement_timeout = '30s'
```

关键实现点（草案骨架，不是全量）：

```sql
-- ① 租户：读侧沿用 007 的"空集语义"，不报错（007:150-152）
if v_tenant is not null and v_tenant <> p_company_key then return; end if;
-- ② 向量入参：模型必须显式，否则跨模型距离没有意义
if p_embedding is not null then
  v_model := nullif(btrim(coalesce(p_embedding->>'model','')), '');
  if v_model is null then raise exception 'media_search: embedding.model is required' using errcode='22023'; end if;
  v_vec := (p_embedding->>'vector')::vector;
  if vector_dims(v_vec) <> 768 then raise exception 'media_search: dims must be 768' using errcode='22023'; end if;
  perform set_config('hnsw.iterative_scan', 'strict_order', true);   -- 007:169 同一条
end if;

-- ③ 混合：向量 top-k 与词法 top-k 各取 k=least(4*limit,200)，按身份去重，向量优先
with base as (
  select d.* from public.media_doc d
   where d.company_key = p_company_key
     and d.superseded_at is null                             -- [live]
     and (p_filters->>'source_kind' is null or d.source_kind = p_filters->>'source_kind')
     and (p_filters->>'gran'        is null or d.gran        = p_filters->>'gran')
     and (p_filters->>'batch'       is null or d.batch       = p_filters->>'batch')
     and (p_filters->>'product'     is null or d.product     = p_filters->>'product')
     and (p_filters->>'group'       is null or d.grp         = p_filters->>'group')
     and (p_filters->>'env_id'      is null or d.env_id      = p_filters->>'env_id')
     and (p_filters->>'min_duration_ms' is null or d.duration_ms >= (p_filters->>'min_duration_ms')::bigint)
     and (p_filters->>'max_duration_ms' is null or d.duration_ms <= (p_filters->>'max_duration_ms')::bigint)
     and (p_filters->'category2' is null or d.category2_id = any(array(select jsonb_array_elements_text(p_filters->'category2'))))
     and (p_filters->'labels'    is null or d.labels && array(select jsonb_array_elements_text(p_filters->'labels')))
),
vec as (
  select b.*, (1 - (b.embedding <=> v_vec))::real as score, 'vector'::text as match_kind
    from base b
   where v_vec is not null and b.embedding is not null
     and b.embedding_model = v_model                      -- ★ 只比同一模型的向量
   order by b.embedding <=> v_vec, b.source_kind, b.asset_key, b.shot_index
   limit v_k
),
lex as (
  select b.*, greatest(similarity(b.name, v_query), similarity(b.body, v_query))::real as score,
         case when b.batch = v_query or b.grp = v_query or b.product = v_query
              then 'prefix' else 'trigram' end as match_kind
    from base b
   where v_query is not null
     and (b.name ilike '%'||v_query||'%' or b.body ilike '%'||v_query||'%'
          or b.batch = v_query or b.grp = v_query or b.product = v_query)
   order by score desc, b.source_kind, b.asset_key, b.shot_index
   limit v_k
),
merged as (
  select distinct on (source_kind, asset_key, gran, shot_index) *
    from (select * from vec union all select * from lex) u
   order by source_kind, asset_key, gran, shot_index, (match_kind = 'vector') desc, score desc
)
select ... from merged
 order by (gran = 'shot') desc, score desc, asset_key, shot_index   -- 能下刀的排前面
 limit greatest(1, least(p_limit, 100));
```

**为什么是新 RPC 而不是改 `search_materials`**：`search_materials` 的返回列是 `(video_id, name, score, category2_id, labels, create_time, account_key)`（`007:120-128`），没有 `gran/in/out/source_kind/availability` 的容身之处；它的 `FROM material JOIN wiki_summary` 也排除了工程视频。硬改它等于同时改 15 个调用点与契约返回列；新增一个 RPC 是两行 `contract.json` 的事，并且旧函数可以原样留给 7 名 compat 面。

**索引类型为什么是 HNSW 而不是 ivfflat**：
1. 我们的写入是**涓流**（一次分析一行），HNSW 增量插入即可，ivfflat 的 `lists` 需要 `ANALYZE` + 全量重建才能保持质量；
2. 查询**永远带过滤**（租户 + 来源 + 粒度 + 批次 + 时长），被过滤到 <1% 时 ivfflat 的候选会集中在少数 list 上，recall 塌方；HNSW 有 `hnsw.iterative_scan`（0.8 起，`001:17-19` 已经把它写成硬前提，`007:169` 已经在用）；
3. 规模：78,874 条卡片向量 ×（3072 B + 2m×4 B ≈ 128 B）≈ **252 MB 索引**，桌面机可常驻；镜头行 946k 条时约 3.0 GB，所以镜头向量**不该铺满全语料**（这也是方案 B 被否的第二个理由）。
4. 为了"同类可比"，用两条**部分索引**把 `asset` 与 `shot` 分开：跨粒度余弦值不可比（镜头文本天然更具体），混排会让"哪一段"永远压过"哪个素材"。

### 4.4 返回结构与"一次往返就下刀"

RPC 返回扁平行；**客户端（Studio/desktop，握着磁盘的那一侧）补可用性**，然后交给 agent 的结构是：

```json
{
  "ok": true,
  "query": "茶汤特写 3 秒 开头钩子",
  "mode": "hybrid",
  "warnings": [],
  "candidates": [
    {
      "assetKey": "sha256:9f2c…", "source": "project",
      "assetRel": "assets/茶汤-01.mp4", "projectId": "p-1",
      "gran": "shot", "shotIndex": 4,
      "in": 12.4, "out": 15.8, "name": "茶汤-01.mp4",
      "durationSec": 63.2, "batch": null, "product": null, "group": null,
      "score": 0.81, "matchKind": "vector", "analyzerVer": "qwen-vl-shots-1",
      "availability": { "state": "local" },
      "insert": { "src": "assets/茶汤-01.mp4", "at": 12.4, "until": 15.8 }
    },
    {
      "assetKey": "129678963", "source": "cloud", "videoId": "129678963",
      "gran": "asset", "shotIndex": -1, "in": null, "out": null,
      "name": "20261106-柠檬宝藏茶200g罐-汤色 (46)", "durationSec": 41.0,
      "batch": "20261106", "product": "柠檬宝藏茶200g罐", "group": "汤色",
      "score": 0.77, "matchKind": "vector", "analyzerVer": "card-meta-1",
      "availability": { "state": "downloadable", "md5": "…", "approxBytes": 52428800 },
      "next": { "tool": "materials.take", "args": { "videoId": "129678963" } }
    }
  ],
  "transport": { "rpc": "media_search", "localChecks": 20 }
}
```

- `availability.state = 'local'` → `insert` 可直接喂 `timeline.insert_clip`（`openfilm-mcp.mjs:89-105`），**0 次额外往返**；
- `state = 'downloadable'` → 只给 `next`（`materials.take`），因为下载是**副作用**，不能替 agent 决定；
- `state = 'missing'`（索引里没有 md5，或字节被 LRU 淘汰）→ 明确说"要先下载，且供应商限流可能重试"，不猜。

**为什么"本地有没有"不进库**：`contentStore` 有 2 GB 预算与 LRU 淘汰（`material-media-cache.mjs:439-467`），Saved 库还有第二套命名（`materials-proxy.mjs:357-390`）。任何库里的 `is_local` 列都会在两小时内变成谎言；而客户端判一次 `stat` 是零成本（`has()` 只 `stat` + 读旁证，`material-media-cache.mjs:474-505`）。

**返回结构为什么按这个形状**：`gran='shot'` 的行自带 `in/out`，`gran='asset'` 的行 `out=null` 且 `durationSec` 必给（否则 agent 无法自己定边界）；`matchKind` 必须外露（§4.5）；`warnings` 承载"某模型向量缺失/仅词法"这类降级事实。

### 4.5 降级（Q6）

| 情形 | 行为 | 不许做什么 |
| --- | --- | --- |
| 没有嵌入端点（`:1235` 不在） | `p_embedding=null` → 只跑 `lex` 分支；`mode='lexical'`；`warnings:['embedding-unavailable']` | 不许返回 `score` 让 agent 以为是语义相似度 |
| 查询向量拿不到（模型名不支持/超时） | 同上，并把原因写进 `warnings` | 不许静默降级成"0 结果"（那会被读成"没有素材"） |
| 某行 `embedding is null`（未分析/已 superseded/被淘汰） | 该行仍可由 `lex` 命中；`matchKind` 如实标 `trigram`/`prefix` | 不许把这些行从结果里删掉（否则"卡片还没建向量"会被读成"没有这条素材"） |
| 冷启（首次嵌入 6.8 s 实测） | 进程启动时打一次预热（照 `analyze-runner.mjs:418-425` 的 `WARMUP_JPEG` 手法） | 不许让用户的第一次搜索付冷启 |
| 供应商限流 / 503 `provider-unconfirmed` | **不影响检索**：`media_doc` 全部来自库内 `material` 与本地索引，检索路径对供应商零依赖；只有 `materials.take` 受影响，而它已有重试（`materials-proxy.mjs:229-254`） | 不许把检索做成"每次去问一次云" |
| HNSW 只在空表上验证过（`19:161`） | 上线前用 1 万条真实卡片向量压 recall@20 与 P95 | 不许拿"能建能查"当"召回可用" |

词法分支的"索引前缀"是具体的：查询串若等于/以某个 `batch`（`20261106`）、`grp`（`汤色`）、`product` 开头，直接命中 `media_doc_scope_idx`，不扫 trigram。这正是本地索引已经给出的三层结构（`material-index.mjs:159-244`：批次 → 产品 → 分组），把它从 JSON 搬进列，检索才能过滤而不是内存筛（今天的时长筛选只能在当页做，`filters.ts:27`）。

### 4.6 Qwen-VL 的位置（Q5）

**边际收益（结构化摘要必然检索不到的查询）**：
- 视觉谓词，文字里没有：`挂杯`、`茶汤透亮`、`蒸汽升起`、`手在揉捻`、`特写/中景/俯拍`、`画面干净能放标题`、`有人的手入镜`。
- 反例（**不需要** Qwen-VL）：品牌/产品/批次/分组/有无字幕/说了什么/多长——元数据 + OCR + 转写就够，而且 VLM 读字是**系统性错误源**（把"李陌茶"读成"李锦记"，`21:70-83`），所以 `caption` 走 VLM、`ocr_text` 只走 OCR，二者的分工不能混。

**成本（本项目实测口径）**：

| 项 | 数字 |
| --- | --- |
| 单帧 | 4.1 s @512 长边（`21:14`），冷启 26.8 s 一次性（`21:13`） |
| 每镜头 1 帧 + 场景切分取边界 | 一条 60 s 素材按 12 镜头估 ≈ 12 帧 ≈ **49 s** |
| 全语料（78,874） | ≈ **1,074 h ≈ 45 天**不间断；20 镜头/条 ≈ 1,796 h |
| 全语料还需要先下载 | 78,874 次下载（1 QPS，`19:87`），按 100 MB/条 ≈ 7.7 TB |
| 按需（2,000 条真正用到的素材） | ≈ **27 h**，一个周末的过夜队列 |
| 存储（2,000 条 × 12 镜头 = 24k 行） | 文本 ≈ 31 MB + 向量 ≈ 77 MB + HNSW ≈ 77 MB |
| 全语料镜头存储（946k 行） | 文本 ≈ 1.2 GB + 向量 ≈ 3.0 GB + HNSW ≈ 3 GB（**不该做**） |

**同步还是排队**：**离线排队，且单飞**。理由不是"慢"，而是：
1. 一次检索的预算是个位数秒；一条素材的逐镜头就是 49 s，比率 1:20；
2. 本地 7B 模型同进程连续调用才有 1.35 s 热态（`21:134`），并发会互相把彼此打回冷启；
3. 队列必须**按需触发**：`materials.take` 命中、工程视频导入、或某人明确"分析这条"。全量排队是方案 B，已被否决。

**写同一行还是另一行**：**另一行，不同 `analyzer_ver`，`gran='shot'`**。反证很硬：写进 `wiki_summary` 同一行意味着 `ON CONFLICT (company_key, video_id) DO UPDATE`（`007:287`）会把 `scenes / risks / production / confidence / status` 整行替换（`:288-299`），而护栏是**文本比较** `excluded.analyzer_ver >= w.analyzer_ver`（`:300`）——`'qwen-vl-shots-1'` 字典序大于 `'analyze-runner-2'`，所以"逐镜头"会**赢过**"整片理解"并把卡片打掉。这正是 §2.4 说的可演进性缺口，用 `media_doc`（版本进主键）一次性修好。

---

## 5 风险与回滚

| 风险 | 触发条件 | 影响 | 缓解 | 回滚 |
| --- | --- | --- | --- | --- |
| **嵌入模型对中文的召回不足** | `nomic-embed-text-v1.5` 以英文为主（`embedding.json:4`），中文短查询可能与长中文卡片文本弱相关 | 语义检索"看起来在跑但不好用" | 上线前用 200 条真实中文查询做 recall@20 对照；`embedding.json:7-12` 已预留 `multilingual-e5-small@384` 的切换（换维度=出 013 迁移，不改 012） | 切回 `card-meta-1` 的旧向量（正文在，25 ms 重算） |
| **跨模型向量混排** | 有人用另一个模型写 `embedding` 却没改 `embedding_model` | 距离无意义，排序被污染 | `media_search` 强制 `p_embedding.model` 并 `b.embedding_model = v_model`；写入侧三件套 + 维度断言 | 删除该模型的 `superseded_at is null` 行，重算 |
| **`material` 至今 0 行**（§1.6） | 同步从未在本机跑过 | `media_doc` 无卡片可建，检索空转 | 先把既有同步 `apps/api/src/sync/*` 跑一次（793 页 × 500 ms ≈ 7 min）；这是**写操作**，需单独批准，不在本次只读任务内 | 无需回滚（同步本身幂等，`store.ts:105-126`） |
| **契约漂移** | 012 加了表/RPC 却没登记 `contract.json` | `migrate --contract` 反向比对报 DRIFT；`index-client` 的 `RPC_NAMES` 与契约测试变红 | 012 同批改 `contract.json`、`docs/sql/README.md`、`index-client.mjs:20-37`、`apps/api/src/index/client.test.ts` | 只改文件不改库即可恢复绿 |
| **工具面超预算** | 想加第 6 个 MCP 工具 | `docs/contracts/mcp-tools.schema.json` 固定 5（`minItems=maxItems=5`） | 不新增工具：把 `query/source/local` 三个参数加到 `material.items`（`material-tools.mjs:173-222`），这正是它当初"吸收 `materials.search`"的既定理由（`openfilm-mcp.mjs:148-152`） | 参数回退即可，无 schema 变更 |
| **镜头向量把索引撑爆** | 有人对全语料跑逐镜头 | 索引 3 GB+，桌面机查询抖动 | 部分索引 `where gran='shot'` 天然隔离；队列默认白名单（只处理 `materials.take` 命中与工程视频） | `truncate media_doc` 中 `gran='shot'` 的部分，卡片不受影响 |
| **`in/out` 与真实时长错位** | 场景切分帧数与预期不符（ffmpeg 0 帧仍退出 0，`21:66`） | agent 切出空镜头 | 写入前校验帧数（`21:125`）；`media_doc_cut_shape` 要求 `out > in`；`out <= duration_ms/1000` 由写入侧断言 | 该素材标记 `status='disputed'`，不进结果 |
| **`env_id` 仍未对齐** | 继续用 `search_materials` 那条 JOIN | 同 `video_id` 在 sandbox+production 各一行 → 结果重复 | 新路径 `media_doc` 强制云素材带 `env_id`；`search_materials` 标注为 compat 面，不修但不再扩展 | 无需回滚 |

**整体回滚**：`drop table public.media_doc;` + 从 `contract.json` 删两条 + 停队列。`wiki_*`、`material`、`search_materials` 一个字节未动，现有 5 个工具全部照旧工作。这是选 C 而不是 A 的最后一个理由：**A 改的是既有表，回滚不了。**

---

## 6 未验证 / 待定（不伪装成已解决）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| HNSW 在 78,874 + N 镜头规模下的 recall@20 / P95 | **未验证** | `19:161` 已登记；`scripts/bench-search.mjs` 被引用但仓库里不存在，需要先补 |
| 中文查询在 `nomic-embed-text-v1.5` 上的实际召回 | **未验证** | 只验证了 768 维与 20–25 ms 时延 |
| 每 60 s 素材的真实镜头数（本文按 12 估） | **未验证** | `21:162` 只说阈值 0.3 未覆盖快剪/慢剪；49 s/条 的成本随这个数线性变化 |
| 供应商毫秒/字节：78,874 条的总字节量 | **不可得** | 落地索引把 `fileSize` 丢了（`material-index.mjs:130-146` 只留 `md5`），所以"下载全量要多少 TB"只能按均值参数化 |
| 逐镜头 caption 的 200 字符/镜头预算是否够 | **待定** | 沿用 `wiki_shot` 的 200 字符口径（`007:410-411`），未做与 400 字符的召回对照 |
| 工程视频"哪段被用过"是否要进检索 | **待定（本次不做）** | 需要从 `film.html` 采使用信号，是第 4 张表；对"该剪哪段"是**正反馈**里最值钱的一条，但超出本次范围 |
| 一次往返就下刀的 `until` 字段是否被 `insert_clip` 接受 | **待定** | 现在 `timeline.insert_clip` 只有 `src/at/track/box`（`openfilm-mcp.mjs:89-105`），`until` 需要一次工具面变更 |
