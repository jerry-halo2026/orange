# 2026-11-12 Fission 命名空间防护合入与实机复验

本记录是脱敏索引，不是完整试用验收。依据实际 Git 与回执更新。

## 合入

- 候选分支 `codex/local-creation-integration` 提交 `34dbe1c`（`fix(fission): hold the task namespace across copy and record stages`），把命名空间防护、CLI 握手协议、产物清单与 nvenc 回退一并落盘。
- `dev` 以 `--no-ff` 合入该分支，合并头 `d3654af`；合并前按 patch-id 核对，候选 `cae5860` 与 dev 已拣选的 `63244a3` 等价（`--cherry-pick --right-only` 计数为 59，等价 1 条），合并后内容未重复。
- 合入时 `dev` 工作区干净；本地未推送（领先 `origin/dev` 69 个提交，含历史文档提交）。

## dev 头复验（实际命令与结果）

| 项 | 命令 | 结果 |
|---|---|---|
| 构建 | `dotnet build workers/fission/Fission.slnx -c Release` | 0 警告 0 错误 |
| C# 单元 | `dotnet test tests/Fission.UnitTests/... -c Release`（`FISSION_PATH_POLICY_TEST_ROOT` 隔离根） | **246/251**；5 项失败与基线 `101b13f` 完全一致（3 项 `FissionEditPlanTests`、2 项 `FissionProcessRetirementTests`），非本轮引入 |
| Node 协议 | `node --test packages/openfilm/studio/server/fission-local.test.mjs` | **19/19**（含 2 条真实 CLI 用例） |
| 类型检查 | `pnpm typecheck` | 通过（`LASTEXITCODE=0`） |

**插曲（如实记录）**：为让本机运行配置通过校验，先建过 `D:\dev\7d-rebuild\assets`，它使既有用例 `EnginePathPolicyTests.Create_UnapprovedMissingReadOnlyLocations_RejectsOriginalDefaults` 失配（该用例断言默认路径缺失）。已删除该目录，并把运行配置的 `LocalAssetsRoot` 指向既有目录 `D:\dev\7d\lib`；随后该用例恢复通过。教训：不要为了本地配置新建默认路径上的目录。

## Windows 实机链路复验（V1 回执 `20261112-102542`）

| 步骤 | 结果 | 关键事实 |
|---|---|---|
| 隔离桌面 + 真实账号登录 | PASS | auth `active`，Studio 19821，fission 服务 200 |
| 进入超级混剪（合成点击） | PASS | 卡片中心 (303.7,174.0)，5.7 s |
| **UIA 亲自操作文件夹对话框** | **未通过（非本人完成）** | 对话框为 `#32770 浏览文件夹`/`SysTreeView32`，无文件名编辑框；实际选中 `sucai` 来自未知驱动（job.json 场景组名 GBK 乱码可证），不计入本项通过 |
| 批量出片 + 按需 1 条草稿 | PASS | job `cde25340…`，2 条各 8 s，17.0 s；草稿 `7L5vU_1zcIpa`（V1 2 段 + A1，problems 空） |
| 编辑/撤销/保存重开 | PASS | rev `b93ae322 → b2893ce5 → b93ae322`，重载逐字节相同 |
| 720p 导出 + 完整解码 | PASS | 3 620 443 B；h264 720×1280 30fps 8.0s 240 帧 + aac 96k 立体声；`ffmpeg -v error -f null -` 退出 0、stderr 0 字节 |
| 五源哈希 | PASS | 5/5 一致；整树 33 文件 847 046 611 B 前后一致 |
| 失败/取消/重复草稿 | PASS | 400 `fission-scene-groups-disabled`；`cancelled`；同 output 幂等、异 output 另建 `Fission 草稿 2` |

**NVENC 归因**：失败 worker 实际使用 `D:\software\OpenFilm\resources\runtime\ffmpeg\ffmpeg.exe`（`ffmpeg 9.0.2-essentials_build`），要求 nvenc API 13.1 而本机驱动仅 12.1；与该 job 的 `paths.json` 及实例配置一致，属“构建-驱动不匹配”，非配置解析错误。`UseNvenc:false` 走 libx264 后 2 条 17 s 出片。本轮已实现**只对该错误签名**的显式回退（探测按配置的 `FFmpeg`，用 256×256 空编码；16×16 会先撞 nvenc 最小尺寸限制）。

**环境前置（已记录）**：隔离 `baseRoot` 必须等于候选树 `.dev/orange-test-control-policy.json` 的值；一个 attempt 只能启动一次（`ISOLATION_RUN_EXISTS`，需换 attemptId）；导出前须把 `chromium_headless_shell-1228` 播进 profile 的 cache；导出不可与页面重载并行（否则会出现 “renderer stopped (exit 0)”）。

**事故**：V1 清理时 `Get-Process electron` 全杀，误伤 `D:\dev\morchat.co` 的 Electron（监听 9333）；此后改为按候选树路径过滤。该误伤需在后续清理流程里作为反面样例。

## 未完成（不得视为验收通过）

- `pnpm test` 全量、`audit-public`、`check:pack` 尚未在 dev 头执行。
- Windows 链路的「UIA 亲自选文件夹」仍未通过；当前依赖未知驱动完成的选择不能作为证据。
- 非作者对合并结果与素材中心的新一轮审查（R4）未开始。
- 素材中心只读传输与三层授权（D1）进行中，未接线 UI。
- 工作树/分支保全与清理（H2–H4）未开始。

## 交互式运行的失败归因（2026-11-12，操作者实机）

一次“混剪执行失败，请检查素材和任务状态后重试”的任务目录（`…/v1chain/T_CHAIN/a20261112104057/home/fission-jobs/`）里同时存在三种不同失败，证据如下：

| jobId | 现象 | 证据 | 归因 |
|---|---|---|---|
| `cf5dbb7d…` | `[Fission:CFG_ARGS]` 退出 2 | `job.json` 里 `"Naming":"Number"` | 原生 `NamingRule` 只认 `AudioFileName/Sequence/RandomTitle`；旧客户端值不被接受 |
| `4b7e44d3…` | `[Fission:OUTPUTS] []` + `[Fission:JOB-FINISHED] 4` | worker.log：`Driver does not support the required nvenc API version. Required: 13.1 Found: 12.1`；`paths.json` 的 `FFmpeg` = `D:\software\OpenFilm\resources\runtime\ffmpeg\ffmpeg.exe`（ffmpeg 9.0.2） | 该次运行用的 CLI 早于 nvenc 回退；9.0.2 需要 nvenc API 13.1，本机驱动 12.1 |
| `4b7e44d3…` | 场景组名 `1绛涙灉` 等 | 同一 `job.json` 的 `SceneGroups[].Name` | 旧构建把中文文件夹名按错误编码写入，组名与真实目录不匹配，即便编码成功也会 0 产出 |

对照：同目录 `cde25340…`（2×8s）与 `f49efd83…`（1×8s）均 `completed`，说明链路本身可用。

处置：
- 已在 dev 头补 `Naming` 别名规范化（`Number/Sequential→Sequence`、`AudioFileName`、`Random→RandomTitle`），未知值在 `start()` 同步拒绝；新增用例覆盖正反两向。
- nvenc 回退已在 dev 头：探测按 `paths.FFmpeg` 的 256×256 空编码，签名匹配才回退；旧 CLI 无此逻辑。
- 中文场景组名：须从 dev 头构建的客户端重新取组名（`contents()` 读目录名），不要沿用旧构建写出的 job.json。

## 流程事故与纠正（2026-11-12）

- **共享主仓被切分支**：一个实现 Agent 在 `D:/dev/orange` 里 `git checkout codex/zhishang-material-readonly`，导致主仓 HEAD 从 `cf7c5ce` 变成 `a49a8ad`。发现时我正在跑 dev 头的全量 `pnpm test`，该次运行已作废（结果不可信，未采用）。
- 处置：`git stash` 保存台账未提交改动 → `git checkout dev`（`cf7c5ce`）→ `git stash pop`；实现分支 `a49a8ad` 完好保留；重跑 `pnpm test`。
- 规则重申：共享主仓常驻 `dev`；一切主题分支用独立工作树（`git worktree add E:/CodexData/worktrees/<name> <branch>`），不得在 `D:/dev/orange` 检出主题分支。

## 真实编码产出的计划无法导入 —— 定位、两次错误修法与最终修法（2026-11-12）

现象（真实进程 + 真实编码，非夹具）：A（`D:\dev\7d` legacy + nvenc）与 C（同引擎 + libx264）产出的 `001.edit-plan.json` 被 Studio 导入器拒绝；B（OpenFilm 9.0.2）恰好落在 4.000 s 才通过。

根因：stream-copy 裁剪留下包尾，成片比对齐时长多 0.1 s（A）/ 0.067 s（C）；计划里 `durationSec` 是真实时长，而导入器有两条不变式——`visuals` 必须覆盖到 `durationSec`（`:156`）、每段必须落在源时长内（`:57`）。引擎已写 `transitions.tailPaddingSec=0.2` 这个预算，但没有任何一方去花它。

**我的第一次修法是错的**（已 `git revert`，`0c3fc5b`）：在 C# 里把末段延长到真实时长，满足了覆盖，却让源片段超出源时长（`:57` 拒绝，实测超 0.0667 s）。把源片“剪长”在语义上不成立。

**最终修法**（`40edcae` + `f9c6223`）：
- 两条不变式**对称地花掉已有预算**，且仅在确有包尾（`action==='trim'` 且 `durationSec > outputDurationSec + 1/fps`）时启用；只有**末段**可享越界额度；
- 预算 = `min(tailPaddingSec, 0.5)`，并把 `tailPaddingSec > 0.5s` 本身判非法（包尾是“至多几帧”的产物）；
- 预算抽成**模块级导出纯函数** `tailPaddingBudget(plan)`；此前它被定义在 `validate()` 作用域却在 `nativeOps()` 引用，导致带包尾的计划一律抛 `ReferenceError`（被 catch 成 `FISSION_IMPORT_INVALID`）——**这是一次真实的假绿**：desktop 套件里没有一条喂“带包尾计划”的用例，所以 600/595/0/5 全绿并不能证明导入器可用；
- 新增 `packages/openfilm/studio/server/fission-import-budget.test.mjs`（3 例）钉死预算语义，防止放宽规则再次悄悄失效。

实测（dev `f9c6223`，真实进程出片后导入）：A4/C4 **均 5/5 通过**；负例仍拒——`duration = output + padding + 2/fps` 拒在缺口规则（`validate:96`）、`tailPaddingSec = 5` 拒在上限规则（`validate:90`）。

**已知限制（不伪装成已解决）**：尾部被**容忍并显式声明**，但**没有在时间线上落点**——导入后的原生工程视频轨为 `#t=0,2` @0 与 `#t=0,2` @2（end 4.0），没有任何 clip 覆盖 4.0→4.1；差异写进 handoff 的 `blockingCapabilities`（`fission-trim-tail-equivalence-unverified`、`fission-alignment-duration-drift`），且 `exportReady:false`、`equivalenceVerified:false`。要真正落点需要新增 freeze/still 段（`sources.kind` 已支持 `still`），这是独立改动，未做。

**前置（必须写进复用清单）**：带包尾的计划导入必须提供 `ORANGE_FISSION_FFPROBE`，缺失时 `videoStreamDuration` fail-closed 拒绝；desktop 套件本身不设该变量，因此“绿”需要人工给变量才可复现。

## 素材中心卡片页合入（同日）

- D2 的 `codex/material-center-ui`（提交 `f517966`：客户端、契约、控制器、筛选、模型、状态、卡片与列表行、页面，共 16 文件 / +2081 行）以 `--no-ff` 合入，合并头 `3fe3488`。
- 关键约束落实为**测试**而非口头约定：卡片组件目录内不得出现 `fetch`、`XMLHttpRequest`、`new Image`、`videoUrl`/`query\/raw`/`\/download`/`isInner`，也不得持有只读客户端；hover 只调 `onHover(videoId)`，`onUse` 仅一处调用点；客户端只认 `/list` `/facets` `/labels` 三条路由，未列参数（`isInner`/`url`/`pageSize>100`）在出网前拒绝，`totalIsProviderTotal!==true` 或分类扁平化与 `children` 不一致时按 `provider-response-unconfirmed` 拒绝而不是显示半页。
- 实测（dev 头 `3fe3488`）：`pnpm typecheck` exit 0；`studio/ui` 测试 **735/735**；`apps/api` 62/62（前一轮）；desktop 套件 600/595/0/5。

## 复核陷阱与 H4 首轮清理（同日）

### 两个会导致“假红/假挂”的复核陷阱（已实测）
1. **必须在仓库根跑**：`fission-local.test.mjs` 里 `CLI_DLL` 是 `path.resolve('workers/fission/...')`，在 `packages/openfilm` 目录下跑会解析到不存在的路径，报 “build the Fission CLI first”；在 `D:/dev/orange` 根下跑则 **23/23 通过**。
2. **不要加 `--test-concurrency=1 --test-timeout=...`**：在本机 node 上组合这两个参数会让 `node --test` 无输出挂起（单文件直跑 3/3、无参数跑全绿）。此前“全量套件 20 分钟无输出”的记录，至少部分由此造成，不能仅据此判定套件失败。

### H4 首轮清理（只删“三证齐全”的）
三证 = ①分支已完全并入 dev（`dev..HEAD` 独有提交为 0）②工作树无未提交改动（或 WIP 已快照）③全仓 bundle 已验证且恢复演练计数一致（763=763）。

