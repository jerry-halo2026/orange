# 素材清洗报告：上云前的脏数据口径与条数（78 874 条 → 可检索 66 470 条）

日期 2026-11-17 · 分支 `chore/vendor-0.3.2` · 只读作业（不写库、不动 `media_doc`、不算向量）

用户要求是「先把数据理清楚再上云，脏数据要清洗」。这份报告交出三件事：**清单**（脏在哪、脏多少）、
**可测的清洗规则**（`packages/openfilm/src/material-clean.mjs`，31 条测试全绿）、**清洗后的条数与样本**
（Lead 用这四个数字决定"上云灌多少条、要不要重算向量"）。

一句话结论：**能上云检索 66 470 条**（原 78 874 条里 11 839 条证不出是素材、565 条是同一份字节的重复行）；
其中 **92.3% 有 md5**、**95.6% 五级元数据齐全**。**不需要全量重抓元数据**，需要一次**定向补抓**
（11 839 条只有名字的行 + 5 124 条无 md5 的行）；**如果检索 text 改用清洗后的名字，43 094 行（54.6%）的向量必须重算**。

---

## 0. 数据源与口径（三份只读输入，各管一段）

| 源 | 路径 | 它负责什么 |
| - | - | - |
| 索引（权威行集） | `~/.openfilm-dev/material-index/index.json` | 78 874 条 entry、md5、labels / durationMs / author / oneLevel / twoLevel / coverUrl、批次形状 |
| 供应商页缓存 | `~/.openfilm-dev/material-cache/materials/meta/*.json` | **唯一带 `videoType` 的地方**（索引 entry 不存这个字段）。索引就是这批缓存回放的，按 videoId 对上是同一批素材 |
| 本机库 `media_doc` | `docker compose -f infra/docker-compose.yml exec -T db psql` | 只做库侧对照：未取代行数、distinct text、`analyzer_ver` 分布。四条 `select`，一条写都没有 |

两条必须说清的前提，否则下面的数字会被读错：

1. **索引是缓存回放，不是真抓取**（`provenance.mode = studio-provider-cache-replay`，`warnings[0]`）：
   桌面会话未登录、`/api/materials/list` 403，构建时用 1 400 个供应商页缓存 + 旧索引补名重建。
   所以 `videoType` 只能从缓存补（覆盖 85.0%），剩下 11 832 条如实报 **未采集**，不猜。
2. **索引 entry 不存 `videoType`，构建外壳的 `pages.perType` 在回放模式下是空的**。这是"按 videoType 0–4 分布"
   只能覆盖 85.0% 的原因，不是漏算。

---

## A. 清单

### A1. 总量与类型

| 项 | 数 | 占 78 874 |
| - | - | - |
| 总 entry 行 | 78 874 | — |
| 　parsed（严格批次形状） | 390 | 0.5% |
| 　unclassified（派生层） | 78 484 | 99.5% |
| `videoType` 0 | 44 389 | 56.3% |
| `videoType` 1 | 21 550 | 27.3% |
| `videoType` 2 | 1 067 | 1.4% |
| `videoType` 3 | 12 | 0.0% |
| `videoType` 4 | 24 | 0.0% |
| `videoType` 已采集 | 67 042 | 85.0% |
| `videoType` 未采集 | 11 832 | 15.0% |

`videoType` 的来源是 1 100 页缓存 / 81 970 行（覆盖 74 765 个 videoId，与索引对上 67 042 个）。
**索引自身没有这个字段**，所以这个分布是"从索引回放的那批页里补出来的"，不是第二个数据源。

### A2. md5 与重复

| 项 | 数 | 说明 |
| - | - | - |
| `md5` 空 | 7 188 | 9.1%。这些人从未下载过，供应商的 `rawMd5` 至今为空 |
| `md5` 非空 | 71 686 | **90.9%** |
| `md5` 重复 | **649 组 / 1 312 行** | 多出 663 行 = 同一份字节被当成多条素材 |
| 同名不同 id | 5 334 个名字 → 22 035 行 | 多出 16 701 行；distinct 名 62 173 |
| `contentKey` 重复（md5 优先，空 md5 退回 videoId） | 649 组 / 1 312 行 | 与 md5 重复同组数：空 md5 的行不会与任何行"确认相同" |

