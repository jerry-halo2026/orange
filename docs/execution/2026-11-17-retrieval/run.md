# media_doc 回填真跑记录（78 874 条素材文档 + 768 维向量）

- 时间：2026-11-17 12:49–13:05 (+08:00)
- 仓库/HEAD：`D:\dev\orange` @ `0b0d9cf`（分支 `chore/vendor-0.3.2`；**未 commit**）
- 写集：`scripts/material-doc-index.mjs`（新增）、`scripts/material-doc-index.test.mjs`（新增）、本文件
- 目标库：本机 Docker `infra/docker-compose.yml` 的 `db`（`pgvector/pgvector:pg17`，`orange` 库），
  已应用 `001`→`013`（`012_media_doc.sql` + `013_media_doc_shot_key.sql` 在本批之前已落地）
- 租户：`tenant-a`（会话 GUC `app.company_key`）。库在跑之前 **`media_doc` 0 行**、`material` 0 行 ——
  这是一次从空表开始的全量回填，四个数字（写入 / 行数 / distinct key / 有向量）因此可以直接对比。

## 0. 先核对事实（不是假设）

| 事实 | 核对方式 | 结果 |
|---|---|---|
| 索引有两层信封 | `schema` 分别读出来 | 外层 `orange/material-index-build/1`（`unclassified` 是**数字** 78484），树在 `index` 键下 `orange/material-index/1`（`unclassified` 是数组） |
| 条目总数 | `batches[].products[].groups[].entries` = 390，`index.unclassified` = 78,484 | **78,874**，与 `index.totals.videos` 相同 |
| 缺身份/重复 | 脚本自己数（`collectEntries`） | 缺 `videoId` **0**，重复 `videoId` **0**，只有 id 没 name **0** |
| 嵌入端点 | `POST http://127.0.0.1:1235/v1/embeddings`，模型 `text-embedding-nomic-embed-text-v1.5` | 200，`data[0].embedding.length = 768`，8 条批量 102 ms（热态） |
| 写入通道 | `infra/migrate.mjs` 怎么连就怎么连 | `docker compose -f infra/docker-compose.yml exec -T db psql -U postgres -d orange`；psql 身份 `session_user = postgres` 属于 010:92 的受信身份，`set app.company_key` 才被采信 |

## 1. 脚本怎么写的（三个必须解释的选择）

1. **一行一条 `select public.upsert_media_doc($json$…$json$::jsonb)`，一批一个 psql 会话。**
   不把 300 行塞进一条 `select … from jsonb_array_elements(…)`：语句级原子性会把"某一行 22023"
   升级成"整批回滚"，而 78k 回填里最该被记录下来的恰恰是个别脏行（它们应该在失败清单里，
   不该让整批重来）。**一行一个事务**，失败只丢那一行。
2. **`set app.company_key` 在会话开头（不是 `--tenant` 参数进 `p_row`）。**
   `v_company := public.tenant_key_required()`（012:186 / 013:140）根本不读 `p_row.company_key`，
   而 `media_doc` 是 `ENABLE + FORCE RLS`：没有会话租户，写和读都是 `42501`。
3. **失败靠"没有输出行"发现，再逐行重放定位。**
   psql 对失败的语句不输出任何行，所以"信封数 ≠ 语句数"就是失败信号；这时对**这一批**逐行重跑
   （一次一个 psql 会话），把失败落到具体 `media_key` 与 psql 的 `ERROR:` 行。

幂等依靠数据库那一侧，不依靠脚本的"跳过"：`text` + `embedding_ver` 都没变 →
`ON CONFLICT … WHERE` 不命中 → 整行不动、**`updated_at` 不刷**（012:302-304 / 013:302-304）。
`--no-resume` 是"重写同样的行"，用来证明这一条；`progress.json` 只是省掉重复嵌入。

## 2. 小样本：`--limit 50`

```
node scripts/material-doc-index.mjs --limit 50
```

真实输出（`media_doc` 跑之前 = 0 行）：