本轮删除 5 个：`zhishang-material`、`test-roots`、`orangeflim-base`、`102f`、`94da`；其中 4 个 `git worktree remove` 因 `node_modules` 超 MAX_PATH 未能自清，用 `\\?\` 前缀删除残留，`git worktree prune --dry-run` 无残留条目。**工作树 23 → 18**。

未删（有独有提交或正在使用）：`material-center`（刚合入，保留待查）、`orange-budget-cap`（V1 环境）、`t01-isolation`(252)、`m0-validate`(251)、`fission-independent`(288)、`services-restore`(263)、`material-ui`(279)、`media-boundary`(262)、`business-admission`(234)、`native-type-baseline`(243)、`native-root-role`(223)、`t05-paths`(245)、`b08`/`b768` 等，均需先判定分支归属。

保全位置：`D:/dev/orange/.dev/cleanup/20261112-130611/`（`all-refs.bundle` 57.8 MB、`summary.md`、`worktrees.json`、`wip/`、`receipts/` 共 6846 个文档 58.8 MB）。

## Windows 链路第 2 步：UIA 实选通过（V1 回执 20261112-195808）

这一步此前一直记为“未通过（选择来自未知驱动）”。本轮由 V1 自己的脚本完成，手段是**跨进程 Win32 树控件消息**：`OpenProcess` + `VirtualAllocEx` 在对话框进程内分配 `TVITEMW`/文本缓冲 → `SendMessageTimeout` 发 `TVM_GETNEXTITEM / TVM_GETITEMW / TVM_EXPAND / TVM_SELECTITEM / TVM_ENSUREVISIBLE` → `GetDlgItem(id=1)` + `BM_CLICK` 点“确定”。路径：`本地磁盘 (E:) → CodexData → cli-chain-20261112 → v1dialog → T_DIALOG → media → sucai`；选中后 `TVGN_CARET` 与目标一致、对话框关闭，应用侧 `/api/fission-local/select` 返回 `name=sucai`，场景组 10/9/3/6/5，`job.json` 的 `SceneGroups[].Name` 用 node 按 UTF-8 读为 `1筛果/2洗果/3挖果/4掰开挤汁/5展示`。

**为什么只能这么干**（实测）：该对话框无文件名编辑框（无 `BIF_EDITBOX`）；UIA 的 `Children/Descendants/TreeItem` 全为 0；`LegacyIAccessiblePattern.LookupById(10018)` 返回 null；MSAA `accChildCount=20` 但 `getAccName(i)` 全为空串——我先前那个走 `accSelect` 按名定位的 `select-folder.ps1` **在这里先天缺名，失败是必然的**，不是实现细节问题。

**V1 同时撤回上轮一条错误证据**：它曾用「`job.json` 组名 GBK 乱码」证明“那次选择不是我做的”。该乱码是 PowerShell 5.1 `Get-Content`（默认 ANSI）读 UTF-8 的**显示假象**，本轮用 node 复核为正确中文。结论（上轮那步不是它做的）仍成立，但证据撤回。

产品侧建议（未改代码）：`pickFolder` 现在硬编码 `at:null` 且用 WinForms `FolderBrowserDialog`，无起始目录、无编辑框；要可测/可回归，建议换带编辑框的 `IFileDialog` 或传起始目录。

## 尾部落点合入（`74d5962` → 合并 `5640601`）

`CommandBuilders.TailFrame` 用 `-sseof` 抽包尾末帧；引擎算 `tail = probe 时长 − Σ(dur/speed)`，当 **1ms < tail ≤ tailPaddingSec** 时追加 `still` 源 + `role=outro, startSec=0, durationSec=tail` 的 visual；抽帧失败或超预算**不伪造**，只记日志。本轮审阅时补两处：`tail` 取 **`Math.Round(tail, 3)`**（容器毫秒刻度，消除 `0.0999…64` 浮点尾），并删掉一处无意义的 `_ = tailFreezePath` 抑制语句。

实测（dev 头 `5640601`）：C# **255 项 / 250 通过 / 5 失败**（5 项与基线同名）；`packages/openfilm/src/fission-timing.test.mjs` **3/3**。V1 侧真实产物：`ffprobe` 4.100000 s，导入 5/5，原生视频轨 `2 → 4 → 4.1`，`videoEnd − durationSec = 0`（CPU 路径 4.067 同样差 0）。`exportReady=false` 与 `blockingCapabilities` 未变——**落点 ≠ 等价性验证**。

## 素材中心接通：P1-A 完成（`689ff62`）

- 入口 `apps/api/src/main.ts`：env 校验（`MATERIALS_PORT`/`MATERIALS_SECRET`/`MATERIALS_CREDENTIALS`/`MATERIALS_ORIGINS`/`MATERIALS_ALLOWED_ROOT`），缺/非法 → `refusing: <code>` + exit 2；`/health` 只回 `{ok,version}`；父进程 EOF / SIGINT / SIGTERM → exit 0。
- **身份只有一个来源**：旧“`verify` 恒拒”已删除，默认改为 `MATERIALS_SESSION_MODE=hmac`——子进程只验 Studio 签过的委托人：
  `canonical = "v1\n" + principal + "\n" + METHOD + "\n" + path(不含 query) + "\n" + 原始 query`，`HMAC-SHA256(MATERIALS_SECRET)` 取小写 hex。
  负例覆盖：篡改 principal 留旧签名、签名给 `/list` 打到 `/facets`、换 query、改方法、`exp` 过期/正等于当前秒、`epoch` 非正整数、字段缺失/多余、非 UUID、query>4096 —— **全部 403 且供应商调用数 0**。
- `MATERIALS_SESSION_MODE=supabase` 缺配置 → `refusing: supabase-config-missing`（exit 2），**不降级**。
- 真进程冒烟：无头 → `authentication-required`；正确签名 → `authorization-denied`（过了会话门、停在授权层，因绑定库未接，不伪造 accountKey）；EOF → exit 0。
- 测试：`apps/api` **83 pass / 0 fail**；`pnpm typecheck` 4 包 Done。
- 顺手修：Windows 编辑器写入的 UTF-8 BOM 曾让凭据被判 `credentials-unreadable`，现解析前剥 BOM，安全属性不变。

**下一步已派**：授权绑定改为读忽略区文件 `MATERIALS_BINDINGS`（`{version:1,bindings:{subjectId:{selfAccountKey,grantedAccountKeys[]}}}`），文件缺失/畸形即拒绝启动，无绑定者 `own`/`account:*` 一律 403，不回退公司视图。

## P1-A 收尾与事故记录（`b84dba9`）

- 授权绑定改为读忽略区文件 `MATERIALS_BINDINGS`：路径必须在 `.dev` 内、文件名 `.local.json`、单链接、≤64 KiB、逐级不得是符号链接、`realpath` 自等；内容顶层键恰好 `bindings/version`、key 为 UUID、每值键恰好 `grantedAccountKeys/selfAccountKey`、accountKey 非空 ≤512 可打印 ASCII、`grantedAccountKeys` 可为空并去重、空 `bindings:{}` 合法。文件缺失/损坏 → **进程不启动**（不存在“空表继续跑”）。
- 无绑定时：`scope=own` 与 `scope=account:*` 一律 403 `authorization-denied`，**不回退公司视图**；日志只打 `bindings loaded count=N`，键值绝不入日志（有用例逐字断言）。
- 测试：`apps/api` **92 pass / 0 fail**；`pnpm typecheck` 4 包 Done。

**事故（如实记录）**：该 Agent 做真进程冒烟时漏装本地 `fetch` 替身，导致签名请求**真实出网一次**打到供应商 token 端点（假凭据，返回 `provider-company-unconfirmed`，未读取素材、未落数据）。代码路径本身用替身测试、无外呼。处置：要求加 `MATERIALS_SMOKE_NO_NET=1` 机械防线——置位时未安装替身即拒绝启动（`refusing: smoke-net-guard`），并要求冒烟脚本断言未使用真实 fetch。

**仍未定**：`scope=company` 的公司视图键来源。已要求新增可选 `MATERIALS_COMPANY_ACCOUNT_KEY`；未设置时保持 403（reason `company-view-unavailable`），**不拿本人键冒充**。

## P2-A 合入（`83edbb8`）：桌面拉起素材服务

- 新模块 `apps/desktop/src/material-service.mjs`：`startMaterialService({checkout, entry, credentials, port:0, origins, sessionMode:'hmac', secret:randomBytes(32).hex, …})` → `{origin, secret, port, stop, kill, child}`；端口从子进程 `[materials-api] ready … port=<n>` 读回（**不硬编码、不预探端口**），失败一律 `MaterialServiceError`（`spawn-failed | health-timeout | start-timeout | credentials-missing | port-in-use | refused:<code> | exited:<code>`），message 带原因不带栈。
- 三处必停：`before-quit`、`runStudio` 开头（Studio 重启先停旧服务）、`process.on('exit')`；`stop()` 幂等。
- 打包：`release.mjs` 把 `apps/api` 复制进 stage（排除 `*.test.ts`/`node_modules`），`files` 增 `apps/api/**/*`，`asarUnpack` 增 `apps/api/**`（plain node 子进程读不了 asar），入口走 `resources/app.asar.unpacked/apps/api/src/main.ts`。
- 实测（dev `83edbb8`）：`material-service.test.mjs` 9/9；桌面套件 **609 / 604 通过 / 0 失败 / 5 skip**；`pnpm typecheck` exit 0。

**一条更正**：有 Agent 报「task-10 素材中心 UI 的未提交成果已丢失」。核查为**误判**——该批成果已由 Lead 提交为 `f517966` 并合入 dev（`git merge-base --is-ancestor f517966 dev` = 0；dev 树内 11 个素材中心文件、磁盘上存在）。删除工作树只移走目录，提交仍在仓库里。不重做，只更正记录。

## P2-B 合入（`a035cea` → `f8dfb0f`）：一个素材库，两种来源

- 去掉 cloud/local 两个 tab 与两套列表：本地（项目 `assets/` 经 `api.files`）与云端（`material-center` 行）映射到**同一个条目模型**，由**同一个卡片组件**渲染，**同一套筛选栏**承载两侧维度（云端分类/标签/状态/作者 + 本地分组/类型/工程）。
- 来源过滤 `全部/本地/云端` 取代 tab，默认 `全部`；切来源**不产生任何请求**（有断言）。
- **封面懒加载**：`LazyCover` + `createCoverGate` 用 `IntersectionObserver`，进入可视区才打开 `img src` 一次；无 IO 则一个都不请求（fail-closed）；`coverUrl` 原样透传，组件内禁止出现 `http(s)://`/`cdn.`/`/cover/`（no-raw 扫描），无下一页预取。
- 云端服务 501 时：本地半区照常可用，云端维度 `disabled` 并把原因写在控件上（`data-disabled-reason`），不整体报错。
- 实测（dev `f8dfb0f`）：UI 套件 **754 / 754**（我这条命令覆盖 lib+components；该 Agent 自己的口径 784/784 含 editor）；`pnpm typecheck` exit 0。

**取用链路的唯一缺口（已定位，正在补）**：`onUseMaterial` 仍由宿主提供，`MediaPool`/`StandaloneWorkspace` 未实现，所以嵌入式界面点“使用/下载”会提示“还没有接上处理方”。

**设计决定（避免造新的写入通道）**：下载 = `apps/api` 的 `POST /api/materials/raw`（唯一触发 `query/raw`、恰好一次、落 staging、限大小、host 白名单）→ Studio server 代理后调用**既有** `files/bring`（`bringIn(project.path,'assets',[path],'copy')`）→ UI `relist()` 后该文件以本地条目出现在同一个库里。这样写入仍走原生机制（命名/provenance/relink 规则不变），不发明第二套落盘路径。

## P1-B 合入（`9410fde` → `97f1dbf`）：代理与懒加载缓存

- `materials-proxy.mjs` 负责转发并签名：`canonical = "v1\n<principal>\n<METHOD>\n<path>\n<query>"`，`HMAC-SHA256(MATERIALS_SECRET)` 小写 hex；`principal` = base64url(`{environmentId,subjectId,instanceId,epoch,exp}`)，`exp = floor(now/1000)+60`（秒），UUID/非空/正整数任一不符即 403 `authentication-required` 且不出网。
- **`x-materials-secret` 与 HMAC 并存**（决定保留）：secret 证明“这一跳来自本机 Studio 进程”，HMAC 证明“委托人是谁”，两层门。
- 页面自带 `x-materials-*` → **403 `material-page-header-refused`**，在缓存与网络之前拦下（0 次上游调用）。
- 缓存：`<cacheRoot>/materials/meta/<sha1>.json`（list 15min / 字典 24h，陈旧先给 + 单飞后台校验，失败不覆盖）、`cover/<id>.bin|.type`（**只在被请求时取**，命中回 `immutable`），512MB 可注入按 mtime LRU，`POST /api/materials/cache/clear` 需登录。`cacheRoot` 只来自隔离档案；无隔离/缺 env 则不建 service（维持 501）。
- 反证（均已钉死）：未请求封面 → 上游 0 次且 `cover/` 空；列表 1 次、换序复问 0 次；TTL 后先旧体再 1 次后台；`raw`/`download` 四种写法 404 且 0 次；上游 403 `authorization-denied` 原样透传不缓存；超时 504。
- 实测（dev `97f1dbf`）：`material-proxy.test.mjs` + `material-center-routes.test.mjs` **24/24**；agent 侧 `tsc -p studio/server` exit 0。

**仍未合的全量验证**：`studio/server/*.test.mjs` 全量（会起真服务器、耗时长）本轮**未跑完**，只有定向用例通过——不得据此宣称“服务端全绿”。

**下一步（并行）**：①`POST /api/materials/raw` 代理 + 复用既有 `files/bring` 落 `assets/`；②宿主 `onUseMaterial` 接线（`MediaPool`/`StandaloneWorkspace`），单击单飞、失败分类提示、首点前提示“会真实下载一次并计入下载次数”。

## raw 端点合入（`e0f8120` → `065085d`）

- `POST /api/materials/raw`，body `{videoId, videoType?}`（缺省 1、0..4）；**整条路由 2 次供应商调用**：`video/list?videoIds=&pageSize=1` 取作者做授权（不计下载）+ `query/raw` **恰好 1 次**；越权/畸形在 `query/raw` 之前就拒。
- **host 白名单在取到 URL 之后判**：那次 `query/raw` 已发生，但 **CDN 0 次、staging 无文件**——这条必须写进契约，否则会被误读成“越权也会下载”。
- 落盘 `raw-<sha256(videoId)[0..32]>.<ext>`，扩展名只认 mp4/mov/mkv/webm，`wx` 写入，失败/超限删半成品；响应 `{path,bytes,sha256,name}`（本机 staging 路径，不含供应商 URL/token）。
- 新 env：`MATERIALS_STAGING`（必填）、`MATERIALS_RAW_HOSTS`（缺省=全拒）、`MATERIALS_RAW_MAX_BYTES`（默认 512MiB，上限 8GiB），错误码见契约 §8.7。
- 实测：`apps/api` **104 / 104**（dev 复跑）；`pnpm typecheck` exit 0。
- 追加要求（进行中）：body 扩 `videoType`，避免其它类型素材被误判 `video-not-visible`；新增 3 条用例（命中/不命中/非法值）。

## raw 代理合入（`215c328` → `d42ec5a`）

- `POST /api/materials/raw` 在 Studio 侧：校验 body（`videoId` 非空 ≤64；`videoType` 0..4，非法 422、上游 0 次）→ 签名转发上游 → 拿 `{path,bytes,sha256,name}` → 调**既有** `bringIn(project.path,'assets',[path],'copy')` → 200 `{landed,sha256,bytes}`。
- **默认工程**：body `projectId` → 否则 Studio 最近 `/opened` 的工程（新增 `openedProjectId`，挂在既有 opened 处理点）→ 否则 404 `project-not-found`（上游 0 次），**不猜**。
- 落盘失败 → 500 `material-raw-land-failed`，响应体不含 staging 路径/供应商 URL/token，并 best-effort 删 staged 文件（失败只记一行，不改响应码）。
- 测试口径按契约 §8.7：只断言“对本代理上游 `/api/materials/raw` 恰好 1 次”，**不**把 api 内部的两次供应商调用算进来（那是另一个进程）。
- 反证保持：未请求封面 → 0 次且 `cover/` 空；列表 1 次、命中 0 次；`download`/`video/query/raw` 404 且 0 次；未登录 → 403 且 `bringIn` 0 次；同 videoId 并发两次 → 项目内该文件只剩 1 条。
- 实测（dev `d42ec5a`）：`material-proxy.test.mjs` + `material-center-routes.test.mjs` **31/31**。

## UI 取用接线合入（`44fa093` → `1834a34`）

- 两处宿主（`MediaPool`、`StandaloneWorkspace`）都接 `onUseMaterial`；`POST /api/materials/raw`，body `{videoId, videoType?}`（卡片有类型就带上，避免被误判 invisible）。
- 交互：单击单飞（连点两次只 1 次请求，测试钉死）；成功后 `relist()` 使条目变本地；失败分类为**未接通 / 无权 / 超时 / 过大或类型不支持（隐藏重试）/ 未知（附代码）** 并给一次重试；首点前一次性提示“会真实下载一次并计入供应商下载次数”，按会话记住。
- 实测（dev `1834a34`）：UI 套件 **764 / 764**；`pnpm typecheck` exit 0。

## `studio/server` 全量套件的真实结论（不再用定向结果冒充全绿）

跑满 86 个文件后出现大量失败，逐项定性如下（**不是本轮引入**）：

1. **多数失败是环境前置缺失**，典型证据：`desktop-auth-entry.test.mjs` 在第 9 行 `path.resolve(undefined)` 直接抛 `ERR_INVALID_ARG_TYPE`——它要一个显式 env 根，没给就在导入期失败，根本没跑到断言。
2. **`server.test.mjs`（起真服务器，50 条）**：默认 PATH（无 ffmpeg）→ **45 通过 / 3 失败**；把 `D:\dev\7d\bin` 加进 PATH 后 → **47 通过 / 2 失败**（音频转 WAV 那条转绿）。剩余 2 条分别是「网页海报/帧需要浏览器」与「重代理片段」——前者缺 Chromium，后者 30s 级耗时。
3. 其余失败集中在 FCP 音频配对、ASR、海报绘制等**与素材中心无关**的域，且都要外部工具/模型。

**结论（必须如实沿用）**：
- 与本次改动直接相关的面是绿的：`material-proxy` + `material-center-routes` **31/31**、`apps/api` **107/107**、UI **764/764**、`pnpm typecheck` 0。
- **「`studio/server` 全量通过」这一门仍未取得**，失败可归因于环境前置（ffmpeg/Chromium/显式 env 根），但**没有逐文件建立基线对照**，因此也不能宣称“全是既有失败”。
- 复现前置：`PATH` 需含 ffmpeg/ffprobe；多条用例需 `ORANGE_TEST_ROOT`、`ORANGE_FISSION_EXPORT_ROOT`/`PLAN`、`ORANGE_LOCAL_DRAFT_SAMPLE` 等显式根。

## 公海下载落点：调研结论（2026-11-12，两轮只读调研 + 源码复核）

**结论**：不新造素材池，用原生 `Saved`（`~/Movies/OpenFilm/Saved`，`saved/` 前缀，媒体面板与 `assets/` 同方式显示）。下载只落库、不碰工程；用到工程走原生 `takeSaved` → `importFile`（sha256+大小+同名 内容去重）。

**R2 落盘形状**：`Saved/云素材/<videoId>.<ext>` + `Saved/云素材/.meta/<videoId>.json`（点目录被 `listLibrary` 忽略且不递归）。禁止：素材夹内 `saved.json`（整夹变 bundle，其余文件不再列出）、与媒体同名的裸侧车（会单独成条目且可被取进工程 assets）、点开头的媒体名（仓库唯一忽略约定就是 `.` 前缀，媒体会消失）、`.film`、符号链接、含 `: * ? " < > |` 或以点/空格结尾的名字。不采用“整库一个 bundle”（写非原子、取一条全量复制、group 不可预览、每次下载重写同一 JSON 无锁）。

**R2 附带发现（性能/正确性）**：`listLibrary` 对每个条目都 `.catch` 兜底，坏文件不会让 `GET /api/saved/files` 整体失败——所以我们**不能靠“接口没报错”判断落盘正确**，必须断言“列表里恰好出现这一条且形状正确”。

**待补**：R1（`saved` 放行需要什么身份判定、是否按账号分命名空间、是否影响 `LibraryDrawer`）仍在进行；P0-A/B/C/D 四条修 bug 并行进行中。

## 公海下载：P0 三个 bug 清零 + R1/R2 调研定稿（dev `f64504b`）

**P0 合入（三个真 bug）**
1. `7ab5417`（P0-A，`apps/api`）：staging 名改为 `raw-<sha256(videoId)[0:32]>-<rand6>.<ext>`，消除同 videoId 二次下载的 `wx` EEXIST；写流 `'error'` 全部捕获（写错 500 `staging-write-failed`、读/网络 502 `raw-download-failed`），**进程不再因流错误退出**；清理责任显式化（成功后由 Studio 落定并调 `discardStaged`）。`apps/api` **110/110**。
2. `49625d5`（P0-B，`apps/desktop`）：补传 `MATERIALS_STAGING`，按三种运行形态派生（源码树 `.dev/staging`、隔离 `cache/material-staging`、打包 `userData/material-staging`）；缺失自动创建；失败 `staging-unavailable` 只记一行、不影响窗口。桌面套件 **617/612/0/5**。
3. `f64504b`（P0-C/D，`studio/ui` + 代理测试）：下载请求**不再带 `projectId`**（与工程解耦），`project-not-found` 改判 `unavailable` 并给专属文案；**修掉一条假绿测试**——原“连点两次只剩 1 条”依赖 fake land 的 Set 去重，现按真实 `bringIn` 语义断言两次点击=两次下载=两个文件（`abc.mp4` 与 `abc 2.mp4`），把去重责任明确划给库层（videoId）与 `importFile`（内容哈希）；把 fake 改回旧行为该用例**立刻变红**（已验）。UI **765/765**、代理 25/25、typecheck 0。

**R1 结论（`saved` 放行）**
- `assertActive()` **不够**：只证明“某账号在”，不证明“库是谁的”；单独用它放行 = 本机任意登录账号读同一份机器级目录，正是 `server.mjs:312-314` 禁止的“静默当公共”。
- 正确判定 = 会话证据 `(environmentId,subjectId)`/`windowScope()` + **库归属记录**（与 `orange-project-owners.json` 同构），在 **四处**各判一次：`server.mjs:468`、`:1085`、`:1108`、`pages.mjs:188`（`'\0saved'`）；长操作前后复判。失败码：无会话 403、有会话无归属 503（**不默认放行**）、属他人 403。
- **不要**加账号子目录（会改 `rel`，破坏 `takeSaved:350` 的落点语义）。要硬隔离就换根。
- **必须同批修 `pages.mjs:188`**，否则放行后 Saved page “能列出、不能播放”。
- 两个附带事实：该库**今天就已可写可读**（`/api/projects/<id>/saved`、`/saved/take` 不在 503 名单），放行 `/api/saved` 只是补上“能看见列表”；且 `/api/saved` 与那份 503 名单**零测试覆盖**，需随批补固定断言。

**R2 结论（落盘形状）**：见契约 §9.1。要点：`Saved/云素材/<videoId>.<ext>` + `.meta/<videoId>.json`；禁止素材夹内 `saved.json`、同名裸侧车、点开头媒体名、`.film`、符号链接、非法字符；不做单 bundle。

**下一步（并行）**：P1-A 服务端（放行 + 落库 + videoId 判重 + 同批修 media origin），P1-B UI（三来源 + 两动作）。

## P1-A 合入（`e91c5db` → `2e3a6c7`）：下载落 Saved，归属按人

- **放行 `saved`**：从 `server.mjs:311` 的 503 名单移除；四处接入归属判定（`/api/saved` 段首 `:485`、写入库 `:1103/1108/1125` 前后 fence、`saved/take` `:1130/1132/1134`、`pages.mjs:194-198` 的 `'\0saved'` 页），判定依据 = 会话 `(environmentId,subjectId)`/`windowScope` + **归属记录** `<studio home>/orange-saved-owners.json`。失败码：无会话 403 `authentication-required`、有会话无记录 503 `saved-ownership-required`、他人 403 `saved-access-denied`。
- **认领**：库空且未认领 → 首个登录会话自动认领；库非空 → 仍 503，须 `POST /api/saved/claim` 且带 `{"confirm":"claim-existing-library":true}`（缺则 400），防止误点吞掉别人的库。
- **`raw()` 落 Saved**：`Saved/云素材/<videoId>.<ext>` + `.meta/<videoId>.json`（点目录，列表忽略）；不再读 `projectId`；**先按 videoId 判重**，命中 `reused:true` 且 `query/raw` 0 次；落定后 `discardStaged`。
- **侧车 v2**：`{version:2, videoId, videoType, sha256, bytes, subjectId, providerAccountKey:null, takenAt}`。修掉了 v1 把“会话 subjectId”写成 `accountKey` 的语义错误；`providerAccountKey` 待上游补字段后才填。
- **videoId 收严**：`^[A-Za-z0-9_-]{1,64}$`；`v.1`/`v/1`/`..`/`../v1`/`v 1`/`a\b`/空串 → 422 且上游 0 次（防路径穿越）。
- 实测（dev `2e3a6c7`）：四文件合跑 **38 / 38**；`tsc -p studio/server` exit 0。

**新发现的环境前置（第三个同类陷阱）**：`saved-library-ownership.test.mjs` 与 `installed-services-boundary.test.mjs` 需要 **`ORANGE_SERVICES_TEST_ROOT`**；不设时在导入期就抛 `explicit owned test root required`（不是断言失败）。此前已知还有 `ORANGE_TEST_ROOT`、以及 `PATH` 需含 ffmpeg/ffprobe。这三个变量/前置不齐时，测试表现是“红”，但原因不在产品代码。

## 账号名核对（只读，不消耗下载次数）

用产品同一套签名规则直连 `/openapi/account/list`，两个写法各按 `account` 与 `name` 两种字段精确匹配：

| 候选 | 字段 | 返回行数 | 精确命中 | accountKey sha 前 8 位 | state |
|---|---|---:|---:|---|---|
| `zhangqingyuan` | account | 0 | 0 | — | — |
| `zhangqingyuan` | name | 0 | 0 | — | — |
| **`zhangqinyuan`** | **account** | **1** | **1** | **`21b9aafa`** | **1** |
| `zhangqinyuan` | name | 0 | 0 | — | — |

结论：**账号精确写法是 `zhangqinyuan`**（比口述少一个 `g`），且 `accountKey` 指纹 `21b9aafa` 与此前 D1 首读回执一致（可复现）。`name` 字段在这里匹配不到，账号解析必须走 `account`。

冒烟将使用 `zhangqinyuan`；不自动改用其它写法。

## 真机冒烟（第一轮）：被一个真实互操作 bug 卡住（未通过）

目标：真实账号 `zhangqinyuan` → 一次真实 `query/raw`（只花 1 次下载）→ 落 `Saved/云素材/` → 第二次点击验证 0 次上游。

**结论：未通过。** 第一次下载就被 `apps/api` 拒绝：`403 authentication-required`（"需要已校验的本人身份"），**没有任何素材被下载，下载计数未消耗**。

已排除的因素（都是在 dev `f64504b` 上实测）：
1. 内层 secret 门是通的——用错 secret 会得到 `internal-auth-required`，用对 secret 才进到 `authentication-required`；
2. **同一 verifier 在隔离调用里接受同一组输入**：直接 `import` `apps/api/src/session.ts` 的 `createHmacVerifier({secret})` 并喂同样的 `{method,path,query,principal,signature}` → **返回 session 成功**；
3. 用**应用自己的** `signRequest()` 生成签名（不是手算）→ 真实进程仍 403；
4. principal 形状合法（键集排序、UUID、`exp=now+60`），Studio 侧发出的签名用同 secret 复算一致（`signatureMatches:true`）。

因此差异只可能在**真实进程内传给 verifier 的输入或密钥**（`path`/`query` 的字节、时钟单位、或进程内 `secret` 与 `internal.secret` 不同源）。已把复现证据交给 `apps/api` 的作者定位，并要求补一条**跨实现回归测试**（`signRequest` → 真实 HTTP → 必须过会话门）。

**冒烟的诚实状态**：`apps/api` 直连层面 110/110 通过、Studio 侧 38/38 通过、UI 772/772 通过，但**真实账号端到端一次都没跑通**；这正说明“单测全绿 ≠ 接通”。下载计数目前仍是 0 消耗。

## 真机冒烟（第二轮）：逐层挖到第四层，仍未通过

按“每次只前进一层”推进，已经确认并修掉的三层，加上正在修的第四层——**全部是真实进程 + 真实供应商**上的现象：

| 层 | 现象 | 根因 | 处置 |
|---|---|---|---|
| 1 | `403 authentication-required` | `principal.environmentId` 必须**等于凭据文件里的 `environmentId`**（`zhishang.ts:85` 的 `current()` 比对）；我自造 `smoke-env` 必被拒 | 改成取凭据值，**通过**；契约 §9.2 记录 |
| 2 | 该 403 **不打印** `MATERIALS_DEBUG_SESSION` 诊断 | 被拒发生在 verifier **之后**（transport 第二道门） | 认知修正：**日志沉默 ≠ 没被拒** |
| 3 | `403 authorization-denied`（公海素材） | `raw.ts` 的 `authorize()` 写死 `decide({kind:'own'})`，只认“作者＝本人” | 已改为 body 可带 `scope`，配公司键时默认 `company`；`apps/api` 120/120 |
| 4 | 真实 id → `422 invalid-query`；假 id → `503` | 真实行 **`videoState` 是对象**（探针实测 `stateType=object`），解码器按字符串假设 → 解码失败 → 又被错误映射成 `invalid-query` | 已派修：解码接受真实形状 + 解码失败改映射 `provider-response-unconfirmed` |

**下载计数仍是 0**（三支样本 `downloadCount=0`，只读复核）——至今没有任何一次 `query/raw` 被计入，那 1 次授权下载**尚未消耗**。

**教训（写进规矩）**：`invalid-query` 只能表示“调用方参数非法”；把它当作解码失败的兜底码，会把“供应商数据形状与假设不符”伪装成“你参数写错了”，排查代价极高。

## 真机冒烟（第三轮）：第五层已定位，仍未通过

上表第 4 层被作者用真实探针推翻（**解码器没错**），真因是 `invalid-query` 被复用为内部失败兜底：

| 层 | 现象 | 真因 | 处置 |
|---|---|---|---|
| 4′ | 真实 id → `422 invalid-query` | 供应商 `code=20000`（它拒绝*我们*的请求）与 `signZhishang` 失败都被映射成 `invalid-query` | 已改为 `provider-response-unconfirmed`(502)；`invalid-query` 只保留给调用方参数。`apps/api` **123/123** |
| 5 | 映射改正后 → `502 provider-response-unconfirmed` | 供应商 `code=20000` 的 info 明确是 **`[accountKey]不能为空`**：我们某次出网调用**没带 account_key** | 已派修：查 `raw` 授权链里 `decision.accountKey` 何时为空；并要求**任何出网请求必须带非空 account_key**，为空时在出网前 403，不得发出裸请求 |

**供应商契约实测（只读，未调 `query/raw`）**：
```
{pageNo,pageSize,isInner,videoType}                     → 20000 [accountKey]不能为空
+ account_key                                           → code=1 rows=1
+ videoIds:"33777574"（无 account_key）                  → 20000
+ account_key + videoIds:"33777574"                      → code=1 rows=1   ✅
+ account_key + videoIds:["33777574"]（数组）            → 20015 sign错误
```
→ `videoIds` 必须字符串；`account_key` 必填。

**下载计数仍为 0**（`downloadCount=0` 复核）。至今未有任何一次 `query/raw` 计数。

**方法论结论（最重要的一条）**：这五层没有一层能被单测发现——`apps/api` 123/123、服务端 38/38、UI 772/772 全绿时，真实账号第一次点击仍然错。原因是**测试 fixture 与真实供应商形状/契约不一致**，而错误映射又把内部故障伪装成参数错误。改进：以真实供应商响应为 fixture 基线（已脱敏入库），并禁止复用 `invalid-query` 作为内部兜底码（已在契约与代码注释中固化）。

## 真机冒烟（第四轮）：第六层——`query/raw` 缺 `isInner`

用外部 fetch 探针（`NODE_OPTIONS=--require .dev/fetch-spy.cjs`，只记形状与 envelope）抓到真实出网序列：

```
auth/access_token  code=1     success=true
video/list         code=1     success=true  dataKeys=list|pageNo|pageSize|total|totalPage
video/query/raw    code=20000 success=false info="[isInner]不能为空"
```

`account_key` 三处均存在。结论：**`query/raw` 的 body 必须 `{videoId, isInner:0}`**；只发 `{videoId}` 会被供应商判 20000，而我们把 20000 映射成 502，于是表现为“供应商响应无法确认”。

下载计数仍为 0（`query/raw` 从未成功，供应商未计数）。

**方法论追加**：读代码到这一步已经不够——探针（拦截出网并打印 envelope）比继续猜快一个数量级。该探针已留在 `.dev/fetch-spy.cjs`，探针不打印密钥与媒体内容。

## 真机冒烟（第五轮）：**通过**（并推翻了“下载次数会 +1”的假设）

### 结果（真实账号 `zhangqinyuan`、真实供应商、真实落盘）

```
first  download  200 {landed:"saved/云素材/33777574.mov", reused:false, bytes:13755197, sha256:bd6a6989…}
Saved/云素材/     file 33777574.mov   +   dir .meta/
.meta/33777574.json  {version:2, videoId, videoType:1, sha256, bytes, subjectId, providerAccountKey:null, takenAt}
second download  200 {landed:"saved/云素材/33777574.mov", reused:true, 与首次同 sha256/bytes}
upstream raw calls: 第一次 1 → 第二次仍 1（**没有第二次出网**）
RESULT: files=1  firstReused=false  secondReused=true  upstreamCalls=1
```

文件实体校验：`ffmpeg -v error -i … -f null -` **exit 0**；`ffprobe` = `hevc 1920x1080 9.105s`，13.12 MB。

### 推翻的假设（重要，已影响 UI 文案）

冒烟前、冒烟后两次只读复核 `video/list`：`downloadCount` **始终为 0**（三支样本全是 0）。也就是说**这次真实下载没有让供应商的下载计数 +1**（至少该字段不变）。所以：

- UI 里那句“会真实下载一次并计入供应商下载次数”**目前没有证据支持，必须改口径或改文案**；
- 我们之前“同一素材只花一次下载计数”的说法，**在计费意义上不成立**（能省的是带宽与耗时，不是计数）；
- 计数是否异步、是否只在供应商自有客户端里累加、是否有独立计数字段，需要供应商侧确认——**不能猜**。

### 仍未由本冒烟覆盖
- 「加到当前工程」（`takeSaved` → `importFile` 内容去重）：由服务端单测与 UI 集成测试覆盖，本轮**没有**用真实工程跑；
- 桌面应用内的真实点击路径（本冒烟用的是真实 `apps/api` + 真实代理 + 真实 Saved，但没起 Electron 窗口）。

## 桌面素材库接通：两处断链（一个已修，一个在修）

**断链 1（已修，`b16a864`）**：桌面把素材服务的 `{origin, secret}` 拿在手里，**从未传给 Studio 进程**，而且素材服务是在 Studio **之后**才启动。而 Studio 侧 `materialsServiceFromEnv` 只在 `MATERIALS_UPSTREAM` 与 `MATERIALS_SECRET` 都存在时才构造 service，否则 `null` → 三条路由恒 **501**。

修法：新增 `studioMaterialEnvironment(service)` 与 `startStudioBesideMaterials({env, materials, launch})`；`main.mjs` 改为 `stopMaterials()` → 先起素材服务 → 把它并入 Studio env → 再 `startStudio`；重启走同一路径，因此每次都带新 env。素材服务起不来时 Studio 照常启动、不带 upstream（保持降级）。
实测：`material-service` + `material-studio-env` **22/22**；桌面套件 **622 / 617 通过 / 0 失败 / 5 skip**；typecheck 0。
顺序断言：`the service is up before Studio is built, and Studio is handed its environment`（`order === ['materials','studio']`）。

**断链 2（在修）**：`server.mjs:146` 的 cache 只在**隔离运行**时创建；普通运行（无 `OPENFILM_ISOLATION_*`，即打包桌面的常态）`cache=null` → service 仍为 `null` → 依旧 501。已派修：cache 根按「隔离 cache → `MATERIALS_CACHE_ROOT` → `studioHomeDir()/material-cache`」解析，并要求保持“缺 upstream/secret 时仍为 null”的回归。

**推论（必须记住）**：真实桌面能不能用素材库，取决于**这两个 env 与 cache 根三者同时成立**；任何一条断掉，UI 都显示“素材服务未接通”，而这不是 UI bug。

## 计划定稿：素材库可用性 + 绑定 + 成果上传（2026-11-13）

**G1** 素材库在真实桌面可用（无 bindings 也能浏览/下载公海）；**G2** 用户认领一次云管家账号（不需登录云管家）；**G3** 成果可上传云管家（URL 回传 + import + 轮询）。

**关键事实（本轮实测）**
- `access_token` 是公司级、**无用户字段**；用户身份由请求头 `account_key` 显式给出（8.1/8.8/8.10 必填）。
- `8.10 视频导入` **只收 `url`**（云管家下载），**无文件上传接口**；导入 body 无 `isInner`。
- 双地址族：`isInner=0` → `szy-hlcxy-sucaiwang.sucaicloud.com:9001`；`isInner=1` → `szy-hlcxy-sucaiwang-inner.sucaicloud.com`（**192.168.10.10**，私有）。
- 本机：在线 `192.168.110.35`；`192.168.10.170/24` 在**已断开**网卡；**无 VPN 适配器、无代理、无 192.168.10.0/24 路由**；公网 443 可达、内网 9 端口全不可达。
- 真机（V1）：素材服务 `refusing: bindings-unreadable` → 全链 501；云端半区把 **401** 显示成 `internal-error`。

**波次**：P0（M1 绑定可选 / M2 401 分层，并行）→ P0.5（V1 真机复跑）→ P1（绑定表+接口+UI，并行）→ P1.5（`MATERIALS_IS_INNER` 三处透传 + 内网不可达明确错误）→ P2.0（上传通道实证，**需批准写操作**）→ P2（上传实现）→ P3（验收 + `downloadCount` 复核）。

## P0 完成（`d0432b4`）：真实桌面的两处硬阻塞已修

| 缺陷 | 修法 | 实测 |
|---|---|---|
| 绑定文件缺失 → 素材服务**启动即拒** → 全链 501 | **缺失=空表启动**（一行日志 `bindings absent: own and account scopes unavailable`）；**畸形仍拒绝启动**；`own`/`account:*` → 403 `self-binding-required`，不回退公司视图 | `apps/api` **132/132** |
| 401 被显示成「读取失败（internal-error）」 | 错误分层补 401 → `authRequired`（新增文案）；501→`unavailable`；其余 403→`unauthorized`；`provider-*`→`providerFault`；**三处使用点（列表/下载/加入工程）共用同一映射** | UI **775/775** |

**「缺失 vs 畸形」判定表**（已固化）：未设置=缺失；指向不存在文件=缺失；JSON 畸形/键集非法=`bindings-invalid`；目录/符号链接=`bindings-unreadable`；越出 `MATERIALS_ALLOWED_ROOT`=`bindings-outside-root`。后三者 exit ≠ 0。

**内部调整**：`providerBindingFor` 增加 `fallbackAccountKey`——某 subject 无条目时用公司键合成 binding（**纯簿记**，不改授权；空表下 `own`/`account:*` 到不了 transport）。

**下一步并行**：P0.5 真机复跑（V1，无需 bindings）；P1-A 服务端绑定表与三接口；P1-B UI 绑定入口与未绑定态。

## P1 合入与一次我造成的破坏（已回滚）

**已合入 dev `46d5bb1`**
- **P1-A 绑定（`3c63ce4`）**：`MATERIALS_BINDINGS_MODE=server|local`；`POST/GET/DELETE /api/materials/binding`；`POST` 只收 `{account}`（精确匹配；只给 `accountKey` → 422，因服务端无法验证任意 key）；绑定文件形状扩为 `{version,bindings{…,account,teamId,groupId,boundAt,status},history[]}`，旧形状兼容、未知键仍拒；**原子写（wx+rename、0600）+ 进程内串行队列 + 写失败回滚**；`local` 模式写请求 409 `binding-store-readonly`、无文件时 503 `binding-store-unavailable`。`apps/api` **142/142**。
- **Studio 代理补 `binding`（`46a4bd9`）**：`GET/POST/DELETE` 三方法签名转发上游；body 只许单键 `account`（1..64），多键/空/超长 → 422 且 0 次上游；上游 400/401/403/501 原样透传；页面自带头 → 403 且 0 次。四文件 **47/47**。

**我造成的破坏（如实记录）**：为让「公司视图」可用，我直接把 `accountKey` 写进了忽略区凭据文件；但 `credentials.ts` 的 `REQUIRED/OPTIONAL` 白名单里没有这个键，`apps/api` 会以 `configuration-required` **拒绝启动**。**已立即回滚**（文件恢复为 `environmentId,companyKey,companySecret,origin,note` 五键）。正确做法已派给 `apps/api` 作者：白名单增加 `accountKey` 并实现 `env > credentials.accountKey > 无` 的回退，之后才能重新写入。

**顺带确认**：`codex/p1-companykey` 只落了“绑定/认领”那半，**公司键回退未落地**，所以真机的 `company` 仍会 403 —— V1 已待命，等这一半合入后再跑。

## 403 显示成「读取失败（internal-error）」的根因（`e562ff5` → `6da2971`）

**不是文案分支顺序问题，是 status 在链路里被丢掉了。**

`controller.failureOf` 原实现是「status 与 code 要么都在、要么一起丢」的全有全无兜底：只要缺一项，就把两者替换成 `{status:500, code:'internal-error'}`。于是 `failureCopy` 既拿不到 403 也拿不到 `authorization-denied`，落到 `error` —— 真机看到的正是那句「读取失败…（internal-error）」。

**修法（根因 + 文案两层）**
1. `failureOf` 独立取字段、**绝不吞真实值**：`code` ← `error.code` → `error.body.code` → 兜底 `internal-error`；`status` ← `error.status` → `error.response.status` → 由拒绝码推断（`authorization-denied`/`origin-rejected`→403、`authentication-required`→401）→ 兜底 500；
2. `failureCopy` 权限档改为 **status 或 code 任一命中** → `unauthorized`；401 仍 `authRequired`、501 仍 `unavailable`、`provider-*` 仍 `providerFault`；
3. `classifyFailure`：任何 403（含 body 读不出 code）进 `unauthorized` 屏；401 保持“error 屏 + authRequired 文案”，避免两句话同时出现。

**测试**：`{403,authorization-denied}`、仅 code、仅 status 三形态都 `=== unauthorized` 且 `!== error`；controller 级四形态（正常/仅 code/仅 status/仅 body.code）均落到「当前身份没有查看权限」；UI **786/786**、typecheck 0。

**教训（写进规矩）**：错误对象在层间传递时，**任何“全有全无”的兜底都会把真实原因替换成通用码**；要么独立取值，要么显式保留原对象。

## 公司键回退与 raw 计数（`d167a96` → `5078a65`）

- 解析顺序：`MATERIALS_COMPANY_ACCOUNT_KEY`（env 非空优先）→ **`credentials.accountKey`** → null；日志只打 `company view: env|credentials|none`，**不打键值**。
- `credentials.ts` 的 `OPTIONAL` 增加 `accountKey`（未知键仍拒；非法值 → `company-key-invalid` exit 2）。**此前我把这个键写进凭据文件却没进白名单，导致 `apps/api` 会拒绝启动——已回滚，现随本笔正式支持并重新写入。**
- 同路径真 bug：transport 的配置校验要求**恰好**三字段（companyKey/companySecret/environmentId），把带 `accountKey` 的整个对象传进去会 `configuration-required`；现只传三字段。
- `raw` 成功日志增加计数：`[materials-api] raw videoId=<id> bytes=<n> count=<k>`（进程内累计，从 1 起；不打印 URL/路径/键值）——用来替代对子进程无效的 fetch-spy。
- 实测：`apps/api` **147/147**，`pnpm typecheck` 0。

**V1 复跑判据**：`company view: credentials` 出现 → `company` 应 200；下载后日志 `count=1`，二次点击 `count` 仍为 1；随后隔 1–2 分钟复核 `downloadCount`（文档称会 +1，此前两次实测为 0）。

## environmentId 混用修复（`763d9e1` → `b7bdc0a`）

**现象（真机，按 scope 分化）**：同一路径同一签名下
- `list`（无 scope / `own`）→ 403 `authorization-denied`（授权层，未绑定）
- `list?scope=company`、`facets?scope=company`、`POST /binding` → 403 `authentication-required`

**根因**：`environmentId` 被当成两个概念——principal 里是**应用环境**（桌面登录 `orange-test-desktop`），凭据里是**供应商环境**（`local-zhishang-probe`）；transport 的第二道门 `current()` 拿前者比后者，不等即 `authentication-required`。`company`/`facets`/`binding`/`raw` 都会走 transport，所以一起被挡；`own`/无 scope 在授权层就拒了，根本没走到 transport——这就是“两种 403”的来源。**我在早前自己的冒烟里踩过同一个坑，当时用凭据值绕过而没修根，这次以产品缺陷形式回来了。**

**修法**：`current()` 只校验**品牌 + 有效期**，不再比较 environmentId；principal 的原值保留供审计；`providerBindingFor(...,{environmentId:supplier.environmentId})` 保持不动（本就是供应商侧配置）。回归用例：`a principal from another application environment still reaches company, binding and raw`（company 200、facets 200、binding 200、raw 200 且 `query/raw` 恰好 1 次；缺签名仍 403）。

**实测**：`apps/api` **148/148**；我用 `environmentId=orange-test-desktop` 的 principal 直连服务 → `list?...&scope=company` **200**、`items=1`、`totalIsProviderTotal=true`、日志 `company view: credentials`。

**V1 撤回的两条（旧产物）**：`ui/dist` 构建于 11-12 11:45、`shell/dist` 19:58，均早于 `binding.ts`(00:17)/`copy.ts`(00:22) → 「页面没有绑定入口」「403 显示 internal-error」按旧产物撤回；HTTP 层结论仍成立。**交付纪律补充：真机验收前必须重新构建（不带 `--no-build`），并记录两个 dist 的时间戳。**

## P0.7 真机：绑定与公司视图已通，下载卡在“原片主机白名单”

**产物澄清（V1 用时间戳+内容双证）**：构建前 `ui/dist` 11-12 11:45、`shell/dist` 19:58；本轮重新构建后 **00:32:18 / 00:32:29**，均晚于 `binding.ts`(00:17)、`copy.ts`(00:22)。新 bundle 内含「绑定」「需要登录后才能读取云端素材。」等新文案，**页面确实出现了「绑定」入口** → 上一轮那两条按旧产物撤回。

**已通过**
- `company` 列表 **200**（`layer:public`、`items=1`），日志 `company view: credentials`；
- **绑定 200**：`{account:"zhangqinyuan", accountKey:"ZmzkzO/…", teamId:2549, groupId:16817, status:"claimed"}`；页面显示「已绑定…（已认领）」，**重启后 `bindings loaded count=1` 持久化**；
- 无 403 可观察（两种 scope 都是 200），错误分层本轮无从验证。

**阻塞（P07-1）**：`POST /api/materials/raw {videoId:"34891188",videoType:1,scope:"company"}` → **403 `raw-host-not-allowed`**。根因：`raw.ts` 的 hosts 白名单只来自 env `MATERIALS_RAW_HOSTS`，而桌面启动器只传 8 个键、**不传它** → 白名单为空 → 任何主机都拒。真实原片主机 `szy-hlcxy-sucaiwang.sucaicloud.com`（内网模式为 `…-inner…`）。

**另两处（P07-2/P07-3）**
- 无 scope 的 `list` 走 **own**（`layer:self`、`items=[]`、`filtered{inspected:2,dropped:2}`）——产品语义是「素材全公司可见」，默认应为 `company`；
- 页面在「200 + 0 条」时显示「需要登录后才能读取云端素材。」，属分层错误（非 4xx 不该出现登录/权限文案）。

**已派修**：①`apps/api`：`rawHosts` 支持来自凭据文件（env 优先、无则 fail closed），list 默认 scope 改 `company`；②UI：200+0 且有 dropped → 「已按授权过滤（丢弃 N 条）」+「切换到公司视图」，默认与绑定后都显式 `scope=company`。

**`downloadCount` 仍无法判断**：一次都没下成（0→0）。

## raw 白名单与默认视图修复（`e32480f` + `674cbaf` → `0ecb1b3`）

**白名单（P07-1）**：`MATERIALS_RAW_HOSTS`（env 非空优先）→ **`credentials.rawHosts`** → 空表（拒绝一切，fail closed）。`credentials.ts` 的 `OPTIONAL` 增加 `rawHosts`（未知键仍拒；非法/非数组 → `refusing: raw-hosts-invalid` exit 2；去重、≤16 项）。日志只打 `raw hosts: env|credentials|none count=N`，不含主机值。凭据文件已写入 2 个主机（公网 + inner 变体）。
**默认 scope**：`companyAccountKey` 存在则默认 `company`，否则退回 `own`（避免“已认领但没配公司键”的实例从可用变 403；本部署有公司键，行为与要求一致）。
**UI（P07-2/P07-3）**：200 + `items=[]` + `dropped>0` → 「本页已按授权过滤（丢弃 N 条）」+「切换到公司视图」，**不出现登录/无权文案**；`dropped=0` → 普通空态；默认与绑定后都显式 `scope=company`，仅用户手选才发 `scope=own`；绑定状态读不到时用绑定专属文案（并说明云端目录与当前工程不受影响）。

**我的独立验证（直连服务，真实凭据）**：
```
POST /api/materials/raw {videoId:"34891188",videoType:1,scope:"company"}
→ 200 bytes=4,446,985 name=raw-23593033….mov
log: company view: credentials | raw hosts: credentials count=2 | raw videoId=34891188 bytes=4446985 count=1
```

**门禁**：`apps/api` **152/152**、UI **789/789**、typecheck 0。

## 页面 401 的真因：`credentials: 'omit'`（V1 头部数据 + 代码双向证实）

**现象**：同一页面、同一 URL，页面自己发的请求 401 `{"error":"open Studio from the address `openfilm open` prints"}`，而我手发同请求 200/422（越过了 401 网关）。卡片 0 张，下载无入口。

**头部证据（V1 用 CDP Network 抓的原始头）**
| 请求 | 状态 | Origin | Referer | Cookie |
|---|---|---|---|---|
| `/api/materials/binding`（页面） | 200 | 无 | 无 | 见注 |
| `/api/materials/list?…&scope=company`（页面） | **401** | 无 | 无 | **否** |
| `/api/materials/facets?…`（页面） | **401** | 无 | 无 | **否** |
| 同上 URL + `probe=v1`（手发） | 422 `invalid-query` | 无 | 无 | **是** |

手发那两条之所以是 422，是因为多带了 `probe=` 被查询校验拒 —— **恰好证明它们已经越过了 401 网关**：带 cookie 就过。

**三个假设的判定**：H1 主机名不一致 → **不成立**（页面与请求都是 `127.0.0.1:4757`，同源 fetch 不带 `Origin`）；H2 cookie 时机 → **不是主因**（只差 Cookie 一项）；H3 路由守卫不同 → **不成立**（`binding` 同样路径规则下能过）。

**代码定位**：`ui/src/lib/material-center/client.ts:202` 是 `credentials: 'omit'`，而 `binding.ts:64` 是 `'same-origin'`。Studio 守卫（`server.mjs:242`：`x-studio-key` 头或会话 cookie，否则 401）因此拒掉 list/facets/raw。**一行 fetch 选项造成整页“无权/需要登录”。**

**附带确认**：`open` 会话 cookie 是 **HttpOnly**（`document.cookie` 恒为空），所以判断 cookie 是否在场只能看 Network 原始头，不能看 JS；`studio.log` 里也没有 `openfilm open` 地址行。
**另一个真缺陷**：「重试」点击**不产生新请求**（Network 计数 0 增量）。

## 修复：会话凭证 + 重试（`f60b487` → `19b2dfe`）

1. **`credentials: 'same-origin'`**（`client.ts`）：list/facets/labels 共用这一处；raw/binding 本就是同源。**未用 `include`**（同源足够，cookie 不外带）。测试逐条断言 `=== 'same-origin'` 且 `!== 'omit'`。
2. **「重试」真重发**：根因不是被 `pendingRef` 挡住，而是旧重试**只重发 list**；而云端失败常来自 facets，所以点下去“毫无变化”。现在 `controller.retry()` 重发失败的半边（list 必发、`facetsFailure` 非空时一并重读），进行中的点击返回同一 promise；header 与云端失败条两个按钮统一走它。测试：点一次 +1、再点 +1、并发只 +1、facets 失败时一并重读。
3. **守卫 401 自动重试**：401 且 body 为 `{error}` 且无 `code`（Studio 守卫形状）→ 自动重试 2 次（300ms，可注入），期间显示「Studio 会话未就绪，正在重试…」并**隐藏失败文案**；带 `code` 的 401/403 不重试。测试钉死 3 次请求、回调 `[true,false]`、`true` 在第二次请求之前。

**门禁**：UI **797/797**、`apps/api` **152/152**、typecheck 0。

**方法论（再强调一次）**：同一请求「手动 200 / 程序 401」，第一步永远先比对**请求头差异**（V1 的 CDP 原始头一次定死三个假设），再去看业务逻辑。

## **真机验收通过**（`4982ab5`）：素材库全链路可用

V1 在真实桌面窗口（新产物：ui `00:56:22`、shell `00:56:27`）完成以下五项，全部命中：

| # | 判据 | 实测 |
|---|---|---|
| 1 | 默认卡片 | **20 个卡片按钮**；「云端 20 · 素材库 1 · 当前工程 0」「供应商总数 178975」；**首读一次成功，自动重试 0 次** |
| 2 | 真下载 | 日志 `raw videoId=34891188 bytes=4446985 count=1`；`Saved/云素材/34891188.mov` = **4,446,985 B**（与 bytes 一致）+ `.meta/34891188.json` 255 B |
| 3 | 二次复用 | 「已在素材库：本次没有重复下载」；全轮 raw 行仅 1 条、`count` 仍 1、无重复文件 |
| 4 | 加到工程 | `Projects/P08 素材验证/assets/34891188.mov` = 4,446,985 B；页面「已加入当前工程」 |
| 5 | 我的素材 | `cloud:own` → 「本页已按授权过滤：检查 20 行，展示 0 行，丢弃 20 行」，**无「需要登录」**；API `?scope=own` 200、`dropped 2/2` |

**`downloadCount` 第四次实测仍为 0**（真实下载成功、bytes 已核对、间隔 ~95 秒）。文档 8.8 写“该操作会增加视频下载次数”，我们四次观测都不变 → **UI 里“会计入供应商下载次数”的措辞必须改**；该字段是否异步/是否仅统计自有客户端，需要供应商确认。

**遗留两处（已派修，随 UX 改造一起做）**：①`filteredEmpty` 时「切换到公司视图」按钮未渲染；②下拉值实际是 `cloud:company` / `cloud:own` / `local:<id>`（我之前说成 `company`/`own` 是错的）。

## UX 改造决定（用户提出，已采纳）

现状「整页塞进素材导入」被判定为错误。改为：**侧边栏独立入口「云管家素材」（与素材导入并列）+ 分组卡片 + 点开看组内素材**。分组维度定为**二级分类**（互斥、可算准数量；标签组方案会跨组重复计数，留作后续可选项）。硬约束：首屏只拉分组树（`facets`，24h 缓存），组卡的封面与数量**进入视口才拉**（并发 ≤6、按组缓存），**不允许把首屏请求数放大到组数**。

## UX 重排完成：侧边栏「云管家素材」+ 分组卡片 + 下钻（`c63b728` / `3cf7da7`）

按用户意见，废弃“整页塞进素材导入”，改为：

| 项 | 实现 |
|---|---|
| 入口 | 侧边栏 **「云管家素材」与「素材导入」并列**；点开为 `<aside data-panel="cloud-steward">` 面板，导入面板**不卸载**、行为不变 |
| 分组 | 一级分类=分区标题，**二级分类=组卡**（互斥、数量可算准）；一级下只有一个二级时直接并列（`data-flat`） |
| 组卡 | 组名 + `≥N`/精确数量（未知不显示）+ 2–3 张封面（复用 `LazyCover`，可见才拉）+ 最近更新；**0 条不渲染** |
| 下钻 | 面包屑「云管家素材 / 一级 / 二级」；组内复用同一套卡片（下载/加到工程/分页），list 带 `twoLevelTypids`；**返回不清空筛选** |
| 性能 | 首屏 **facets 1 次、list 0 次**；组卡进视口才拉，**并发 ≤6**，按组会话缓存（二次进视口 0 次） |

**同轮修复**
- 「切换到公司视图」按钮不渲染的真因：条件多了 `&& view.entries.length === 0`，而 own 为空时本地/素材库条目让合并列表非空 → 走普通 filtered 分支。现在只看 `view.filteredEmpty`；
- 下拉文案：「公司素材（全部）」/「我的素材（我上传的）」，值仍 `cloud:company` / `cloud:own` / `local:<id>`；
- **删掉“计入供应商下载次数”的说法**（`purpose`、`useSpendNotice`、`USE_NOTICE` 三处）——因为 `downloadCount` 四次实测均为 0，界面不应承诺观察不到的事。

**门禁**：UI **834/834**、`tsc -p studio/ui` 0、`material-import-interaction` 5/5（导入职责未变）。

## 宿主模式素材入口缺失（真机发现的产品缺陷，已修 `f4385a8` → `f5c0c2d`）

**现象**：桌面 app（host 模式）里素材池不可达。V1 实测：`[aria-label="显示素材"]` = **null**、`[data-action="open-cloud-steward"]` = 0、`localStorage['openfilm.project.assets']` 从未写过（不是“持久化关掉”）。

**根因**（都在 `ProjectView.tsx`）：
- `:2628` `hostAssets = hostPanel?.assets`；
- `:4441` 素材栏 `{!hostAssets && assetsPaneOpen && assetsFit ? mediaPool() : null}` → host 下不渲染；
- `:4484` 「显示素材」按钮 `{hostAssets ? null : <button/>}` → **host 下按钮整个不渲染**；
- `:4909` 素材池改由宿主 `LibraryDrawer` 承载，而宿主侧没有可见控件。

**后果**：新加的「云管家素材」入口（在 `MediaPool` 标题栏）在**交付形态里不可达**——又一个“单测全绿、真实应用不可用”，而且这次在导航层。

**修法**：host 模式下在素材视窗 pane bar（原按钮同一位置）渲染 `data-action="host-assets-toggle"`，`aria-label` 复用 `assetsPane.show/hide`，点击 `hostAssets.setOpen(!hostAssets.open)`；非 host 模式逐字不变；`ProjectLayoutMenu` 的 `assets={null}` 保持（不出现第二个开关）。测试断言该按钮全文件仅一处、位于 layers 开关之前。

**门禁**：UI **839/839**、typecheck 0。

## 装配层缺陷第 4 例：facets 把供应商包装漏给了 UI（`f5c0c2d` 真机后）

**现象**：分组面板显示「分组读取失败，本次结果不作数。」，但 `/api/materials/facets?scope=company&videoType=1` 返回 **200**，一级 81、二级 888，数据齐全。

**根因（我直连服务实测）**：
```
one.id typeof = object
{"id":{"sourceType":"number","source":"271500"},
 "level":{"sourceType":"number","source":"2"},
 "name":"新仓",
 "parentTypeId":{"sourceType":"number","source":"…"}}
```
供应商把每个值包成 `{sourceType,source}`（与视频行里的 `videoId` 同一形态），而**客户端类型契约要求 number/string**。所以不是 UI 太脆弱，是 **`apps/api` 出口没有归一化，违约的是服务端**。

**修法**：在 `apps/api` 出口统一拆包（`facets` 的 `oneLevel/children/states/publicLabels` 与 `labels` 路由），保留 null 语义、不产生 NaN；归一化失败不静默丢，给明确错误码；加**真实形状 fixture** 测试（断言 `typeof one.id === 'number'`）。

**另发现**：`CloudStewardPanel.tsx:25` 把 `scope` 写死 `'company'`，面板没有「公司/我的」开关 → 用户在宿主抽屉里找不到「我的素材」。已派修：加二段式开关，切 scope 时**清掉组卡探针缓存**（不同 scope 的组内数量不同），未绑定时 `own` 禁用。

### 硬规则（新增，写入门禁）
**任何跨边界的路由都必须有「真实形状 fixture」测试**，不允许只用自造的扁平 fixture。装配层缺陷已出现 4 例：

| # | 层 | 缺陷 | 产生原因 |
|---|---|---|---|
| 1 | 传输 | `environmentId` 混用 → 两种 403 | 概念在两个层被同一个字段承载 |
| 2 | 凭证 | `credentials: 'omit'` → 整页 401 | 一个 fetch 选项决定鉴权 |
| 3 | 导航 | host 模式入口不渲染 | 三处 `hostAssets` 联动，单测断言的是源码字符串 |
| 4 | 边界 | 供应商包装值漏到 UI | fixture 是自造扁平形状 |

共性：**单元层全绿，装配层必错**。因此真机窗口冒烟（含导航路径）与真实形状 fixture 是两条必须的门，不能再用“测试通过”替代。

## facets 归一化落地（`46532de` → `41924f2`）

- 新增 `apps/api/src/plain.ts`：`{sourceType:'number',source}` → `Number(source)`；字符串/布尔原样；缺失 → `null`（绝不 `NaN`）；数组按元素展开（`children` 仍是行数组）。
- `materials.ts`：`facets` 的 `oneLevel`（含 `children`）、`twoLevel`、`states`、`publicLabels` 与 `labels` 全部归一化；`labelTotal`/`total` 保持 WireNumber（契约如此）；`list` 不动（§1.2 本就是 wire 形状）。
- **归一化失败 = 502 `provider-response-unconfirmed`**，不静默丢弃——静默正是“分组面板空白”的成因。
- 测试：真实形状 fixture 断言 `typeof one.id === 'number'`、`children[0].id === 271500`、`children[0].name` 字符串、`parentTypeId` 数字；**空 children 的一级分类保留**；`{"id":{"nested":true}}` → 502。

**我的直连验证**：`GET /api/materials/facets?scope=company&videoType=1` → 200，`oneLevel=81`，`typeof one.id=number`、`child.id=number`、`child.name=string`。
**门禁**：`apps/api` **154/154**、UI **843/843**、typecheck 0。

**同轮 UI（`baffec1` → `b185233`）**：分组面板新增「公司 / 我的」二段式开关（`data-action="board-scope"`，`data-scope="company|own"`）；切 scope 重建 board 并**清空组卡探针缓存**（缓存键带 scope 前缀）；未绑定时 `own` disabled + tooltip 且**不发请求**；下钻时 list 同时带 `scope` 与 `twoLevelTypeIds`。UI **843/843**。

## 缓存键缺陷：形状修复被 24h 缓存挡住（`5792da3` → `64dd740`）

**现象**：服务端把 facets 归一化后，**页面拿到的仍是旧包装体**；直连 `apps/api` 是裸值，走 Studio 代理就是 `{sourceType,source}`。表现成“修复无效”。

**根因**：`materials-cache.mjs` 的键是 `sha1(route + params)`，**不含响应形状版本**；而 `facets`/`labels` 的 TTL 是 **24h** 且为 **stale-while-revalidate**（先返回旧答案再后台刷新）。于是任何改变响应形状的服务端修复，最长 24 小时对用户不可见。

**修法**：`SHAPE_VERSION = 2`（`materials-cache.mjs:39`，注释要求“响应形状变更必须 +1”）；键 = `sha1(route \0 shapeVersion \0 params)`；读时 `stored.shapeVersion !== 当前` （含字段缺失的旧文件）→ 当 miss 并 `rm` 该文件再回源；写盘记录增加 `shapeVersion`；文件格式 `version` 与形状版本**分开**。

**测试**：不同形状 → 不命中（且真的再请求上游）；同版本 → 命中（两次 facets 只 1 次上游）；当前键名下放“无 shapeVersion / shapeVersion-1”旧文件 → 都 miss 且文件被删；`clear()` 仍只删 `<root>/materials`。服务端四门 **50/50**、typecheck 0。

**遗留（已知、可接受）**：旧形状条目落在**旧文件名**下，当前读取方看不到，只能等 LRU 或 `clear()` —— 这保证旧形状**永远不会**被当成新答案。

**归类**：这是装配层第 9 例，且性质最隐蔽——**它让“已修复”的代码在用户面前仍然是错的**。规则补充：跨边界形状变化时，缓存键必须同步升级，否则等于没修。

## 分组 UI 真机：分组已通（888 组卡），剩“面板渲染两份”

**缓存实验（V1 验证我的判断）**：`~/.openfilm-dev/material-cache` 里 2 个文件 / 421,207 B；整目录备份后删除 → 重启 → **分组立刻正常**（888 张组卡、一级分区齐全）。随后 `64dd740` 的形状版本键在**未手动清缓存**的情况下也自动生效。

**已 PASS 的判据**
| # | 判据 | 实测 |
|---|---|---|
| 1 | 入口 | `host-assets-toggle` → steward 1 → 面板打开 |
| 2 | 分组 | `fail=false`，**组卡 888**，一级分区文本可见（公司宣传 / 泰国-美妆类 / 公司游艇 / 跨境电商 / 公司豪车 / 日区-穿戴甲…），**无 0 条组卡** |
| 3 | 首屏 | `facets=1`、`list=0`、`cover=0`；滚动时 `list` **在飞并发最高正好 6** |
| 4 | 下钻 | `list?...&scope=company&twoLevelTypeIds=271500&videoType=1`，面包屑「云管家素材 / 公司宣传 / 新仓」 |
| 5 | scope | company/own 均可切换；切 own 只发 1 次 facets、0 次 list |
| 6 | 文案 | 无「计入供应商下载次数」；「会把文件真实下载一次到本地」可见 |

**阻塞（F2）**：页面上同时存在**两个重叠的 `[data-panel="cloud-steward"]`**（一个 296×810 在 `DIV.relative.flex` 链里，一个 295×809 在 `ASIDE.absolute.inset-x-1.5` 里），都 visible → `querySelector` 命中被覆盖的那层 → 组内 list 发不出 → 「下载」点不到。判断为 `MediaPool` 在“自家 pane”与“宿主抽屉”两条路径各渲染一份面板。已派修：面板只由抽屉那一份拥有，**全树 `[data-panel]` 恒为 1**，并以测试钉住。

## 重复面板收敛（`a55d3aa` → `97d36c4`）

**现象**：页面上同时存在两个重叠的 `[data-panel="cloud-steward"]`（296×810 在 `DIV.relative.flex`，295×809 在 `ASIDE.absolute.inset-x-1.5`），都 visible → `querySelector` 命中被覆盖层 → 组内 list 发不出、下载点不到。

**修法（方案 1：单一所有者）**：新增 `lib/material-center/panel-host.ts`（`hostsCloudSteward(inDrawer) === true`、`cloudStewardPanels()` 计数）；`MediaPool` 的**入口与面板共用同一条件**，只由抽屉那份渲染；`ProjectView` 把 `inDrawer` 传进两个 `MediaPool` 分支。断言：`cloudStewardPanels([false,true]) === 1`、源码 `data-panel="cloud-steward"` 仅 1 处、`mediaPool(true)` 恰好 1 处。

**结论（pane 那份为何存在）**：两个挂载点在源码上互斥（pane 需 `!hostAssets && assetsPaneOpen && assetsFit`，抽屉需 `hostAssets?.open`）。同帧出现两份 → **宿主 `assets` 上报与抽屉开合存在时序抖动**：pane 渲染时 `hostAssets` 尚为假，抽屉已按 `hostAssets?.open` 打开。

**遗留**：pane 在 host 模式下确实不该有素材池，但那是它自身渲染条件的时序问题；本次未动（避免同时改两条路径）。若出现“打开抽屉瞬间素材闪两次”，再把 `ProjectView:4441` 的闸门改成「宿主未持有素材池」的显式谓词。

**门禁**：UI **846/846**、typecheck 0。

## `MATERIALS_IS_INNER` 与内网不可达（`15b8af3` → `77d26db`）

- env **`MATERIALS_IS_INNER`** 只接受 `'0'`/`'1'`（缺省 `'0'`）；非法 → `refusing: is-inner-invalid`（exit 2）。
- 只打进**确实接受**该字段的两个 body：`video/list`、`video/query/raw`；`video/type/list`、`video/state/list` 不塞。
- 作为 transport 的 composition 参数（`Dependencies.isInner`），**不进签名/会话**——它不是身份。
- **内网不可达的映射条件**：`isInner===1` 且失败属网络层（`ENOTFOUND / EAI_AGAIN / ECONNREFUSED / ECONNRESET / EHOSTUNREACH / ENETUNREACH / ETIMEDOUT / EPIPE / UND_ERR_CONNECT_TIMEOUT / UND_ERR_SOCKET`，或 `AbortError/TimeoutError`）→ **503 `material-inner-unreachable`**；供应商业务码在此之前已作为第一方错误抛出并原样重抛（`code=20000` 仍是 502 `provider-response-unconfirmed`）。
- 日志只打 `[materials-api] inner mode: on|off`，用例断言日志不出现 `sucaicloud` / `192.168.`。
- 用例：`a network failure in inner mode is material-inner-unreachable, not a generic supplier error`、`a supplier business code in inner mode keeps its own mapping`。

**门禁**：`apps/api` **159/159**、typecheck 0。

**背景（供内网部署时判断）**：`isInner=1` 的地址族是 `szy-hlcxy-sucaiwang-inner.sucaicloud.com` → **192.168.10.10**（私有）。本机在线网段是 `192.168.110.x`，且那块 10.x 网卡处于 **Disconnected**，所以本机切 `=1` 必然 503 `material-inner-unreachable`——这是**正确表现**，不是缺陷。

## 仓库整洁度（H4）：已移除 13 个、剩余待清

| 项 | 数 |
|---|---|
| `git worktree list` 清理前 | 49 |
| 已移除（**已并入 dev 且干净**） | **13** |
| 清理后注册 worktree | **14**（含主仓 dev） |
| 磁盘 `E:/CodexData/worktrees` 目录（含孤儿） | ~70 |

**未并入 dev、仍留注册的 13 个**（必须归档后处置）：`material-proxy`、`orange-business-admission/orange`、`orange-fission-independent/orange`、`orange-m0-validate/orange`（detached）、`orange-material-ui/orange`、`orange-media-boundary/orange`、`orange-native-root-role/orange`、`orange-native-type-baseline/orange`、`orange-services-restore/orange`、`orange-t01-isolation/orange`（38 dirty）、`orange-t02-native/orange`（3 dirty）、`orange-t05-paths/orange`、`p1-companykey`。

**孤儿目录**：约 56 个已不在 git 注册表内（含 `node_modules`/`dist`/未跟踪产物）。已派 `i1-inventory` 执行「先归档 patch → 再删」，并要求产出 `.dev/archive/<日期>-orphans/REPORT.md`（每目录：类别 / 是否并入 dev / 归档路径 / 是否删除 / 释放空间）。

**纪律**：不 `branch -D`、不对 dirty 注册树 `--force` 移除、不碰 `D:/dev/orange` 与 recovery archive。

## 面板唯一性改由结构保证（`5f8d5ff` → `afad3ae`）

**为什么再修一次**：上一版用 `inDrawer` 谓词“只让抽屉那份渲染”，UI 846/846 全绿，但真机 `[data-panel="cloud-steward"]` **仍为 2**（一个 296×810 在普通 `DIV.relative.flex` 链，一个 295×809 在 `ASIDE.absolute.inset-x-1.5`）。**条件会被运行时绕开，结构不会。**

**改法**：面板从 `MediaPool` 提到 **`ProjectView` 顶层**（`{stewardOpen && <aside data-panel="cloud-steward" className="fixed z-40 …">}`），状态 `stewardOpen`/`stewardClient` 归 `ProjectView`；`MediaPool` 只保留标题行入口按钮，仅触发回调、不渲染面板；两个 `MediaPool` 分支都传同一回调。

**验证**：全 UI 源码 `data-panel="cloud-steward"` 出现 **恰好 1 处**（`MediaPool` 里 0 处）；`panelMounts(true)=1 / false=0`；UI **846/846**、typecheck 0。

**教训**：这一层（ProjectView 级装配）没有 DOM 渲染器，只能靠源码结构断言 —— 因此**条件式唯一**不可信，必须让结构本身只可能产出一个。

## 下钻 422 的真因（待修）

`apps/api` 两层白名单都没有 `twoLevelTypeIds`：`materials.ts:79` 的 `LIST_KEYS` 与 `zhishang.ts:99` 的 `MATERIAL_KEYS`。真机对照：带该参数 → 422；去掉 → 200 items=2。已派修（含逗号串校验、拒绝数组），并要求顺带纳入文档 8.1 的其余筛选键（`oneLevelTypeId`/`videoStateId`/`includeLabelIds`/`excludeLabelIds`/`accountKeys`/`teamIds`/`groupIds`），避免 UI 加筛选器时再撞同一堵墙。

## 下钻 422 修复：白名单其实有四层（`931acc0` → `3675367`）

**真因**：`twoLevelTypeIds` 不在查询白名单里。作者比线索多找出一层——`server.ts` 的 `PARAMS.list` 也缺，只补 materials/transport 两层的话**路由层会先 422**。

**修法**：白名单统一为
`pageNo, pageSize, videoType, name, videoIds, scope, twoLevelTypeIds, includeLabelIds, excludeLabelIds, teamIds, groupIds, accountKeys, oneLevelTypeId, videoStateId`
三处（`server.ts:PARAMS.list`、`materials.ts:LIST_KEYS`、`zhishang.ts:MATERIAL_KEYS`）一致，后两者 spread 新文件 `apps/api/src/filters.ts` 的 `FILTER_KEYS`，**杜绝漂移**。

**校验**：数字 id 串 `^[0-9]{1,12}(,[0-9]{1,12}){0,49}$`；`accountKeys` 逗号分隔、每项 1–512 可打印 ASCII、≤50；`oneLevelTypeId`/`videoStateId` 单整数（1.5/负数/文本拒绝）；数组与 JSON body 一律 422 不强转；未知键仍 422。

**我的直连验证**：`GET /api/materials/list?pageNo=1&pageSize=5&scope=company&twoLevelTypeIds=271500&videoType=1` → **200, items=5, providerTotal=171**。
**门禁**：`apps/api` **163/163**、typecheck 0。

**顺带（UI 侧后续）**：其余筛选维度要真正生效，只需在 UI 的 `LIST_QUERY_KEYS` 补同名键——服务端已全部接受并透传。

## H4 清理完成：73 → 31 目录，释放 23.68 GB

| 指标 | 前 | 后 |
|---|---:|---:|
| `E:/CodexData/worktrees` 目录数 | 73 | **31** |
| 占用 | 46.88 GB | **24.35 GB** |
| `git worktree list` 注册数 | 14 | 16（清理期间其他成员新建了 `p1-hoist`、`twolevel-filter`） |
| 删除 | — | **44 个，释放 23.68 GB** |

**删除依据**：44 个全是「已不在注册表 + 没有 `.git` 指针」的纯残留；其中 33 个对应分支**已并入 dev**，11 个分支已不存在。删除前每个都留了 `listing.tsv`（排除 node_modules/dist/.next/.cache/obj/bin，共 2600+ 条路径）+ `meta.json`，归档总计 3.77 MB。报告：`.dev/archive/2026-11-13-orphans/REPORT.md`。

**必须承认的局限**：这批目录的 `.git` 指针早被 `worktree remove` 一并删掉，**无法生成可应用的 patch**，可恢复的只有文件清单、不含内容。敢删的前提是“对应分支已并入 dev 或已无该分支”，即源码内容已在 dev 里，丢的只可能是未跟踪的临时产物。

**保留**：15 个注册树/容器（11 个 `orange-*/orange` + 4 个 dirty 的 p1 树，未做 `--force`）；7 个空标记目录（对应分支未并入 dev）；4 个迁移备份（`orange-studio-c3/c4-*`，恢复副本，不动）；3 个**他项目**残留（`sync-0.8.2`、`r1-02b-claim-pin`、`morchat-round1`，属 `morchat.co`，不碰）。另有 2 个空目录被进程占用，稍后重试。

**待判定（12 个未并入 dev 的分支）**：`t01-isolation`(38 dirty)、detached `m0-validate`(24)、`fission-independent`(6)、`native-lifecycle-ci`(3)、`services-restore`(1)，以及干净待合并的 `original-home-entry`/`material-ui-dev`/`media-boundary`/`native-chain-ci`/`owner-collections`/`native-card-home`。已派 i1 产出「已提交 stat + 提交标题 + 未提交 patch + 是否已被 dev 取代」的证据包到 `.dev/archive/2026-11-13-branches/`，**先不删任何东西**。

## 真机第 11 例：面板 list 风暴（一次会话 370 次 list / 10 次 facets）

**现象**：分组面板打开后懒加载不收敛，`list` 持续增长（一轮 370 次、`facets` 10 次）；DOM 被持续重建，连按名字定位组卡都会失败。上一轮“再进同组 15 次 list”是同一现象的小样本。

**影响**：它是所有交互验证的噪声源——V1 本轮的下钻/下载因此完全没跑到，`raw` 的 403 响应体也没取到。

**处置**：要求 UI 侧落三条硬不变量——①渲染期间零请求；②effect 依赖稳定（`useMemo`/`useCallback`/ref，禁止内联对象进依赖）；③同一 `(scope, groupId)` 探针会话内只发一次，observer 重复触发必须命中缓存。并加回归测试：连续 20 次无关 re-render → `list` 增量 0；同组卡进出视口 10 次 → 恰好 1 次；下钻→返回→再进 → 0 次。

**顺带澄清（V1 判定，非缺陷）**：`[data-panel="cloud-steward"]` 计数 2 是因为**抽屉外壳与面板本体重名**：结构为 `aside[data-panel] > section[data-panel]`，面板本体只有 1 份。处置：外壳属性改名为 `data-panel-shell`，让 `[data-panel]` 恰好 1。

## 另一处待判（可能是真 bug）

`POST /api/materials/raw` 在公司视图下返回 403「当前身份无权下载这条素材」。但授权逻辑里 `layer==='public'` 时 `visible()` **直接放行任意作者**，所以「作者不是本人」不该产生 403。**必须按响应体判断**（`code` / `authorization.reason`），不能按界面文案——界面的“无权下载”是 403 通用兜底。待 V1 用控制台手发同形请求取原文。

## 真机第 12 例：公司视图里“无权下载”其实是 **raw 主机白名单**（已定性）

**证据（我直连服务复现）**：
```
POST /api/materials/raw {videoId:"20728596",videoType:1,scope:"company"}
→ 403 {"code":"raw-host-not-allowed","message":"原片地址主机不在白名单"}
```
`20728596` 属「新仓」组（`twoLevelTypeIds=271500`）；而此前成功的 `34891188` 属另一组。→ **供应商的原片 CDN 不止一个域名**，我们白名单只有 `szy-hlcxy-sucaiwang.sucaicloud.com` 与 `-inner` 变体。

**误导点**：UI 把 403 统一显示成「当前身份无权下载这条素材」，把“主机不在白名单”伪装成“权限不足”。这与之前 `invalid-query` 当兜底码是同一类错误——**错误码必须保留原始语义**。

**诊断受阻原因**：`raw.ts` 在**下载前**就按主机名拒绝，所以 CDN 请求根本没发出，外部 fetch 探针看不到主机名。已加诊断开关需求（`MATERIALS_DEBUG_RAW_HOST=1`，仅打主机名）。

**修法**：`rawHosts` 支持 `*.domain.tld` 通配（域名边界匹配，`evil-` 前缀与后缀伪装不命中），env 与凭据同一套规则；仍然 fail closed。

## 通配白名单落地并验证（`3037d67` → `e3c52c2`）

**根因补充（关键）**：被拒素材的 CDN 主机是 `szy-**qqcc**-sucaiwang.sucaicloud.com:9001`，而我们原先白名单里的精确条目是 `szy-**hlcxy**-sucaiwang.sucaicloud.com` —— **同一域名家族、不同主机主体**。逐个枚举域名注定失败。

**修法**：`apps/api/src/hosts.ts` 提供 `hostEntry/hostAllowed/isHostname`；条目 `*.suffix` 命中当且仅当 `host.endsWith('.'+suffix)` 且严格长于 suffix（**apex 不被通配覆盖**）；`*` 只能是整个最左标签；env 与 `credentials.rawHosts` 共用同一实现；空表仍 fail closed。凭据已改为 **`["*.sucaicloud.com"]`**。

**诊断**：`MATERIALS_DEBUG_RAW_HOST=1` 时拒绝只打 `[materials-api] raw host refused host=<hostname>`（仅主机名，用例断言不含 `http`/路径/查询）。

**我的验证**：
```
POST /api/materials/raw {videoId:"20728596",videoType:1,scope:"company"} → 200, bytes=43,830,202
[host-spy] media host=szy-qqcc-sucaiwang.sucaicloud.com port=9001
[materials-api] raw videoId=20728596 bytes=43830202 count=1
```

**门禁**：`apps/api` **169/169**、typecheck 0。

**教训**：白名单这类"枚举外部资源"的配置，必须按**家族后缀**表达，而不是逐个主机名——否则对方每换一个桶，功能就静默坏一次。

## DevTools 可用性（`6f5749a` → `6dd2f00`）

操作者需要开发者工具查看与指引 UI。核查结论：**dev 构建从未禁用**（全仓只有 `main.mjs:235` 的 `devTools: !app.isPackaged`，无 `devTools:false`、无 `--disable-devtools`）。此前“打不开”的最可能原因是**只绑了 `Alt+CmdOrCtrl+I`，没绑 F12**。

**补强**：
1. View 菜单项 `developerToolsWithKey`，`accelerator: 'F12'`，仍在 `packaged ? [] : [...]` 门控内（打包构建无此项）；
2. `makeView()` 内（仅 `!app.isPackaged`）新增 `before-input-event` → `isDevToolsShortcut(input)` 命中即 `preventDefault()` + `toggleDevTools(v, v)`，使 **F12 与 `Alt+CmdOrCtrl+I` 并存**且不会一次按键既开又关；
3. 菜单回调带 HOME 兜底：`toggleDevTools(activeView(), views.get(HOME))`，无前置页时不新建窗口；
4. i18n 新增 `developerToolsWithKey`（5 语）：`开发者工具 (F12)` / `Developer Tools (F12)` / …
5. `webPreferences.devTools: !app.isPackaged` **原样保留**（未改成常量）。

**门禁**：桌面套件 **633 / 629 通过 / 0 失败 / 4 skip**、根 typecheck 0。
**给操作者的三种查看方式**：菜单（视图 → 开发者工具）/ **F12** / `--remote-debugging-port=9333` + `http://127.0.0.1:9333`；编辑器内容在独立 `BrowserView` target 里。

