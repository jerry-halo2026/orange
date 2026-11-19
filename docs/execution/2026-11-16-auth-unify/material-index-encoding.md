# 素材索引：落盘编码自校验 + rawMd5 纳入 + 全量真跑

- 时间：2026-11-16 18:58–19:15 (+08:00)
- 仓库/HEAD：`D:\dev\orange` @ `a496d08`，**未 commit**
- 写集：`packages/openfilm/src/material-index.mjs`、`material-index-build.mjs`、两个同名 `*.test.mjs`、本文件
- 应用：dev Studio 在跑，`~/.openfilm-dev/run.json` → `origin=http://127.0.0.1:4757`（`key` 不落盘、不打印）
- 产物：`~/.openfilm-dev/material-index/index.json`，13,166,148 B，`generatedAt 2026-11-16T11:06:46.134Z`

## 0. 结论三条

| 项 | 结果 |
|---|---|
| 落盘编码 | builder 自己以 UTF-8 写 tmp → **读回比对 + `JSON.parse`** → 才 rename；自校验失败删 tmp 并抛错，旧 `index.json` 不动 |
| `rawMd5` | 条目（`entries` 与 `unclassified`）新增 `md5`，缺失为 `''`；**计数语义零变化**；真跑覆盖率 71,686/78,874 = **90.89%** |
| 真跑 | 5 类全量、414 s、793 次 list 请求、**0 次 429**、0 warning `rate-limited`/`page-failed` |

## 1. 上次的故障与根因

上次重建后的文件里，`标品` 变成 `鏍囧搧`、`加冰块` 变成 `鍔犲啺鍧?`，JSON 结构还在、体积也对，但字符串已不可逆损坏，最终回滚。

根因不是 builder 的字符串处理，而是**文件曾经经过 shell**：`Set-Content` / `Out-File` 走控制台代码页（本机 GBK），UTF-8 字节被按 GBK 解释后再以 UTF-8 写回 —— 一轮不可逆转码。所以修复的第一条不是"记得加编码参数"，而是**这类文件不允许由 shell 落地**。

## 2. 修复一：写盘与自校验（`material-index-build.mjs`）

`writeMaterialIndex` 现在的顺序，每一步都为堵一个已发生过的失败：

1. **显式 UTF-8，本进程写**：`writeFileSync(tmp, text, 'utf8')`（不再 `writeFile(tmp, text, {mode})`，也不再有任何 shell 参与）。
2. **读回比对**：`readFileSync(tmp, 'utf8') !== text` 即失败 —— 编码被改写、写入被截断都在这里暴露。
3. **读回 `JSON.parse`**，并校验 `schema` 与 `videos` 与内存中的结果一致。
4. **以上任一失败 → 删除 tmp + 抛 `index-verify-failed`**，带上"已删除临时文件，旧 index.json 未改动"；**只有全部通过才 `rename`**（`replaceFile` 保留 Windows 文件占用重试）。
5. `bytes` 改为 `Buffer.byteLength(text, 'utf8')`，与落盘字节同口径。

新增 `countMd5s(index)`：`writeMaterialIndex` 的返回值多一个 `md5s: {entries, withMd5, missing}`，写盘时就把 md5 覆盖率说出来。

测试（`material-index-build.test.mjs` 新增两条）：

- 中文名往返：`标品-加冰块 (1)` 写入后读回逐字符相等、无 BOM、无 `U+FFFD`、无 `鏍/鍔/鍧/啺/搧` 形状。
- 自校验必须拦住坏写：用一个"序列化时 `videos: 7`、校验时 `videos: 8`"的结果对象 → `index-verify-failed`、tmp 被删、**旧 index 字节不变**；再把 tmp 路径占成目录 → 同样拒绝、旧文件不变。

## 3. 修复二：`rawMd5` 纳入索引（`material-index.mjs`）

- `IndexEntry` 由 `{videoId, name}` 变为 `{videoId, name, md5}`（`md5` 恒在，缺失为 `''`）。
- 取值只在新函数 `md5Of(row)` 一处：`row.rawMd5 ?? row.md5`，`{sourceType, source}` 字面量会解包，非字符串一律 `''` —— 不猜、不补、不算哈希。
- 落点：`group.entries`（原来只有 `videoId/name`）+ 平铺的 `unclassified`。派生层的 `videoIds` 仍是纯 id 数组。
- **计数语义未动**：`totals`、`videoIds`、排序、`derivedTotals` 全部原样；`material-tools.mjs` 的 `material.items` 自己投影 `{videoId, name}`，不受影响（其 8 条测试仍全绿）。
- `rowOf`（CLI 页解码）同步带上 `observation.rawMd5` / `observation.md5`，否则索引里永远不会有 md5。

测试：`material-index.test.mjs` 新增两条（三种取值名 + 缺省 `''` + `videoIds` 仍是 id 数组 + totals 不变；`md5Of` 的解包与拒收），两处既有 `deepEqual` 断言按新形状同步。

## 4. 全量真跑（已提交 CLI，无改源码驱动）

```
node packages/openfilm/scripts/material-index-build.mjs --json
```

CLI 自带 `DEFAULT_THROTTLE_MS = 500` 与 429 指数退避（1/2/4/8 s，每页 4 次），本次**没有**用仓库外驱动。

