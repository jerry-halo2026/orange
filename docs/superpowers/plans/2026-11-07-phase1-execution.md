# orangeflim 一期分包执行计划（修订3：原生优先/平台/完整试用衔接）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. 项目按 C89 对独立工作包动态并发；共享写集仍串行。

任务编号/依赖/状态唯一见docs/execution/project-tasks.json；计划维护步骤，17维护验收。并发单写/资源不是无关契约冻结的假依赖。

U1文档整理基线：70ed6107ad99d6a852c798d57840488946391f4c；执行前核最新dev头，不能从历史subject分新任务。

**Goal:** 在原版 OpenFilm Windows 客户端内完成真实鉴权后的卡片首页、统一素材接缝、Fission 受控运行与原工程交接、剪口播闭环；不另造客户端或时间线。

**Architecture:** 原 desktop HOME/项目 WebContentsView、原 Studio UI/本地编辑服务保持主工程。新增业务 TS 模块经受限桥接接入；公司凭据、本人绑定、组内准入、积分留可信 Node/TS 服务，.NET worker 只报告执行事实。

**Tech Stack:** 既有 Electron / React＋TypeScript / Node＋TypeScript / Supabase Auth＋Postgres / .NET Fission；原 `.mjs` 与根 lock 保留，不重选技术栈。

**Spec:** [16原生协议与平台](../../discovery/16_OpenFilm原生接口与平台对齐.md)、[17完整试用门](../../discovery/17_小范围试用交付与Goal验收.md)、 [整体设计](../../architecture/overall-design.md)、[PRD v0.16](../../06_橙子生产级重构PRD.md)、[00 v0.43](../../discovery/00_讨论基线与决策台账.md)、[07 唯一契约登记](../../discovery/07_统一数据契约草案.md)、[13 物理边界](../../discovery/13_技术架构与目录依赖基线.md)、[14 交付流程](../../discovery/14_新会话启动与开发交付流程.md)。

状态：2026-11-07 修订3交接稿；本次U1统一后重新独审，旧审查不覆盖新内容；这份计划不是开发已经开始或机器契约已冻结的证明。历史源码/文档subject（不是当前开发头） `3a29a38ea35e488f4769927d816721e19e238076`；上游 `7713d38c8ddc860e1b8e517bb8b0f180988f8f73`；Fission `c28810bcc7704fce4ac0aa1ad8cc57d3628b12e9`。

## Global Constraints

- 原生能力直接复用原IO/API/CLI/类型/ID/错误/时基；16源码索引先于新增协议设计，07只管必要业务增量/映射，禁止平行编辑API/第二可写工程。原rev字符串/非UUID ID/秒毫秒不改成全局整数revision/UUID/微秒。
- 平台仅Windows和macOS Apple Silicon arm64；Windows首发，Mac保留适配/构建，实测前不承诺。IntelMac/Linux客户端/Universal不纳入。D/E是开发环境，不写死进公共业务逻辑。
- 本计划是17的R1阶段，后续U包和全部试用PG门仍必须完成或取得明确范围排除，不能T10结束就宣告整个goal完成。

