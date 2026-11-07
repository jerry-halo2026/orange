# Fission（裂变引擎）· 产品需求文档 PRD

| 项 | 值 |
|---|---|
| 文档版本 | v1.1（响应评审，有条件通过 → 修订稿） |
| 产品名称 | Fission 裂变引擎与工作台 |
| 评审状态 | **已评审通过，定稿（2026-11-03）**——B1–B8 闭环于 v1.1；ADR-005 三处声明偏离（抽帧前置、快速×转场降级、配音资产化）已获批准 |
| 上游依据 | `_rea_analysis\复用开发契约\00-开发规范总纲.md`、`01-多场景裂变编排规范.md`、`02-全功能编排目录.md`、功能 ini 参数总表、sucai 素材实测、三家 AI 厂商现行官方文档（2026-11 核实） |
| 行为基线 | 7D全自动批量混剪 v43.5「多场景顺序裂变」窗口（逆向行为级还原；**三处批准偏离**见 ADR-005：抽帧前置、快速×转场降级、配音资产化） |
| 技术基线 | .NET 10（SDK 10.0.300）、D:\dev\7d 原厂引擎资产、D:\dev\sucai 基准素材 |

---

## 0. 变更记录

| 版本 | 日期 | 变更 | 依据 |
|---|---|---|---|
| v1.0-draft | 2026-11-02 | 初稿 | — |
| v1.1 | 2026-11-02 | ① 新增 ADR-001~005；② B1 素材消耗事务模型（预留→确认→回滚）；③ B2 快速模式×转场组合矩阵；④ B3 抽帧前置到对齐之前（ADR-005，声明偏离原版）；④ B4 契约文件化 error-messages.zh.json / ini-mapping-spec.md；⑤ B5 依赖图修正（组合根模式）；⑥ B6 bench 环境指纹绑定；⑦ B7 本地 Web 加固（token/Host 校验/magic number）；⑧ B8 AC 可测化（相似度阈值/统计口径/时间戳自动测）；⑨ 新增 FR-6.5 每个音频制作 N 条视频；⑩ 里程碑改垂直切片（M1 最小闭环→M5 UAT）；⑪ HTTP 对外 API 不承诺兼容；⑫ 覆盖率口径调整、CI 提前、DPAPI 服务账户说明、trash 自动清理、report 脱敏、命名 sanitize、Job 状态机、封面失败语义、视觉链边界、ProcessPool 全局上限 | 评审结论（有条件通过） |
| v1.1.1 | 2026-11-03 | FR-6.3 扩为 BgmRegistry 分级资产库（preset 只读 / library 上传即入库自产复用 / generated 二批）；上传流水（magic/hash 去重/probe/LUFS 预扫）；BGM 定为耐用品不进消耗事务；ADR-006 定案；§12.4 增备份清单 | BGM 资产方向确认（Ethan） |
| v1.1.2 | 2026-11-03 | FR-6.5 重写为 VoiceRegistry 配音资产库（按产品归类/usePolicy once·count·unlimited/已用次数展示）；Consumed 语义改为计次、删除为可选副作用；循环驱动两模式（消耗/复用）；组合去重（配音 hash+画面组合 hash）；ADR-007；R7 | 配音按产品复用确认（Ethan） |
| v1.2 | 2026-11-03 | **评审通过，PRD 定稿**：ADR-005 三处偏离（抽帧前置/快速×转场降级/配音资产化）批准；进入 M1 | Ethan 裁决 |
| v1.3 | 2026-11-03 | **并发目标升级（用户指令）**：成片级并发上限 3→64（要求支持 ≥20 路稳定并发）；ProcessPool 全局上限随线程数缩放；新增 NVENC 会话闸门（GeForce 驱动并发编码会话上限 8，超出排队；per-process 编码线程钳制 16/threads）；线程数上限报错文案更新；新增 stress 压测命令（20+ 路混合故障注入）；Web 工作台提前到本里程碑（使用便捷性） | 目标指令：最高并发 20 路以上 + 执行稳定性 + 使用便捷性 |

---

## 1. 产品概述

### 1.1 背景与定位

Fission 是基于对 7D全自动批量混剪 v43.5 完整逆向后的**行为级重写**。两层定位：

1. **引擎层**：模块化批量混剪流水线引擎。Step 自描述、可独立调用（库内嵌 / CLI），供其他功能与外部项目接入。
2. **产品层**：v1 交付「多场景顺序裂变」工作台——web 界面操作，行为对齐原版（两处声明偏离见 ADR-005），叠加 AIGC 生产链（DeepSeek 文案 → 豆包/MiniMax 配音 → 配音池驱动裂变）。

### 1.2 v1 范围（In Scope）

- 「多场景顺序裂变」核心闭环（P0 参数面 8 组，§5）
- AIGC 生产段：文案生成、TTS 配音（豆包主/MiniMax 备/Edge 兜底）、预设 BGM（可替换）
- Web 工作台（v1 内部使用，**不承诺对外 HTTP API 兼容**——minimal API 仅为 Web UI 服务，接口变更不通知）
- CLI：`doctor` / `run` / `script` / `voice` / `step` / `mkaudio` / `bench`
- 性能工程：滤镜融合、硬件编解码自动探测、三层并行、零拷贝路径（bench 环境绑定见 §6.1/ADR-004）

### 1.3 非 v1 范围（Out of Scope，第二批）

歌单模式、屏幕字幕/卡拉OK（字级时间戳 v1 采集，持久化格式见 §7.8）、贴纸槽 4–10 与场景次序、文件名数字排序开关（O2 二批）、变调、定帧补帧、比例裁剪、曲目/关键帧极速分割、保存结构全集、对外 API 稳定承诺、发布对接、多用户鉴权。

### 1.4 目标用户与场景