注意区分三个"重复"，它们不是一回事：

- **663 行**：同 md5 多出来的行——同一份字节，真正的重复；
- **16 701 行**：名字写成一样（折叠空白 + 去尾部 `(n)` 后仍相同）——不一定是同一份字节，但**文本必然相同**，
  是向量重复的来源；
- **225 行**：`index.json` 外壳自报的 `duplicates`（= `pageable 79 099 − videos 78 874`），那是**供应商分页
  重叠**（同一行被两页各返回一次），构建时已按 videoId 去重，与上面两个都不是一回事。

### A3. 名称形态（一行只落一个桶，优先级固定）

| 桶 | 数 | 占 | 判定 |
| - | - | - | - |
| `batch` | 390 | 0.5% | 严格形状 `20261109-油弃乌龙茶-外包装 (24)` |
| `date` | 26 727 | 33.9% | 名字开头是日期/数字（`12.13_…`、`12月18日 …`、`25-7-27 …`） |
| `number` | 344 | 0.4% | 整个名字就是一串数字 |
| `trailing-name` | 485 | 0.6% | 末尾挂孤立姓名段（`trailingNameRule` 判该剥的） |
| `separator` | 15 192 | 19.3% | 分隔符异常：连续空白、首尾分隔符、`- _ / + 、` 混用 ≥2 种或同类连写 |
| `plain` | 35 736 | 45.3% | 其余（有产品/分组词，但没日期、没异常） |
| `empty` | 0 | 0% | 空名：**一条都没有** |

`trailing-name` 只有 485 条，是因为这个桶只收"前面几个桶都不成立"的行；真正判定为"末尾是姓名段"的是
`trailing-author` 3 007 + `trailing-name` 2 247 = **5 254 行**（见 A4 的 issue 表）。

### A4. 元数据非空率

| 字段 | 非空 | 占 78 874 |
| - | - | - |
| `labels` | 63 655 | 80.7% |
| `durationMs` | 66 909 | 84.8% |
| `author` | 67 035 | 85.0% |
| `coverUrl` | 66 959 | 84.9% |
| `oneLevel`（一级分类） | 67 035 | 85.0% |
| `twoLevel`（二级分类） | 67 035 | 85.0% |
| 五级全齐（labels + duration + author + 两级分类） | 63 573 | 80.6% |

### A5. 库侧对照（`media_doc`，只读）

> 快照 `2026-11-17T07:45Z`。**库此刻正被另一个进程回填 `card-meta-2`**（未取代行数不变、`card-meta-1` 在被逐条取代），
> 所以"总行数 / 版本拆分 / distinct text"是这一秒的读数，会继续动；**索引侧的数字才是准的**，这一节只做对照。

| 项 | 值 |
| - | - |
| 总行数 | 119 595 |
| 未取代（`superseded_at is null`） | 78 874（与索引 entry 数一致） |
| distinct `text` | 70 004 |
| `analyzer_ver` | `card-meta-2` 40 721 行 · `card-meta-1` 38 153 行（前者在增长） |
| `batch` 空 / `gname` 空 | 78 484 / 78 484（只有严格形状的 390 行有） |
| `duration_ms` 空 | 38 262 |

两条从库里读出来、对决策有用的事实：

- **distinct text（≈70 004）> distinct 名（62 173）**：说明 `labels / 时长 / 作者 / 分类` 正在把同名行分开——
  名字层面 16 701 行同文，落到 text 层面只剩约 8 900 行同文。**元数据是"同文不同向量"的唯一分隔物**，
  所以"要不要重抓元数据"直接决定这些行会不会撞成同一个向量。