- 品牌 `orangeflim`；只在原版 App/Launcher 增量首页，左上品牌回首页、右上原设置；无新增业务侧栏，不恢复已撤回的独立网页/壳。
- 原 Projects 管工程/草稿，原 Edit/Canvas、素材源、Saved/Library、Templates/Skills 复用；智尚是业务素材与正式标签主源，不把内置 Library 改成第二业务真源。
- 启动/重启在线第一方鉴权；有效会话运行中断网按既有规则续用有权本地资源。登录、公司 API 认证、本人绑定、素材权限分别表达。
- 剪口播默认选中口播、可多选/本工程全部人声；识别后人选文字/空白、试听确认，音画字幕同步切分合拢，原片不变，一次 Undo；空白不是静音证明。
- 只冻结当前消费者最小依赖；原字幕保存 N0/N1 不自动批准剪媒体或新宿主。原生签名直接引用源码；自有增量/映射唯一登记07，不在本计划复制正式DTO。
- Fission 路径和输入消费行为未隔离前，不启动 Web/doctor/stress/Bench/媒体；既有 Web 不是另一个产品 UI。
- 模型测试总额≤人民币50元，合成/无敏感输入、不自动重试，费用或工具边界不可核则仅停模型子项；不外发智尚真实素材/字幕，不自动安装模型。
- 生产、业务云写/上传、真实扣分规则、发布、main/tag 和远端保护配置不随本计划自动获批。素材审核/上传/正式沉淀/团队共享保留真人最终确认。
- E 盘工作树和缓存；正式集成门禁留 D 盘获准候选区。旧文件/暂存/Git已按用户确认完整归档保全；D主仓dev已就位；main不提交/不推送；不强推、不盲合不相关旧壳。
- 一期是本轮工程增量，不等于 PRD 全首版/M4 已完成；剪映、录音、AI补素材、模板技能治理等原确认范围不因这四条工作线被删除。

## Review Focus

1. 回首页是否卸载项目、丢选区/Undo/后台任务；同屏原 UI 不等于生命周期正确（T03）。
2. localhost key、客户端 owner、同 hash、公司凭据不能代替本人/对象授权；换号换绑和缓存直链必须拒绝（T02/T04）。
3. Fission 的输入配音移动、跨任务缓存、OutDir 覆盖和路径链接逃逸不能遗漏（T05）。
4. 旧 base 自动 rebase、film-only hash、逐 VTT 补偿不能冒充严格修订和跨资源恢复（T08）。
5. HTTP200、进程退出、文件存在、skip、旧头绿色、MP4或截图均不代实际可编辑/集成验收（T06/T10）。

---

## 1. 一期交付与最短路径

采用唯一已选路径：原工程逐接缝增量；不再比较“重做壳/重写引擎”方案。先让原首页导航和真实登录可验，再让同一素材供 Studio/Fission，随后收口 Fission 可编辑交接与剪口播。四条能力并非整条串行。

一期验收分轨：`local_core`、`zhishang_personal_read`、`model_asr` 各自记录。本人绑定未就绪只使第二轨暂停；不能因此把真实云功能标通过，也不能阻止本地工作。模型/ASR能力未知同样局部暂停，不假称 Harness 是 ASR。

### 已有成果如何用

| 成果 | 复用方式 | 不照搬 |
| --- | --- | --- |
| 旧 Auth 核心/测试 | 逐函数审计提取，接原 desktop；重新验证自己的开发 Supabase 目标和会话隔离 | 旧独立红黑壳、假工作区、旧宿主路径 |
| K01/N1、K07、旧门禁/测试 | 保留原提交和测试意图；按新原版宿主/媒体修改扩充最小包再签收 | 旧通过不自动授权新工程或剪媒体 |
| Fission 70 文件 | 同仓 worker 原内核；先隔离，再修证伪缺陷/捕获实际决策 | 不从 MP4/seed 反推工程，不启动第二套 Web UI |
| 原 OpenFilm UI/CLI/编辑/导出 | 直接扩原组件、原操作链和原格式 | 不假造现成 edit/剪口播 CLI，不把 render 当保存 |

## 2. 最小依赖与并行图

```text
计划确认
 ├─ T01 隔离/门禁单写引导 ── N5a 当前写集准入
 ├─ T02.a 最小身份/命令契约 ── T03 原首页+鉴权接入
 ├─ T02.b 素材引用/权限契约 ── T04.a 素材适配与替身
 │                                      └─ 本人绑定就绪 → T04.b 真实只读
 ├─ T05.a Fission隔离纯逻辑 ── T02.c任务包 → T05.b 宿主/真媒体
 │                                                        └─ T06 决策/续编
 └─ T02.d剪口播设计/fixture ── T07 识别/时间映射 ─┐
                    └──────── T08 严格编辑/恢复/CLI ├─ T09 原UI剪口播
 T03完成共享UI写者交接 ───────────────────────────┘
 T03 + T04.a + T05/T06 + T07/T08/T09 → T10 最新实际候选集成 → dev
```

