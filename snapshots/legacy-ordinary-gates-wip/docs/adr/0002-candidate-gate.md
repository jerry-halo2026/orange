# ADR 0002：本地候选和并行准入预检

状态：A-only 单写引导；待独立规格和质量审查。不是 N5a 签发，不配置远端。

## 决策

把「可机械核对」和「已批准合入／并发写入」分开。先运行受信入口的 Git 差异、写集、工作树、导入及调度检查；只要必测证据未接入，候选与准入都保持 `admitted: false`、退出码 1。没有默认放行、`skip`、作者自填报告、任意命令或隐含免测。

总控把受信脚本放在候选之外，从已审头运行，使用受信 Node、Git、PATH 与本机 Git 配置。用独立干净候选，不复用带构建缓存的实现树；准备候选时也不得启用候选可触发的 checkout 过滤器或钩子。总控在作者不可写的目录制作并锁定卡和索引，冻结候选写入后再执行。目录必须在所有登记任务树之外，不能用链接或硬链接。脚本的读操作、卡对比和短时快照不等于签名、文件权限或原子租约；仅靠脚本不能防止能修改本机控制面或并发改写工作树的人。拒绝从候选自己的副本执行候选检查。

## 入口及结果

- 在实际主题候选工作树根运行 `node TRUSTED_GATE/tools/ci/check-candidate.mjs --base WORKING_BASE_SHA --head HEAD_SHA --card CONTROL_DIR/card.json`。读取同一目录下的 `index.json`。完整 SHA 必须分别等于卡中工作基线和候选头，且命中当前卡版本、实际 Git 工作树及主题分支。基线必须为祖先；允许经审查的线性多次提交，不接受多父头。按逐提交 NUL 分隔的 Git 差异取写集并核对文件模式，拒绝中途越界又回退的提交。按精确大小写授权，另按 Windows 别名保守判冲突。不用 Git status、工作区 diff 或任何会触发 clean/process 过滤器的命令；只比较提交树、索引元数据、实际目录名单与未过滤原始文件。任何未登记项（包括被忽略的缓存）、链接／硬链接、异常文件类型、索引标记或字节不符均拒绝。自动换行或 smudge 产生的合法变换同样不等于原始字节；应重新准备独立原字节候选，不放宽门禁。
- 运行 `node TRUSTED_GATE/tools/ci/check-admission.mjs --index CONTROL_DIR/index.json --card CONTROL_DIR/card.json`。验证真实 linked worktree、主题分支、提交和直接依赖，校验写集（包含目录大小写前缀）与资源冲突。按最新总槽数减其他活跃角色（含总控）及活跃写者；有空槽时，先检查排首的独立审查任务与其实际分支头，不让待派写卡的冲突阻挡审查。审批索引在开始及出建议前都须有效；过期或审查头已前移则不推荐槽位。建议不授予槽位，不保留资源，不启动子任务或产品任务。相同机器上 reviewer 等非写者所持资源也须由总控列入租约。
- 仅做导入预检可在仓库根运行 `node TRUSTED_GATE/tools/ci/check-imports.mjs --head HEAD_SHA`。读取该提交的对象，不加载候选 JS/TS 或其构建配置。检查 renderer 的常见静态／动态导入、已知 Node/Electron 特权依赖、受控 renderer 入口、vendor 反向依赖、大小写别名和扫描到的环。无额外参数使用原 A-only 词法子集；无法稳解的 JSX、模板、转义标识符等继续拒绝。实际 B TSX 用下述受信 AST 入口；两种模式都不是 Vite 构建图。gitlink 内部未取得源码时不当作检查通过。只有独立导入预检可返回 0，且报告仍不表示合入批准。

### 受信 TypeScript AST 入口

总控可在上述候选或导入命令末尾显式加 `--trusted-typescript TRUSTED_TOOLCHAIN/typescript.js`。只允许候选 Git 树之外的本地绝对真实路径。门禁不从卡、候选配置、环境或候选 `node_modules` 查找；无法读取、路径不合规或摘要不符时拒绝，不降级到 A-only。先校验读取的字节，再只装载同一份内存字节；解析器依赖查找仅限 Node 内置模块。候选代码始终作为提交里的源码文本解析，不执行、不加载其 tsconfig 或插件。