自媒体/带货团队单机操作员：输入产品卖点与场景素材目录，批量产出互相差异化的竖版带货短视频。技术用户经 CLI/Step 嵌入自有管线。

---

## 2. 端到端流程与 Job 状态机

### 2.1 总流程

```
产品名/卖点/场景组(自动读目录 1筛果→5展示)/人群/风格模板
   ▼ [DeepSeek] N 条差异化文案 + 每条导出标题（估时长）
   ▼ [豆包 Seed-TTS / MiniMax TTS] 配音池（含字级时间戳）
   ▼ 裂变主循环（配音池耗尽/生成数量/素材不足，先到先停）：
   VALIDATE → SELECT(预留素材·事务B1) → [IMG2VID] → NORMALIZE
   → SCENE_SPLIT(五路) → FRAME_DROP(抽帧·前置，ADR-005)
   → ALLOCATE(八策略·按抽帧后实际时长对齐)
   → ASSEMBLE(concat快速/标准×转场矩阵B2)
   → AV_MERGE(配音+BGM+响度) → VISUAL(翻转/LUT/贴纸/蒙层·滤镜融合)
   → EXPORT(命名sanitize+归档) → COVER(封面·失败不判任务失败)
   → CONSUME(确认消耗·事务B1)
```

无 key 自动降级离线模式（手工文案/音频目录/`mkaudio` 合成），全链功能不受阻。

### 2.2 Job 状态机（新增，评审 §2 意见）

```
queued → preparing → running → stopping → terminal
terminal ∈ succeeded | failed | cancelled | partial
```
- `partial`：用户停止或错误中止时已有 ≥1 条成片导出成功
- 断点判定：`多场景素材缓存.ini` + report.json 流水即进度；重启任务时，Reserved 残留（崩溃遗留）在启动时**自动回滚为 Available**（ADR-002）
- `actualStopReason ∈ {audioExhausted, countReached, materialShort, userStopped, error}` 记入 report.json，UI 明示；**复用模式（FR-6.5）下 audioExhausted 不触发**，实际停止原因只能是其余四项

### 2.3 封面失败语义

封面是最后附加物（43.x 语义）：封面生成失败 → 成片保留、封面**回退为首帧截图**、记 Warning，不判任务失败；成片列表缩略图用回退图。

---

## 3. 术语表

| 术语 | 定义 |
|---|---|
| Step / FilterFragment / FileArtifact | 同 v1.0；StepOutput 序列化带 `kind: filter \| file` 判别字段 |
| MaterialPool | 素材池，唯一权威状态源，含 Reserved 计数（ADR-002） |
| 预留（Reserve）/ 确认（Confirm）/ 回滚（Release） | 素材消耗事务三阶段 |
| 场景组 | 素材目录子文件夹（数字前缀=叙事序；**组内为无序镜头池**，UI 明示） |
| NORMALIZE / 快速模式 / 标准模式 / 8 策略矩阵 | 同 v1.0 |
| 音频复用数 | 每个配音最多应用的成片条数（FR-6.5，默认 1=用后即删） |

---

## 4. 角色与权限

操作员（Web 全功能）与开发者（仓库协作者，遵循 §8–§11）。v1 单机单用户；Web 仅 127.0.0.1 + 启动 token（§13.1）。

---

## 5. 功能需求（P0 参数面，UI 8 组）

> 控件文案采用原版原文；报错文案以 `docs/contracts/error-messages.zh.json` 为**唯一事实源**（引擎/UI/测试三方共用，UAT 逐字断言对它做，ADR-003）。

### FR-1 素材池设置
- FR-1.1 目录：裂变视频目录（子文件夹=场景组）/ 裂变音频目录 / 背景音乐目录 / 片头视频目录 / 片尾视频目录
- FR-1.2 池统计：视频/音频/背景音/片头/片尾总数量，选目录即时刷新（含可用数=总数−Reserved−Consumed）
- FR-1.3 抽取模式：顺序循环使用 / 顺序单轮均匀 / 随机循环使用 / 随机循环不重复；可重复抽取视频
- FR-1.4 跨批次缓存：读写 `多场景素材缓存.ini`，**原子替换写**（temp+move），格式与原版互换（ADR-002/003）
- FR-1.5 素材健康：扩展名白名单外与损坏文件（ffprobe 失败）进**跳过清单**（日志用原版措辞 `检测到损坏文件：`，清单入 report.json），不阻断任务
- AC：空目录报错与契约文件逐字一致；并发下同一素材不被两条成片重复选中（集成测试：3 线程 × 10 成片，断言零重复、零超耗）

### FR-2 文案与配音（AIGC 生产段）
- FR-2.1 文案输入：产品名、卖点（多行）、场景组描述（自动读目录、可编辑）、目标人群、风格模板（带货口播/种草/剧情/知识讲解）、文案数量 N、目标成片时长
- FR-2.2 文案生成（DeepSeek `deepseek-flash`/`deepseek-v4-pro`）：输出 N 条差异化文案 + 每条导出标题 + 估时长；UI 预览 + 单条重 roll
- FR-2.3 配音生成：厂商选择（豆包主/MiniMax 备/Edge 兜底）、音色、语速；产物**入 VoiceRegistry 配音资产库**（见 FR-6.5）+ 字级时间戳持久化（§7.8）
- FR-2.4 离线模式：无 key 时手工粘贴文案 / 音频目录直用 / mkaudio
- FR-2.5 key 配置页：三厂商槽位 + 连通性测试；DPAPI 加密（§13.2）
- AC（可测，B8）：
  - 文案差异化：任意两条文案句级 Jaccard 相似度 ≤0.6（自动断言）+ 人工抽检
  - TTS 时长偏差口径：`|配音时长 − 估时长| / 估时长`，**中位数 ≤15%**；单条 >25% 自动重合成一次，仍超差记 Warning 不阻断；统计入 report.json
  - key 失效：错误码 + 指引（§12.5），不重试鉴权错