T05.a 的路径纯函数、T07 的合成样例/纯算法准备可先做，不消费未冻结业务字段；真实消费者按对应 N1 提交准入。T02 按 a/b/c/d 顺序单写，可先交可用子包，不要求全部 K 包就绪。T06 真实业务渲染另需可信组内准入，不被 T05 测试宿主代替。T04.b 不在本地候选关键路径；完整含云验收仍需它通过。

### 调度规则

- 总控维护 ready/waiting/review/integration 队列；本轮工具上限4个活动Agent含总控，实际容量以每次运行核验，不固定实现人数。
- 第一空槽优先待审；没有待审且依赖/写集/资源满足才派新的实现。每一变更的规格和质量由非作者分别给结论，总控写过的也另找非作者。
- 每包一名作者、一份唯一任务卡、独立受管 E 盘树；共享 `App/ProjectView/Timeline/CaptionsPane`、main/preload/bridge、server入口、根 workspace/lock/CI、07/fixtures分别单写；交接后才能下一包修改。
- 原生工作树工具未恢复时，最多在现有合格隔离树做获准单写引导；只读研究可并行，不手工绕过管理工具创建/删除树。
- Windows桌面、GPU/编码、剪映和正式集成候选各一份独占租约；CPU纯函数测试可并行。每张卡记录端口/DB命名空间/缓存/输出及释放证据。
- 首次并发写入前实跑N5a：越界写共享文件、破坏旧消费者、必测skip三类拒绝反例；未部署的门禁不能算已通过。基线/契约前移只重验受影响包。
- 未来模型路由按09：常规确定模块选标准能力；授权/修订/恢复/并发准入用高推理；实际Agent/model/effort从运行时登记，不编造模型可用性。开发Agent开销与产品50元模型测试预算分账。

## 3. 文件与职责地图（新增均为提案，不表示已存在）

- 原类型/IO在原模块直接引用；`packages/contracts/src/phase1/`仅为确有跨边界缺口的候选位置，不预先创建。07登记最小增量/映射及TS/C#样例，禁止复制FilmValue/Op/ExportAsk等原生Schema。
- 新业务优先在现有合适接缝增加小模块；`packages/orange-application/src/{identity,assets,fission,speech,project-commands}/`仅在确有消费/构建隔离需要时登记创建，不先建一层通用应用框架，不重写原编辑服务。
- `apps/api/src/{identity,bindings,zhishang,claims}/`：既定 Node/TS 可信服务模块；公司密钥/绑定/共享准入；非每功能新建服务。先本机隔离实例，不改生产或部署配置。
- 原 `apps/desktop/src` main/preload、`shell/bridge.ts`：受限实例桥接、进程生命周期；新增适配薄层，不复制应用规则。
- 原 `packages/openfilm/studio/ui/src/components` / `lib`：复用首页、素材、字幕区域；新模块可用 `Home.tsx` / `SpeechCutPane.tsx` 等名，由相应作者单写。
- 原 `packages/openfilm/studio/server` 和 CLI：只接已校验的原工程操作，必要 `.mjs` 桥接保留原模块风格，不全量改写上游。
- `workers/fission/src` / `tests`：保留 .NET；路径、worker协议、实际方案记录、纯逻辑与真媒体测试分别交付。
- `.dev/phase1/<task>/<attempt>/`（忽略）和 D 盘候选运行区：隔离数据/合成媒体/输出/证据；不把测试账号、真实字幕、URL或私有配置提交公开仓。

每个经证据确认必要的新增包，其最小 package/config/test入口归T01单写接入原 workspace，不另建第二root lock；具体导出只在相应N1固定。不先搭未被当前消费者需要的整套架构。

## 4. 工作包与逐包门禁