- 退出码 0，用时 **414 s**，`pageSize 100`，`scope=company`，`videoTypes 0..4`。
- **0 次 429**、0 条 `rate-limited`、0 条 `page-failed`、0 条 `page-cap`。
- 每类停止原因：0/2/3/4 `short-page`（读完），1 `repeat-page`（供应商第 289 页钳位）。

### 六个数字

| 字段 | 值 |
|---|---|
| `videos` | **78,874** |
| `parsed` | **390** |
| `pageable` | **79,099** |
| `claimed`（`sourceTotal`） | **230,030** |
| `unreachable` | **150,931** |
| `duplicates` | **225** |

恒等式成立：`390 + 78,484(unclassified) + 225 + 150,931 = 230,030`。

### 分层计数

| 层 | 值 |
|---|---|
| 真实批次 `batches` | **7 个**，Σ count = **390** |
| 派生批次 `derived.batches` | **1,726 个**，Σ count = **26,727** |
| 未归档 `derived.groups` | **26,160 条 / 17 组** |
| 未归类 `derived.unassigned` | **25,597** |

`26,727 + 26,160 + 25,597 = 78,484 = unclassified`（三层不丢行）。

与上次记录（`material-index-run.md`，78,994 条）差 120 条：供应商账号当日有增删，不是解析差异 —— `parsed` 两次都是 390。

## 5. 落盘校验（node 读回，不经过 PowerShell）

```
JSON.parse: ok            schema: orange/material-index-build/1
bytes: 13,166,148         generatedAt: 2026-11-16T11:06:46.134Z
U+FFFD / GBK 形状字符: none
```

中文抽查（同一份文件里同时看两处）：

- `加冰块`：parsed 组内 **6** 条（`20261109-油弃乌龙茶-加冰块 (3)`…），`unclassified` 里 **35** 条。
- `标品`：`unclassified` **674** 条（`标品-源记号-光辉岁月180g/盒—包装_4`…），parsed 组内 0 条 —— 这类名字本就不符合严格命名，属预期。
- 全文 `\uFFFD` 0 个，`鏍/鍔/鍧/啺/搧` 0 个。

## 6. `20261106` 与它下面的合集

批次 `20261106` 共 **108 条**，**2 个合集**：

| 合集 | 条数 | 组 |
|---|---|---|
| `柠檬宝藏茶200g罐` | 57 | 汤色 20 ｜ 茶干 18 ｜ 外包装 12 ｜ 规格 3 ｜ 冲泡 2 ｜ 加冰块 2 |
| `2024头采新会柑普茶250g罐` | 51 | 规格 18 ｜ 茶汤汤色 14 ｜ 包装 11 ｜ 茶干料子 7 ｜ 冲泡 1 |

前 3 条原样：`20261106-柠檬宝藏茶200g罐-汤色 (8)` (129767966) ｜ `… (25)` (129767983) ｜ `… (33)` (129767991)。
`57 + 51 = 108` ✔，与 `material-index-run.md` §4 一致。

## 7. md5 覆盖率：为什么 parsed 是 0/390

| 范围 | 覆盖 |
|---|---|
| parsed `entries` | 0 / 390 |
| `unclassified` | 71,686 / 78,484（91.3%） |
| **全部 videos** | **71,686 / 78,874 = 90.89%** |

parsed 全空**不是丢字段**，是供应商就是这么发的。带 key 直查（`GET /api/materials/list?...&videoType=1&name=20261106`）：

```
20261106-2024头采新会柑普茶250g罐-包装 (33)   rawMd5=""  rawFileSize=36091178  state=2
20261106-2024头采新会柑普茶250g罐-规格 (24)   rawMd5=""  rawFileSize=52440856  state=2
…
```

即：这批"编号规范"的素材行本身 `rawMd5` 为空串（而 `rawFileSize` 有值），同一个接口的其它行则带 32 位摘要。索引如实记 `''`，没有伪造、也没有拿 `fileSize` 之类去凑。

## 8. 验收

| 项 | 结果 |
|---|---|
| `node --test --test-concurrency=1 packages/openfilm/src/material-index*.test.mjs` | **42 pass / 0 fail**（原 37 + 新增 5） |
| `node --check` 改动文件 | 0 错（4 个 `.mjs` 全过） |
| 真跑落盘 | `JSON.parse` ok、中文正常、六数字+三层计数见 §4 |
| 403/429 | 本次 0 次；无伪造响应体可贴 |
| `git status --porcelain` | 本任务只动写集 4 文件 + 本文件；同一 checkout 另有并行会话在改 `apps/desktop/src/desktop-auth.test.mjs`、`packages/openfilm/studio/**`（UI 素材中心），**非本任务所为、未触碰** |

## 9. 复现

```powershell
# 前置：app 在跑且已登录（run.json 里有 origin/key）
node packages/openfilm/scripts/material-index-build.mjs --json      # ~7 分钟，500 ms 节流内置
node --test --test-concurrency=1 packages/openfilm/src/material-index*.test.mjs
```

读回校验就用 node（**不要**用 `Get-Content`/`Set-Content` 抄这份文件）：

```powershell
node -e "const fs=require('node:fs');const p=require('node:path').join(require('node:os').homedir(),'.openfilm-dev','material-index','index.json');const j=JSON.parse(fs.readFileSync(p,'utf8'));console.log(j.videos,j.parsed,j.pageable,j.sourceTotal,j.unreachable,j.duplicates)"
```
