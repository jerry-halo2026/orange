# OpenFilm 原生接口与平台对齐

文档集：U1（2026-11-07）。当前执行口径，不包含历史指令。

## 1. 对齐原则（最新用户确认）

**先原生、再必要扩展，最后才是OpenFilm没有的业务。** 原UI、IO、API、CLI、类型、ID、单位、错误、状态和资源闭包必须一起复用，不能只是外观像原版。原生接口事实以固定源码/类型/测试为准；07只登记橙子业务增量和明确映射，不覆盖原生定义。

| 分类 | 允许做法 | 禁止 |
| --- | --- | --- |
| native-reuse | 直接引用原导出类型/函数/API/命令；补特征/兼容测试 | 为统一命名重建Project/Timeline/编辑API，再让原系统迁入新DTO |
| native-extension | 在原操作链/提交协调中做最小能力增量；显式能力/版本、旧调用方兼容 | 改原字段含义、外层GET后POST冒充原子CAS、把旧行为悄悄改掉 |
| business-addition | 本人身份/智尚绑定/资产许可/业务版本/人审/混剪准入/账务等缺失业务，窄边界接原系统 | 每个页面一套API/素材库；公司key下发桌面；第二可变工程头 |

每包开工卡必须填：分类、原源码符号及pin、真实输入输出/单位/ID/错误、原调用方、增量必要性、映射责任、特征/回归测试、兼容与回滚；“原生有但不好看”不是重写理由。原生功能直接引用＋特征测试即可就绪，不先重新生成一份同义Schema。跨.NET/云边界确有需要时才冻结07的最小增量。

## 2. 原生数据和时基（不能全局替换）

| 对象 | 已核源码事实 | 来源 |
| --- | --- | --- |
| 原工程 | 文件夹中的film.html和引用媒体/HTML/VTT/parts；.film放辅助状态 | [projects](../../packages/openfilm/studio/server/projects.mjs)、[film-doc](../../packages/openfilm/src/film-doc.mjs) |
| project.id | .film/id，生成randomBytes(9).toString('base64url')，接受既有合法字符串，不是UUID | projects.mjs:114–142 |
| Clip.id | string；可能由文件名派生、含中文/冲突后缀，不强制UUID | film-doc.mjs:281–313 |
| FilmValue/Track/Clip/Op | 直接复用原定义；Op含set/move/insert/remove/split/props/stage/fields/track/reorder/captions/uncaptions/keyframes | [原类型](../../packages/openfilm/src/film-doc.d.mts)、[ops](../../packages/openfilm/studio/server/ops.mjs) |
| rev | sha256(film文本).hex.slice(0,16)，字符串；不是正整数业务revision，也不覆盖VTT变化 | [film](../../packages/openfilm/studio/server/film.mjs):29–45 |
| film at/time/fade，导出range/ranges | 秒（可有小数）；按原语义，不改成微秒 | film-doc.d.mts、[exports](../../packages/openfilm/studio/server/exports.mjs) |
| SpokenLine.startMs/endMs、marks.startMs | 毫秒；marks仅起点，不能假设完整词结束时间 | [transcripts](../../packages/openfilm/studio/server/transcripts.mjs):18–35 |
| provider Word.startSec/endSec | 秒；endSec可缺，不能伪造完整词末时刻；供应商到转写存在原生转换 | [transcripts](../../packages/openfilm/studio/server/transcripts.mjs) |
| VttCue.start/end | 秒，VTT序列化为毫秒精度；保留NOTE/REGION/STYLE/cue id/settings | captions.mjs及原字幕轨实现 |
| WorkspaceResource.durationMs / etaMs等 | 明确各自毫秒字段，不能因都叫duration就直接传值 | [workspace-resources](../../packages/openfilm/studio/ui/src/lib/workspace-resources.ts)、exports.mjs |

07中的业务UUID、整数revision、整数微秒只是新业务交换候选：不得强加给上表。必要转换仅在明示边界发生，记录精度、舍入、有理帧率、半开区间和round-trip反例；原生ID与业务ID显式关联、不覆盖。同源多实例/裁剪/变速映射不靠“统一一个单位”解决。

## 3. API/调用接缝核验表

原Studio编辑/API服务器使用127.0.0.1指定端口；film预览为独立localhost端口。当前本机端口必须实核，不照抄默认值。路径下表`:id`是原project.id。