## 错误码 → 用户语义：`raw-host-not-allowed` 与「无权」分开（`47bc2c2` → `9cbb707`）

`copy.ts`：
```ts
if (kind === 'forbidden') return code === 'raw-host-not-allowed' ? copy.useStorageBlocked : copy.useForbidden;
```
- `authorization-denied` → 「当前身份无权下载这条素材。」
- `raw-host-not-allowed` → 「该素材的存储位置未被放行（属于配置问题，不是权限问题）。请联系管理员白名单放行后再试。」

两者仍都进会话级 `deniedDownloads`（二次点击 0 请求、按钮禁用、不显示「重试」），只是句子不同；`denied` 现在按 id 记 code（`add(videoId, code)` / `codeOf`），已禁用的卡片也能说对原因。UI **865/865**、typecheck 0。

**这是今天第 4 个“错误码当兜底码”的修复**（前三个：`invalid-query` 兜住供应商 20000、`internal-error` 兜住 403、`provider-response-unconfirmed` 兜住缺 `isInner`）。共性：**用通用码盖住具体原因，等于把排查成本转嫁给下一个人**（多次是我自己）。

## 真机第 15 例：组卡“可见即探针”在真实规模下是风暴，并触发供应商 429

**真机数据（head `e2b3d0c`）**：打开面板 `facets 1` ✔ 但 **`list 43`**；滚动 6 轮 `list +108`，会话累计 **151 次**；随后供应商 **429 `provider-rate-limited`**，组内 list 与 raw 全部被限流。