- **`batch` 只有 390 行有值**：`material-doc.mjs` 只用严格形状取批次。清洗层能派生到 27 112 行
  （严格 390 + 派生 26 722），这是 `media_search` 的 `batch` 过滤目前几乎不可用的原因。

---

## B. 清洗规则（`packages/openfilm/src/material-clean.mjs`，纯函数）

四个函数，各自可单独测；`issues[]` 记录"修了什么"，诊断与修复分开（`NAME_REPAIR_ISSUES`）。

### B1. `normalizeName(text, {stripUnderline})` — 名字

| 步骤 | 规则 | issue |
| - | - | - |
| 全角→半角 | U+FF01–FF5E 减 0xFEE0（含 `（）` `，` `！`）；U+3000 与窄空格算一个空格。`、` `。` `「」` 属于文字，不动 | `fullwidth` |
| 空白 | 连续空白折叠成一个空格、去首尾（含全角空格） | `whitespace` |
| 括号配对 | 一次深度扫描：深度 0 处的 `)` 是多余的→删；结尾还有开括号→补 `)`。`（小尹)` = 全角左+半角右，半角化后本来就配对，**不报** | `unbalanced-paren` |
| 尾部 ` (n)` | `… (24)`、`…（24）` → 去掉 | `trailing-sequence` |
| 尾部 `_n` | `…_2` → 去掉，**但采集原名不动**：`IMG_2525` / `mmexport…_1` / `DSC_0007` 的序号就是它的身份（剥掉 923 行会塌成一条 `IMG`） | `trailing-underline` |
| 剥成空 | 只剩标点就退回原名（清洗不产出空名字） | `name-kept` |

`normalizeName` 额外导出 `nameTextKey`（只折叠空白/全角 + 去 ` (n)`，**不剥 `_n`**），用来数"同文"——
`_n` 是派生序号的猜测：剥 ` (n)` 得到 62 173 个 distinct 名，再剥 `_n` 只剩 46 514 个（多塌 15 659 条），
那个数字不该拿来当"重复"。

### B2. `trailingNameRule(name, author)` — 末尾姓名段（剥 / 不剥都要给理由）

**剥**，当且仅当全部成立：

1. 末尾有一段，用**单个空格**与前文分开；
2. 这一段是 **2–3 个汉字**、不含数字/字母；
3. 这一段 **不在 `KEEP_TAIL`**（`material-index.mjs` 的 17 个分组词 + 状态词：`素材 / 合集 / 样片 / 成片 / …`）；
4. 剥掉之后前文**非空**，且前文含汉字或数字（名字全靠这一段承载就不剥）；
5. 并且满足其一：**这一段等于该行的 `author`**（供应商自己说的作者，硬证据 → `trailing-author`），
   或这一段**首字在百家姓里**（弱证据 → `trailing-name`）。

**保留**时同样给原因：`no-space` / `keep-word` / `not-a-name` / `tail-is-all`。

`KEEP_TAIL` 不是可选项：`汤色` 的首字 `汤` 在百家姓里，没有这张表，`洛神花陈皮茶 汤色` 会被剥成
`洛神花陈皮茶`——把一个分组词吃掉。这是这条规则最容易出错的地方，测试里钉死了 5 个保留例子。

### B3. `splitIdentity(entry, counts)` — 内容身份

| 字段 | 规则 |
| - | - |
| `mediaKey` | `asset:<videoId>`；没有 id 退回 `asset:md5:<digest>`；再退回名字（复用 `mediaDocId`，与 §012 的 `media_key` 同一口径） |
| `contentKey` | **`md5` 非空 → `md5:<digest>`（小写）**；为空 → `vid:<videoId>` |
| `dupGroup` | 只有同一个 `contentKey` 在这一批里出现 ≥2 次时才给出该 key，否则 `null` |

