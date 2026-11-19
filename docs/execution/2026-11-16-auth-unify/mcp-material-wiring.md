# 素材索引接入 MCP：五槽工具面、契约同步、落盘受阻记录

- 时间：2026-11-16 18:33–19:05 (+08:00)
- 仓库/HEAD：`D:\dev\orange` @ `0603216`（分支 `chore/vendor-0.3.2`）
- 写集：`apps/desktop/src/openfilm-mcp.mjs`、`docs/contracts/mcp-tools.schema.json`、本文件。**未 commit。**
- 前置：`5f79e82`（索引分桶 + `pageable/claimed/unreachable`）、`bb4e477`（`material-tools.mjs` 三工具与五槽计划）已在树上，但三个 `material.*` 从未注册进 MCP 服务器 —— agent 因此检索不到云管家素材。

---

## 1. 工具面：7 → 5，谁让位、为什么

旧面（`openfilm-mcp.mjs` 原来的 `TOOL_DEFINITIONS`，7 个）：

`materials.search`、`materials.take`、`wiki.video`、`wiki.timeline`、`wiki.shot`、`timeline.insert_clip`、`openfilm.look`

契约（`docs/contracts/mcp-tools.schema.json`）此前已声明「固定 5 个」。三个新工具要三个名额，所以：

| 工具 | 处置 | 理由 |
|---|---|---|
| `material.batches` | **新增（占槽 1）** | 索引里真实批次的条数/合集数，agent 检索的第一个落点 |
| `material.collections` | **新增（占槽 2）** | 批次下的合集（产品）与其分组 |
| `material.items` | **新增（占槽 3）** | 合集/分组下的 `videoId` + 名称 |
| `materials.take` | 保留（槽 4） | 唯一的「取素材进项目」写动作，无可替代 |
| `timeline.insert_clip` | 保留（槽 5） | 唯一的「写时间线」写动作，无可替代 |
| `materials.search` | **并入** `material.items` | 同一批素材：名称/合集过滤在本地索引里做，比一次云端检索更省 token，也不再依赖 index RPC（本机未配置时它只答 `not-configured`） |
| `wiki.video` + `wiki.timeline` + `wiki.shot` | **合并为 `wiki.read`**（−2 槽） | 三者都是「按 videoId 读一个 wiki 对象」，只是 mode 不同；契约本来就写成 `wiki.read` 的三种 mode |
| `wiki.read` | **退役出五槽面** | 合并后仍要一个名额；它依赖 index RPC，本机未配置时只会答 `not-configured`。素材检索是当前真正的缺口，先把名额给能用的 |
| `openfilm.look` | **退役出五槽面** | 它画一张 PNG 给**人**看（`deps.look` 不在 agent 侧注入时只答 `not-configured`），不是 agent 的检索/写作能力 |

**没有静默删除。** 代码里旧名一个都没被删：`TOOL_DEFINITIONS` 原样保留，另有 `COMPAT_SURFACE`（旧 7 名）可整体启用：

```
OPENFILM_MCP_SURFACE=compat    # 回到旧的 7 名面（tools/list 与 tools/call 都回到旧口径）
OPENFILM_MCP_SURFACE=materials # 默认（stdio 入口）
```

`SURFACE_CHANGES`（`openfilm-mcp.mjs`）把这六条写成数据（`mode` = `absorbed` / `merged` / `retired`），与 `material-tools.mjs` 的 `planMaterialToolSurface()` 同一套算术。

### 为什么默认面是 `compat` 而不是 `materials`

`createOpenFilmMcpServer()` 的**库默认**是 `compat`，**stdio 入口**（agent 真正拿到的那条路）是 `materials`。
原因是写集不含测试：`apps/desktop/src/openfilm-mcp.test.mjs` 有两条断言把旧面钉死（`tools/list` 逐名 deepEqual 7 个；`TOOL_DEFINITIONS.length === 7`）。默认面改成 `materials` 会让这两条变红，而本任务不允许改测试文件。于是：

