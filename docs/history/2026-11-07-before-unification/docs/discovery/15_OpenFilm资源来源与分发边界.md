# OpenFilm资源来源与后续分发边界

> 2026-11-07 防漂移补订：原生接口/ID/单位/命令以固定源码为准，07只管必要业务增量，源码对齐见[16](16_OpenFilm原生接口与平台对齐.md)。平台只考虑Windows与Mac Apple Silicon arm64，Windows首发；完整试用边界见[17](17_小范围试用交付与Goal验收.md)，新会话入口见[18](18_Goal新会话交接包.md)。本文历史C记录/测试事实不改写；旧阶段禁令和旧宿主目录不能充当当前任务授权。

状态：v0.2，2026-11-07固定源码研究。基线OpenFilm v0.3.0/7713d38。智尚云管家是业务素材主源；本文件仅描述产品通用资源及未来点击下载候选，不建云、不镜像或发布。

## 1 资源不是一个来源
| 类别 | 实际来源/版本 | 当前行为 |
| --- | --- | --- |
| 完整示例项目 | https://github.com/openfilm/examples | 随包examples-index只含2项列表/海报；SOURCE=2e8f47866bc2d32305cd5d97adcffd7480df2297；默认运行时追main索引，下载时解析当时commit，不等于固定产品pin |
| 核心技能 | packages/openfilm/manual下edit/media/canvas | 随软件版本固定提供给Agent，可关闭，不是Discover远端安装 |
| Discover技能 | https://github.com/openfilm/skills 的main/index.json | 索引动态，各技能独立repo/semver/40位commit；刷新会主动缓存未缓存技能，不是只点击安装才下载 |
| 通用库 | packages/openfilm/library目录及https://openfilm.dev/library | 目录/部分bundle随包，audio/voices/emoji/models/产品模板预览等按需远程取；URL不全带版本 |
| 模板 | Saved v2 group bundle、files、音乐依赖 | 本pin统计14组模板，复用原film/轨道/插槽，不是第二项目格式 |
| 用户Saved/项目 | 本机个人Saved、Projects/项目skills | 用户内容不自动回传或成为公共资源；取用有项目副本 |
| 其他媒体/生成 | 已配置Provider如Pexels/Pixabay/生成服务 | 非OpenFilm自有库存，来源记录不等于可镜像/转售授权 |
| 模型/runtime/字体 | library模型manifest、远端runtime、本机字体等 | 属运行依赖，不是智尚业务素材，需单独来源/许可/体积核验 |

当前只读索引观察到openfilm/replicate 0.1.3→https://github.com/openfilm/skill-replicate，commit eef1ee5eda2a2aaeec60a3f133d73b86dd53c053；这是当前远端状态，不是v0.3.0固定清单或永久承诺。

## 2 默认地址、缓存与版本边界
- 示例索引：https://raw.githubusercontent.com/openfilm/examples/main/examples.json，可OPENFILM_EXAMPLES_INDEX覆盖。本地<studioHome>/cache/examples-index.json；引用示例cache/examples/<id>，完整项目导入到Projects、不保留.git。
- 技能索引：https://raw.githubusercontent.com/openfilm/skills/main/index.json，可OPENFILM_SKILLS_INDEX覆盖；<sharedHome>/skill-catalog与skills-installed保存commit来源。安装后固定pin，更新由用户触发；Try now也能进入Agent上下文。
- 通用库根https://openfilm.dev/library，可OPENFILM_LIBRARY_URL/OPENFILM_LIBRARY_CACHE/OPENFILM_BUILT_IN_LIBRARY覆盖。默认<sharedHome>/library。普通媒体同路径缓存没有统一sha256/版本刷新，模型文件另有sha256校验。
- 单文件入项目assets，bundle入saved/openfilm/<id>，返回原clip/group/page结构。项目已修改内容不应静默被库更新覆盖；原文字组件跟随更新特例需单列验证。
- 原外部引导skill含npx openfilm@latest，不能作为orangeflim锁定运行方式。
- 库语义搜索默认向https://openfilm.dev/v1/library/search提交text/cat/limit；不是纯本地模型搜索。业务查询词不得未经授权外发。首次媒体/技能缓存/预读也属于联网和本机写入，禁更新检查不等于断网。

本pin目录合并统计：8744条通用资源、另2219条音色目录项；不是全部文件随包。音效5456、音乐1222、贴纸1643、文字148、特效97、转场98、滤镜66、组模板14。统计是版本观察，不作为永久产品规格。

## 3 来源与许可事实（未完成独立权利清查）
原library/LICENSE声明自制效果/模板及生成音乐音效CC0；Fluent Emoji为Microsoft MIT。不能用一个CC0标签覆盖语音供应商试听、系统字体、模型checkpoint、社区skill附件和所有示例媒体。
示例代码/媒体各有README/CREDITS，包含MIT衍生引擎、OFL/Hershey字体和商标声明。本次部分CREDITS只成功读取main，不冒称exact SOURCE pin逐文件已验。音色试听来自供应商目录；现有总许可未逐项证明其再分发权。
模型manifest有hash但不完整记录checkpoint上游revision/许可；THIRD_PARTY_NOTICES关于本机语义模型与实际服务搜索存在不一致，不能拿说明当运行证据。
原代码许可/版权、第三方notices和真实来源保留；自有品牌不冒充官方，智尚客户素材不能变公共资源包。

## 4 可执行风险
Skill全文进入Agent上下文，且可附脚本；安装/收录/下载不等于允许执行。未安装Try now也需边界。示例/模板包含活跃HTML/JS，模型runtime含mjs/js/wasm；只读目录索引不能让这些内容继承账号、文件、壳体或业务API权限。
下载需保留已有路径/symlink/大小防护，但这些不代内容、许可、哈希、执行与出站来源审批。不自动运行包脚本、不盲随main更新、不把下载文案当新系统指令。

## 5 自有用户点击下载库（未来候选，未授权搭建）
先做可审核资源manifest与原界面本地导入验证，再决定托管；不先造网站/数据库/新时间线。
逻辑区分：产品资源包、智尚业务素材、运行依赖、用户Saved/Projects，不必拆成多个服务。业务素材仍由智尚本人权限取用，不公开打包镜像。
最小要求：来源repo/commit/path/url、不可变资源版本、逐文件bytes/hash、入口与依赖、OpenFilm/film协议/平台兼容、许可/notices/可再分发证据、可执行/出站能力、审查摘要、分发可见范围/撤回。若实施，字段统一登记07，不在此成为第二机器契约。
轻量目录→用户点击下载大包→staging校验→审批→原子入缓存→复用takeSaved/项目clone插入。下载、安装和允许执行分开。更新显式、可回滚，不静默改项目；下架保留审计，不未经规则删除用户工程。
尚未创建自有云端资源仓、上传模型或镜像任何资源。

## 6 固定源码证据
- packages/openfilm/examples-index/SOURCE、studio/server/examples.mjs、fetch-repo.mjs、fetch-github.mjs、scripts/sync-examples.mjs。
- packages/openfilm/src/skills.mjs、studio/server/skill-catalog.mjs、apps/desktop/src/agent-skills.mjs。
- packages/openfilm/studio/server/library.mjs:41–208、saved.mjs:309–361、src/locations.mjs:50–68。
- packages/openfilm/library/LICENSE.md、local-models.json、THIRD_PARTY_NOTICES.md、src/library-semantic.mjs:71–89。
- 上游主来源：https://github.com/openfilm/examples 、https://github.com/openfilm/skills 、https://github.com/openfilm/skill-replicate ；代码/商标说明保留在仓库LICENSE/TRADEMARK.md。