**根因（设计错，不是实现细节）**：组卡为了拿“组内数量 + 封面”，在**进入视口时**对每个组发一次 `list`。888 个组 = 最多 888 次请求。会话缓存只能去重，救不了总量。

**我的测试为什么没抓到**：`material-center-storm.test.ts` 只模拟了 **2 个组**，却用它论证 888 组的行为。**这是方法错误**：凡“按规模决定性能”的功能，测试必须用接近真实的规模（888 组或等量级）跑请求计数。

**改设计（进行中）**
1. 组卡**默认不取数量、不取封面**，只显示组名 → 首屏严格 `facets 1` / `list 0`；
2. 数量在**进组之后**由 `providerTotal` 得到，返回时写回组卡（会话缓存，0 新请求）；
3. 想显示每组数量需**显式开启**，走受控队列：一次 ≤24 组、QPS ≤6、并发 ≤2、**429 立即暂停**并提示；
4. materials 客户端加**全局节流与指数退避**（429 只重试 1 次，其后交用户手动重试）；
5. 移除自动探针路径，`IntersectionObserver` 只用于封面懒加载。

**已确认通过**：面板唯一（`[data-panel]`=1、`[data-panel-shell]`=1）。

## 设计修正落地：组卡不再自动探针，首屏 list = 0（`ea13129`/`c0f7f13` → `0972aa2`）