**md5 优先、空 md5 退回 videoId** 是这里唯一重要的判断：空 md5 的行只是"*可能*与别人相同"，不是"已确认相同"。
名字再像也不进身份——`IMG_2525` 和 `IMG_2526` 就是两条。

### B4. `classifyEntry(entry)` — 这一行是什么

`kind ∈ material | text | subtitle | unknown`，判定顺序（先证据、后推断）：

1. 扩展名 `.vtt/.srt/.ass/.ssa/.sub/.lrc` → `subtitle`（不入检索）；`.txt/.md/.json/.csv/.log/.doc/.docx/.pdf/.rtf/.xlsx` → `text`（不入检索）；
2. 扩展名是视频/图片/音频 → `material`；
3. 无（已知）扩展名：`videoType ∈ 0–4` → `material`（供应商自己的分类就是证据）；
4. 卡片上任一字段（时长/封面/标签/作者/一级分类）→ `material`；
5. 其余 → `unknown`：既没扩展名、也没 videoType、也没卡片，**证不出是素材**。

`.18` 这种不是扩展名（`素材-王鑫-3.18但哥茶膏` 仍是 `unknown`），只有已知的那些扩展名才算。

### B5. `cleanEntry(entry, counts)` — 规范行

输出 `{ mediaKey, contentKey, md5, dupGroup, name, batch, product, group, labels, durationMs, author, oneLevel,
twoLevel, coverUrl, kind, issues[] }`（`md5` / `dupGroup` 是报告要多带的两位身份）。

- `batch / product / group` **只从严格形状取**；不按形状写的行 `product` 空着、`group` 只取那份分组词表认出的词
  （`茶干 / 汤色 / 外包装 / 规格 / 冲泡 …`）、`batch` 取派生 token。**猜不出来的字段就空着**——空着能统计，猜错了不能。
- `labels` 走 `docLabels`（去重 + 码点排序），顺序变了记 `labels-normalized`。
- `issues` 分两类：**修复**（`fullwidth / whitespace / unbalanced-paren / trailing-sequence / trailing-underline /
  trailing-author / trailing-name / labels-normalized / name-kept`）与**诊断**（`no-md5 / dup-md5 / dup-content /
  batch-derived / group-derived / sequence-only / no-shape / kind-* / missing-card / empty-name`）。
  诊断不算"修复"：7 188 行本来就没有 md5，把它算成"被修过"等于什么也没说。

---

## C. 前后对照（全量 78 874 条）

### C1. 四个数字

| 项 | 数 | 占 78 874 |
| - | - | - |
| **保留**（`kind = material`） | **67 035** | 85.0% |
| **丢弃**（`kind ≠ material`） | **11 839** | 15.0% |
| 　├ `text` | 0 | 0% |
| 　├ `subtitle` | 0 | 0% |
| 　└ `unknown`（只有名字，证不出是素材） | 11 839 | 15.0% |
| **修复**（名字/标签真的被改） | **47 572** | 60.3% |
| 　只带诊断、一个字没改 | 31 302 | 39.7% |
| **去重**（同 `contentKey` 多行） | 649 组 / 1 312 行 → material 内去掉 **565** 行 | — |
| **去重后可用于检索** | **66 470** | 84.3% |

`kind` 的判据分布：`card`（有卡片字段）67 014 · `name-only` 11 839 · `ext`（明确扩展名）21。

### C2. issue 分布（前 12）

| issue | 行数 | 类别 |
| - | - | - |
| `trailing-underline` | 29 981 | 修复 |
| `batch-derived` | 26 722 | 诊断 |
| `no-shape` | 25 603 | 诊断 |
| `group-derived` | 16 194 | 诊断 |
| `kind-unknown` | 11 839 | 诊断 |
| `missing-card` | 11 839 | 诊断 |
| `sequence-only` | 9 965 | 诊断 |
| `fullwidth` | 9 729 | 修复 |
| `no-md5` | 7 188 | 诊断 |
| `trailing-sequence` | 4 696 | 修复 |
| `trailing-author` | 3 007 | 修复 |
| `trailing-name` | 2 247 | 修复 |