### T01 隔离和真实门禁引导（共享基础单写）
**前置：** 本计划获批；当前原版提交、适用工具/环境和旧后台进程已核。
**文件：** 原根 package/workspace/CI、desktop 启动配置；新增 `scripts/phase1-isolation.mjs` 及对应测试、任务范围/证据检查；13登记新增边界。
**接口：** 产出固定实例ID、目录能力、运行配置与受保护任务卡版本；不定义全首版业务字段。
- [ ] 写失败测试：默认共享 `~/.openfilm`、C盘增长、跨实例路径、根lock竞争应被拒。
- [ ] 实际跑失败并记录原因；最小接入独立profile/home/projects/Saved/Library/exports/skills/下载/日志/temp/crash目录与端口，均D/E。
- [ ] 验原版构建/类型和受影响测试，实跑越界/兼容/skip拒绝；保留N5a适用证据。
- [ ] CI增量检查在工作分支/后续dev/PR明确触发；只开本仓受控验证，不启官方发布或付费硬件、不写真实云凭据。远端保护另批并核实，不伪称强制门禁已配置。
- [ ] 非作者审查范围/隔离及拒绝证据后提交，登记确切可消费提交。未就绪只能单写引导。

### T02 原生协议对齐与最小增量（按消费者分批就绪）
**文件：** 16源码引用、07必要增量/映射、原模块类型与特征测试；仅跨语言/新业务确需时建立最小契约文件；原Auth定向提取另审。
- [ ] 先逐项标native-reuse/extension/business-addition并引用真实原输入/输出/路由/命令/单位；原生复用用源码pin+特征测试就绪，不先发明新DTO。
**子包：** a身份/实例/命令(K01/K07)；b素材/版本/权限(K02及K06只读子集)；c任务/实际方案/准入(K03/K04/K05)；d剪口播选择/时基/确认/恢复(K01/K04/K05/K07增量)。名称不是新K号或已冻结DTO。
- [ ] 各子包先列生产者/消费者、请求/结果/错误/版本、唯一写端、正反fixture及存储/恢复映射；只冻结当前使用范围。
- [ ] 先写并运行失败校验测试，对必要业务增量实现机器校验，TS/C#读同一JSON；原API仍保留秒/毫秒/字符串rev和原ID；转换只在明确边界。增量未知版本/不安全整数/缺必填拒绝，不自动补零；原生旧行为也要回归。
- [ ] a补身份可信验证/本地对象归属，c补真实组内原子预占及未知占用保护；不能用本地内存模拟代验收。
- [ ] d新增严格资源修订和确认范围；逐条展示原K01字幕N1哪些复用、哪些不覆盖，媒体写入授权不得继承旧签收。
- [ ] 规格/质量独审、消费者签收、Ethan对高风险身份/权限/媒体命令签核；登记设计就绪与可消费冻结的不同状态和确切提交。

### T03 原首页与真实鉴权导航
**前置：** T01、T02.a；不依赖智尚本人绑定或Fission已运行。
**文件：** 原 `App.tsx`、`Launcher.tsx`、`ProjectView.tsx` 品牌接缝、desktop `main.mjs/preload.cjs`、`shell/bridge.ts`、UI `lib/host.ts`；新 Home和导航测试；Supabase业务核心从已审旧源码定向复用。
**接口：** 原项目列表、受限HOME激活、已验证本人会话、卡片ready/blocked原因；未就绪卡片不造假内容。
- [ ] 失败测试：首页→原工程→首页→同工程，保留选区、Undo、未保存状态、Agent/导出；原HOME与项目view保活，不靠卸载ProjectView切页。
- [ ] 实现卡片：超级混剪/创作中心/素材管理/最近项目；原模板/Skills和草稿入口复用。品牌回HOME，右上同一SettingsModal/Services；不做侧栏。
- [ ] 失败鉴权测试：离线冷启动/旧会话重启拒绝，合法运行中断网不清工程，第三方云失败不踢出第一方；换号不读另一人项目。核验自有开发Supabase项目，不改密码或账号作为默认调试手段。
- [ ] 原Electron Windows实测真实登录→首页→Edit/Canvas→设置→回原工程；100/125/150%缩放、窗控/拖拽/键盘检查并截图。
- [ ] 非作者审查后提交；把共享UI写集正式交接给T09，旧截图/旧壳登录通过不代新集成。