**改法**
- **组卡只显示组名**（已知时带数量）；面板渲染路径只读 `sections()`/`count()`（**纯内存**），`probe` 路径删除，`IntersectionObserver` 从面板移除（封面也不画）；
- 数量来源只有两种：①进组时那条 list 的 `providerTotal`（`remember` 写回，**0 请求**）；②显式「显示每组数量」→ `collect()`：**≤24 组/次、并发 2、经 gate 6 QPS**；
- **429 → 队列暂停**（`notice='throttled'`，显示「供应商限流，稍后再试」），`notice` 未清空前再调 `collect()` 直接返回，**不自动重试**；
- `gate.ts`（`createRequestGate`，默认 QPS 6 / 并发 6）：`run` 抢槽即占位（修掉首版超发竞态），`pause/resume` 挂起新请求，`stats()` 暴露 `started/inFlight/maxInFlight/waits`；
- `client.ts`：所有请求经 `gate.run`；429 → **退避一次**（400ms，可注入）后重试一次，仍失败抛给用户。

**测试（868 例全绿，+5 import）**：888 组开面板 `facets 1` / **`list 0`**；20 轮滚动 + 50 次进出视口 → `list 0`；20 次重建 → 1/0；进组 1 次 + `remember` 0 请求；显式 pass 恰好 24 次；company/own 互不串；gate spacing（2 QPS → waits 500ms）与 429 退避一次。