| 能力 | 原入口与关键IO | 原消费者/源码 | 必要增量而非重建 |
| --- | --- | --- | --- |
| 读工程 | GET `/api/projects/:id` → project/folder/text/rev/value/doc/problems，可能filmMissing/outer；不是`/film`端点 | [api.ts](../../packages/openfilm/studio/ui/src/api.ts)、[server](../../packages/openfilm/studio/server/server.mjs):716–725 | 本人访问/资源闭包版本，不能替换原返回字段 |
| 编辑 | POST `/api/projects/:id/edit`，`{base?,ops?,undo?}` → text/rev/value/doc/rebased；冲突409/非法422附当前rev/doc | server:859–869；film.editProjectFilm(root,base,ops,{undo}) | 剪口播严格前置条件要进原最终提交边界；保留旧原生rebase特征测试 |
| 事件 | `/api/events`、`/api/projects/:id/events` | server/api.ts | 新业务事件关联原项目，不能重造第二条原状态权威 |
| 源转写 | GET captions；PUT captions/line `{src,line,part?,text,language?}`，line为源毫秒起点；POST subtitles/transcribe `{srcs?}` → transcribed/failed | [server captions](../../packages/openfilm/studio/server/captions.mjs) | 词时基/分析版本/人选删除意图；改字不自动剪媒体 |
| 字幕轨 | GET/PUT caption-tracks/file；POST from-subtitles/new/sync/translate；GET speech只算不写 | [caption-tracks](../../packages/openfilm/studio/server/caption-tracks.mjs):64–138 | 多文件协调/恢复/一次Undo；不把原逐文件writeAtomic视为跨资源事务 |
| 项目文件 | `/api/projects/:id/files`及bring/relink/collect；路径为项目相对正斜线，上传有文件流 | [files](../../packages/openfilm/studio/server/files.mjs)、server | 绑定业务资产版本和授权解析，不把大媒体塞JSON或路径当所有权 |
| Saved | GET `/api/saved/files`；项目POST saved和saved/take；原bundle内部VERSION=2、clip/group/page | [saved](../../packages/openfilm/studio/server/saved.mjs) | 原跨项目副本语义保持；业务归属/公司留存额外关联 |
| Library | `/api/library`、voices/missing/fetch/favorites；openfilm/id内置资源，复制到工程 | [library](../../packages/openfilm/studio/server/library.mjs) | 智尚经业务适配接原素材UI，不塞内置只读Library当第二业务源 |
| 素材视图 | WorkspaceResource是派生UI视图；MediaSources提供资源URL；不存在由本计划发明的`/api/sources` | workspace-resources、[project-sources](../../packages/openfilm/studio/ui/src/lib/project-sources.ts) | 只加必要provider适配，不复制浏览器/资产库 |
| 导出 | ExportAsk原联合video/gif/audio/stills/poster/subtitles/slides/nle/project；nle含jianying/capcut；POST单ask→export或jobs→exports；DELETE job取消 | exports.mjs、server:1073–1104 | 原Job waiting/running/done/failed/cancelled保留；业务交付/计数状态另映射，不覆盖原枚举 |
| desktop桥接 | openfilmNative→openfilmHost(version:1)/openfilmDesktop(bridgeVersion:'1')；原HOME view/项目view切换 | [preload](../../apps/desktop/src/preload.cjs)、[bridge](../../apps/desktop/shell/bridge.ts)、[host](../../packages/openfilm/studio/ui/src/lib/host.ts)、[main](../../apps/desktop/src/main.mjs) | 窄HOME/业务方法；保活原工程，不给任意shell/文件直通 |

原launch key/x-studio-key、Origin/Host校验保留，但不是Supabase对象授权。剪口播必须协调原film/caption写端、外部变化检测、Undo/Redo和读取/预览/导出的已提交闭包；只包新CLI会留下绕过入口。原base过旧而clip仍存在时可成功`rebased:true`，不能写后检查它就称旧计划被拒。

## 4. CLI与Skill

真实入口[openfilm.mjs](../../packages/openfilm/bin/openfilm.mjs)：open/look/render/get/canvas/skills/skill/update/doctor；canvas apply是画布，不是剪时间线。退出码0完成、1命令/film失败、2错误命令/非工程。原look/render/get/canvas按当前目录定位工程；不要把文档中不存在的edit/剪口播命令当已实现。

desktop通过[openfilm-command.mjs](../../apps/desktop/src/openfilm-command.mjs)生成自带版本命令，不能绕到全局最新版npx。确需剪口播CLI时扩此注册入口，绑定确切实例/工程和能力，复用原Op/编辑服务与同一权限/恢复边界；名称、输入/输出、错误/退出码、help、Skill文档与测试同一变更，不另造Orange CLI。未完成相应最小N1前只记能力缺口。