- 工件来源：已独审 B `0dc626daac1907bb7dc4685e972150b9eeb57b4a` 冻结工具链，锁 SHA-256 `74851cd23286ee92e796ebfc84d748ae06d68cee87edce051f3c42e59f64a08e`；TypeScript 5.9.3 的锁定包 SRI 为 `sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==`。只使用其中 `lib/typescript.js`（9,112,572 字节，SHA-256 `3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675`）；此版本和字节摘要固定在受信代码中，不接受调用方提供其他摘要。
- AST 记录有界静态模块边、字面量动态导入及可识别的 require，使用同一依赖方向规则。识别接收者、静态键及直接调用时忽略括号、类型断言、非空断言和 `satisfies` 等不改变运行时值的包装。间接 require 按属性访问与解构位置检查，识别静态字符串、无插值模板和简单字符串拼接。赋值目标及嵌套目标由已固定 TypeScript 的 AST 能力判定（含 `for…in`、`for…of`）；能力缺失即拒绝。普通数据对象及默认值右侧不当作目标，简写、值引用和解构仍检查。已识别的加载位置和全局／模块接收者有不可解析的动态表达式时仍拒绝；解析错误和 `import.meta` 同样拒绝。这是语法预检，不推断任意运行时别名、数据流或反射。报告的 `importParser` 标明版本和摘要，但不替代类型检查、Vite 别名/插件/条件导出等真实构建图证据。
- 验证完整 AST 回归时，测试进程显式设 `ORANGE_TEST_TRUSTED_TYPESCRIPT` 为上述树外文件，然后运行三份治理测试；此变量仅供测试生成 CLI 参数，门禁本身不读它。未配置的 A-only 测试会明确标记专属 AST 测试未运行，不能引用该次运行证明 AST 回归。

### 固定 B renderer Vite 图

由总控在干净候选根执行候选入口，追加 `--trusted-vite-manifest VITE_MANIFEST --trusted-renderer-manifest RENDERER_MANIFEST --trusted-node-modules VERIFIED_B_NODE_MODULES --graph-scratch PROTECTED_SCRATCH`。四项同时提供；均为候选外、总控保护的本地绝对真实路径。请求任何图参数都必须实际加载获信的 `--trusted-typescript` 并通过 AST 预检；缺失或错误时拒绝，不走 A-only。Windows x64 固定 Node 24.22.1。运行目录不能在任何 Git 树内，不能包含候选树，祖先不能有 `node_modules`。不接收 runner 路径、任意命令、旧图文件或作者结果。省略整组参数时图检查仍未执行，原无图 A-only 模式不变。

- Vite 8.3.6 工具闭包（17 包/399 文件）清单 SHA-256 `50c18efaeb531b7464d9d3e012a38ca9f14bd0a852f217cab09b3767651d2210`；B renderer 的 React、React DOM、scheduler 闭包（3 包/85 文件）清单 SHA-256 `2c9780e58f4d9ebab03103055e4728d8955922406dd7d8dedb92fa635311f3c1`。读取、校验每个文件，实际装载从同一已校验字节新写的工具镜像，构建依赖写入不同的源码镜像；不从现有候选 node_modules 或全局模块搜索路径执行，不运行安装器。
- 仅认当前受保护的 B renderer profile：内建原 B 和带 K07 根入口的两组已审锁/manifest，以及可选 `--trusted-renderer-profile APPROVED_PROFILE`（总控已审核 01d9da6 的等价 renderer 配置，外部登记文件固定 SHA-256 `383b1b1f94eefbc3d8c2c21e35e4bca57d227edd2eb5a4180b7a9574337782dc`）。比较实际 HEAD 的配置/blob 摘要，而非用某次 head 的绿色记录替代本次执行。未知锁、配置、renderer 文件范围或 Studio/vendor 不宣称已覆盖；该子项不可用。
- 候选原始字节检查通过后，从其 Git blob 构造独立一次性镜像。固定受信子进程禁用候选 Vite 配置、环境加载、publicDir 与 PostCSS 自动配置，使用实际解析器并检查模块及输出 chunk 的静态/动态边闭包、越界路径、外部、Node/Electron、实际 renderer 入口及 React 两包各一个物理根。不依赖可能缺失的 `isExternal`。构建不写候选或产物；受控临时目录在运行后清理。返回结果前重新核对控制卡、实际候选 HEAD、索引、原始字节与快照有效期；阶段报告绑定当前 base/head、锁和清单摘要。
- 该子项不运行应用、桌面、候选 build 脚本，也不替代 Windows、类型/格式、契约、秘密/依赖审计或独立审查。只请求图、不请求其他阶段时，图通过也不能把未运行阶段标绿。
- 验证图阶段的完整治理回归时，在现有 TypeScript 测试变量之外，给测试进程显式设 `ORANGE_TEST_GRAPH_SOURCE` 为独立已审 B 源树、`ORANGE_TEST_GRAPH_TOOLCHAIN` 和 `ORANGE_TEST_GRAPH_RENDERER` 为上面两份清单，另设 `ORANGE_TEST_GRAPH_PROFILE` 才覆盖第二审核配置。变量仅供测试构造实际 CLI 参数，不是生产入口的来源。