### T04.a 素材目录与智尚只读适配；T04.b 本人真云联调
**前置：** T02.a/b、T01；T04.b另需明确本人账号绑定/标识，当前没有accountKey。
**文件：** TS assets/bindings/zhishang模块；原 `workspace-resources.ts`、`MediaSources/MediaPool`、Saved导入接缝，入口共享文件由集成人接线。
- [ ] 用合成fixture写失败测试：主体/绑定隔离、资产身份/内容版本/表示分开，成功空结果≠未绑定≠无权≠超时未知；正式标签≠模型候选。
- [ ] 最小实现原素材源浏览、筛选/分页和受控导入；Studio/Fission引用同一版本/来源授权；不建平行素材UI或平级正式标签库。
- [ ] 拒绝反例：他人ID、旧绑定、同hash跨用户、直链/缩略图/转写越权、URL跳转/过期、撤权；无绑定仍能用合法本地素材。
- [ ] 真实联调仅在本人绑定确证后做最小定向只读；公司认证成功不能替代本人素材通过，不扫全公司、不借管理员兜底；原片地址查询会计下载次数，不作无副作用预览。
- [ ] 独审和原UI合成素材拖入/保存重开通过后交付a；b保持 `blocked_personal_binding`，其它包继续。云上传/标签写不在本包。

### T05 Fission隔离、受控宿主和真实执行
**前置：** a路径纯逻辑仅需T01；b协议/真媒体需T02.c和路径隔离证明。
**文件：** `EnginePaths.cs`、CLI/Web的配置入口、`FissionEngine.cs` 输入消费/缓存；新路径策略/worker协议、desktop受控进程适配和对应测试。
- [ ] 失败测试覆盖旧D默认路径、相对/逃逸/链接、job.OutDir越界、Web未读CLI配置、共用缓存、`AudioUses==1`移动原配音。
- [ ] 显式注入引擎只读路径与每任务work/out/config，首轮仅任务输入副本；原媒体SHA256和位置不变，不靠移动/删除源文件记消费。
- [ ] 协议测试进度、错误、取消整进程树、迟到结果、重复回执、attempt重试固定输入；stdout不混日志/凭据，超时不报成功。
- [ ] 核`.NET10`/编译壳和已许可引擎依赖；缺SDK/私有引擎/资源单列，不安装或修改系统安全设置换绿。实媒体前只跑纯逻辑；现有会早退的测试必须能识别skip/缺样本。
- [ ] Windows合成小样例核文件/时长/音轨/输出规格；真业务新组合必须真实可信准入，取消与已完成成果保留，未完成不计数。
- [ ] 非作者审路径/进程/源文件保护并提交；不启动独立Fission Web工作台。

### T06 Fission实际方案固化与原Studio续编
**前置：** T05、T02.c；受控资产引用和原编辑命令最小端口就绪。
**文件：** .NET实际选材/分割/变速/构图/字幕音轨决策形成处新增FrozenPlan记录；TS fission-import适配；原项目创建/依赖保存入口薄层。
- [ ] 先写失败样例：固定数字组序、组内抽数/复用、同视频换实际配音/BGM、相同内容换编码；复现文档FIS-001/002再根因修复，不先猜补丁。
- [ ] 捕获实际源版本/区间/序号/变速/翻转/字幕/音轨和能力报告；MP4/seed/JobReport不冒充可编辑方案。
- [ ] 无改导入原film后可分轨继续编辑、保存关闭重开；原计划仅来源，film修订唯一可写权威。
- [ ] Windows比较同方案直出与Studio导出时轴/音画字幕，不只比hash；未知效果/缺依赖明确拒绝/报告，不静默扁平化。
- [ ] 真实准入并发/离线已准入续跑/未知不释放/80-100计数反例与跨语言样例；独审通过才认该闭环。

