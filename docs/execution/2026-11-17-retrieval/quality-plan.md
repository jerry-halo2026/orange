# 语料怎么处理：隔离、共用向量、上云顺序

日期 2026-11-17 · 分支 `chore/vendor-0.3.2` · 结论先给，过程在后

## 一句话结论

**78 874 条里 11 718 条不是素材**（清洗前那版只有名字的行），处理方式是**隔离而不是删**：不嵌入、不写库、不上云、检索不返回，行本身留着，元数据补回来就能复活。重复文本**不合并行、只在向量层共用**（同一段文本给两个向量 = 同一个问题两个答案）。上云灌的是**规范版本 67 156 行**，不是物理行数 151 030（那是三个版本叠着）。

## 1. 三个数字先摆清楚（不然会拿错基数）

| 数 | 值 | 它是什么 |
| - | - | - |
| 物理行数 | 151 030 | 三个 `analyzer_ver` 叠在一起：`card-meta-1` 78 874 + `card-meta-2` 67 156 + `card-meta-qwen3-8b` 5 000 |
| 规范版本 | **67 156** | `card-meta-2`：清洗后那一版，只有 12 行没有卡片字段 |
| 隔离集 | **11 718** | `card-meta-1` 收过、`card-meta-2` 没收的 media_key —— 就是"只有名字"的那批 |
| 同文组 | 1 729 组 / 4 533 行 | 规范版本里 `text` 逐字节相同的行；`distinct text` 64 352 |
| 检索面（改后） | **67 156** | 存活行；隔离集已全部 `superseded`，`card-meta-1` 现在 0 行存活 |

`11 718` 与清洗报告里的 `11 839` 差 121 条：清洗报告按 `kind` 分类算（规则随代码漂移），这里按**库里的既成事实**（哪个版本收了它）算。两个口径都留着，取数时用后者——入库结果不会漂。索引对账：78 874 个 videoId 里正好 11 718 个落在隔离集，一进一出对得上。

## 2. 脏行：隔离，不删

判据（`scripts/material-quality-plan.mjs`，只读三条 select）：

```
card-meta-1 收过 ∧ card-meta-2 没收  →  quarantined
```

为什么用"版本归属"而不是重新跑一遍 `classifyEntry`：分类规则会改，入库结果不会。为什么留而不删：这 11 718 条的元数据可以**定向补抓**回来（智尚只读接口，按 videoId 取 `videoType`/时长/分类），补回来清掉 `superseded_at` 就复活；删了永远对不上号。

落地的三刀：

1. **清单** → `.dev/material-clean/quality-plan.json`（`quarantined[]` + `duplicateTexts[]`，474 KB）
2. **回填闸** → `material-doc-index.mjs --exclude-file`，被闸掉的条目不嵌入、不写库、不进 progress（进度不会把"没做"记成"做完"）
3. **检索面** → `update media_doc set superseded_at = now() where analyzer_ver='card-meta-1' and superseded_at is null`（11 718 行）

第 3 步之后 `card-meta-1` 存活 0 行；全库"只有名字"的存活行从 78 508 降到 **12**。检索回来的是带产品/分组/分类的真素材：

```
20261106-柠檬宝藏茶200g罐-规格 (10) | 柠檬宝藏茶200g罐/规格 | 1.000
20261106-柠檬宝藏茶200g罐-外包装 (2) | 柠檬宝藏茶200g罐/外包装 | 1.000
```

## 3. 重复文本：共用向量，不合并行

`text` 相同 ≠ 同一份素材：`text` 是名字+标签+时长+作者渲染出来的文档，两个不同 videoId 完全可能渲染成同一段文本（同一产品同一机位的多个文件）。**合并行等于把真实素材从检索里摘掉，剪辑 agent 会插错片段。**

所以：

- 向量层共用（`material-doc-index.mjs` 的 `vectorMemo`）：同一 `md5(text)` 只嵌一次，多行写同一条向量；memo 只对重复 digest 建（64k 条 4096 维字面量约 2 GB，全量缓存会把内存吃光），所以上限就是那 1 729 组。第一条失败会撤掉 memo，下一行自己重试，不连坐。
- 行层不动：每个 videoId 保留自己的身份，检索命中多个同文本行是**事实**（同一镜头有 17 个文件），不是重复。
- 同 `md5`（同一份**字节**）的 1 312 行 / 649 组是另一回事 —— 那是真重复，但去重要在**上云层**做（留元数据更全的那行），本地行不动：Studio 按 videoId 引用它们。

## 4. 上云顺序（等 4096 跑完再动）

1. 4096 全量覆盖规范版本 67 156 行（当前跑的就是这个，断点续跑）；
2. 200 条中文查询 recall@20：4096 vs 768 基线（8B 在前 8 条查询上 top-1 是 8/8，nomic 是 1/8，但仍要全量语料上复核）；
3. 只上**存活 ∧ 在规范版本 ∧ 有向量**的行（67 156 级别），带 `analyzer_ver` + `embedding_ver_4096` 两列版本标签；
4. `card-meta-qwen3-8b` 那 5 000 行试点在 4096 覆盖到它们的 key 之后作废（现在还是存活行，别和规范版本一起上云）。

## 5. 命令

```
node scripts/material-quality-plan.mjs --index ~/.openfilm-dev/material-index/index.json
node scripts/material-doc-index.mjs --dims 4096 --all --concurrency 4 \
     --analyzer-ver card-meta-2 --progress .dev/material-doc/progress-4096b.json \
     --exclude-file .dev/material-clean/quality-plan.json
```

重启后的实测开头（`.dev/logs/media-doc-4096-full3.log`）：

```
条目 78874 条（缺 videoId 0，重复 videoId 0）
本次处理 67156 条；断点续跑：已完成 4500，待写 62656
质量闸：隔离清单 … 共 11718 个 media_key，本次挡掉 11718 条
模式：写入 mode=coexist analyzer_ver=card-meta-2 列=embedding_4096(4096 维) model=text-embedding-qwen3-embedding-8b
```

## 6. 验证

- `scripts/material-doc-index.test.mjs` 34/34（新增 4 条：闸的形状、闸先于 `--limit`、同文共用、失败不连坐）
- `scripts/material-quality-plan.test.mjs` 7/7（隔离 SQL 两侧口径不对称 —— 旧版本那侧**不许**看 `superseded_at`，否则行被取代后清单自己变空、闸消失）
- 库侧实测：`card-meta-1` 存活 0；"只有名字"存活 12；规范版本 67 156 行全部有 768 向量，4096 覆盖随回填增长