**最脏的三类**：① 尾部 `_n`（29 981 行，占 38.0%）；② 全角字符（9 729 行）；③ 尾部 ` (n)` 序号（4 696 行）。
名字类问题合计 47 572 行受影响，但**没有一条名字需要人工重写**：全部可由 B1/B2 的确定性规则处理。

### C3. 十组「前 → 后」真实样本

按固定规则各取索引顺序第一条（可复现：同一份索引给出同样这 10 行）。

| # | 形态 | 前（索引原文） | 后（规范行） | issues |
| - | - | - | - | - |
| 1 | 空 md5 + 批次形状 + 尾部序号 | `20261109-油弃乌龙茶-外包装 (10)`｜md5=空 | `20261109-油弃乌龙茶-外包装`｜material｜batch=20261109｜group=外包装｜contentKey=`vid:130113139` | trailing-sequence no-md5 |
| 2 | 同 md5（同一份字节两行） | `胶原蛋白肽-张雨`｜md5=3a1d61c3… | `胶原蛋白肽-张雨`｜material｜batch=—｜group=—｜contentKey=`md5:3a1d61c3619cd56ebf5f77004f1593d6` | no-shape dup-md5 |
| 3 | 全角括号 + 双空格 + 人名列尾 | `1月13日  4  黄芪玫瑰 （屈屈） 汪学蕊`｜md5=9fa1a90b… | `1月13日 4 黄芪玫瑰 (屈屈)`｜material｜batch=1月13日｜contentKey=`md5:9fa1a90b…` | fullwidth whitespace trailing-name batch-derived |
| 4 | 括号只有左半 | `5月29日油弃乌龙茶1（隆`｜md5=ea109e6e… | `5月29日油弃乌龙茶1(隆)`｜material｜batch=5月29日｜contentKey=`md5:ea109e6e…` | fullwidth unbalanced-paren batch-derived |
| 5 | 无批次形状 + 尾部 `_n` | `功效3_廖文涛_2025-02-13_苹果玫瑰茶_1`｜md5=3883a417… | `功效3_廖文涛_2025-02-13_苹果玫瑰茶`｜material｜contentKey=`md5:3883a417…` | trailing-underline sequence-only |
| 6 | 日期形状 + 人名列尾 | `25-7-27 洛神花陈皮茶 潘兴城`｜md5=37c21648… | `25-7-27 洛神花陈皮茶`｜material｜batch=25-7-27｜contentKey=`md5:37c21648…` | trailing-author batch-derived |
| 7 | 纯数字名 | `13432644904276398`｜md5=空 | `13432644904276398`｜material｜batch=—｜contentKey=`vid:116500086` | no-shape no-md5 |
| 8 | 只有名字（无卡片字段） | `20261109-油弃乌龙茶-汤色 (15)`｜md5=空 | `20261109-油弃乌龙茶-汤色`｜**unknown**｜batch=20261109｜group=汤色｜contentKey=`vid:130112671` | trailing-sequence kind-unknown no-md5 missing-card |
| 9 | 同一名字多行（同文） | `20261109-油弃乌龙茶-外包装 (15)`｜md5=空 | `20261109-油弃乌龙茶-外包装`｜material｜batch=20261109｜group=外包装｜contentKey=`vid:130113144` | trailing-sequence no-md5 |
| 10 | 采集原名（`_n` 不许剥） | `mmexport1786701099436[1]`｜md5=空 | `mmexport1786701099436[1]`｜material｜contentKey=`vid:114712427` | no-shape no-md5 |

读这 10 行能看出三件事：**第 1/9 行**是同一个名字的不同序号（旧规则下文本相同 → 向量相同）；
**第 3/4 行**是"括号问题"，一个多右括号、一个少右括号，都在不改一个字的前提下修好；
**第 8 行**是"名字完整但证不出是素材"的那一类——它**不是**脏，只是缺元数据，所以它丢的是检索资格，不是数据。