**代价（有意为之）**：组卡默认没有数量和封面。数量/封面属于锦上添花，不值得用 888 次请求去换——这是本轮最重要的取舍。

**门禁**：UI **872/872**、typecheck 0。

## 真机验收通过：分组 UI + 请求闸门（`4f83381`）

| # | 判据 | 实测 |
|---|---|---|
| 1 | 开面板 | `facets` **1**、`list` **0**（listUrls 空） |
| 2 | 滚动 5 轮 | `list` **0**、`facets` 0 |
| 3 | 显式「显示每组数量」 | `list` **24**（24×200）、并发 **2**、无限流提示 |
| 4 | 进组 + 下载 | 进组 `list` **+1**；`raw videoId=20728681 bytes=162144513 count=1`；落盘 `Saved/云素材/20728681.mov` = **162,144,513 B**（与 bytes **完全一致**）+ `.meta` 257 B |
| 5 | 二次复用 | 全轮 `raw` **仅 1 次**（复用未被破坏）；界面「已下载到素材库…」 |
| 6 | 返回 | `list` 0、`facets` 0 |
| 附 | 面板唯一 | `[data-panel]`=1、`[data-panel-shell]`=1；组卡默认只有组名、无数量无封面 |

**全轮计数**：`facets` 3、`list` **26**（开面板 0 + 滚动 0 + 显示数量 24 + 进组 1 + 返回 0，另 1 次登录首读）、`raw` 1、并发上限 2。**未出现 429。**