### 固定本地执行：B 格式/类型与 Windows、D 的 K07

总控可另加 `--trusted-g2-plan ABSOLUTE_CONTROL_JSON`。省略时三项仍未运行。计划必须在树外，原字节 SHA-256 等于最新保护索引的 `g2PlanSha256`，且绑定当前 `taskId`、`assignmentRevision`、`base`、`head`、Git `tree` 与有效期。计划仅含路径、摘要、期限和资源身份，不接受命令、环境、测试过滤器或报告。其 `executionRoot` 是同库同头的另一登记 linked worktree（允许 detached），开始必须原字节及索引干净；`outputRoot` 是树外保护的空短路径，每次新建。每条固定命令启动紧邻前后，重读卡、保护索引、计划原始字节、有效期和适用的桌面租约；撤销或换发则停止下一条命令，保留已经启动的证据，不假定能原子中止在途进程。源和执行树的 Git 头/索引在各阶段重查，阶段通过前再核原字节、批准产物与日志。过期或撤销不续签，重新准备干净的执行树与输出目录再发新计划。没有原子系统租约或 OS 恶意代码隔离承诺。

- **可执行范围**：`executableInputs` 仅认总控独立核准的 24 个 B/D v1 输入、原始摘要与对应候选头；额外可执行范围、隐式配置及可能改变解析的祖先输入拒绝。该授权不来自 renderer 图 profile。Windows x64 工具身份固定到保护计划的绝对路径和字节：Node 24.22.1、Git、.NET 10.0.300 + 同 SDK Roslyn、Windows 系统 `cmd.exe` 和 `taskkill.exe`。不继承作者 `PATH`、Node/Electron/MSBuild 配置、用户缓存或凭据。标准本机运行库仍是控制面信任边界。
- **依赖与等价执行**：`installedPackages` 的审准清单绑定当前 pnpm 锁，逐文件读取并核准同一字节后才写入执行树（含 Electron 运行文件），只重建批准的本地实体链接。donor 不提供可执行脚本、配置、旧产物或绿灯；不运行安装器，也不复制 pnpm 生成的 `.bin`。固定 B 根脚本只转发到原来的 tsc 与 Vite 三 mode，固定 D 根检查脚本只转发到 `generate.mjs --check`；门禁从原工作目录用固定 Node 直调这些原入口，跳过转发包装，不声称任意脚本或依赖更新也等价。NuGet 从计划钉住的 13 个本地包、空缓存和独立配置恢复，写原生外部锁供后续审计；恢复本身不是依赖审计。
- .NET 的版本检查、restore 和 test 额外使用同一获核系统盘上的 `Program Files`、`Program Files (x86)`、`ProgramData` 物理目录及已核 .NET 安装目录（加入固定 PATH）。这些值由门禁构造，不读取调用者变量；不改变 Node/Electron 环境、隔离缓存或同 SDK 编译器转发。
- **实际阶段**：`format-types` 运行本次 Git 差异空白检查和 desktop TypeScript/Vite 构建一次，核 main 实际 SHA-256 和嵌入的当前候选提交；不是全仓格式器。Windows 阶段在启动前再次核保护索引中同 ID/holder 的唯一 `resourceLeases` 桌面租约和有效期，运行原九项测试，验证本次原生 TAP 无 skip/todo。契约阶段仅为 K07 v1：生成一致性、TS 原生 TAP 125 项（114 个冻结夹具加 11 个生成器反例）和 C# 本次原生 TRX 114 项（同一组 ID）；不能复用历史报表或空过滤，TRX 拒绝陈旧时间、异常结果、DTD 和错误计数。报告记录固定命令、时间、退出、stdout/stderr 摘要、构建身份和测试证据；Windows 仅由原套件清理自己捕获的进程。
- G1 renderer 图与 G2 各自留证，不互为替代。只请求 G1/G2 时，未运行的安全阶段不能标绿；本地候选继续 `admitted: false`、退出码 1。