---

## D. 结论与建议

### D1. 数字

| 项 | 数 | 比例 |
| - | - | - |
| 清洗后可用于检索 | **66 470** | — |
| 　其中 `md5` 非空（可去重 / 可本机命中） | **61 346** | **92.3%** |
| 　其中 `md5` 空（只能靠 videoId 区分） | 5 124 | 7.7% |
| 其中元数据五级齐全 | 63 573 | 95.6% |
| 　元数据缺（至少一项） | 2 897 | 4.4% |
| `batch` 有值 | 27 112（严格 390 + 派生 26 722） | 34.4% |
| `group` 有值 | 16 584 | 21.0% |

### D2. 判断：上云前还需不需要重抓元数据

**不需要全量重抓；需要一次定向补抓。** 依据：

1. 可检索的 66 470 条里，**95.6% 五级元数据齐全**——全量重抓 78 874 条的卡片，收益只有 2 897 行（4.4%），
   代价是一次 78 874 × N 页的供应商请求（含 150 931 条 `videoType 1` 供应商自己承认拉不到的行，见
   `index.json` 的 `unreachable`）。
2. 真正缺得多的是**那 11 839 条只有名字的行**（`unknown`）：它们 100% 没有卡片字段。其中 **10 340 条有 md5**
   （字节知道、卡片不知道），**1 499 条连 md5 都没有**。这 11 839 条要么补抓元数据后进检索，要么明确"本期不灌"。
3. 5 124 条可检索行没有 md5：`rawMd5` 是随卡片来的，补抓元数据能顺带补上——这是定向补抓的第二个理由。

**建议的灌库口径**：先灌 **66 470 条**（有卡片、去重后）；11 839 条 `unknown` 挂在"待补抓"清单里，
不进检索也不删；1 499 条无 md5 无卡片的行优先补。

### D3. 判断：要不要重算向量

取决于检索 text 用哪个名字，两个分支的数字是确定的：

- **若沿用现行 `mediaDocText`（只用 `stripSequence` 去 ` (n)`）**：清洗不改变 text → **不必重算**。
  现有 `media_doc` 的 78 874 条未取代行都已有向量（版本正在从 `card-meta-1` 迁到 `card-meta-2`，见 A5），可直接复用。
- **若改用清洗后的名字（去 `_n`、去人名列尾、修括号）**：**43 094 行（54.6%）的 text 会变**，
  这部分的向量必须重算；剩下 35 780 行的 text 与现在一致，可复用。

（`修复 47 572` 与 `text 变 43 094` 的差 4 478 行是"只有标签去重排序变了"——`docLabels` 在
`material-doc.mjs` 里本来就做去重排序，不改 text。）

### D4. 上云前的顺序（建议）

1. 定向补抓 11 839 条 `unknown` + 补 md5 → 重新出这份报表，看 `unknown` 是否归零；
2. 定 text 模板（沿用 / 用清洗名）→ 定"要不要重算 43 094 条向量"；
3. 按 `contentKey` 去重后灌 66 470 条（或补抓后的更多）——**同一份字节只留一行**，
   留哪一行由 `betterRow` 决定（有 md5 → 卡片字段多 → videoId 小），所以两次运行结果一致。

---

## 复现

```bash
node scripts/material-clean-report.mjs                 # A + C 全部数字 + 10 组样本
node scripts/material-clean-report.mjs --no-db         # 不连库（库侧标"未采集"，A/C 不受影响）
node scripts/material-clean-report.mjs --no-cache      # 不读缓存（videoType 一律"未采集"）
node --test --test-concurrency=1 packages/openfilm/src/material-clean.test.mjs
```

写集：`packages/openfilm/src/material-clean.mjs`、`packages/openfilm/src/material-clean.test.mjs`、
`scripts/material-clean-report.mjs`、本文件。**未写 Supabase、未改 `media_doc`、未重算向量。**