### T07 剪口播识别、候选和时间映射（不写工程）
**前置：** T02.d最小范围/时基样例；纯算法先用明确合成数据，不等真实云或模型。
**文件：** TS speech分析/时间映射；原 `transcripts.mjs`、provider只读适配；原timeline-edit原语复用，不另建时间线。
- [ ] 失败测试：单选/多选/全工程、人声与BGM、同源多实例、裁剪/变速/复合片段、帧边界；源时→实例→工程映射，非选中实例不变。
- [ ] 词时间缺失、低置信、无字但有声音、重叠发言/锁轨明确标记或拒绝；一轨空白不能删另一轨人声；词起点不伪造完整词结束时间。
- [ ] 输出分析/候选/用户可选删除计划，不在识别时改film；改错字与删媒体意图区分。
- [ ] ASR单独核现有Services提供者/词时间/费用与获准输入；Harness先以无敏感最小LLM调用验证，不当ASR。费用不可确认只停该真实调用，合成算法照常。
- [ ] 独审算法与越界反例，签收可消费计划提交；真ASR未跑则不能声称识别已通。

### T08 原编辑服务严格提交、恢复、一键撤销与受控CLI
**前置：** T02.a/d；可与T07按共同fixture并行，最终消费T07固定计划。
**文件：** TS project-command/resource-commit及测试；原 `film.mjs/server.mjs/caption-tracks.mjs`、字幕生成/同步写端和外部文件watcher受限接缝；原 `caption-tracks.ts/use-film.ts`撤销；CLI dispatcher受控新增入口，准确命令名在N1签发，不假写现成命令。
- [ ] 失败测试：只改VTT也使旧计划失效；旧expectedRevision拒绝，禁止沿原base自动rebase；同键同payload回原结果，同键不同payload冲突。
- [ ] 实现预览/确认摘要/授权及资源闭包校验；film、VTT/parts、业务head和幂等回执有可恢复journal/提交标志与重启核对，不宣称文件rename跨资源物理事务。
- [ ] 同工程全部受影响旧写端（原film edit、caption PUT、from-subtitles/sync等）接同一提交协调闸门，不只包新CLI；原film私有serial和外部settle自动合并不能绕过。外部非受控写不能假装被锁住：提交/恢复前后核闭包，发现新写隔离冲突、保全两版，不覆盖并发或恢复后的新编辑。
- [ ] 原Undo/Redo同样走该协调；读取/预览/导出绑定已提交资源闭包和修订，不能读到journal中间film/VTT混合态。对并发预览/导出补固定旧版或完整新版的反例，不只验证写端回执。
- [ ] 注入每个写入阶段故障：VTT写后退出、film失败、receipt失败、磁盘满；重启前后只能完整旧版或核验后的完整新版，不显示半成功。
- [ ] 并发反例：确认后旧caption PUT/字幕同步插写、film自动settle、VTT-only外部写、崩溃后外部新编辑；必须排队或明确冲突且原数据保全，不能靠最初一次digest校验放行。
- [ ] 一次Undo/Redo恢复音画字幕与位置；后续/外部编辑不能被盲恢复；原片hash不变。CLI/UI/Skill共享同一执行边界，不给任意shell或文件写入。
- [ ] CLI绑定指定实例/工程/主体，不沿宽松run.json发现误连旧版；缺参数/越界路径/他人项目/已撤权限拒绝。
- [ ] Windows真实音画字幕小样例+故障恢复，规格/安全/质量独审；Ethan签核高风险媒体命令后才交消费者。

### T09 原字幕区内剪口播交互
**前置：** T07/T08 consumer-ready、T03共享UI写者释放；原版UI内验收，不新做预览站。
**文件：** 原 `Timeline.tsx`分割按钮旁、`library/CaptionsPane.tsx`/新SpeechCutPane、ProjectView及use-film薄适配（共享修改串行）。
- [ ] 先写失败状态测试：默认选中/多选、可切全工程人声、选字/空白/试听/保留/取消，分析失败可恢复；未确认工程零写。
- [ ] 原组件主题增量唇形入口；展示受影响轨/时长/冲突，不静默解锁/跳过；确认只覆盖所选计划及版本。
- [ ] Windows实际应用→原轨道多段音画字幕同步合拢→保存重开→一次Undo/Redo；CLI失败不报成功，改文字不自动剪音视频。
- [ ] 非作者规格/质量审查及原版前后截图，提交；没有真实ASR的场景明确 `fixture_only`，不得冒充完整识别验收。