### FR-3 分割设置
- FR-3.1 镜头分割：**ffmpeg `select='gt(scene,T)'` + showinfo 帧时间戳**（低分辨率差分：解码即缩至 1/4 面积再检测）；精度阈值 0.01–0.99（默认 0.3，值越小越精细）；最短场景时长——**不足 minDur 的片段并入下一片段，尾段并入前段**；最长场景时长——超长片段从内部切分
- FR-3.2 静音分割：`silencedetect` 音量阈值 + 最短静音时长
- FR-3.3 SRT 分割：同名 .srt 时间轴（缺失报契约原文 `没找到对应的同名SRT字幕文件`）
- FR-3.4 均分：平均 N 片 / 按秒平均 / 随机区间 a–b 秒（**a==b 时为固定时长**，边界单测覆盖）
- AC：日志 `分析得出总镜头数：N`（契约措辞）；边界精确到帧；五路分割各有独立单测/集成测试

### FR-4 时长对齐
- FR-4.1 目标时长：固定值（支持小数）/ 以配音时长为准，互斥（报错契约原文）；默认后者。**对齐基准 = 抽帧后片段实际时长**（ADR-005）
- FR-4.2 八策略真值表（`L`=视频轨长 `R`=目标长；裁掉=`-t` 截断；变速=atempo；循环=`-stream_loop -1` 垫底）：

| # | 策略（原文） | L>R | L<R |
|---|---|---|---|
| 1 | 较长者裁掉多余 | 裁掉 | 裁掉（=目标侧裁） |
| 2 | 若右边长则裁掉，若右边短则变速 | 变速 | 裁掉 |
| 3 | 若右边长则裁掉，若右边短则循环 | 循环 | 裁掉 |
| 4 | 若右边长则变速，若右边短则变速 | 变速 | 变速 |
| 5 | 若右边长则变速，若右边短则循环 | 循环 | 变速 |
| 6 | 若左边长则裁掉，若左边短则变速 | 裁掉 | 变速 |
| 7 | 若左边长则裁掉，若左边短则循环 | 裁掉 | 循环 |
| 8 | 若左边长则变速，若左边短则循环 | 变速 | 循环 |

（注：策略 1–5 中"右边"指目标/音频侧；真值表以 docs/contracts/align-strategies.json 为准并配 8 组输入输出示例，单测对齐）
- FR-4.3 变速公式：倍速 x=L/R；atempo 单次有效域 [0.5,2.0]，**超界自动链**：x>2 → `atempo=2,atempo=x/2`（依此类推）；x<0.5 → `atempo=0.5,atempo=x/0.5`
- AC：八策略 × {L>R, L<R} 全组合单测（期望值表驱动）；变速后音画时长一致（±1 帧）

### FR-5 装配设置
- FR-5.1 合成规则：顺序连续不重复 / 首尾不动中间乱序[片段大于4个] / 无序 / 顺序加转场 / 随机转场
- FR-5.2 编码模式：快速模式（不编码，接受卡帧）/ 标准模式（重编码）
- FR-5.3 **快速×转场组合矩阵（B2，ADR-005）**：

| 组合 | 行为 |
|---|---|
| 标准模式（±转场） | 全支持 |
| 快速模式 + 无转场 | concat demuxer `-c copy`（NORMALIZE 后编码统一，前提成立） |
| **快速模式 + 转场** | **自动降级为标准模式**（转场走 ffmpeg6 GL 通道必然重编码）；UI 勾选时即时提示「快速模式下加转场将自动切换为标准模式（重编码）」，日志记录降级事件；UAT 增组合用例 |

- FR-5.4 转场：66 GLSL 列表 + 随机转场；时长 100–400ms（`gltransition=offset=0:duration=`）；单转场渲染失败 → 该条成片回退无转场 + Warning（不失败）
- FR-5.5 片头片尾：加片头/片尾（jpg/png/jpeg/gif/mp4）；片头随机剪取开头区间；「片头放入主素材/片尾放入主素材」开关（参与时长分配）；音频覆盖片头片尾
- AC：快速模式仅在编码统一前提成立时执行（不成立自动升标准，日志说明）；转场产物无音画漂移（集成测试抽 5 个转场断言时长）

### FR-6 音频设置
- FR-6.1 音量倍率 0.0–2.0（默认 1.0）
- FR-6.2 统一响度 -70.0～-5.0dB（默认 -14，loudnorm）
- FR-6.3 BGM（BgmRegistry 分级资产库，ADR-006）：
  - **三来源一出口**：`preset/` 预存库（构建期下载 CC0，只读，升级不覆盖用户改动）｜`library/` 自产库（**上传即入库、跨任务复用**）｜[二批] `generated/` AI 生成（MiniMax Music 同 key 接入）。裂变只面对 Registry，「背景音乐使用规则」（随机/顺序/指定）语义不变
  - **上传入库流水**：magic number 校验 → SHA-256 去重（同哈希报已存在）→ probe（时长/声道/采样率）→ loudness 预扫（loudnorm 单遍积分 LUFS，v1 存数不启用自动匹配）→ 元数据（名称/哈希/时长/LUFS/来源/标签/启用位）→ 即刻可选
  - **复用语义（与配音相反）**：BGM 为耐用品——不进消耗事务（ADR-002 仅约束配音池）；「替换」= 单曲禁用/启用 + 任务级规则，**禁用不删文件**
  - 背景音乐音量、循环垫底（`背景音乐不循环` 可关）
  - UI：选择器两页签（预存/自产）+ 行内（时长/LUFS/启用/试听）+ 拖拽上传；来源标记 `preset(cc0) | library(user-upload)` 可见（§13.3 责任边界）