**三处待补的小验证（非缺陷）**
1. 「二次点击同一张」的文案未精确复现（选择器落到了同组另一张卡），需按卡片 id 锁定再点一次；但 `raw` 全轮仅 1 次，**不重复下载的事实成立**；
2. 「进过某组后写回数量且 0 新请求」——所测那组不在本轮取数的 24 组内，下轮进该组再验；
3. 该组首张即 **162 MB**（下载约 1 分钟），下次优先选小文件。

**结论**：首屏 0 请求、滚动 0 请求、取数受控（24 组 / 并发 2 / 6 QPS）、进组 +1、下载真实落盘且 bytes 一致、复用不重复——分组 UI 与请求闸门可算交付。

## 素材大脑 · W1 完成（dev `3b2b753`）

| 路 | 分支/HEAD | 内容 | 门禁 |
|---|---|---|---|
| W1-A | `codex/w1-contract` @ `0ae96a5` | 契约四层统一：`FILTER_KEYS` 单点定义（`filters.ts:112`），`orderByType`（仅 `1`）、`esUpdate*`、`upload*`（严格 `yyyy-MM-dd`、成对、start≤end、真实日历日）；`filterValues(record)` 合并两处逐键循环，消除漂移 | `apps/api` **172/172** |
| W1-B | `codex/w1-services` @ `c9d0f89` | 解 503：`providers`/`local-models` 走**账号级 store**（`<studioHome>/services/<companyKey>.json` 或 `acct-<sha256>…`），目录 0700 / 文件 0600 / 原子写 / 无账号 → 403 且不建文件；GET 只回 `configured` 与 `last4` | 服务端 **63/63**、隔离回归 9/9 |
| W1-C | `codex/w1-db` @ `06d713e` | Docker `pgvector/pgvector:pg17`（`127.0.0.1:55432`）+ 六表 DDL + RLS(force) + `hnsw`(1024, m16/ef64) + `pg_trgm`；`infra/verify.mjs` 五项 5/5 | 幂等两轮 exit 0 |

**我补的漏洞**：`.dev/` 被 gitignore，W1-C 的 compose 与 verify **原本没进提交**；已复制到可跟踪的 **`infra/`** 并提交（`d2d1c22`），README 已指向新路径。我本地实跑 `node infra/verify.mjs` → **5/5 PASS**。

**W1 合并后 dev 门禁**：`apps/api` 172/172、服务端 63/63、typecheck 0。

## W2 / W3 已派（三路并行，写集互斥）
- **W2**（`apps/api/**` 独占）：同步器（day/watermark/full、禁止用 `total` 终止、限流与退避、幂等 upsert、周对账标删）+ 检索 RPC 客户端（走 PostgREST，保持零依赖）。
- **W3-A**（`apps/desktop/src/**`）：`openfilm-mcp.mjs` 六个工具 + 写闸门 + `agents.mjs:1383` 注入。
- **W3-C**（`studio/ui/**`）：素材中心纪要面板 + 实体页（含 hook/selling_point）+ 裁决入口，先接 mock 契约。

## W3-C 完成：素材中心「纪要」UI（dev `23043f5`）

分支 `codex/w3-wikiui` @ `d2801e8`，写集仅 `studio/ui/**`；UI **884/884**、typecheck 0。

**请求纪律（有计数证据）**：列表页 **0 请求**；展开 **1 次**；再展开 **0 次**（会话缓存 + single-flight，并发三次展开仍 1 次）；实体页首次 1 次、再开 0 次；裁决不重读列表。

**冻结契约落地**：`wiki.ts` 提供 `createWikiClient`（`/video/:id`、`/entities`、`/entities/:id`、`/entities/:id/arbitrate`）+ `createWikiCache`（按素材/实体缓存、单飞、裁决回写）+ `groupEntities`（含 **hook / selling_point**）+ 失败分层（未接通 / 限流 / 失败）。

**UI**：素材卡「纪要」按钮（仅云端有 card 时）→ `WikiPanel`（一句话、场景时间线、最佳片段 +「用这段」走既有 `controller.use`、标签、风险、`data-production` 徽标 + 置信度）；工具栏「实体」→ `WikiEntities`（按 kind 分组，`disputed` 给 **采纳 A / 采纳 B / 保留冲突** 三动作）；**200+空显示「还没有实体。」不算错误**。

## W2 完成：同步器 + 检索 RPC 客户端（dev `07cf8f2`）

分支 `codex/w2-sync` @ `1a6b03f`；`apps/api` **195/195**（+23）、typecheck 0。

**请求预算（实测断言）**：一次日增量 = `ceil(命中行数/200)` 个分页 + 1 个 `access_token`（单飞缓存 ≤24h，热态摊销为 0）。150 行 → **1 个**；恰好 200 行 → **2 个**（满页必须再问一页，空/短页即停）。

**关键实现（都是这轮真机教训的固化）**
- 终止条件只认「本页为空」或「越过游标」，**`total` 从不参与判定**（有用例喂 `total=178310` 证明不被采信）；
- 水位**只在整页落库后推进**；失败写回 run 前的 cursor（`status='failed'`），用例断言 cursor 未前进；
- `rate.ts`：并发 1（上限 2）、1 QPS、burst 5、连发 ≥10 静默 2s、退避 2/4/8/16/32s+jitter ≤5 次；注释明确 **写端点与 `query/raw` 不重试**；
- `hash.ts`：`sha256(name|size|duration|category2|labels|createTime|account)`，labels 排序后参与 → 顺序变化不算变更；
- `store.ts`：PostgREST 幂等 upsert（`on_conflict=company_key,env_id,video_id`），删除只打 `deleted_at`，**绝不物理删**；
- `index/client.ts`：租户在**创建客户端时捕获**并注入 `p_company_key`，调用方无法覆盖；`limit` 夹 100、超长 query 422 不出网。

**同步补的迁移（已派 r4，写集 `docs/sql/**` + `infra/**`）**：`005_sync_state.sql`（`sync_state` 表 + `material.deleted_at` + 部分索引 + RLS）与 `006_rpc.sql`（`search_materials` 及其他三个幂等 upsert；`set_config('hnsw.iterative_scan','strict_order',true)` 事务级设置）；`infra/verify.mjs` 扩到 8 项。

## W3-A 完成：MCP 服务 + 注入（dev `6678441`）

分支 `codex/w3-mcp` @ `b9104e6`，写集仅 `apps/desktop/src/**`；桌面 **643/639/0/4**（+10）、typecheck 0。

**7 个工具**：`materials.search`、`materials.take`、`wiki.video`、`wiki.timeline`、`wiki.shot`、`timeline.insert_clip`、`openfilm.look`。
未接通的后端（云端 RPC / 素材字节 / look）一律返回结构化 `{ok:false, code:'not-configured'}`，**不抛**——因为 dsh 的 `failOnStartupError: true` 会让整个会话打不开。

**写闸门（自建，因 MCP 绕过 OpenFilm 审批）**：`~/.openfilm-dev/mcp-write.json`（`{version,allowWrite:true,projects:[绝对路径]}`）；缺失/非 true/相对路径/项目不在白名单 → `write-not-authorized` / `project-not-allowlisted`，且**在读 film.html 之前**就拒；每次写追加一行审计（工具/项目/clipId/参数摘要，**不含整条或绝对媒体路径**）。

**注入**：`agents.mjs:1383` → `mcpServers: [openfilmMcpServer()]`，绝对 command + `ELECTRON_RUN_AS_NODE=1`，启动异常只写 stderr、`exitCode=0`。

**三条已知边界（后续卡）**：①云端 RPC/下载/look 仍是注入缝；②`openfilm-mcp` 对 `packages/openfilm/{src/film-doc.mjs, studio/server/ops.mjs}` 用相对路径 → **打包态会失败**，需 release 随包（已派 W3-B）；③`materials.take` 复现 `assets/<name>` + `clipTag` 语义。

## 进度总览（dev 至今）

| 波次 | 状态 |
|---|---|
| W1-A/B/C | ✅ 已合并（契约 172、服务端 63、infra verify 5/5） |
| W2 | ✅ 已合并（`apps/api` 195） |
| W2-DDL | 🔄 在跑（005/006 迁移 + verify 扩到 8 项） |
| W3-A | ✅ 已合并（桌面 643） |
| W3-B | 🔄 在跑（Python 随包 + rea-video 骨架 + 打包补齐） |
| W3-C | ✅ 已合并（UI 884，列表页 0 请求） |
| W4（分析管线 / wiki 编译 / 时间线联调） | ⏳ 等 W3-B 与 W2-DDL |

## W2-DDL 完成：RPC 与同步状态迁移（dev `de3beee`）

分支 `codex/w2-ddl` @ `a5407df`；迁移 001→006 连跑两轮 exit 0、`ERROR:` 0；`node infra/verify.mjs` **8/8 PASS**（我本地复跑确认）。

| 检查 | 结果 |
|---|---|
| ① vector 版本 | 0.8.7 |
| ② `hnsw.iterative_scan` | `strict_order` |
| ③ 六表 | 6/6 |
| ④ RLS | 六表 on/force |
| ⑤ 两租户互不可见 | A/B 各见自己；未设租户 0 行；跨租户写入被拒 |
| ⑥ `sync_state` | PK `(company_key,env_id,mode)` |
| ⑦ `material.deleted_at` | timestamptz |
| ⑧ `search_materials` 跨租户 | 自己可见 / 跨租户 0 行 / 未设租户 0 行 |
| INFO | 事务内 `set_config('hnsw.iterative_scan','strict_order',true)`（被接受 ≠ 生效；<0.8 见 README 的两段式回退） |

**`search_materials` 硬条件行号**：租户 `:85`（向量分支）/`:109`（关键词分支）；`deleted_at IS NULL` `:86`/`:110`；**会话租户优先、参数不可覆盖租户** `:52` 与 `:63-65`（不一致直接返回空集；写入侧抛 `42501`）。