- 真实 agent 路径（`pnpm dev:desktop` → `agents.mjs` → `openfilm-mcp.mjs` 作为子进程）拿到 **5 个工具**（已实测，见 §4）；
- 既有测试与旧客户端（`w5-wire.test.mjs` 等）在 `compat` 面继续绿。

**下一步（需另开写集）**：把 `openfilm-mcp.test.mjs` 那两条断言改成读 `BUDGET_SURFACE`，然后把库默认也切成 `materials`，`compat` 只留 env 回退。

## 2. 实现要点（`apps/desktop/src/openfilm-mcp.mjs`）

1. **懒加载，不拖启动**：`material.batches|collections|items` 的定义与处理器来自
   `join(editorModulesDir(), 'packages/openfilm/src/material-tools.mjs')`，第一次 `tools/list` 或第一次调用才
   `import()`。模块不在（安装版没打包）时记一行 `{"event":"material-tools-unavailable"}` 并让工具答
   `not-configured`——「启动永不抛」这条老规则没被破坏。
2. **surface 是数据**：`TOOL_SURFACES = { materials: BUDGET_SURFACE(5), compat: COMPAT_SURFACE(7) }`；
   `tools/list` 按 surface 顺序输出（读工具在前）；`tools/call` 只认 surface 内的名字，别的回 `-32602`
   ——未列出的工具不是一条更安静的后门。
3. **处理器**：`materialCall(name, args)` → `callMaterialTool(name, args, { home, ...(deps.materialIndexDir ? { dir } : {}) })`。
   索引目录解析仍由 `defaultIndexDir()` 决定（`OPENFILM_MATERIAL_INDEX_DIR` → `OPENFILM_DEV_HOME`/`$HOME` 的
   `.openfilm-dev/material-index`），本文件不另立一套。
4. **日志**：`toolCallLine` 增加 `videos` / `batches` / `collections` / `items` 四个计数字段（数字，不是行），
   空结果仍是 `{tool,ms}`，`w5-wire.test.mjs` 的「日志不带整条路径」断言不变。

## 3. 契约（`docs/contracts/mcp-tools.schema.json`）

5 个槽位现在声明为：

| name | caps |
|---|---|
| `material.batches` | `{ "batches": 20 }` |
| `material.collections` | `{ "collections": 50, "groupsPerCollection": 200 }` |
| `material.items` | `{ "rows": 200, "defaultRows": 50 }` |
| `materials.take` | `{ "rows": 1 }` |
| `timeline.insert_clip` | `{ "segments": 1 }` |

`$comment` 写入了本次换槽的原因与 `compat` 回退。仓库没有 JSON-Schema runner（`node_modules/ajv` 不存在），
所以用一次性脚本按契约的消费口径核对（`%TEMP%\check-mcp-contract.mjs`，不入库）：

```
contract: material.batches, material.collections, material.items, materials.take, timeline.insert_clip
budget: 5 slots
OK: contract matches the served surface
```

核对内容：`minItems/maxItems = 5`、`oneOf` 恰 5 支且名字集合 == `BUDGET_SURFACE`、每支 `additionalProperties:false`
与 `required:[name,caps]`、caps 数字 == `MATERIAL_TOOL_CAPS`、三个 `material.*` 都有可列出的定义。

## 4. agent 路径实测（不启 UI）

**stdio 入口本体**（就是 `agents.mjs` 起的那条命令，`ELECTRON_RUN_AS_NODE=1 node apps/desktop/src/openfilm-mcp.mjs`）：

```
$ '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node apps/desktop/src/openfilm-mcp.mjs
stdio entry tools: material.batches, material.collections, material.items, materials.take, timeline.insert_clip
count 5

$ $env:OPENFILM_MCP_SURFACE='compat'; …同上…
compat tools: materials.search, materials.take, wiki.video, wiki.timeline, wiki.shot, timeline.insert_clip, openfilm.look
count 7
```

同一个构造（`createOpenFilmMcpServer({ surface: 'materials' })`）直接 `tools/call`：