### 固定离线安全扫描

总控可加 `--trusted-g3-plan ABSOLUTE_CONTROL_JSON`，保护索引中的 `g3PlanSha256` 钉住原字节。计划绑定当前卡/版、base/head/tree、期限、树外全新产物根、已核工具/数据库和独立核定的 pnpm 身份清单；不接受命令、环境、忽略列表、报告或扫描配置。每个进程启动前后重核现行控制；换发、撤销或过期停止，不刷新本次授权。候选 Git 对象、索引和原始工作树保持独立、只读。

- `secret-scan`：固定 Gitleaks 8.30.1 与内建默认规则配置；原始 Git blob 按原路径投影到一次性快照。逐个**显式文件**调用 `dir <file>`，不许目录回退：目录模式已实测会遵守候选本地匹配的 `.gitleaksignore`。每个 blob 保留两次本次独立原生凭据：绝对原文件路径保留路径相关规则；同一字节（原 SHA-256 一致）独占写入受信目录中固定相对名 `g3-content.txt`，补扫内容，避免内建路径豁免（实测 SVG、pnpm 锁等）形成假绿。任何一侧发现均拒绝；只有两份有效凭据才算覆盖，失败时记录未扫数量。禁用行内 allow、全脱敏、外部空 ignore；包含受支持的追踪点文件与配置文件。只接当前普通 UTF-8 文件（至多 1000 文件、64 MiB），拒绝非文本和显式归档，**不**声称检视归档/嵌套编码或整个 Git 历史。快照、中性副本与原始报告均为临时文件；不回放 scanner 输出、Match 或 Secret，只保留校验后的规则/原仓库路径/行号、数量和摘要。
- `dependency-audit`：仅在同次 G2 contracts 通过后，从其真实 K07 restore 输出读取原生 NuGet lock，核对本次头/树、项目、输出归属与原字节；不接受旧锁/作者报告。冻结的 pnpm v9 锁由保护清单绑定全部 61 个身份，NuGet 本次原生 lock 派生 13 个身份。固定 OSV 2.7.0 的 `scan source --offline --no-resolve --no-call-analysis=all` 只读这两个明确锁，不安装、不解析项目、不联网；配置为空，缓存只用获核 `osv-scalibr` 的 npm/NuGet 两份原始归档。核对数据库 generation/哈希/批准日期，不按在线最新宣传；锁来源、每项名称/版本/生态、完整清单、实际 DB 加载日志和零漏洞缺一不可。警告、跳过、漏源或输出不匹配一律拒绝；没有库返回 127 时即使生成无漏洞 JSON 也拒绝。
- 两项均通过仍不是合入或并行批准；非作者独立审查阶段未接，候选保持 `admitted: false`、退出码 1。完整本地治理测试可额外设置 `ORANGE_TEST_G3_TOOLING` 为固定扫描工具/数据库根；只由测试使用，不是正式入口环境参数。

## 最小机器卡与索引

### G5：K07 v1 只读就绪证据

`check-admission.mjs --index CONTROL/index.json --card CONTROL/card.json --trusted-k07-proof ABSOLUTE_JSON` 只识别一项精确消费：`{id:"K07.desktop-startup.v1",version:"1",sha256:"bc41ba5f2eeca4aec400b42cbf8aa34f8354da674915669402d5b72912daedfd"}`。该摘要是实际 N1 签发原字节（不是 Schema 哈希），索引仍须匹配 `consumer_ready`。保护索引另钉 `k07ProofSha256`；无证明、其他契约/版本/摘要或组合不放行。此入口不是候选门禁或 N5a 签发。

