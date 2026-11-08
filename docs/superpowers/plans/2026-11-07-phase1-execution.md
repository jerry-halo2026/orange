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


## 2026-11-08 T02.a Authservice local refinement

Approved direction: original desktop/Studio, signed three identity/offline/switch N0 boundaries. This is an implementation refinement under T02.a, not new pilot scope or a second app. Parent task registry remains the only lifecycle source.

### Goal, approach and source facts
Use a two-file native .mjs/JSDoc service in apps/desktop/src, injected fetch and monotonic clock only. Do not add supabase-js/package/lock, storage, routes, bridge or UI. Reuse audited old-core ideas (bounds, redirect refusal, generation cancellation), never its restricted secret-shaped fixture or old shell. A new browser SDK would introduce refresh/storage defaults; an invented login would not authenticate. The original native main's frame/key and Studio key only establish local channel trust, not first-party subject.

Official source pins read 2026-11-08: supabase/supabase-js 0b83a9c1594af9ee4667fcf32bf1f77a1a12f0db packages/core/auth-js and supabase/auth 35307ce6c1ca59016fd820f1d77d9b6201dc2e15. Types define expires_in in seconds since issue; server UserGet sends the user; user.go explicitly emits is_anonymous bool and omits empty factors. Therefore missing factors is valid no-known-factor shape, NOT malformed merely because optional; factors present must be an array, statuses verified/unverified, verified factors or unknown statuses are unsupported for this password-only slice. Do not copy user/app metadata into authorization. Current source != actual project's deployed version; D12 real environment/test identities still must be confirmed.