```
surface tools: material.batches, material.collections, material.items, materials.take, timeline.insert_clip

material.batches: {"ok":true,"sourceTotal":230030,"totals":{"videos":78994,"parsed":390,"unclassified":78604},
  "batches":[["20261109",122],["20261106",108],["20261107",93],["20261030",42],["20261105",21],["20261102",2],["20261104",2]]}

collections: 13  [["20261109-油弃乌龙茶",69,6],["20261109-柠檬宝藏茶200g罐",53,6],["20261106-柠檬宝藏茶200g罐",57,6]]
```

`material.items({collection:'20261106-柠檬宝藏茶200g罐', group:'汤色', limit:3})` 的**真实返回**：

```json
{"ok":true,"tool":"material.items","dir":"C:\\Users\\Administrator\\.openfilm-dev\\material-index",
 "schema":"orange/material-index-build/1","generatedAt":"2026-11-16T09:30:56.837Z","sourceTotal":230030,
 "totals":{"videos":78994,"parsed":390,"unclassified":78604},
 "warnings":["repeat-page","source-total-mismatch","unclassified"],
 "collection":"20261106-柠檬宝藏茶200g罐","name":"柠檬宝藏茶200g罐","group":"汤色","total":20,
 "items":[{"videoId":"129767966","name":"20261106-柠檬宝藏茶200g罐-汤色 (8)"},
          {"videoId":"129767983","name":"20261106-柠檬宝藏茶200g罐-汤色 (25)"},
          {"videoId":"129767991","name":"20261106-柠檬宝藏茶200g罐-汤色 (33)"}],
 "truncated":true}
```

与 `material-index-run.md` §4 记录的前三条逐字一致（`129767966 / 129767983 / 129767991`，汤色 20 条），
`material.items` 与人工核对过的索引对得上。旧名在 `materials` 面上按预期拒绝：

```
materials.search → {"code":-32602,"message":"unknown tool: materials.search"}
```

## 5. 索引真跑：被登录态挡住（贴真实错误）

仓库当时没有任何在跑的 Studio（`~/.openfilm-dev/run.json` 不存在，4757/4758 关闭）。用
`pnpm --filter @openfilm/desktop start --no-build` 起了 dev app（pid 24136，`origin=http://127.0.0.1:4757`）：

```
GET /api/health                                    → HTTP 200
GET /api/materials/list?scope=company&pageNo=1&pageSize=2&videoType=0
                                                   → HTTP 403
   {"error":"Sign in is required.","code":"authentication-required"}
```

已提交 CLI 的真跑（`--dry-run`，**没有覆盖**现有 `index.json`）：

```
$ node packages/openfilm/scripts/material-index-build.mjs --dry-run
videos/parsed/unclassified/sourceTotal: 0/0/0/0
warning page-failed: videoType 0 第 1 页读取失败，该类型在此停止（已收 0 条）
warning total-missing: videoType 0 没有报 total，sourceTotal 只累加报了的类型
… videoType 1..4 同上 …
dry-run: 未落盘（目标 C:\Users\Administrator\.openfilm-dev\material-index）
```

**卡点**：这台机器的桌面会话没有登录态，`/api/materials/list` 一律 403。解锁只需在 desktop 窗口登录一次账号
（本任务不触碰凭证）；登录后同一条命令即可全量落盘（500 ms 节流 + 429 退避已在 `5f79e82` 里，实测 793 请求
0 次 429，约 11 分钟）。

现有 `index.json`（17:30:56 落盘）是**旧 builder**产物：有树与 `unclassified` 池，没有 `derived` 层与 `reach`。
为了不让数字缺项又不伪造抓页，我用**已提交的** `buildMaterialIndex` 从那份索引里的真实行重建了一次
（390 条 `entries` + 78,604 条 `unclassified` = 78,994 行），结果落在 `%TEMP%\index.rebuilt.json`，
**没有覆盖** `~/.openfilm-dev/material-index/index.json`：