证明精确字段为 `{schemaVersion:1,subject,n1Path,registrationReview}`。subject 为 `{taskId,assignmentRevision,branch,baselineCommit,workingBaselineCommit,headCommit,gitCommonDir}`，必须匹配本次实际卡与已验证 linked Git worktree/同库控制路径。registrationReview 为 `{reviewerId,authorId,result,originalCommit,integratedCommit,evidencePath,evidenceSha256}`；只认总控确认的 `/root/k07_n0_review` 对 `/root/t02_k07` 的登记独审 approved（原 `18e29f7`，整合 `67e974d`），不把登记作者日志作独审。证明、N1 与独审证据均为树外、不经链接的实际普通文件，校验受信原始字节；控制面必须独立核对证据和角色，摘要不等于 PKI 签名。路径从受信证明读取，不从任务卡查找或执行命令。

实际 Git 验证登记祖先和原/整合登记原始差异等价；对工作基线和请求头逐项核对正式 registry、Schema、114 个唯一样例及验证器、生成物、测试/生成程序等固定 11 个常规 Git blob 和 SHA-256，禁止卡写入冻结范围。对两个提交读取 Git 树的文件和目录条目；若受保护文件或其祖先目录出现大小写／NFC 折叠后的不同拼写，直接以 `K07_FREEZE_PATH_ALIAS` 拒绝，即使别名目录下没有同名叶子、规范 blob 仍在。无关路径的别名不改变该切片的就绪判断；这不是通用 checkout 安全认证。N1 历史 pnpm 锁只在原实测根复核；不将后续 workspace link 或当前锁/构建的独立验收混为 K07 消费身份。该首个固定切片不覆盖其他 K07、其他 K 包或后续 registry 版本；变更须重核。决定前重读有效控制和证明、分支/头、写集与资源；与原检查一样不是原子租约。

成功只报告 `eligibility:"read-only-verified"`、`verifiedContracts` 和非绑定的 nextSlot 建议；保留 `N5A_UNVERIFIED`、退出 1、`admitted:false`。无签发、无保留资源、无启动写者；首次真实两卡 N5a 与实际并发另证。空契约的既有行为、导入预检和 G4 候选成功语义不变。

这是 09 的机械字段子集。角色、模型、授权与完整审查证据仍由总控台账维护。以下字段和值为格式示意，SHA、路径、分支和快照须换成真实观测值，不用此例制作产品证据。

```json
{
  "taskId": "T01.fixture",
  "assignmentRevision": 2,
  "baselineCommit": "405b45f322e29e097dca57efef6c0be90e95f699",
  "workingBaselineCommit": "405b45f322e29e097dca57efef6c0be90e95f699",
  "headCommit": "0123456789012345678901234567890123456789",
  "worktree": "C:/WORKTREES/CANDIDATE",
  "branch": "codex/candidate",
  "writeSet": ["docs/example.md"],
  "dependencies": [],
  "contracts": [],
  "resources": [{ "kind": "desktop", "id": "local-default" }]
}
```

- `writeSet` 仅允许精确文件名，以 `/` 分隔；不能填 glob 或目录。依赖条目是 `{taskId, headCommit}`；契约条目是 `{id, version, sha256}`。测试、报告、命令、跳过标志不能出现在卡内。
- 两种入口都要求索引 `schemaVersion: 1`、`validUntil`（最长未来五分钟的时间戳）、`cards`（完整现行批准卡对象数组，所选卡须逐字段完全相同）。G2 候选执行额外读取 `g2PlanSha256` 与 `resourceLeases`；G3 读取 `g3PlanSha256`。
- 准入入口另外要求 `slots: {total, otherOccupied}`、`activeWriters: [taskId]`、`pendingReviews: [taskId]`（总控按审查优先级排序）、`completed: [{taskId, headCommit}]`、`freezes: [{id, version, sha256, state}]`、`resourceLeases: [{kind, id, holder}]`。空数组表示当前快照确无此类条目。写者的资源从其已批准卡读，非写者占用从 `resourceLeases` 读；总控必须统一物理资源 ID，例如本机唯一桌面或端口 `5432`，不能用不同名字冒充隔离。契约登记中即使标签是 `consumer_ready`，也不能代替真实冻结验证。
- 机械正例：实际 linked worktree、准确当前卡、独立写集／租约、有可用槽；候选记录写集和导入子项退出码 0，仍以 `REQUIRED_CHECK_UNAVAILABLE` 返回 1；准入建议下一槽但返回 `N5A_UNVERIFIED`。反例：用旧卡版本、另一个 SHA、大小写变体、替换为真实 junction，或两卡使用同一桌面／端口／测试库；分别拒绝。见三个 `tests/governance/*.test.mjs` 中真实临时仓库及工作树用例；这些不是产品候选或实际并发证明。