## 5. 平台与构建矩阵

| 目标 | 产品范围 | 当前事实/验收边界 |
| --- | --- | --- |
| Windows | 一期交付；既定Intel/NVIDIA测试档位的x64作为首轮候选，Windows ARM不自动纳入承诺 | 原脚本有`--platform=win --arch=x64`、NSIS；需要自有隔离安装、真实Windows媒体/升级/恢复，不直接执行发布脚本 |
| macOS Apple Silicon arm64 | 后续支持方向，本期保留原适配/构建路径 | 原脚本`--arch=arm64`、dmg/zip；原配置minimumSystemVersion13.0仅上游配置事实，不等于orangeflim最低版本已验 |
| Intel Mac / Linux客户端 | 不纳入 | 不做Universal；原通用代码和Linux CI不必为裁剪而删；不要从CI运行环境推导产品支持 |

来源：[release.mjs](../../apps/desktop/scripts/release.mjs)、[desktop workflow](../../.github/workflows/desktop.yml)、[CI](../../.github/workflows/ci.yml)。上游release管线在macos-15构建Mac及win-x64且限制官方仓，不能声称Windows宿主打包已就绪；原release脚本会安装/下载/写产物。本轮未执行。自有构建需显式platform/arch/资源集/产物名，不依赖宿主默认目标，不使用官方appId/更新源/证书。

共享业务层禁硬编码盘符、exe/cmd、PowerShell、Windows路径分隔符或NVIDIA-only策略；平台适配集中复用原位置。Fission的.NET源码不等于原引擎/编译壳/FFmpeg/硬件编码器支持Mac arm64，分别核依赖和许可，缺能力明确禁用不假成功。Windows的D/E路径是本机开发布局，不是产品Mac路径。

## 6. 消费前最低验证

1. 现有非UUID工程/中文clip ID、16hex rev、秒小数/毫秒转写的特征样例通过；原结构round-trip不丢head/CSS/未知保留字段/VTT扩展。
2. 原edit自动rebase测试继续真实表达旧行为；新strict能力另有旧计划写前拒绝测试，检查与写入位于同一协调边界。
3. 原UI/API/CLI/Skill同一能力的正常/拒绝/取消/错误样例一致；导出状态与业务计数不混淆。
4. 原操作写入/并发/崩溃与闭包读取/Undo回归；仅VTT改变也使旧剪口播确认失效。
5. HOME/sharedHome/projects/Saved/Skills/下载/输出/temp全部隔离；原dev默认共享路径不能当隔离证据。
6. Windows/arm64 Mac分别登记构建、运行、媒体和安装证据；上游配置存在不是通过。新依赖/原生升级必须重核本表与相关消费者，不自动跟latest。

## 已验证的原生内部生命周期增量（2026-11-08）

`native-extension`，不另造工程格式、worker消息协议或编辑状态权威。源码/测试及下列提交仍是接口事实；这些是Node内部生命周期钩子，不是新HTTP或renderer协议。

- `person-edits.mjs` 的 `stopMergeWorker(): Promise<void>`／`startMergeWorker(): boolean`，生产者提交 `54edc703ffb01108c438d009a083b1983a99ad15`：初始active兼容原调用；stop同步关merge准入，等待已准入的完整`mergeFilmWrite`返回链及所有current/retired真实线程exit；未退出时start拒绝，完成后显式重开。原`mergeFilmWrite`参数/结果、1000clip阈值、wire及编辑历史不变。
- 原同步constructor异常保留整个人的film；postMessage executor拒绝/异步worker异常普通fallback；timeout late保留整片。具体事实更正见 `../execution/t02-merge-worker-ruling-ctor.json`，不把计划错误期望当生产缺陷。
- 原 `startStudio` 已在 `754627721f5bd326968966c77bd686d0533d38a2` 消费watcher及Auto completion；**尚未消费上述共享Worker stop**。多Studio进程所有权、film后续keepAside/replace、已进入route IO、exports/fetch等仍须独立就绪及消费者验证；不能据生产者通过提升完整退场、owner、N1或PG。
- 可消费字节及平台证据分别见 `../execution/t02-studio-watch-readiness.json`、`../execution/t02-merge-worker-readiness.json`；raw/Git哈希分列，Mac arm64未实测不宣称支持。