Primary references: [types](https://github.com/supabase/supabase-js/blob/0b83a9c1594af9ee4667fcf32bf1f77a1a12f0db/packages/core/auth-js/src/lib/types.ts), [client](https://github.com/supabase/supabase-js/blob/0b83a9c1594af9ee4667fcf32bf1f77a1a12f0db/packages/core/auth-js/src/GoTrueClient.ts), [server user](https://github.com/supabase/auth/blob/35307ce6c1ca59016fd820f1d77d9b6201dc2e15/internal/models/user.go), [UserGet](https://github.com/supabase/auth/blob/35307ce6c1ca59016fd820f1d77d9b6201dc2e15/internal/api/user.go), [getUser](https://supabase.com/docs/reference/javascript/auth-getuser), [signout](https://supabase.com/docs/reference/javascript/auth-signout), [sessions](https://supabase.com/docs/guides/auth/sessions), [changelog](https://supabase.com/changelog). Markdown index request unsupported content-type400; HTML read and relevant breaking changes already reviewed. No actual project API/config was read.

### Exact internal interface
Only export createAuthService({environmentId,authOrigin,publishableKey,instanceId,epoch},{fetch,monotonicNow,requestTimeoutMs}); return frozen methods getPublicState,signIn,revalidate,getVerifiedEvidence,signOut,dispose. Each config/dependency/input is a strict own-data-field snapshot; no arbitrary getters/coercion, unknown config/input fields reject. Invalid config/deps throw fixed invalid-configuration, never echo input. Require nonempty stable environmentId/instanceId and positive safe integer epoch. HTTPS origin may have only an optional root slash; no username/password/query/hash/subpath, normalize root once. publishableKey printable header-safe bounded <=8192bytes; reject known sb_secret_ prefix and decodable legacy service_role roles only as negative config validation (decoding is not authentication), never include a real credential-shaped fixture. Require injected fetch and clock, no default globalfetch/env/files. requestTimeoutMs integer1..30000.

PublicState frozen exact {kind,reason}; kind signed-out/signing-in/active/expired/revoked/clock-anomaly/disposed; reason null or a fixed code. Operations frozen exact {ok,code,state}. SignOut frozen exact {state,remote}, remote not-attempted|acknowledged|unconfirmed. Codes: ok,invalid-input,invalid-response,authentication-rejected,identity-mismatch,anonymous-user,unsupported-auth-flow,request-timeout,response-too-large,redirect-rejected,verification-unconfirmed,busy,switch-required,not-active,expired,clock-anomaly,superseded,disposed. No URL/identity/password/token/raw exception/response/fullsession in public results or logs. getVerifiedEvidence is trusted-native-only, exact existing policy six fields environmentId,subjectId,instanceId,epoch,establishedAtMs,expiresAtMs, frozen or null; not exposed to renderer by this package. Tokens remain a private memory reference, no refresh/persist/restore.

### Requests and finite authorization
signIn snapshots exactly email/password, strings only; email <=320chars nonempty/no controls, password 1..4096UTF8bytes (do not trim/normalize password; Unicode allowed). Reject unsupported extra owner/epoch fields. New service always signed-out. Single-flight signIn/revalidate returns busy for overlap. Once any session was successfully activated, every later signIn on this service returns switch-required without fetch, including expired/revoked/signed-out states; trusted controller must complete preservation and create a new service epoch. This prevents service-level account replacement from bypassing the policy barrier; it does not prove actual preservation.

At exchange start sample m0 from injected monotonic clock. POST origin+/auth/v1/token?grant_type=password with JSON email/password, apikey, accept/content-type JSON, redirect:error. Then GET origin+/auth/v1/user with apikey and Bearer access. No other endpoint/retries. Require success response JSON access_token/refresh_token finite bounded strings, case-insensitive exact bearer token_type, positive finite expires_in with finite nonoverflowing m0+1000*expires_in >m0, exchange user ID and online user ID exact equality. Supabase subject UUID syntax is provider-specific and must not change native project/clip IDs. Online user explicitly is_anonymous:false; missing/true/nonboolean refuses activation. Optional factors omission/empty valid; verified factor or unknown/malformed factor shape refuses unsupported flow. Known unverified factors alone do not require AAL2. On error CAPTCHA/MFA routes are not attempted; report fixed unsupported flow if machine code identifies it, never parse/return upstream prose.

Fixed evidence establishedAtMs=m0, expiresAtMs=m0+1000*expires_in. Online GET completion time consumes the lifetime; equal/after cutoff cannot activate. Ignore optional expires_at for granting/renewal (no client wall-clock recalculation). Every state/evidence/async completion checks finite nonnegative nondecreasing monotonic clock, sticky terminal anomaly; equality expires. Property/clock/transport reentrancy cannot overwrite dispose/revocation/new generation. After each await, recheck owning operation+generation before another request/state write. Timeouts cover fetch AND streaming body, <=65536bytes per response, cancel/abort on failure; do not await an untrusted cancel forever. Transport may ignore abort in tests: timeout still resolves safely and late responses cannot issue a subsequent request or reactivate. No background UI/refresh/expiry timer in first slice; actual sleep/resume/clock adapter and immediate view retirement remain integration gates.

revalidate only while current active: GET same online user, no token exchange/refresh and no deadline reset. Valid same nonanonymous user keeps active; explicit401/403 or subject mismatch/anonymous/known newly verified unsupported factor invalidates local evidence, no global revocation claim. Network/timeout/429/5xx/malformed unconfirmable protocol returns verification-unconfirmed but retains prior active authorization ONLY until original deadline; never turns unknown into known revoke or infinite grant. Expired/revoked/disposed/anomalous cannot revive.

signOut synchronously invalidates generation/evidence/token and aborts pending operation before awaiting POST /auth/v1/logout?scope=local using captured token. 204 acknowledged, other outcomes unconfirmed; no retry/global logout. Repeated signOut is idempotent/no duplicate remote request; dispose is sync terminal/idempotent/no network. Late completion never overwrites current disposed/clock anomaly state. Already-exported evidence is immutable data: future trusted controller must revoke associated policy/streams in the same boundary; this service does not magically revoke old copies or hide actual views.

### TDD and verification
- [x] Write/configure tests with synthetic transport/streams/clock; see card15groups, watch absent capability then genuine behavioral RED before implementation. No real fetch/listener/config.
- [x] Cover happy two-request chain, native six-field policy compatibility, omitted factors, mixed bearer casing, malformed/nonJSON/oversize/redirect, subject/anonymous/MFA denial, lifetime spent in both requests, overflow/exact cutoffs, clock and getter reentrancy, busy/stale cancellation/signOut/dispose, unknown revalidate retention, switch-required, local-only logout, no refresh and sentinel secrecy.
- [x] Implement only the two allowed files; no source dependency/export/bridge/renderer edits. Tests may import actual same-tree Studio policy by filesystem path; production module must not hardcode cross-repo imports.
- [x] All new pure tests zero fail/skip/todo/cancel, existing policy92 and CPU84, syntax; report firstfail/allattempts/sourcehashes. Non-author exact-diff spec/quality and root independent verification precede local source commit. Ceiling local-transport-policy-ready, not realAuth/N1/T03.

## 2026-11-08 T05.a controlled fileIO refinement

### Goal, native consumption and alternatives
Consume tested EnginePathPolicy in actual original FissionEngine source and compile/test it through original UnitTests ->Providers reference. Helper-only would leave original File.Move source behavior intact; reflection or new harness would be longer. Providers references Core and public pinned System.Management10.0.14, no privateengineDLL. Add just the fourth allowed csproj reference, no new test/worker/app project or protocol. Public restore needed transitive closure must be recorded, never guessed.

Files: new Core/Engine/EngineJobFiles.cs; existing Providers/Pipeline/FissionEngine.cs; new original UnitTests/EngineJobFilesTests.cs; existing UnitTests.csproj one Providers ProjectReference. Original job/MaterialItem/ConsumeLog schemas, original policy/tests, buildprops/shim, CLI/Web/config, rootlock/workspace/CI remain unchanged.

### Required source behavior
Add explicit controlled constructor/entry using EnginePathPolicy and its exact Paths, no second inconsistent _paths. Preserve old constructor/entry as legacy explicitly unisolated, do not use it in tests or admit CLI/Web. On controlled original RunAsync, ValidateJob and all computed work/out/cache paths must pass before mkdir/probe/copy. Work/norm/voice/temp/cover/concat/output stay under this attempt; use CacheRoot, not shared WorkRoot INI. Timestamp job IDs do not replace the trusted task/attempt scope. Reject unsafe reuse/conflicts rather than overwriting other attempt data.

Actual BuildPool must stage approved external audio via the same helper BEFORE probe and MaterialItem insertion. Source opened read-only, private owned destination created with CreateNew, no target overwrite. Preserve filename/basename, original job.AudioDir and original parent meta.json lookup (subtitle/name behavior), do not mutate job to point to a fake source directory. Input directory/path fields still need future trusted authorization; filesystem policy does not prove owner/license. Reject relative/escape/junction/symlink/nonregular or input/writable overlap before consuming; actual open/create/registration checks revalidate paths. Point-in-time checks do not claim hostile concurrent replacement immunity.

Only files registered as this helper's current attempt-owned audio copy/generated audio may archive. Original audio/source-adjacent _consumed is never created in controlled flow. After pool.Confirm, AudioUses1 archives only registered task copy under own task _consumed; confirmation remains usage authority and no new count/schema is invented. Generated audio has no external source but must be registered after validated own output creation before it can archive. Fail/cancel/copy/partial output never removes/moves original source; preserve owned incomplete evidence or clean only a newly owned partial file after strict containment, never broadcleanup.

### Actual-file/original-callsite TDD
- [x] Add Providers ref and actual BCL file/helper + original controlled RunAsync tests, watch genuine missing capability/unsafe original behavior RED. Restore uses new owned public/cache-only config, never existing Nuget configs; actual SDK10.0.300, no install.
- [x] Minimal synthetic bytes: VideoDir/01-scene/video.mp4, AudioDir/配音 one.mp3; Count1/Threads1/AudioUses1, duration2, SplitModeNone, transition0, NVENCfalse+ctorfalse, flipfalse, BGM/intro/outro null, subtitleoff normally, legal original1080x1920/30fps defaults. Placeholder engine files/assets exist but never execute.
- [x] Fake IVideoEngine/IMediaProbe implement exact Core interfaces, record calls/cancel and ensure allowed input/output scope. Only known original command shapes may create synthetic output bytes under owned dirs; never instantiate ProcessPool/hardware/FFmpeg/ffprobe. Original Concat itself writes a list, which must also be owned. This proves file control/orchestrator behavior, NOT media/rendering.
- [x] Direct original entry invalidOutDir: source/job otherwise valid; exception, engine/probe calls0, no work/out/cache creation. Positive full RunAsync confirms staged audio in probe+merge, original bytes/hash/path unchanged, source folder no _consumed, only registeredcopy archived after Confirm, success/count retained. Two attempts/cache/output disjoint.
- [x] Copy failure/cancel, destination preexists (including hardlinked/precreated target), original/foreign/unregistered archive input, relative/escape/junction cases all refuse without source mutation. Do not assert source-hardlink file identity is proven merely by path checks.
- [x] Subtitle case: original AudioDir parent metadata items file=配音 one.mp3,text=synthetic line; actual sub.ass contains line, output naming retains stem, job unchanged.
- [x] Genuine new file-symlink cases must exist; local EPERM is an ENV failure, not return/skip/PASS. Historical local ENV failures remain recorded. The separately reviewed hostedCI run42419906355 has now executed both truefilelink cases and all34passed, so this local-ENV gate is closed only for the controlled-fileIO subset. Old43 proof alone never covered new I/O.
- [x] SDK help actually advertises --artifacts-path for restore/test/build; use owned new per-project artifacts and verify paths, no overwriting old bin/obj; absent capability stops. Compile actual Providers via original Unit graph, not stub/reflection/temp project. Root independent tests and non-author source/runtime-scope review beforecommit.

- [x] Separately rerun original standalone MaterialPool confirm-count tests under a new bounded approved test card before claiming those original test cases passed. Source/fixtures are unchanged, and the selected43+34 classes exercise originalPool behavior through RunAsync, but do not substitute for this standalone suite. No new runtime filter was smuggled into rev14.

### Handoff limits
No real CLI/Web/config/hardware/media/private engine or worker/admission/actualPlan protocol launch. Original early hardware probes/config defaults remain unsafe. RuntimePathsIsolated staysfalse; only protected file-copy/archive/original-callsite behavior under Fake codecs may be claimed. New csproj graph and added files require coordinator's later separate CI input-closure+new test-result gate change; source author cannot touch CI. No original43/oldhead green used as new helper coverage. Source, logs, package versions, scope failures, all first attempts retained under .dev/fission-io. Mac arm64 still untested.

执行细化纠正（2026-11-08）：原最小夹具曾误用VideoDir根目录video.mp4；实际MaterialPool以Group为空识别配音，故原入口测试先得到materialShort。总控核原源码后只批准改为原生01-scene子组，首轮28例20pass8fail与旧fixture留存。未修改MaterialPool/DTO/算法，根目录视频分类缺口仍列待验证，不冒充修复；这不缩小产品范围。


## 2026-11-08 CI closure for controlled IO

Coordinator single-root-CI writer taskT01rev13 consumes source-reviewed IO6048 and Auth274b. Old actual43proof remains only pathpolicy, while new34class has two localfile-symlink ENVfail. Only four CI files allowed, no C#/project/checker/docs changes by sourceauthor.

- [x] Write new strict34TRX-descriptor/required2filelinks+2fallbackcases/closedbuild-input andphase1Auth/policy cases, watchRED. Preserveold218strict cases andallfirstfailedreports.
- [x] Minimal internalstrictvalidator reuse, sealed43/34suite constants, source canonicalhashes ascard; enumerate currentcandidate compiledsource/project graph includingProviders/helper/newtests beforebuild and recheckafter, no untracked/link/foreignproject allowed.
- [x] SameactualpreinstalledSDK10.0.403/ownedoneSDKinventory/realX64host/pfx86, publicexplicit originalUnitgraph16packages only, --artifacts-path ownedoutputs. Separate real original43and34filters/TRXs, no mixedfakepass/skip/oldhead inference. Runtime remains Fakecodec fileIO not media.
- [x] Add nativeAuth81/policy92pure tests toexistingphase1(331expectedcaseexecutions) withoutdeps/network, sameWindowspublicscope, permissions/timeout/noartifact fixed. AllCIcodepuretests/syntaxpass, non-authorreview andRootindependentverify beforecommit. Authorno.NET/entry/job/push evenmocked.
- [x] Root laterfreshsource/historyprivacy/publictarget/cardN5a andseparateone-joblease; actualsamehead43+34mustfullypass0skip beforeIOconsumerfreeze. PreservefirstrootCI failure42406704504, old43success42410466762, sourcequalityfix/SDKpolicydeviation. Newjobfailure notskipped/rerun automatically. No production/devmain/tag/remoteconfig/model/media/privateupload.

执行回执（2026-11-08）：CI源25e44b经非作者源码审查、总控299/331纯测试及外置N5a84后冻结；Root runtime14在不可变1a28、完整新历史审计/即时public远端核验后只推主题分支。同head真实run42419906355/job128545885418成功：43/43与34/34，0fail/skip/inconclusive，truefilelinks和fallback均实跑；companion42419906370实际331/331。源码/真实证据/局部consumer冻结分别独审批准。回执74f56fc和t05-controlled-io-readiness仅局部完成，非整T05/T01或pilot。此前旧43/本地ENVfail/首CI失败不抹除，不更改主仓dev/main/tag/远端配置。

计划状态审查纠正（2026-11-08）：受控IO source6048及真实Windows34通过已证步骤逐项勾选，避免恢复时重复实现；原独立MaterialPool confirm-count测试未在本次43+34过滤器选择，单列未完成，不能因代码未改而声称已实跑。该剩余选测及完整宿主/媒体/试用门禁保留，不缩试用范围。

同类状态精确化：Authservice local refinement四项也已由274b与t02-auth-service-validation的81Auth/92policy/84CPU及独审/总控验证满足，勾选只覆盖本地注入服务，不代表真实Auth/父通道/持久归属/UI或N1/T03。D12与保全/资源退役仍待后续原生接线。


## 2026-11-08 Auth synchronous invalidation producer

Classification native-extension, T02.a rev5. Engineering choice under Ethan-approved N0: future actualAuth and access authority share originalStudio utility, not copiedcrossprocessdeadline. First freeze the smallest missing synchronous signal producer, before anydependentcontroller/sourcewriter. Exact API/order/reentrancy/negativefixtures andtwofile write set: execution/t02-auth-invalidation-assignment.json; Auth274b andpolicyacc27 are inputs, not a declaration of N1.

- [x] Add newbehavioral tests on actualcreateAuthService with optionalown-data hook; genuineRED before sourcechange. Preserveoriginal81 and exact6public methods. Strictbaddeps/getter/hookthrow/abortorder, reentrantdispose/signOut/clock/reentrantlogin, nativePromise rejection andunreadthenable negatives.
- [x] Minimal synchronous notification after localgeneration/session/flight/state invalidation and before external cancellation. No recursivehook, no newauthorization fromcallback orlateeffects. Trustedvoid hook only; no generic callbackframework orarbitraryPromise securityclaim.
- [x] Allnew+old81/policy92/CPU84pass0skip, syntax/diff0, source/secrecy/test logs report. Non-authorcodeSPEC/QUALITY andRootfreshverify/N5a beforelocalcommit/producerfreeze.
- [ ] Laterconsumer mustimport actualfrozenproducer in originalutility/serverauthority; no standalonehelper declaredwholeAuth. ActualAuth/ownerpersistence/HTTPWS/pages/CLI/UI/保全/N1/T03 stillpending, fullpilot unchanged.
- [x] Root separateCI15/16 singlewriter refreshedfrozenAuthd008 hashes/count353 atb869; actualsameheadbdc353passed underindependentreview. This closesonly theCI substep, notnativeconsumer/N1. AuthorsnevermodifiedCIoutsidetheirapprovedCIcard.

## 2026-11-08 original MaterialPool regression

Classification native-reuse, T05.a rev3 Rootverificationonly; this discharges explicitlyunrun originalstandalone suite, notnewfeature ormedia capacity. Exact6 in-memory tests reside originalCoreLogicTests.cs, not a newfile; sourceandalgorithmunmodified. The originalConcurrent20Workers unit is only syntheticmemory reservation, not20realmedia load. Inputs/exacttools/paths/commands in execution/t05-material-pool-assignment.json.

- [x] Non-authorsafeinput/cardreview, immutableN5a84 on managedE3 before Rootlocal.NET; no existingNugetconfig/privatefeed/network/SDKinstall.
- [x] Freshownoffline16packagecache/artifacts, preinstalledSDK10.0.300 oneSDKinventory andrealX64host/pfx86; unchangedoriginal4project forcedcompile/4Csc, then exactMaterialPoolTests6only.
- [x] Record exact6/6/allnames/0skip withrealTRX/source/compiler/hash; failures remainfail, no automatic rerun/weaken. Peeractualscope review andN5a, onlythenclose priorstandalone pendingcheckbox. No realhost/media/T05.b/fullT05/PG inference.

Auth producer门禁建模纠正（2026-11-08）：rev5已完成103Auth+92policy+84CPU与非作者源码审查，但Root错误把本次允许修改的Auth源码/测试列入必须保持旧raw字节的admission.dependencies，故写后外置N5a正确拒绝DEPENDENCY_HASH。修订rev6仅将274b列作editable native baseline（Git源码pin/旧81前缀/实际diff/独审/Root279为证），保留不可变Git原件；实际消费且不修改的acc27策略及CPU仍在原immutabledependency验证。作者已冻结，不再改源；新卡独审、不可变提交及实际N5a通过后才可提交候选。检查器、写集、测试、权限和高风险语义均不放宽，旧拒绝保留。

原MaterialPool独立回归回执：4152242记录实际6/6、0skip，Root新隔离offlineSDK10.0.300/4项目4Csc/X64；非作者material_pool_actual_review规格/质量批准，写后及精确回执提交N5a84通过。仅该先前未选测项关闭，不将内存20worker单测冒充媒体负载。

Auth producer冻结回执：d008，源b4ddbc/test032130，原81字节前缀不变；新103Auth/92policy/84CPU在最新组合Root279通过、源码独审批准。nativebaseline rev6不可变d6b4e61、目标更新前后/门禁前后新哈希独立验证、实际N5a84及精确源提交再次84。仅生产者局部完成；最后消费者/CI步骤未勾，不把旧331当新353。


## 2026-11-08 CI Auth producer refresh

T01rev15, engineering-verification, Root-owned sharedCI singleton delegatedoneauthor inmanagedE3. SourceAuthd008 localproducerready andold81prefix preserved, new103/policy92/old158=353. Published1a28/331is historicalonly, no currentCIclaim. Exact3filewrite/card andproducerproof: execution/t01-auth-ci-refresh-assignment.json / t02-auth-ci-refresh-consumer-review.json. CI25e44 is editableGitbaseline, not immutableworkingbytes; do not repeatAuthrev5 inputclassification defect. Auth/policy/CPU/IOsource dependencies remainunchanged frozeninputs.

- [x] NewcurrentAuthfixture/retiredpin/count353 RED againstoldCIpin, minimal2hash+countliteral update andspecifictests only. Preserveold299security assertions/parser/43+34/graph/toolenv/workflowboundaries.
- [x] PureCItests plusphase1actual353pass0skip andsyntax/diff0; all34C#inputrawunchanged. Sourceauthor no .NET/entry/jobs/network/Gitwrites.
- [x] Freezeexactdiff/non-authorSPECQUALITY/Rootfreshverify+N5a andlocalcommit beforepublication. Rootactualremotejob staysseparatelease/audit/publictargetgate, no implicit newpass.

CI实际回执（2026-11-08）：代码b869/不可变运行候选bdc，Rootruntime16全部审查/新历史审计/即时public与旧终态/84门禁后只推单一codex主题。actualFission42426527222/job128565878701：Node22.23.4、SDK10.0.403、pure300和原43+34全0skip；同headcompanion42426527245/job128565878646实际353/353、4Auth/policy源码pin正确。两份日志/安全摘要/计数/工具/源/包闭包分别独审，回执fc87保留旧失败。新case只证明currenttuple/oldpin不再选，不声称旧bytes直接负例；depth1历史对象缺陷真实复现修复，Root误把phase1353套depth1的350/3实验亦保留，actualphase1是depth0。仅此CI任务局部完成，生产Auth/原nativeconsumers/owner/UI/N1/媒体安装/PG仍未完成。


## 2026-11-08 projects admission subset

T02.a rev7 native-extension/businesscontroladdition, same approved N0 but NOTN1/owner/productioncontrolledactivation. Source2+tests2 only: newproject-control-guard and actualoriginalprojects.mjs consumeit, notunusedhelper. ExactAPI/registry/marker/privatecapabilities/input-negativefixtures/resources in execution/t02-native-projects-admission-assignment.json. Nativebaseprojects iseditableGitbaseline; onlyCPU/locations/atomic/oldfixture dependencies immutable. Broadernativeentry/drain untouchedandmandatorylater, notdeletedfromscope.

- [x] Actualnewfactory andoriginalmarkedpathwritedefect/race RED, ownrealFS/childNode notsimulationmodel; preservedunmarkednativehappyIDs/film/reopen andallnewnegativecases.
- [x] Sharednativeleases/controlledexclusive shortatomicmeta protocol, trustedbrandedguard injection/ALS, guardactualprojectsIO beforeprefs/read/mkdir/describe/followLibrary/id/choose; processstatequeue no nesteddeadlock. DefaultOScoord stable, testsONLYexplicitownE2coord.
- [x] Strictprojectsprivatepending->deny markers->committed, no owner/historyclaim, partialfailurefailclosed, fixedfalseglobalactivation capabilities. ActualallpublicIOentrypointregressions, source4syntax/diff/alltests0skip wherecapable; ENVfilelinkfailure separatelynotpass. No actualTrash/defaultOSregistry/package/server/media.
- [x] IndependentSPECQUALITY+Rootfreshrealtests/sourcehash/N5a+localcommit; freezeonlyqualifiedprojects-admission-v1 localinput; filelinkassertion andallactualentry/drain/activation areseparateuncheckedfollow-ups below.


## 2026-11-08 auto versions real drain

T02.a rev8 native-extension minimumexistingproducer, independentNativeprojects7. Exacttwofilecard execution/t02-auto-versions-drain-assignment.json modifiesoriginalauto-versions.mjs/test only, notanotherhelper/editor. Freezeproducerbeforedependentserver canconsumeGuard7/newdrain; do notrunnewGuard-default-coord inadvertentlyduringcross-treeearlytests. Actualoriginalserver.shutdown await/composition is mandatorynextconsumer, notdeclaredfixedhere.

- [x] Original5unitbaseline thenrealpending-save/stop/drain/reentrant-newwork RED, actualcallbackPromise trackedbeforeexternalreentry; no mockimplementation.
- [x] Minimalgeneration/pending/stop/drain andexplicitrestartsemantics, preserveoriginalcallbacks/constants/oldassertions; no timeoutRace calledquiescence.
- [x] Actualnew+oldpuretests0skip/fail, syntax/diff/forbiddeninputsrawunchanged; no server/ports/realOS/files/media/model/SDK.
- [x] Non-authorcode+Rootfreshactualtests/N5a thenproducercommit only; actualoriginalserverawait andremainingproducers areseparateuncheckedfollow-ups below.

局部执行回执（2026-11-08）：projects源码c8a4经历独审1P1/2P2、真实38/27+11RED与fix1后40测试、Root40+289、前后/精确提交N5a84，保留SYS-C临时合成fixture边界偏差及原初中间sourcehash证据不足。真正file-symlink仍EPERM、assertions0，不计通过。Auto源码8857原5prefix不变/18真实producer测试、Root102/独审/N5a84；原server仍没await。串行组合436b重新347/347、0skip。两子包仅本地资格完成，旧bdcCI不代新6源CI，生产activation/owner/全部entry与background/N1未完成。

- [ ] 将真实file-symlink marker拒绝断言保留在可执行受控测试并在hostedWindows实际跑，不以junction/ENV或旧FissionCI代替。
- [x] 实际原Studio.shutdown await已冻结Auto.stop、actualAuto+actualstartStudio+NativeGuard DI组合，见source2b5e44b/Root354真实证据。
- [ ] exports/fetch/watch/hostpipeline retain/drain和完整entry/owner/parent/UI继续，未删减。


## 2026-11-08 original Studio auto version close

T02.a rev9 native-extension actualconsumer ofc8a4/8857 snapshot436b. Exactlyoriginalserver.mjs+newserver-auto-versions.test; no newUI/daemon/helpermodel. FactoryisinternaltrustedNode additiveoption only, testsreturnactualAuto withactualdeferredsave andrunactualstartStudio underactualNativeGuardDI/approvedisolationprofile. Scope/card execution/t02-studio-auto-close-assignment.json; consumerproof t02-studio-close-consumer-review.json.

- [x] Actualoriginalclose/first-and-second-port-startfailure pending-save earlysettle RED, sourcebaseline/logs retained. Checkallproducerinputsready first, no fallbackfakestop.
- [x] Originalshutdown capturesstop synchronously, closesexistingadmission/resources thenawaitsactualsave/cleanup; startupfailure alsostops/waits/cleans. PreserveoriginalAPI/errors/othercleanup, safeinvalidfactorybeforelisten.
- [x] Ownports18475/18476 andprofileE3 paths only, no remote/bootstrap/browser/media/privateconfig, zero leftovers; allnew+oldaffectedNode tests0skip/fail/syntax/diff/inputhash stable.
- [x] Non-authorSPECQUALITY+RootfreshactualHTTP/Auto/Guardcomposition andN5a beforeproducercommit/serialintegration. Notfullbackgroundquiescence; exports/fetch/watch/hoststreamandactualAuth/owner/nativeentry/UI/N1 remainmandatory.

StudioClose工具交接（rev10，2026-11-08）：实际E3无playwright-core，Root此前“本地已有”判断错误，首次ERR_MODULE_NOT_FOUND是能力失败不是业务RED；作者未安装/stub。E1原pin1.61.1现存，无scripts/传递deps，Root拟离线复制完整公开包+许可到E3新ownedstage并全文件SHA核验后原子物化到absent本地node_modules；不网络/安装脚本/browser/SDK/全局配置、不改源/锁。新handoff须独审/不可变/raw+N5a，作者保持冻结前Source/test，不可据缺包失败声称lifecycle已复现。完整权限/执行测试/API/端口原样。

Studio Auto consumer执行回执：source2b5e44b、真实DIonly7/2pass5fail RED（不是缺包失败），Root149与精确最新source354均全0skip，真实两端口/已有TCP连接在save pending时已关闭、actualIO/cleanup最后settle，首/次EADDRINUSE保存原错且不关闭自有blocker。源码/Root/tooling/N5a和独审见t02-studio-auto-close-validation。当前只自动版本保存caller链闭合，旧producer readiness里尚未await是其冻结时状态；当前新证据补充不改旧样例。

- [ ] Native file-symlink永久断言/真正hostedWindows +新8源CI，补原依赖playwright-core1.61.1固定tar SHA512/许可/禁scripts/browser再测试；不再假定builtin-only或E3原本已有依赖。
- [ ] watch/export/fetch/host流及sharedmergeWorker真实completion/leasedrain，原server消费；再完整入口/owner/parent/UI/realAuth/N1及17签收，未缩范围。


## 2026-11-08 native Studio Windows CI

T01 rev17 engineering-verification consumesactualfreeze2b Native/Auto/Studio8source/test files andoriginalCPU/context/TAP/package-lock source. Newfourfilesonly: native-studio workflow/CI module/unit/permanentfile-symbolic testcase. Allcontracts, fixed8pins+lock/tar SHA512/count66/source+secret/path/permissions in execution/t01-native-studio-ci-assignment.json. No wholepilotclaim.

- [ ] Purecontext/TAP/source/packagearchive safety RED thenminimalimplementation, importzeroIO; permanentrealfile-symlink testlocalENVfailure recordnotpass, no conditional skip.
- [ ] SourceGitsamehead/rawEOL/strict66/ownedpaths/cleanenv, futureCIonlyfixedoriginalpublicplaywright-core1.61.1 tar SHA512+safeextraction/Apachelicense, no scripts/browser/SDK. Sharedworkflow singlewriter, oldCI/producers no edits.
- [ ] Localpureunit/syntax/diff plusallimmutableproducerrawunchanged, non-authorSPECQUALITY/Rootfreshverify/N5a+sourcecommit. No localmain/fakeCI/.NET/network/actualserverbycodeauthor.
- [ ] Root laterseparateone-jobpublicstandardWinlease/privatehistoryaudit/freshpublictarget/officialcostcheck/immutableN5a beforepush; actual66zero skip inclgenuinefilemarkerassertion andactualStudio7/ports0 beforeclosingcurrentENVgap. Sourcecandidateslocal354/oldbdcCI are notsubstitute.


## 2026-11-08 watch real drain producer

T02.a rev11 native-extension originalwatch.mjs/test only, disjointCI17E2fourfiles. Existinginitialread/fullflush/settle/400msgrace/actualFSWatcherclose andretiredmanagerinstances aretruework, nottimer/mapclear. Exacttwofile API+trustedNode testwrapper/positive-negativegroups andlimits execution/t02-watch-drain-assignment.json. Sharedperson-editworkerexit isNOTprovenbyreturnedPromise; fullclosure remainslater.

- [ ] Oldeventtests preserved, actualenteredread/settle/closingFS handles andretiredmove/unsub RED beforeproductionfix; realfiles/functions notmodel.
- [ ] Callablefolderclose stablePromise andterminalmanagerdrain, registrationbeforecallbacks, reference-safe retiredtracking, nocallback/add/flushafterclose. closeAll remainsnonterminalresubscribe asnative.
- [ ] Old/newtests underexplicitownE3TEMP, actualcleanupawaitbeforefreshfixture removal, syntax/diff/hash0, no sourceCI/server/otherproducer/SDK/network changes.
- [ ] Non-authorSPECQUALITY/RootactualFS+N5a thenproducercommit; actualservermustlaterawaitdrain/retain leases, andsharedworkerexit/fullrouteclose remainmandatorybeforecontrolledactivation/N1.

## 2026-11-08 Studio watch consumer

T02.a rev12 is native-extension: consume frozen f1fff watcher drain in original startStudio, only server.mjs and new server-watch-drain.test.mjs. Shared server single writer on managed E3; E2 diagnostic19 two-script writer is disjoint. Preserve original Auto7/watch25 and all native formats. Stable reentrant close Promise, synchronous stop admission, network shutdown before first await, wait actual current+retired watcher IO/FSWatcher completion and Auto cleanup; both listen failures preserve original error and external blocker. Real-function gated synthetic tests under explicit Guard/isolation profile, exclusive18475/18476, existing core1.61.1 no install. Independent policy/source review, immutable inputs/N5a and Root379 baseline precede author; later Root integrated fresh acceptance. Shared worker exit/all entered routes/owner/Auth/N1/full pilot remain pending. Exact write/resource/fixture and proof pins are in docs/execution/t02-studio-watch-assignment.json.

### Studio watch consumer fix1 / rev13

Source12 remains unaccepted despite Root395 passing: native final advertise metadata failure bypassed cleanup, and late-upgrade pending-query proof was absent. Rev13 preserves the two-file write set/17 immutable inputs. Exactly two directed tests may use isolation:true + advertise:true + explicit synthetic key under a new own profile, run.json absent, precise fault-before-write hooks restored in finally; required profile keeps all examples/providers/discover bootstrap disabled. No real default HOME/discovery/network or new DI/protocol. Metadata-fault behavior RED precedes minimal cleanup fix; an already-correct late-upgrade race test must be reported GREEN rather than inventing RED, with separately labeled mutation if needed. Preserve carried065/728 WIP before/after metadata FF; source peer and Root actual integrated revalidation remain mandatory.

## 2026-11-08 Native Studio CI110 alignment

T01 source22 uses exact assembledB5 (fixedGit5865316/watchf1fff/caller7546277), only native-studio workflow/driver/unit. Fixed old66+watch25+serverwatch19=110, sevenfiles serial and true file-symbolic mandatory unchanged. Literal input pins18+SELF4=22; frozen externalinputs19 exclude threeeditableCI files. Update only threeworkflow triggerpaths and own studio-watch-close/profiles namespace. Rootjoint579 actually563pass16sourcefixture pinfailures at retiredf050 vsactualc8, preserved as genuine alignmentRED; separate missingoutputparent ENOENT spawned0tests andisnotRED. Preserve181 testcase meanings/allnegativeguards with explicit closed66-to110/currentpinfixture trace, no byteprefix claim or dualcount/skip. Pure tests/actualonexact22recordsourcepositive must pass; exact new runtime still separately reviewed/gated/audited. Sharedworker/allroute/owner/N1/PG remainpending.

## 2026-11-08 Merge worker lifecycle producer

T02.a rev14 native-extension, spec docs/superpowers/specs/2026-11-08-merge-worker-lifecycle-design.md. Write only person-edits.mjs/new person-edits-worker-lifecycle.test.mjs. Consume frozen original merge/wire/atomic/ops/film-doc and pureperson-merge.test; editableperson-edits baseline2ae excluded.

Review focus: oldexit must not fail newgeneration; idleunref is notexit; constructor/postMessage error cannot orphan timer/thread; stop reentry/getters cannot admit newwork; fallback/bookkeeping and editinghistory remain correct.
- [ ] Policy/proofs/immutable/managedE3FF/raw10+2proof/externalN5a before author; CI22 E2 writer has no overlap.
- [ ] Run originalpurebaseline ownenv (includes5k Workercase, no filesystem at virtualtmpkeys); create newbehavioralRED with genuine Worker/gates, not missingexports.
- [ ] Minimal stopMergeWorker stablePromise/startMergeWorker boolean andpergeneration ownership, preserve defaultactive/originalwire/results, max4owned actualthreads. No serverconsumer.
- [ ] New+oldtests actual defaultnative1000+/tworoot/cache, separate reply/exit/retired/configure/failure/reentry gates allpass0skip; retain originals/perfassertions and verify realexit/peak/finalcleanup.
- [ ] Non-authorSPEC/QUALITY andRootfreshactualWorker+N5a before sourcecommit/serialintegration. FilmIO/processlease/owner/N1/PG staypending.

Worker14事实更正（不改原冻结卡/hash/API/资源）：原同步constructor throw发生在inWorker返回Promise/.catch之前，原outercatch保留整个人的film；postMessage executor拒绝、errorreply/异步error/异常exit才走普通fallback，timeoutlate保留整片。按独审Ruling保留该真实行为；相反constructor测试期望是计划假设错误，不计生产缺陷RED。首次RED取消/timeout只算验证失败，后续真实Worker事件观察包装需保存原监听器再门控交付，必须证明实际exit而非测试进程结束。详见execution/t02-merge-worker-ruling-ctor.json。

## 2026-11-08 Native kernel integration641

T01 rev24 Root-only validation receipt, no source edits. Latestassembled native+Worker641 = native398 + originalmerge33 + newWorker18 + pureCI192, CPU84 alreadywithin398. Freeze31 directmodule/fixture inputs and2proofs, newE3metadataFF/independentN5a beforeexecute. ExclusiveE3/localhost18475-18476 andCPU; fourteenfiles serial, allsevenTEMP/HOME/etc exactlysame newownscratch belowmerge-worker-lifecycle/root-integration641. Record realownedWorker exits/peak<=4/final0 andfinalbothportsbindclose, allcounts0skip/fail/cancel/todo, exactHEAD/cleantracked/hash proof. Existingcore106 noinstall/network, rawlogs ignored; olda68Windows110 notattributedtonewWorker. ServerWorkerownership/filmIO/allroutes/N1/PG pending; no dev/main/newCI authority fromthislocalvalidation.

## 2026-11-08 Native110 plus Worker51 CI

T01 source25 onlynative-studio workflow/driver/unit, freshE2 author. Preserve Native110/7files/TAP validator andoriginalenv. Add independent strictflatWorker51(unchangedpure33+new18) serialsecondchild; realexisting51top-level evidence confirmed. Workernewordinarynamespace .dev/merge-worker-lifecycle/run/attempt/scratch, sevenenvsamescratch, Nativeenv unchanged. UniquecompleteWorker line18created18exits/peak1..4/final0 andmandatorynames; failures/missing/duplicates/skip/wrongcounts fail. Add5producerpins ->23+SELF4=27 and5workflowpaths. Preserve192 testcase semantics; exactsourcefixture count/index mapping only, no globalnumberreplacement/tarbytechanges. Keepfirstfailure/perstageprocessreceipts/rawprivateTAP hashes/sourceandresourcepostchecks, combine161onlybothpass. NewTDD/peer/Rootfresh/27actualGitpositive thenseparateactualruntime; olda68Native110/local641notfuture161proof.

## 2026-11-08 Native type contract repair

T02.a16 fixes verifiednew115type regressions versus original41b0 using onlyprojects/server/watch JSDoc/type annotations. Reuse managedE4baseline tree as codex/native-type-contracts createdfromverifiedlatestdev41b thenFFtoc7; historicalbaseline proof persists, sameTS5.9.3/NodeTypes22.20.5/Core1.61.1 readonlydependencies, noinstall. Freeze20inputs+2proof withtsconfig/Guard/canvas-history/API immutable; no @tsignore/nocheck/any/unknownweakening orruntime changes. Restoreactualnative_* genericparameters/tuple/optional/default/results, lifecyclePromise<void>/never; downstreamerrorsfixupstream.
- [ ] Independentpolicy/proofs/immutable/managedE4FF/raw/tooling/N5a beforefreshauthor.
- [ ] Reproduce115RED withoriginalnoEmitconfig; applyminimal3file types, originalserver0diag andtargetedtempcontracts/anyleak/optional/default/minargs/returnchecksGREEN.
- [ ] RuntimeASTbeforeafter ignorescomments/JSDoc butpreservesoptionalchain/grouping, onlyexplicittransparentcastparen sites, equalstructurehash required; otherwiseRootamendment first.
- [ ] Actor449native+Worker runtimeallpass underownE4ports18475/6/strictWorkerScratch/max4threads; doNOTeditCI toachievefakeold641GREEN. OldCI newhash refusal retained asexpectedstale pin.
- [ ] Non-authorpeer/Rootfresh thenRootreviewedconsumerproof/pin refresh, latestcombined countcurrentCI25pure300+native449=749 andtype0 beforeactual161/branchintegration. No source/data/businessscope shrink.

## 2026-11-08 Exports real completion producer

T02.a15 native-extension, spec docs/superpowers/specs/2026-11-08-exports-completion-producer-design.md. Onlyexports/newdrain.test,13frozeninputs; optionalNodeinstance fork/encoders/fs wrappers defaultnative/no publicprotocol. Testvalidfilm.doc/h264hardwarefalse/burnfalse/sidecaromitted/realownedNodeCP exactoriginalIPC+ordinarytextpart, no realmedia/ffmpeg/browser/WMI. Stableterminalstop replaces8sfalse-success withactualfullwork/directCPclose+stdio/FS+cleanup, missingcompletion/failure notpassed; max2freshownedCP, nativepriority andexactownedPIDtaskkill allowed, noforeignprocess. Actor onlynewtests withinexports-drain; CPU84delegatedRootexternalpre/post/exact, oldtests importnotrun. Capturetypebaseline/nonewexportsdiagnostic; E4onlyshared3types independentlyfixed. Policy/proofs/immutable/E3rawN5a beforefreshactor, genuineRED/FS+CPgates thenminimalfix/non-authorRootproof; poolNLE/descendants/desktop10s/server/fullretirement/N1/PG pending.

## 2026-11-08 type-consumer-pin-rebind

Type16 c384 originaltype0/ASTequal/17contract/Root449 repairs3canonicalnativefilehashes, so CI25 literalpins correctlyrefuse old300 sourcefixtures (259pass/41fail). Source26 onlyrebinds projects/server/watch approvedliteralSHAs in existingdriver/test, unchanged300semanticcases/allsecuritychecks/Native110+Worker51 counts andworkflow. BeforefreshRED, afterpure300, immutable26inputs+2proofs, nonauthorSPEC+QUALITY/Rootproof required; thenRootlatest749+type0 beforeseparateactual161 runtimecard. NoCI runtime ordevintegration approvedbythis source task. Exports15 independent2fileproducer underreview/fix; no sharedwrites.

## 2026-11-08 current-type-exports-native-integration

After individuallyreviewed sourcec384/0cf/42db serialassembly ac630, Rootlocal781 =existingnative449+unchangedCI300+Exports32 (CPU84alreadyinside449), plusoriginalfourtypeprojects noEmit0. ExactE1raw/canonical37inputs+2proofs, fixedexistingtool fingerprints, ownedWorker18/Node10exitclose andfailedspawnseparate, dualstack18475/6 pre/post, no sourceedits. Independentpolicy/proof/immutable/N5a beforeexecution, nonauthoractualresultreview. DoesnotreplaceactualWindows161/media/install/owner/fullretirement/PG; no dev/main/remote action inthis task.

## 2026-11-08 native161-actual-Windows

ReviewedCI26+Type16+Exports snapshot9d12762 acceptedlocal781/fourtype0 now requires ONE separatelybounded actualstandardWindows110+Worker51 run. Card28 freezes38raw/Git inputs+2proofs and27literal/SELF source records. Afterpolicy/immutable/N5a/fullunpublishedhistoryaudit/freshownPUBLICrepo+financial/source-contextchecks, RootnonforcepushesexplicitSHA onlycodex/t05-path-policy; observeNative161 andexistingphase1353 toterminal, no rerun. NoCI/source edits, no model/privateupload/cache/artifact/paidlarger/build/release, noPG/N1/fullretirement claim.

## 2026-11-08 worker-local-diagnosis

Actualruntime28 firstfailureWorkerTAP_INVALID withprivate51data unavailable; no remote retry. Rootsequentiallocal51 underverifiedexistingNode26/24 exactCIargs/cleansevenenv/8MiB/180s, freshownscratchmax4actualthreads, no sourceedits/newdownloads/fakeCI/network. Captureactualexit/TAP/privatefailednames/events andseparatebase/strictvalidatorcodes to distinguishrealtestfailurefromclosednameconsumer mismatch. KnownnativeU+2192additionalTAP_NAMEgap isnotobservedTAP_INVALIDcause. Independentpolicy/inputproof/N5a beforeexecution; actualevidencereviewafter; no hosted/PG inference.

## 2026-11-08 native-worker-ci-observability

Source30 ONLY2CI scripts afterRoot29same51twoactuallocalruntimesprovedclosednativeU+2192name rejection. Spec `../specs/2026-11-08-native-worker-ci-observability-design.md` ownsclosednameallowance/source-grounded51fixtures andsafeidentity-boundCLIWorkerfailureevidence preservingall300oldguards. Baseline/newbehaviorRED thenminimalimplementation/all300+N puretests, bothpreviousactual51TAPs read-onlyacceptedafterfix, no newWorker/main/CLI/network. Independentpolicy/proofs/immutable/N5a andnon-authorSPECQUALITY/Rootfreshfullcoverage beforecommit. DoesnotresolveunknownhostedTAP_INVALID orauthorizeactualruntime31.

## 2026-11-08 current-worker-observation-integration

Source30 reviewed4585/Root482+Node24pure398/oldreal51TAPs accepted, actualGit27 andN5a pre/post/exact qualified. Rootnextlocal879=449+398+32 andfouroriginaltype0 onlatestassembly,37raw/Git inputs+2proof/ownedWorkers18+Node10close/ports/tools beforeafter. Independentpolicy/immutable/N5abeforeexecutionandactualresultreviewafter. No sourceedits/newjob/hostedrootcause/actual161/PGclaim.