## 尚缺的真实证据

### 固定 G4 独立审查

总控可附加 `--trusted-review ABSOLUTE_JSON`。当前树外保护索引的 `reviewApproval` 精确字段为 `sha256, scopeKind, reviewerId, authors, evidencePath, evidenceSha256`。scopeKind 为 `task` 或 `integration`；总控依据真实任务/组合贡献记录登记作者（含集成冲突作者）与非作者身份，不用共享 Git 显示名作独立性证明。审查及其证据必须是保护范围内的树外真实普通文件，摘要校验不代表签名。审查记录精确字段为 `schemaVersion=1, subject, reviewerId, specs, quality, evidenceSha256`；仅接受两项独立的 `approved`。subject 精确字段为 `taskId, assignmentRevision, branch, base, head, tree, scopeKind, scopeSha256, inputsSha256`。scope SHA-256 取 UTF-8 JSON.stringify 的 `[scopeKind, 排序后的逐提交实际触及文件, 排序后的授权写集]`。完整组合审查须以确实覆盖该组合的基线/头/范围登记，不以任务审查或旧头代替；有需要的人类技术签核仍按 09 单独完成。

inputs SHA-256 为 UTF-8 JSON.stringify 排序后的 `[label, sha256]` 项。固定来源：`git:freeze-registry`、`git:k07-schema`、`git:k07-fixture`、`git:pnpm-lock` 是同头 Git blob 原字节；`g1:typescript`、`g1:toolchain`、`g1:renderer`、适用时 `g1:profile` 是实际已核图输入；`g2:executable-inputs`、`g2:installed-packages`、各 `g2:tool:<role>` 是本次固定计划输入；`g2:nuget-feed` 为排序的 `[包路径, SHA-256]` 列表的 UTF-8 JSON SHA-256；`g3:database`、`g3:inventory`、`g3:tool:<role>` 来自本次计划，`g3:native-lock`、`g3:secret-config`、`g3:audit-config` 来自实际扫描输入；三个 `runner:check-*.mjs` 各取当前受信 runner 原字节。期限、输出位置和桌面租约不属于该摘要，但运行/决定时仍须检查最新卡、计划和租约。真实审查可以先进行；不需要先候选通过或取得 N5a，不能复用旧技术绿灯。

只在本次 G1–G3、写集及导入检查实跑成功、独立审查及全部绑定一致、源树和控制收尾复核后返回 `CANDIDATE_CHECKS_PASSED`、exit 0、`admitted:true`。缺 G4 仍 unavailable，缺技术阶段仍拒绝；它不是 N5a、主线合并或发布。准入建议与导入预检的旧语义不变。

总控在真实隔离候选上绑定基线、头、依赖、夹具与非作者审查，不能汇总各分支局部绿灯来代替候选实跑。上述入口不采信任何外部绿色 JSON，也不执行任意候选脚本。受限 B/K07 以外的格式/类型/Windows/契约路径没有在此批准。仍需同头运行所需实际阶段并由非作者作规格／质量批准；没有设备、批准的输入或契约时继续失败关闭，不以静态扫描、其他平台或夹具替代。

G01/G04/G06、E21.admission 的机械反例可独立复验；G02、真实消费兼容、真实候选和并发写入演练仍需实际 B/D 依赖。N5a 签发之前只允许已批准的单写引导和只读准备。回滚时停止使用本版入口并回到上一受信门禁版本或继续单写；不得用停门禁来放行，亦不重写原工作树、暂存或历史。