- FR-6.4 用后即删：默认开（**确认消耗阶段才删**，ADR-002）；「移入 _consumed 文件夹」安全开关
- FR-6.5 **配音资产库与使用策略（VoiceRegistry，v1.1.2 重写，原版控件「每个音频制作：」升格）**：
  - **资产库**：`generated/`（AIGC 产物入库：文案/标题/时长/字级时间戳/来源厂商/音色）+ `upload/`（自有配音上传，同 BGM 流水：magic/hash 去重/probe/LUFS）；**归类维度=产品标签**（生成时自动挂当前产品，可手动归并）；每条显示**累计已用次数**
  - **usePolicy 三选一**：`once`（默认，原版用后即删）｜`count:N`（1–999，计次复用，到 N 后行为可选：删除/归档/保留）｜`unlimited`（耐用品，与 BGM 同语义）。策略可任务级设默认、单条覆盖
  - **事务语义（ADR-002 不变）**：确认消耗 = 计次 +1，**删除只是 Consumed 的可选副作用**
  - **循环驱动两模式**：消耗模式（parity：配音池耗尽/数量达标先到先停）｜复用模式（配音不设耗尽，停止由生成数量/素材不足/用户驱动；配音按产品随机/顺序取）。原厂隐藏行为「重复抽取+随机+用过不删除⇒无数视频」升为正式模式
  - **组合去重（v1 简化）**：记录 `配音 hash + 画面组合 hash`，同配音同画面组合不重复出片（防整条重复——原版删音频想防的就是这个）
  - AC：once 删时机不变；N=3 第 3 次确认才删；unlimited 不删且计次增长；复用模式下 50 条成片零"配音+画面组合"重复

### FR-7 视觉差异化
- FR-7.1 随机左右翻转（hflip）
- FR-7.2 随机抽帧：**前置到 ALLOCATE 之前**（ADR-005，声明偏离原版后置方案）：`select` 滤镜在片段级执行，抽帧比例 p 可精确折算时长系数，下游对齐按抽帧后实际时长计算 ⇒ 时长与音画同步由 FR-4 保证；UI 保留原版警示措辞
- FR-7.3 贴纸槽 1–3：目录（gif/png/jpg/mov/mp4）、改大小 x/y、持续、延迟、循环 gif
- FR-7.4 蒙层：透明蒙层目录（png/gif）或黑底模板 0.8
- FR-7.5 LUT：智能滤镜（10×3）+ 探店（30）全列表，lut3d
- AC：视觉差异化全部走滤镜融合单 pass（§6.1 视觉链定义）；同种子同参数可复现；抽帧+对齐集成测试断言输出时长=目标±1 帧且音画同步

### FR-8 输出设置
- FR-8.1 分辨率：默认 1080×1920；1280×720 / 1920×1080 / 720×1280 / 2160×3840 / 原分辨率 / 自定义
- FR-8.2 比特率（自定义或原码率）、帧率（默认 30 CFR）
- FR-8.3 生成数量（与配音耗尽/素材不足先到先停，停止原因记 actualStopReason）
- FR-8.4 保存目录 + 打开按钮
- FR-8.5 命名规则：按替换的音频的文件名 / 数字序号 / LLM 导出标题 / 随机标题；**sanitize 规则**：非法字符 `\/:*?"<>|` → `_`；长度 ≤80 字符（截断不破坏扩展名）；重名自动追加 `_2/_3`；LLM 标题为空/纯符号时回退配音文件名
- FR-8.6 封面：截图时间，`-ss -q:v 2`，最后添加（失败语义 §2.3）
- AC：产物 H.264/AAC mp4 平台可直传；封面 jpg 同名；命名 sanitize 单测（含中文/emoji/超长/重名用例）

### FR-9 Web 工作台
- FR-9.1 8 组参数表单（分组折叠、原版措辞）；参数持久化并可与 `多场景裂变.ini` 互换（**仅承诺 P0 键双向，非 P0 键只读透传**——ADR-003）
- FR-9.2 任务控制：开始执行任务！/ 停止；线程数 1–3（`线程数最大只能设置为3`）
- FR-9.3 实时性：SSE 日志流、阶段进度、单条 ETA、总进度、actualStopReason 展示
- FR-9.4 成片列表：封面缩略图（回退图可用）、时长、命名、打开文件/目录
- FR-9.5 池统计卡片（含 Reserved/Consumed 计数）、`检测本机显卡` 按钮（nvenc/qsv 可用性）
- FR-9.6 安全面：启动 token（§13.1）；上传 BGM magic number 校验

### FR-10 CLI
`fission doctor | run | script | voice | step | mkaudio | bench`；退出码：0 成功 / 2 参数 / 3 引擎 / 4 素材 / 5 AI；`--json` 结构化输出；进度走 stderr。demo 见 §14 各里程碑。

---

## 6. 非功能需求（NFR）

### 6.1 性能（bench 环境绑定 ADR-004）
- **环境指纹**：每次 bench 记录 CPU/GPU/驱动/ffmpeg 构建（`-version` 全文）/fixture 文件 hash；**基准机=本开发机**，指纹随表入库；无 N 卡时 nvenc 指标条件化跳过（记录 N/A），不做跨机比较
- **视觉链边界（B 评审）**：滤镜融合范围 = 同流同分辨率的 hflip/lut3d/overlay×n/scale/scale_pad；**不含**转场、concat、AV_MERGE（各自独立调用）。指标：视觉链重编码次数 ≤1（对照原厂 4–8 次）
- 量化门槛（均在本机基准机口径）：