### T10 串行集成、一期验收与现有dev回归（不是整个goal终点）
**前置：** 相应包独审通过，非作者核影响集合和当前提交；只暂停缺的子轨。
**文件：** 集成台账/根CI/支持矩阵/恢复报告；不让功能作者关闭自己检查。
- [ ] 每个合入候选串行生成真实组合提交，重新运行受影响类型/构建/单元/契约/权限/媒体/E2E；相邻包各自绿色不作为组合通过。
- [ ] D盘正式候选实测：真实登录→原首页→有权本地/已验证智尚素材→Fission与Studio复用→原工程续编/保存重开→剪口播确认/Undo→视频导出，原设置/Edit/Canvas回归。
- [ ] 真云绑定、真ASR、目标档位、剪映开改存重开、安装升级、10/50/100负载分别记录未测/阻塞，不用本机一条小样例冒充M4发布。
- [x] Git基座纠偏（非功能验收）：Ethan明确当前原版可作dev起点；D:/dev/orange已切dev@8b8ef16，旧dev/源文件/暂存完整保全。后续功能从最新dev分支，独审和实际候选门禁后串行回dev，不再重复规划切换或从旧壳开工。
- [ ] 每次实际合入dev后从该精确头分后续主题树；main必须PR且Ethan确认，tag/发布仍另批。提交/测试/审查/恢复及未决全部进执行台账。

## 5. 命令和证据（待实施时运行，不是本轮已通过）

从批准的候选绝对路径运行，Node/pnpm版本先核对（根Node≥22.18，pnpm9.15.9，原lock）；不用裸dev启动污染共享用户目录。

```powershell
pnpm -C "D:/dev/orange" --filter openfilm typecheck
pnpm -C "D:/dev/orange" --filter "@openfilm/desktop" typecheck
pnpm -C "D:/dev/orange" build
pnpm -C "D:/dev/orange" --filter "@openfilm/desktop" test
pnpm -C "D:/dev/orange" --filter openfilm test
pnpm -C "D:/dev/orange" audit:public
pnpm -C "D:/dev/orange" check:pack
```

精准RED/GREEN选测沿原`timeline-edit/timeline-split/caption-edits`、editor `undo/steps`、server `film/caption-tracks/transcripts/closure`及desktop `tabs/page-presentation/shell-page`测试入口；每张任务卡固定实际命令/退出码/输入hash，不以全量长测替代RED根因。

仅T05隔离/编译壳审查后，.NET候选命令：
```powershell
dotnet test "D:/dev/orange/workers/fission/tests/Fission.UnitTests/Fission.UnitTests.csproj"
dotnet test "D:/dev/orange/workers/fission/tests/Fission.IntegrationTests/Fission.IntegrationTests.csproj"
```
测试目录名不是媒体实测证据；缺资源早退不算PASS。新增TS模块用Node测试/现有TS编译配置接入，确切命令在T01交付前验证，不杜撰当前不存在的script。

每包最小证据：task/assignmentRevision、作者Agent/实际model/effort、基线/依赖契约提交、工作树/写集/资源、RED→GREEN命令与输出、真实/替身边界、原始/集成提交、非作者规格与质量结论、恢复与未决。沿docs/execution唯一索引登记，私有素材/凭据/完整日志只留私有证据区。

## 6. 确认范围

请确认本一期分包/依赖与“先原版增量、局部阻塞、审查优先、串行集成”方案。确认后在该范围内连续执行，不逐任务问继续；越界外部动作、必要高风险签核或语义改变仍暂停受影响项。当前只提交修订计划/交接文档，不开始业务开发。新会话明确启动并批准范围后按18连续执行，完整目标按17收口。