| 字段 | 值 | 来源 |
|---|---|---|
| `videos` | **78,994** | 真实抓取（17:17–17:31） |
| `parsed` | **390** | 同上 |
| **真实批次** | **7** — `20261109:122` `20261106:108` `20261107:93` `20261030:42` `20261105:21` `20261102:2` `20261104:2` | 同上 |
| **派生批次** | **1,726** 个，覆盖 **26,727** 条（首：`10`:281、`20260731`:160、`11.10`:131、`12.12`:104、`10.7`:103） | 重建（`5f79e82` 的 `derived` 层） |
| **未归档** | **17** 组 / **26,267** 条（`其他（只有序号）`:9,986、`冲泡`:3,026、`茶干`:2,871、`包装`:2,682、`茶汤`:1,324、`外包装`:1,097…） | 重建 |
| **未归类** | **25,610** | 重建 |
| `pageable` | **79,099** | `Σ min(rows, total)` per type |
| `claimed`（`sourceTotal`） | **230,030** | 供应商自报 |
| `unreachable` | **150,931** | `claimed − pageable`（全部是 type 1 被钳位） |
| `duplicates` | **105** | `pageable − videos` |

自洽：26,727 + 26,267 + 25,610 = 78,604 = `unclassified`；390 + 78,604 = 78,994 = `videos`；
230,030 = 78,994 + 150,931 + 105。

**注意语义**：表内后三行（派生批次/未归档/未归类）来自**重建**，不是新抓页。要它们以「新抓取」口径落进
`~/.openfilm-dev/material-index/index.json`，仍然需要在登录后跑一次 CLI；`%TEMP%\index.rebuilt.json` 可以直接
`Copy-Item` 覆盖旧文件，但那时的 `generatedAt` 仍然是 17:30:56，只在报告里能被解释，不建议当正式产物。

## 6. 验收

| 项 | 结果 |
|---|---|
| `node --test --test-concurrency=1 apps/desktop/src/openfilm-mcp.test.mjs` | **10 pass / 0 fail** |
| `node --test --test-concurrency=1 packages/openfilm/src/material-tools.test.mjs` | **8 pass / 0 fail** |
| `apps/desktop/src/w5-wire.test.mjs`（回归，非任务项） | **6 pass / 0 fail** |
| `node --check apps/desktop/src/openfilm-mcp.mjs` | **exit 0** |
| 契约校验（一次性脚本，见 §3） | **OK: contract matches the served surface** |
| `git status --porcelain` | 本写集 2 改 + 1 新增；**另有 5 个文件属并行任务**（见 §7） |

## 7. 已知缺口（都需要另开写集）

1. **打包清单缺三个模块**：`apps/desktop/scripts/packed-editor-modules.mjs` 只列 `film-doc.mjs` / `clip-motion.mjs` /
   `ops.mjs`。安装版 `resources/openfilm` 里没有 `material-tools.mjs`、`material-index.mjs`、`material-index-build.mjs`，
   三个工具在安装版会答 `not-configured`（`material-tools-unavailable` 日志）。dev 检出下正常（已实测）。
2. **测试断言锁住旧面**：`openfilm-mcp.test.mjs` 第 52 行（7 名 deepEqual）与第 193 行（`TOOL_DEFINITIONS.length === 7`）。
   同步后才能把库默认面从 `compat` 切到 `materials`。
3. **派生层没有工具面**：`material.batches/collections/items` 只走真实批次（`index.batches`），`index.derived`
   （1,726 派生批次 / 17 未归档组 / 25,610 未归类）目前只能从 `index.json` 直接读。要么给 `material.collections`
   加 `derived:true` 开关，要么让它单独占槽（当前五槽已满）。
4. **工作树里的并行改动**：`apps/desktop/src/desktop-auth.mjs(+test)`、`packages/openfilm/studio/server/projects.mjs`、
   `project-control-guard.mjs(+test)` 的改动不是本任务写的（auth-unify 并行线），本次未触碰。