| 指标 | 目标 | 度量 |
|---|---|---|
| nvenc 收益 | 相对 x264 veryfast ≥3x（有 N 卡时） | bench |
| 归一化吞吐 | 4K HEVC→1080p ≥6x 实时（硬解+硬编） | 单文件 bench |
| 单条成片 | **基准机标准模式中位数 ≤ 成片实时时长**（30s 片 ≤30s） | sucai 端到端 bench |
| 并发 | 成片级并发=线程数（≤3）；**ProcessPool 全局上限 = max(线程数×2, 6) 进程**，预取不得突破 | 压测观察 |
| SSE 延迟 | 事件生成→客户端接收 p95 ≤500ms（**事件带双时间戳自动断言**） | 集成测试 |
| 基准回归 | 同机同 fixture 版本间劣化 >10% 阻断合并 | bench diff |

### 6.2 可靠性
- 取消：2s 内 kill 全部子进程；半成品入 `work/{jobId}/trash`；**预留素材全部回滚**（ADR-002）
- 断点：崩溃/停止后重启任务，从缓存+流水推断已产出，续跑不重复出片；启动时自动回滚残留 Reserved
- 引擎探测：`fission doctor` 校验 ffmpeg/ffprobe/ffmpeg6/资产目录/显卡，缺失给修复指引
- 素材保护：失败路径不删素材；删除仅发生在确认消耗阶段（FR-6.4/6.5 时序）

### 6.3 可观测性
Serilog 按天+50MB 轮转保留 14 天，全日志带 jobId；`JobEvent{jobId, ts, stage, progress, detail}`；进度解析 ffmpeg `time=`；`GET /healthz`（进程/磁盘水位/引擎就绪/并行度）；每任务 `report.json`（参数快照**脱敏**、消耗流水、各阶段耗时、actualStopReason、TTS 偏差统计）。

### 6.4 兼容性
Windows 10/11 x64；与原版 ini 互换（ADR-003 范围）；产物 H.264 High yuv420p + AAC-LC。

---

## 7. 架构设计

### 7.1 项目结构

```
D:\dev\7d-rebuild\
├── PRD.md · Fission.sln · Directory.Build.props · .editorconfig · .gitattributes · .gitignore
├── docs/
│   ├── adr/001-dependency-composition.md … 005-pipeline-ordering.md
│   ├── contracts/ error-messages.zh.json · ini-mapping-spec.md · align-strategies.json
│   └── bench/（基准表+环境指纹）
├── src/{Fission.Core, Fission.Steps, Fission.Providers, Fission.AI, Fission.Web, Fission.Cli}
├── tests/{Fission.UnitTests, Fission.IntegrationTests, Fission.Bench}
├── assets/{bgm/preset, bgm/upload(.gitignore), transitions}
└── work/ · out/（.gitignore）
```

### 7.2 依赖图（B5 修正：组合根模式）

```
            ┌────────── 组合根（引用全部，负责注册）──────────┐
            │   Fission.Cli      Fission.Web                 │
            └───────┬──────────────────┬─────────────────────┘
                    ▼                  ▼
        Fission.Steps   Fission.Providers   Fission.AI
                    └─────────┬──────────────┘
                              ▼
                        Fission.Core        ← 全部抽象定义于此，零具体实现依赖
```
- **Core 定义**：`IStep`、`StepContract`、`StepOutput`、`IVideoEngine`、`IMediaProbe`、`IGLTransition`、`ILLMProvider`、`ITTSProvider`、`IAssetRegistry`、`IStepRegistry`、`MaterialPool`、`JobSpec/JobEvent/ProviderError`
- Steps→Core；Providers→Core；AI→Core；**三者互不依赖**；Cli/Web 是组合根，负责 DI 注册与路由
- 新功能 = 新 Step + 模板 JSON，不改引擎

### 7.3 Step 契约
- `StepContract{id, version(语义化), inputs/outputs JSON Schema, capabilities}`；schema **minor 向后兼容**（加字段可以，改语义升 major 并保留旧版别名）
- `StepOutput` 联合序列化：`{kind:"filter", chain:[…]}` | `{kind:"file", path, durationSec…}`
- 注册表：Core `IStepRegistry`，组合根反射扫描程序集自动注册；CLI `fission step <id>` 由注册表生成

### 7.4 滤镜融合
范围见 §6.1；融合决策（可否融合、顺序保持）单测覆盖；**融合失败自动回退逐 Step 执行**（保功能不保速度，日志说明）。

### 7.5 引擎与并发
主循环状态机（§2.1/2.2）；成片间并发=线程数（1–3）；流水线预取受 ProcessPool 全局上限约束（§6.1）；取消经 CancellationToken 贯穿 + 进程树 kill。

### 7.6 素材消耗事务（ADR-002，B1 核心）

```
Available ──reserve──► Reserved(计数 n) ──export 成功──► Confirmed ──► Consumed(计次+1)
                            │                                   │
                            ├── 失败/取消/崩溃 ──► Released(回滚 Available)
                            └── Consumed 副作用按 usePolicy（FR-6.5）：once=删/移入 | count 到 N=删/归档/保留 | unlimited=仅计次
```
- **MaterialPool 是唯一权威状态**（内存对象，池级锁）；磁盘态（缓存 ini + report 流水）仅在**确认**时落盘，写法=临时文件+原子替换
- 预留发生在 SELECT：一次成片所需的音频（含复用计次）+视频片段原子预留；同一素材不可能被并发双选（集成测试断言）
- 崩溃恢复：启动扫描未确认的 Reserved → 自动回滚；report.json 流水与缓存 ini 对账（不一致时以流水为准并告警）
- report.json 消耗流水：`[{output, audio{path, useIndex, useCount}, videos[], reservedAt, confirmedAt|releasedAt}]`

### 7.7 AI 接入规格（2026-11 官方文档核实；同 v1.0 表，此处为唯一维护点）