```
条目 78874 条（索引 totals.videos=78874；缺 videoId 0，重复 videoId 0）
本次处理 50 条；断点续跑：已完成 0，待写 50（progress=D:\dev\orange\.dev\material-doc\progress.json）
模式：写入 tenant=tenant-a analyzer_ver=card-meta-1 embedding_ver=nomic-embed-text-v1.5 batch=300 concurrency=4
[1/1] done=50/50 (100.0%) 47.9/s eta=0s written=50 unchanged=0 fail=0

—— 汇总 ——
written=50 unchanged=0 fail=0 批次=1 耗时=1s 速率=47.9/s
media_doc：总行数 50，其中未取代 50，有向量 50，distinct media_key 50
```

- 增量：`select count(*) from media_doc` **0 → 50**（`distinct media_key` 50，`count(embedding)` 50）。
- 抽样行（`text` 与 `embedding` 都非空；第 3 列是 `vector_dims(embedding)` = 768）：

```
100084028 | 11 | 768 | [-0.018205013,-0.0046633743,-0.15786523,-0.00466 | 6.4-益生菌-李百佳
100140553 | 26 | 768 | [-0.024666319,0.043467574,-0.16075127,0.00261660 | 养生茶_廖文涛_2026-06-04_油弃乌龙茶_1
100140554 | 26 | 768 | [-0.014829705,0.032407764,-0.1581782,0.003507731 | 养生茶_廖文涛_2026-06-04_油弃乌龙茶_2
100155029 | 29 | 768 | [-0.009016297,0.051261365,-0.14741153,-0.0365970 | 已发_柑普茶_廖文涛_2026-06-04_头采小青柑_2
100155294 | 27 | 768 | [-0.015247604,0.045211744,-0.14596027,-0.0448017 | 已发_柑普茶_廖文涛_2026-06-04_头采三组合
```

（`vector_dims = 768` 是列上 `vector(768)` 的 typmod 与函数内断言共同的结论；向量不是全零占位，
首分量已是非零浮点。）

## 3. 幂等证据（两条，都实测）

### 3.1 同一批重写：`--no-resume --limit 50`

```
node scripts/material-doc-index.mjs --no-resume --limit 50
[1/1] done=50/50 (100.0%) 54.1/s eta=0s written=0 unchanged=50 fail=0
```

- `written=0 unchanged=50`：50 条语句都执行了，**50 条都被 RPC 判成幂等命中**。
- 行数不变（50 → 50），且把 `media_key || '|' || updated_at` 全量导出前后逐行比对：
  `identical_updated_at=True`（`updated_at` 一个都没被刷新）。

### 3.2 全量之后再来一次（同一批 50 条，在 78 874 行上复核）

```
before/after 各导出 78874 行：media_key|updated_at::text|md5(text)
rows_before=78874 rows_after=78874
idempotent_full_dump_identical=True
[1/1] done=50/50 (100.0%) 50.0/s eta=0s written=0 unchanged=50 fail=0
```

### 3.3 断点续跑

```
node scripts/material-doc-index.mjs --limit 50
本次处理 50 条；断点续跑：已完成 50，待写 0
没有待写条目（全部已完成）。要重写同一批请加 --no-resume（幂等复核）。
written=0 unchanged=0 fail=0 批次=0
```

0 个 psql 会话、0 次嵌入 —— 续跑不重复付向量的钱（一次 20 ms × 78k = 26 分钟）。

## 4. 全量：`node scripts/material-doc-index.mjs`

- 起止：**12:49:19 → 13:04:36**（wall 15 m 17 s；脚本自报 `耗时=15m16s`）
- 批次 **263**（300 行/批，题述 200–500 区间内），速率 **86.0 行/s** 端到端
  （嵌入选 4，单条热态 ~22 ms；后半段 HNSW + trigram 索引变大，瞬时速率从 85/s 掉到 ~78/s 再回到 86/s）
- `written=78824`（前 50 条已在样本里写完）+ `unchanged=0` = **78,874**
- **`fail=0`**：失败原因分布为空（嵌入侧 0、写库侧 0）

最后三批与汇总（原样）：

```
[261/263] done=78350/78874 (99.3%) 86.0/s eta=6s written=78300 unchanged=0 fail=0
[262/263] done=78650/78874 (99.7%) 86.0/s eta=3s written=78600 unchanged=0 fail=0
[263/263] done=78874/78874 (100.0%) 86.0/s eta=0s written=78824 unchanged=0 fail=0

—— 汇总 ——
条目 78874 条（索引 totals.videos=78874，缺 videoId 0，重复 0）
written=78824 unchanged=0 fail=0 批次=263 耗时=15m16s 速率=86.0/s
media_doc：总行数 78874，其中未取代 78874，有向量 78874，distinct media_key 78874
```