**额外行为验证**：旧 `analyzer_ver` 不能覆盖新版本（`a1.0` 挡 `a0.9`，`a1.10` 可覆盖）；跨租户写 `42501`；半套向量（只有 embedding 无 model/ver）`23514`；事件重复投递 `count=1`。

**类型一致性我已核对**：DB 侧 `analyzer_ver text`，客户端侧 `analyzerVer?: string`，两侧一致。

## W4-B 已派（`apps/api/src/wiki/**` 独占）
wiki 编译：8 类实体（含 hook/selling_point）、triage New/Update/**Disputed**（冲突不覆盖、保留双方 sources）、LLM 输出必须过 schema（否则 `analyzer-malformed` 零写入）、`analyzer_ver` 旧不覆盖新、`arbitrate(a|b|keep)` 落事件、重复编译幂等。

## W3-B / W4-B 完成（dev `260dbac`）

### W3-B（`codex/w3-python` @ `9da455d`）：Python 随包 + rea-video 骨架 + 打包补齐
- `python-runtime.mjs`：照 `ffmpeg-runtime` 形状（pinned 版本表 + sha256 + 许可 + 缓存 + 单飞）；**`sha256: null` 即拒绝下载**，校验失败**目录不留任何文件**；仓库无二进制。
- `rea-video` 预置清单（Apache-2.0、180 MB、按需装入 `services/rea-video`）+ `openfilm analyze` 命令注册；**退出码语义**：`0` 成功 / `2` 用法错 / **`4` 组件未安装**（stderr 一行结构化 JSON，不抛栈）。
- 打包补齐：`PACKED_EDITOR_MODULES`（含 `ops.mjs` 依赖的 `clip-motion.mjs`）+ `release.mjs` 步骤 2c + `extraResources: resources/openfilm`；`openfilm-mcp.mjs` 的 `editorModulesDir()` 三级解析（env → `resources/openfilm` → 源码树）。
- 桌面 **654/650/0/4**（+11）、typecheck 0。

**我做的回归核查（重要）**：合并后 `packages/openfilm/src/*.test.mjs` 有 26 项失败，逐项定位后确认**不是 W3-B 回归**——失败文件 `library-semantic-isolation.test.mjs` 在两提交间**逐字节未变**，且 W3-B 对该目录**只新增** `analyze.mjs` 与 `analyze-command.mjs`；失败原因是环境前置（`approvedBaseRoot must be a local non-C Windows development directory`）。

### W4-B（`codex/w4-wiki` @ `32943dc`）：wiki 编译
- **8 类实体**（含 `hook` / `selling_point`）；**triage 由代码判定**（不是让模型判）：
  | 现有状态 | 新证据 | 结果 | 正文 | sources |
  |---|---|---|---|---|
  | 无 | 任意 | new | 新写 | `[videoId]` |
  | active | supports | update | 覆盖为新结论 | 旧 ∪ 新 |
  | active | contradicts | **disputed** | **原样保留**（`compile.ts:138-152`） | 旧 ∪ 新 + dispute |
  | disputed | supports | update（仍 disputed） | **不覆盖**（`compile.ts:155`） | 旧 ∪ 新 |
  | disputed | contradicts | disputed | 不覆盖 | 旧 ∪ 新 + 再追加 |
- **两阶段编译 → 零写入保证**：全部页面过 schema 才写；不合格 → `analyzer-malformed`，entity/event/summary 全 0。
- **schema 校验器遇到不认识的 keyword 直接失败**（防“关键字被静默忽略”）。
- `analyzer_ver` 字典序比较，**compile 与 store 双层校验**；`event_id = videoId:kind:slug:analyzer_ver`（不含 triage）→ 重复编译幂等。
- `arbitrate(a|b|keep)`：`b` 采纳挑战者正文并保留双方 sources，三种都写 `wiki_event(kind='arbitrate')`。
- `apps/api` **212/212**（+17）、typecheck 0。

## W4-A 已派（`packages/openfilm/src/analyze*.mjs`）
分析管线 runner：预热（冷/热分开计时）、多帧（≤12 帧、长边 ≤1280 q85）、**文字走 OCR 不走 VLM**、品牌以元数据为准、幂等（同输入 0 请求）、失败结构化不抛。已把“LM Studio 在 **1235** 端口、base64-only、热态 1.35s/冷启 26.8s”写进任务书。

## W4-A 合入 + 真机三连击（dev `5dfa28a`）

`codex/w4-analyze` @ `9c04fc4`：`src/analyze*.test.mjs` **22/22**。

### 真跑暴露的三个 bug（单测全绿时都抓不到）

| # | 现象 | 真因 | 修法 |
|---|---|---|---|
| 1 | `exit=-22`，`Non full-range YUV is non-standard` | ffmpeg 9 的 mjpeg 编码器要求 full-range | 两遍都加 `-pix_fmt yuvj420p`；失败映射 `frames-encoder-range` 并给可操作提示 |
| 2 | `fps=1` 后跟 `select=gt(scene,0.3)` **选出 0 帧，且 ffmpeg 退出码 0** | 1fps 相邻帧差值通常 <0.3，两滤镜互相抵消 | 默认只 `fps+scale`；场景改**第二遍**单独跑；**0 帧显式失败** `frames-empty`（含注入空数组） |
| 3 | `Error splitting the argument list: Option not found` | **ffmpeg 9 移除了 `-vsync`**，须用 `-fps_mode vfr` | 改用 `-fps_mode vfr` + 旧版降级；**场景遍失败不得阻断**：steady 有帧则 `states.scene='failed'` 继续跑 |

**实测耗时（本机 4060 Ti + LM Studio 7B）**：抽帧 8 帧 **378 ms**；**warmup 11.7 s**；**describe ≈26 s/帧（1280 长边）**；embed 5.2 s。→ 179k × 1 帧 ≈ **1291 小时**，全量本地不可行，必须降分辨率或改云端；已让 i1 量 1280/768/512 三档以定默认值。

**教训（继续累加）**：凡与外部二进制/外部模型交互的模块，“单测绿”只能证明形状；**必须有真跑门禁**。这轮三个 bug 全部是单测抓不到的。

## W5-A + 分辨率实测（dev `8558b71`）

### W5-A（`codex/w5-wire` @ `5a15398`）：端到端接线
- `index-rpc.mjs`：`readIndexConfig`（`OPENFILM_INDEX_URL/KEY/COMPANY[/SESSION]`，缺一即 null）+ `createIndexRpc()`；源码树动态 import `apps/api/src/index/client.ts` 的 `createIndexClient` 复用 search，其余按 PostgREST `/rest/v1/rpc/<fn>` 薄适配，**company_key 由客户端捕获、不入参数**。
- `openfilm-mcp.mjs`：四个读工具走 `cloud()`；`materials.take` = `takeSaved` / `importFile` / `clipTag`；每次 `tools/call` 一行结构化日志（`path` 只留 `basename`）。
- `analyze-service.mjs`：`runAnalyze()` → 本地缓存；有 `upsertWikiSummary` 且成功才 `uploaded:true`；失败仍 `ok:true, uploaded:false, reason:'rpc-failed'`。

### 桌面套件失败项的定性（我逐条核过）
| 失败项 | 单跑结果 | 结论 |
|---|---|---|
| `on Windows the tracked launcher exits when its sign-in window closes` | **81/81 通过** | 全套并发下的**既有 flake**，非回归 |
| `chat audio uses Studio file URLs: playback, ranges, large files…` | 单跑仍失败（超 60s） | **既有环境失败**（task-9 基线已记录） |

→ W5-A **未引入回归**。

### 分辨率实测（`analyze-resolution-bench.mjs`，本机 LM Studio :1235 / qwen2.5-vl-7b）
| longEdge | JPEG | describe |
|---:|---:|---:|
| 1280 | 58,097 B | **20,293 ms** |
| 768 | 26,871 B | **6,387 ms** |
| **512** | 14,713 B | **4,107 ms** |

**总量测算（179k 条）**：1280×12 帧 ≈ 12,100 h；768 ≈ 3,800 h；512 ≈ 2,450 h。→ **只降分辨率不够，必须同时压帧数**（4–6 帧/条 ≈ 800–1,200 h）。结论：**首轮全量必须走云端或一台更强 GPU 的常驻机；本机 8 GB 只适合增量与验证。**

### ffmpeg 两个新 bug（已修，`5ca2bb4`）
1. **`-vsync` 在 ffmpeg 9 已被移除**（`Unrecognized option 'vsync'`）→ 改 `-fps_mode vfr`，旧版降级路径保留（先试新拼写）；
2. **场景遍失败不应拖垮分析** → 抽帧器返回 `{frames, scene}`，`states.scene='failed'` + `timings.sceneFailed=true` 后继续；仅 steady 也 0 帧才 `frames-empty`。

`analyze*.test.mjs` **26/26**。

## 文档定稿 + 一个门禁漏洞（dev `6907741`）

### 四份文档（`codex/docs-brain` @ `0de4ef0`）
`docs/discovery/{19_素材索引与检索,20_Harness与客户端集成,21_素材理解管线,22_Wiki编译与分类学}.md`，121/110/132/121 行，统一「结论表 → 细节 → 未验证/待定」，每条带 `[实测]/[探测]/[代码]` 与文件:行号。r3 同时修正了我两处口径（`server.mjs` 503 实际在 `:321/:324`；`006` 会话租户判断在 `:65`）。

### 门禁漏洞（重要）
r3 在文档里把 `eventId` 签名不一致标为“待核”。我定性后确认是**缺陷 + 门禁漏洞**：

```json
// apps/api/tsconfig.json
"include": ["src/*.ts"]      ← 只含顶层
```
→ `src/wiki/**`、`src/index/**`、`src/sync/**` **从未进入类型检查**。`pnpm typecheck` 的“全 Done”是**假绿**。

强制单文件检查立刻暴露：
```
src/wiki/compile.ts(180,16): error TS2554: Expected 5 arguments, but got 4.
```
即事件键实际是 `…:<version>:undefined`，**不随 triage 变化**；`update → disputed` 的状态变化会被幂等去重吞掉，分歧不落事件流。

**修法（已派）**：`include` 改 `src/**/*.ts` 并修掉暴露的错误（不许 `@ts-ignore`）；`eventId` 补传 `triage`；**加一条门禁测试断言 typecheck 覆盖 `src/**`**（并点名三个关键文件）。修完后“同一视频同版本同 triage”仍幂等，而 `update → disputed` 各记一条事件。

**教训**：`"include": ["src/*.ts"]` 这种写法会让新增子目录**静默逃出**门禁；今后每新增一层目录，都要用“断言覆盖”的测试兜住，而不是靠人记得。

## 门禁漏洞修复完成（dev `3c7e4d1`）+ 全量门禁结果

### typecheck 覆盖 31 → 48 个文件
`codex/typecheck-include-fix` @ `26ce23d`：`include` 改为 `src/**/*.ts`，`--listFilesOnly` 实测覆盖 **48** 个文件（此前 31，**17 个文件从未被检查**，含三个最大模块）。

**修掉的 3 条真错**：`compile.ts:180` TS2554（`eventId` 少传 `triage`）、`sync/catalog.test.ts:149/150` TS2345（缺 `mode`）。**零** `@ts-ignore`/`@ts-nocheck`（门禁用例全树扫描断言为零）。

**`eventId` 新语义**：键 = `videoId:kind:slug:triage:analyzer_ver` → 同元组幂等，`update → disputed` **各记一条事件**（新增用例断言事件流恰为 `new → update → disputed` 三条且 id 互异）。

**新增两条门禁**：①`include` 必须是 `src/**/*.ts` 且三个关键文件在覆盖内、无 `.ts` 落在 include 外；②全树禁止编译器抑制注释。

### 全量门禁（我在 dev 上跑）
| 套件 | 结果 |
|---|---|
| `apps/api` | **216 / 216** |
| `apps/api` tsc（真覆盖 48 文件） | exit 0 |
| `studio/server`（8 文件） | **63 / 63** |
| UI | **884 / 884** |
| desktop | 659 / 653 / **2 fail** / 4 skip ← 见下 |
| 根 `pnpm typecheck` | exit 0 |
| `infra/verify.mjs` | 8 项全 PASS |

**desktop 那 2 条失败是新发现的跨包回归**：`apps/desktop/src/w3-python-packaging.test.mjs` 断言 `JSON.parse(stdout)`，而 CLI 卡改动后**不带 `--json`** 时把 usage 打到了 stdout。契约（W3-B）本应是「组件未安装 → exit 4 + stderr 一行 JSON + stdout 空」。已派修：代码归位 + 测试改读 stderr 并断言 stdout 空，且**门禁必须跑桌面套件**（跨包测试是这轮的盲点）。

## 最终门禁（dev `6992c57`，工作树干净）

| 套件 | 结果 |
|---|---|
| `apps/api` | **216 / 216** |
| `apps/api` tsc（覆盖 48 文件） | exit 0 |
| `studio/server`（8 文件） | **63 / 63** |
| UI | **884 / 884** |
| 分析管线 `src/analyze*.test.mjs` | **31 / 31** |
| desktop | **659 / 655 / 0 fail / 4 skip** |
| 根 `pnpm typecheck` | exit 0 |
| `infra/verify.mjs` | **8/8 PASS** |
| 真机窗口（历史验收） | 素材库浏览/下载/复用/加到工程、分组 UI、请求闸门 |

**跨包回归已闭合**：`openfilm analyze` 在组件未安装时 → exit **4**、**stdout 为空**、stderr **恰一行**结构化 JSON（带/不带 `--json` 逐字相同）；测试从 `JSON.parse(stdout)` 改为解析 stderr 并**断言 stdout 空**（契约钉死而非迁就实现）。

## 交付状态总表

**已完成并有证据**
1. 素材库（OpenFilm 原生底盘）：真实账号端到端——浏览 20 卡 / 下载 4,446,985 B（bytes 与落盘一致）/ 二次复用不出网 / 加到工程。
2. 分组 UI：侧边栏入口、一级分区 + 二级组卡、下钻、公司/我的、裁决入口；**首屏 facets 1 / list 0**，滚动 0 增量，显式取数 ≤24 组 / 并发 2 / 6 QPS，429 暂停。
3. 数据层：Docker pgvector 0.8.7 + 六表 + RLS(force) + hnsw + trgm + 四个 RPC；增量同步（日窗口 + 水位 + 周对账）；**垂直切片真库跑通**（A 命中 1 / B 命中 0）。
4. wiki 编译：8 类实体（含 hook/selling_point）、triage New/Update/**Disputed**、冲突不覆盖、两阶段零写入、`analyzer_ver` 双层校验、`update → disputed` 各记事件、仲裁三动作。
5. Harness：`agents.mjs:1383` 注入 MCP（7 工具）、**自建写闸门 + 审计**、未接通结构化降级；打包随 `film-doc/clip-motion/ops`。
6. 分析管线：真 ffmpeg 抽帧（8 帧 378 ms）、真 VLM（冷 26.8s / 热 1.35s；1280=20.3s、768=6.4s、512=4.1s）、预热与冷热分开计时、文字走 OCR、品牌信元数据、幂等（同输入 0 请求）。
7. CLI：`openfilm analyze`，默认 `--frames 6 --long-edge 512`，退出码 0/2/4/5，`--json` 六键且不含媒体路径。
8. 文档：`docs/discovery/19/20/21/22` + `docs/sql/README` + `infra/`。

**未完成 / 待接线**
- `openfilm services install rea-video` 子命令未接线（所以 `analyze` 真机还到不了 exit 0）；
- `fetchPython` 只做下载+校验+落地，**未解包**（等发布流水线钉住 sha256）；
- wiki 无 HTTP 路由、无 `.md` 导出实现；
- 桌面把索引配置（`OPENFILM_INDEX_*`）注入 Studio/agent 子进程这一跳未接线；
- 真机端到端（对话 → 检索 → 落时间线）未跑：需要 agent 会话 + 已安装组件 + 索引后端三者齐备。

**需操作者决策**
- **首轮全量算力**：512px × 6 帧 ≈ 4.1 s/帧 → 179k 条 ≈ **1200 小时/单机**；本机 8 GB 只适合增量与验证，全量需更强 GPU 常驻机或云端 API（约 2 亿 token 量级）。
- Jev key（图像 + Box 实测）；云端索引用哪个 Supabase 项目与凭据托管方式。