| 项 | DeepSeek 文案 | 豆包 TTS（主） | MiniMax TTS（备） |
|---|---|---|---|
| 端点 | `POST https://api.deepseek.com/chat/completions` | `POST https://openspeech.bytedance.com/api/v3/tts/unidirectional` | `POST https://api.minimax.io/v1/t2a_v2`（国内 minimaxi.com） |
| 鉴权 | `Authorization: Bearer` | `X-Api-Key` + `X-Api-Resource-Id: seed-tts-2.0` + `X-Api-Request-Id: uuid` | `Authorization: Bearer` |
| 模型 | `deepseek-flash` / `deepseek-v4-pro` | `seed-tts-2.0-standard`，音色如 `zh_female_vv_uranus_bigtts` | `speech-2.8-hd` / `speech-2.8-turbo` |
| 关键参数 | messages/temperature/response_format JSON | req_params{text,speaker,audio_params{format,speech_rate,loudness_rate,enable_subtitle}} | voice_setting{voice_id,speed,vol,pitch,emotion}+timbre_weights(≤4) |
| 音频返回 | —（JSON） | **base64** + sentence.words 字级时间戳 | **hex** + subtitle 字级时间戳 |
| 重试 | 429/5xx 退避 | code≠0/HTTP 分类 | 1002 限流退避；1004 鉴权不重试 |

出网白名单仅三域（§13.1）；超时文案 60s/TTS 120s；退避上限 3 次；豆包 `aigc_watermark` 默认开——**UI 配置处明示水印提示与合规说明**。

### 7.8 字级时间戳持久化（二批字幕预备）
`work/{jobId}/voice/{name}.timestamps.json`（`[{word, beginMs, endMs}]`，格式冻结为 v1）；任务成功随 report 存档到 `out/{jobId}/timestamps/`；temp 侧随清理策略回收，不堆积。

### 7.9 配置模型
`config/appsettings.json`（引擎路径、端口、上限）+ `config/keys.json`（DPAPI）；`FissionJob` JSON Schema 文档化；ini 映射见 ADR-003（P0 双向、非 P0 只读透传、未知键显式忽略清单——**不静默丢参**）。

---

## 8. 代码工程标准（统一性）

### 8.1 编译基线
.NET 10；`Nullable/ImplicitUsings` enable、`LangVersion latest`、`AnalysisLevel latest-recommended`；`TreatWarningsAsErrors` enable，**暂缓机制**：按规则登记 `NoWarn` 白名单，每项带 issue 编号与解除条件，白名单本身入 PR 审查；UTF-8 无 BOM；`.gitattributes`：`* text=auto eol=lf`，`*.sln/*.csproj eol=crlf`。

### 8.2 命名与结构
PascalCase/camelCase/`I` 前缀/`Step`/`Provider`/`Adapter` 后缀；`Async` 后缀；一类一文件；单文件 ≤500 行、单方法 ≤80 行——**审查卡点，非编译阻断**；禁魔法数字。

### 8.3 异步与并发
CancellationToken 贯穿；库内 `ConfigureAwait(false)`；禁 `async void`（事件除外）；子进程一律 `ProcessPool`；锁不跨 await；并发集合用 Concurrent/Channel。

### 8.4 错误处理
`ProviderError{code,message,retryable}`；`FissionException→{EngineException, MaterialException, AiException, ConfigException}`；不吞异常；消息含 jobId 与可操作指引；对外错误码表 §12.5。

### 8.5 日志
Serilog/ILogger 结构化；级别语义同 v1.0；禁业务 `Console.WriteLine`（Cli 顶层除外）。

### 8.6 注释
公共 API XML doc（中文）；复杂算法配溯源注释（`// 依据: 01-多场景裂变编排规范.md §2.5`）；注释写"为什么"。

---

## 9. Git 与仓库管理标准

### 9.1 前置
M1 首项：winget 安装 Git for Windows；`core.autocrlf=input`、`core.longpaths=true`、默认分支 `main`。

### 9.2 分支模型（trunk-based）
`main`（保护，仅 PR 合入，始终可构建）；`f/<scope>-<desc>`（≤5 天寿命）；`release/m<N>`（仅修 bug+文档，打 tag `v0.<N>.0`）；`hotfix/*`。

### 9.3 Commit 规范
Conventional Commits：`<type>(<scope>): <主题≤72字符>`；type ∈ feat/fix/perf/refactor/test/docs/chore/ci；scope ∈ core/steps/providers/ai/web/cli/docs/bench；一 commit 一事。

### 9.4 仓库卫生
`.gitignore`：`bin/ obj/ work/ out/ logs/ *.user .vs/ config/keys.json assets/bgm/upload/ publish/`；>10MB 二进制不入库（BGM 预设 LFS vs 构建期下载：**ADR-006 待 M1 决策**，倾向构建期下载）；D:\dev\7d 引擎与资产不入库，配置指向+doctor 校验；**CI 在 git 就绪后立即建立**（不等 M3）：GitHub Actions build+test matrix（windows-latest），端到端用 `FISSION_SUCAI_DIR` 环境变量注入，CI 缺省时以 fixture 生成替代。

### 9.5 版本与发布
SemVer v0.x→v1.0（UAT 后）；发布包 `publish/<ver>/`；PR 必须可构建（CI 门禁）。

---

## 10. 代码审查标准

### 10.1 流程
PR 描述贴**实际命令与输出**（构建/测试/跑片）；v1 单人期：§10.2 自查清单逐项勾选落 PR 模板 + 里程碑末出**变更审查报告**（变更面、风险、测试证据）供复核；≤400 行原则；24h 响应；squash merge。

### 10.2 必过 Checklist
依赖方向 §7.2；新 Step 契约+测试、随机化走 SeededRandom；CT 贯穿/ProcessPool/无句柄泄漏；失败不删素材、产物不半写（事务 §7.6）；路径规范化与越界检查；日志含 jobId/级别正确/无 Console；无硬编码路径密钥/无魔法数字/无 TODO 上 main；参数面变更同步 PRD §5 与 UI 与 `docs/contracts/`；性能敏感路径带 bench 数字。