### 差额：0（三类可能的不一致都实测为 0）

| 可能少行的原因 | 实测 |
|---|---|
| 条目没有 `media_key`（无 `videoId`） | **0** 条（`mediaDocRow` 会抛 TypeError，脚本先计数再排除） |
| 同一 `videoId` 出现两次（同一主键） | **0** 条（390 组内 + 78,484 未归档之间无重复） |
| `text` 为空被 CHECK 拒（012:83） | **0** 条（`mediaDocText` 兜底到 `asset:<id>`；库内 `btrim(text)=''` 的行 **0**） |
| 逐行重放定位到的脏行 | **0** 条 |

结论：**写入 78,874 = 索引 78,874**，`parsed 390 + unclassified 78,484` 一条不少。

## 5. 库内事实（一条 SQL 的上半部分就是全部证据）

```
set app.company_key = 'tenant-a';
select count(*), count(embedding_ver), count(embedding), count(distinct media_key), count(distinct text),
       count(*) filter (where superseded_at is null), min(length(text)), max(length(text)),
       count(*) filter (where btrim(text) = ''), count(distinct analyzer_ver), count(distinct source_kind),
       min(shot_index), max(shot_index) from public.media_doc;

78874|78874|78874|78874|62373|78874|1|700|0|1|1|0|0
```

| 项 | 值 | 说明 |
|---|---|---|
| 行数 | **78,874** | = 索引条目数 |
| `count(embedding_ver)` / `count(embedding)` | 78,874 / 78,874 | 没有一行"有正文没向量"或"有向量没版本号" |
| `distinct media_key` | 78,874 | 主键 `(company_key, media_key, analyzer_ver, shot_index)` 上没有塌陷 |
| `distinct text` | 62,373 | 16,501 行正文重复 —— 见 §7 第 3 条 |
| 未取代 / `superseded_at` | 78,874 / 0 | 只有一个 `analyzer_ver`，没有陈旧版本 |
| `text` 长度 | 1 … 700 字 | `MEDIA_DOC_TEXT_MAX=2000` 一次都没触发 |
| `analyzer_ver` / `embedding_ver` / `source_kind` / `gran` / `shot_index` | `card-meta-1` / `nomic-embed-text-v1.5` / `cloud` / `asset` / `0` | 各只有一种取值，`shot_index` min=max=0（013 的 asset 形状） |

抽样 5 条（脚本跑完自动打印，`batch=-` 表示名字不符合 `批次-产品-分组 (序号)`，没有批次可claim）：

```
抽样 100084027 text=11字 embedding=非空 batch=- 6.4-益生菌-李百佳
抽样 100084028 text=11字 embedding=非空 batch=- 6.4-益生菌-李百佳
抽样 100140553 text=26字 embedding=非空 batch=- 养生茶_廖文涛_2026-06-04_油弃乌龙茶_1
抽样 100140554 text=26字 embedding=非空 batch=- 养生茶_廖文涛_2026-06-04_油弃乌龙茶_2
抽样 100155028 text=29字 embedding=非空 batch=- 已发_柑普茶_廖文涛_2026-06-04_头采小青柑_1
```

## 6. 验收对照

| 验收项 | 证据 | 结论 |
|---|---|---|
| `--limit 50`：50 条写入 | §2，`written=50`；`count(*)` 0 → 50 | 通过 |
| `count(*)` 增量正确 | 0 → 50（样本）、50 → 78,874（全量） | 通过 |
| 抽样行 `text`/`embedding` 非空 | §2 五条 `| 768 |`，首分量为非零浮点 | 通过 |
| 全量写入 = 78,874 | §4、§5 | 通过（差额 0，见 §4 的表） |
| 重跑 `--limit 50` 不新增行、`updated_at` 不变 | §3.1/§3.2，78,874 行 dump 前后 byte-identical | 通过 |
| `node --check scripts/material-doc-index.mjs` | `exit=0` | 通过 |
| 新增测试（文本→载荷→批次写入，桩，不连真库） | `node --test --test-concurrency=1 scripts/material-doc-index.test.mjs` → `tests 24 / pass 24 / fail 0`（2.58 s） | 通过 |
| `git status --porcelain` 仅写集 + 本文件 | 见 §8 | 通过（另有一个**不是本批**的 `docs/execution/2026-11-17-collections/`，见 §7 第 6 条） |
| 幂等：同一 `text` + `analyzer_ver` 不修改行 | §3（RPC 的 `written=false` 是数据库给的答案，不是脚本跳过） | 通过 |