### 10.3 直接打回
吞异常、非事件 `async void`、硬编码密钥/路径、绕过 ProcessPool、PR 无自测证据、契约文件（error-messages/ini-mapping）改动无对照说明。

---

## 11. 测试标准

| 层 | 范围 | 工具 | 门槛 |
|---|---|---|---|
| 单元 | **Core 纯逻辑**（池事务、8 策略、融合决策、命名 sanitize、ini 映射、文案相似度）Provider 全 mock | xUnit | **Core 行覆盖 ≥70%**；Step 层不卡行覆盖 |
| 契约 | error-messages.zh.json / align-strategies.json / ini-mapping-spec 断言 | xUnit | 全绿才可合并 |
| 集成 | 真 ffmpeg 小 fixture：归一化/concat/转场×5/抽帧+对齐同步/并发零重复 | xUnit+fixture 生成 | 全绿 |
| 端到端 | sucai 3 条成片规格断言（路径经 env var） | run+断言 | 每里程碑 |
| 基准 | §6.1 表+环境指纹 | fission bench | 同机同 fixture 劣化>10% 阻断 |

命名 `方法_场景_期望`（中文允许）；fixture 可再生不入库。

---

## 12. 运维

### 12.1 部署
`dotnet publish -c Release -r win-x64 --self-contained`；v1 控制台自宿主；可选 `sc create` 文档化（见 12.6 DPAPI 注意）；端口默认 8090 绑 127.0.0.1，**冲突自动回退递增（8090→8091…）并在控制台/UI 明示实际端口**。

### 12.2 目录与磁盘
work/{jobId}（temp 任务成功后清；trash 保留 7 天）；**水位策略**：≥80% 自动清 trash+已完成 temp；≥90% 拒新任务并告警（/healthz 同步）；out/{jobId}：成片+封面+report.json+timestamps/。

### 12.3 日志与监控
同 §6.3；任务报表 report.json 供 bench 对账。

### 12.4 升级回滚与备份
停服→替换二进制→doctor 校验；缓存格式带版本号向后兼容；回滚=切回 `publish/<ver>/`。**备份清单**：`config/`（keys 明文不可备份，记录需重新录入）、`assets/bgm/library/`（自产 BGM 用户资产）、`多场景素材缓存.ini` 同目录、`out/`。

### 12.5 故障手册（错误码 → 处置）
CFG-001 引擎路径失效→doctor 重指；MAT-001 空目录/损坏→原文+跳过清单；MAT-002 素材不足→原文+开重复抽取；MAT-003 并发预留冲突（不应出现，防御码）→告警+重试；DISK-001 水位≥90%→清理指引；AI-401/402 鉴权/限流→key 页重测（限流退避自动）；ENC-001 nvenc 不可用→自动回退 x264。

### 12.6 服务化注意（DPAPI）
默认控制台宿主用 `DPAPICurrentUser`；**注册 Windows 服务时服务账户与登录用户不同将无法解密 keys.json**——服务场景须在服务账户下重新录入，或改 `DPAPILocalMachine`（文档化权衡：LM 范围同机所有用户可解）。v1 默认控制台宿主规避。

---

## 13. 安全与合规

### 13.1 网络边界（B7 加固）
- 仅 127.0.0.1；**启动随机 token**：每次启动生成，控制台打印+写 `config/runtime-token`，所有 POST/SSE 需 `X-Fission-Token` 头（页面同源自动注入）；**Host 头白名单**（仅 127.0.0.1/localhost/[::1]，防 DNS rebinding）；**禁自动跟随重定向**，出网仅 §7.7 三域（域+IP 直连校验）
- 上传：扩展名白名单 + **magic number 检查** + ≤500MB + 落盘不可执行目录

### 13.2 密钥
keys.json DPAPI 加密；.gitignore 排除；UI 只显尾 4 位；report/日志永不落 key/Authorization/token 全文。

### 13.3 内容与许可
第三方许可沿用总纲 §8；**ffmpeg LGPL 动态链 + nvenc 启用的合规确认列入 M1 检查项（R6）**；BGM 仅 CC0/已授权并标注来源；用户上传责任自负（UI ToS 提示）；豆包水印默认开+合规提示（§7.7）。

### 13.4 素材安全
源素材目录零写入；删除仅限配音确认消耗路径。

---

## 14. 里程碑（垂直切片，每段交付可运行 demo）

| 里程碑 | 内容（垂直） | 可运行 demo（DoD） |
|---|---|---|
| M1 最小闭环骨架 | git+CI 骨架、Core 抽象、FFmpeg/FFprobe Provider、**doctor（引擎/硬件/资产/显卡探测）**、NORMALIZE 单文件 + bench 框架（环境指纹） | `fission doctor` 全绿截图；`fission normalize <sucai单文件>` 出 1080p 代理 + 归一化 bench 数字（x264 vs nvenc 如有）；ADR-001~006 定稿 |
| M2 离线 CLI 垂直闭环 | 素材池+**消耗事务**（B1）、五路分割、8 策略、装配（B2 矩阵）、AV 合并、差异化（抽帧前置 B3）、输出/封面/命名 sanitize、契约文件三件套（B4）、mkaudio | `fission run`（mkaudio 配音）在 sucai 出 **3 条成片**；并发零重复集成测试绿；bench 表 v1 |
| M3 AIGC 段 | DeepSeek/豆包/MiniMax 适配器、Script/Voice Steps、时间戳持久化、key 管理（CLI 侧） | 有 key：真实文案+配音出片全链 demo；无 key：mock 冒烟录屏 |
| M4 Web 工作台 | 8 组表单、池统计、启停+SSE+ETA、成片列表、key 页、token/Host 加固（B7） | 浏览器全流程走查：配置→开始→看进度→收成片 |
| M5 UAT+收尾 | §14.2 全清单（含组合用例）、bench 回归、文档收口 | UAT 报告 + 发布包 v0.5.0 |