## 7. 风险与遗留（都不在本次写集里改）

1. **租户是合成值 `tenant-a`。** 本机库原本 `media_doc` 0 行、`material` 0 行，没有真实公司键可用；
   `--tenant` 就是为此留的。换租户重跑时脚本会**拒绝复用** `progress.json`（tenant/analyzer_ver/
   embedding_ver 任一不符即报错），这是设计：用 A 的向量冒充 B 的答案比"要删一个文件"糟得多。
2. **`embedding_ver` 写成 `nomic-embed-text-v1.5`（不带 `@768`）。** 012:108-109 的注释举例是
   `nomic-embed-text-v1.5@768` 风格。维度由列 typmod + 函数内 768 断言两处兜住，所以版本串只承担
   "哪个模型"这件事；如果后续要跨维度并存，这一列需要统一口径（改约定则要重算，属于决策项）。
3. **16,501 行正文与别的行完全相同（`distinct text` 62,373）。** 原因在模板本身：`(46)` 这种供应商
   相册序号被剥掉后，同一组里的条目正文一模一样，向量也就一模一样。语义检索层面它们互为同分，
   排序只能靠 `media_key` 兜底。要区分"同组不同条"必须把序号或 `md5` 放进 `text` —— 那是
   `material-doc.mjs` 的模板决策，本次**没有**动它。
4. **速率不是线性的。** 前 40 批 85 行/s，中段掉到 ~78 行/s（`media_doc_asset_vec_idx` 的 HNSW 与
   `media_doc_text_trgm_idx` 随行数变大），末段又回到 86 行/s。全量 15 m 16 s 是在"索引已建好的热库"上
   测的，冷库（首次建索引）会更慢。
5. **`0 失败` 只覆盖本机库这一次。** 索引侧脏数据（空 `videoId`、空 `text`）实测 0 条；
   换一份索引/换租户后这个数字要重测，不能引用。
6. **`docs/execution/2026-11-17-collections/` 是别人未提交的目录**（本批之前就在工作区里），
   不是本批产物；本批只新增 `scripts/material-doc-index.{mjs,test.mjs}` 与本文件。
7. **没有验的**：`media_search` 的端到端语义检索（`p_embedding` 走 HNSW 的那一支）、
   `superseded_at` 取代路径（只有一个 `analyzer_ver`，0 行被取代）、`project` 语料的 `source_kind`。
   这些属于检索面与下一档粒度，不在本次写集。

## 8. 写集与工作区状态

```
$ git status --porcelain
?? docs/execution/2026-11-17-collections/     ← 不是本批（本批之前已在）
?? docs/execution/2026-11-17-retrieval/       ← 本批的 run.md 落在这里（该目录原本只有 analysis.md，未跟踪）
?? scripts/material-doc-index.mjs
?? scripts/material-doc-index.test.mjs
```

未 commit、未 push。`progress.json` 落在 `.dev/material-doc/progress.json`（`.dev/` 已 gitignore，
不进写集）；它是"省嵌入钱"的缓存，删掉重跑结果不变（§3 的幂等是数据库给的）。

## 9. 复现命令

```powershell
# 空表基线
docker compose -f infra/docker-compose.yml exec -T db psql -U postgres -d orange -qAt -c "select count(*) from public.media_doc"

# 小样本（先验写入通道）
node scripts/material-doc-index.mjs --limit 50

# 幂等复核（重写同一批，RPC 应答 written=false，updated_at 不动）
node scripts/material-doc-index.mjs --no-resume --limit 50

# 全量（断点续跑默认开启；中断后重跑同一条命令即可）
node scripts/material-doc-index.mjs

# 库内事实
docker compose -f infra/docker-compose.yml exec -T db psql -U postgres -d orange -qAt `
  -c "set app.company_key = 'tenant-a'" `
  -c "select count(*), count(embedding), count(distinct media_key) from public.media_doc"
```