### 14.2 UAT 验收清单
- [ ] 校验/报错：与 `error-messages.zh.json` 逐字断言（空目录/缺 BGM/缺 SRT/线程超限）
- [ ] 事务：3 线程并发 10 成片——零重复选取、零超耗、取消后素材全回滚、崩溃重启 Reserved 自动回滚
- [ ] 抽取模式×可重复抽取×**音频复用 N=1/3/不限**：消耗与删除时机正确
- [ ] 五路分割：片段数/边界抽检；最短场景合并；随机区间同数=固定
- [ ] 八策略×长短两侧 16 组合：真值表断言
- [ ] B2 矩阵：快速+无转场 copy；快速+转场自动降级提示与日志；转场抽样 5 个无漂移
- [ ] B3：抽帧+对齐输出时长=目标±1 帧、音画同步断言
- [ ] ini 互换：原版 ini 读入→出片→参数回写，P0 键无损；非 P0 键透传清单核对
- [ ] AIGC：文案差异化自动阈值+人工抽检；TTS 偏差统计口径核对；命名 sanitize 用例
- [ ] 停止：2s 内停、半成品隔离、actualStopReason 正确
- [ ] 安全：无 token 的 POST 被拒；非本机 Host 头被拒；上传 magic number 拦截可执行

### 14.3 交付物
发布包、源码仓库、PRD/ADR-001~006/契约三件套/基准表（含环境指纹）、运维手册（§12 独立文档）、UAT 报告、变更审查报告（各里程碑）。

---

## 15. 风险与开放问题

| # | 风险 | 等级 | 对策 |
|---|---|---|---|
| R1 | ffmpeg6(4.1) GL 转场稳定性 | 中 | M2 集成测试 5+ 转场；失败回退无转场+Warning |
| R2 | 本机 GPU 未知 | 中 | M1 doctor 硬件探测先行；无 N 卡条件化 bench（ADR-004） |
| R3 | 三家 API 价格/限流变动 | 低 | 适配器隔离+连通性测试 |
| R4 | VFR 源时间戳精度 | 中 | accurate_seek+边界单测；必要时两遍法 |
| R5 | 单人开发审查独立性 | 中 | §10.1 清单落 PR+里程碑变更审查报告；关键模块 AI 辅助交叉审 |
| R6 | ffmpeg LGPL 动态链+nvenc 启用合规 | 中 | M1 检查项：确认分发形态（动态链+许可声明）后启用硬编；不合规则软编兜底 |
| R7 | 配音高复用（unlimited）下平台音频指纹限流风险 | 低 | Registry 亮出累计已用次数，复用度由操作员把握；产品归档支持跨产品换用 |
| R8 | 本机 Win10 19044 未打 CET 补丁，.NET 10 SDK apphost 启动即 FailFast | 高（已缓解） | 编译走 `tools/csc-shim/csc.bat` 转发 `dotnet exec`（宿主形态绕过检查）+ 产物 `CETCompat=false`；根治=打齐 Windows 更新后移除壳（详见 tools/csc-shim/README.md）。**注意：`dotnet test` 的 testhost 为 Microsoft 预编 apphost，M2 起跑测试前需验证，必要时同法规避** |
| R9 | GeForce 驱动 NVENC 并发会话上限（537 系 ≈8 路）制约 20+ 路并发硬编 | 高（设计缓解） | NVENC 会话闸门（信号量 8，满则排队，日志可见）；编码非瓶颈（M1 实测收益 26%），排队不损失吞吐；可配置回退 x264 |
| O1 | BGM 预设入库方式 | 已定 | **ADR-006 定案**：预存=构建期下载 CC0（不入 git/LFS）；自产=`assets/bgm/library/` 本地目录（gitignore、纳入备份清单 §12.4）；AI 生成二批 |
| O2 | 组内文件名排序 | — | 维持无序池+UI 明示；数字提取排序开关二批 |
| O3 | HTTP 对外 API | — | v1 不承诺兼容（已写明 §1.2） |

---

## 16. 附录（ADR 索引与外部契约）

- ADR-001 依赖方向与组合根（§7.2）
- ADR-002 素材消耗事务模型（§7.6）
- ADR-003 ini/错误文案契约（`docs/contracts/error-messages.zh.json` · `ini-mapping-spec.md` · `align-strategies.json`）
- ADR-004 bench 环境指纹与回归阈值（§6.1）
- ADR-005 管线次序决策（**已批准**，三处声明偏离）：① 抽帧前置到对齐之前（原版后置、接受时长漂移）；② 快速模式+转场自动降级标准模式（原版极速+转场未组合）；③ 配音资产化 VoiceRegistry（原版用后即删防整条重复 → 改组合去重保留资产）
- ADR-006 BGM 分级资产库：三来源一出口（preset 只读 / library 上传即入库自产 / generated 二批）；BGM 为耐用品不进消耗事务；上传流水含 hash 去重与 LUFS 预扫；预存构建期下载、library 入备份清单（**已定案**，FR-6.3）
- ADR-007 配音资产库（VoiceRegistry）：按产品归类；usePolicy once/count:N/unlimited；消耗事务不变、删除为 Consumed 可选副作用；循环驱动两模式（消耗/复用）；组合去重（配音 hash+画面组合 hash）
- 外部：原版文案对照（`01-多场景裂变编排规范.md`）、66 转场（`D:\dev\7d\lib\*.glsl`）、AI 官方文档（api-docs.deepseek.com / platform.minimax.io / docs.volcengine.com/docs/6561/2528925）、素材缓存 ini 实物

---

*评审记录：v1.0-draft → 有条件通过（B1–B8）→ v1.1 修订稿 2026-11-02 提交复核。*
