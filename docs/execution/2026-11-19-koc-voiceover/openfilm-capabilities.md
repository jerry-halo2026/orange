# OpenFilm 能力清单 & 无人声素材的语义化

日期 2026-11-19 · 与 `playbook.md` 配套：那份讲"怎么编"，这份讲"手上有什么"

> 每个条目都标了状态：**能用**（有代码、有测试，跑过）/ **半通**（有代码，缺一端）/ **未验证**（代码在，没真跑过）。
> 这不是愿望清单，是当前这一步的事实基线。

---

## 1. Studio（编辑器与服务器）

| 能力 | 状态 | 入口 / 证据 |
|---|---|---|
| 项目读写（`film.html` 是唯一真相源） | 能用 | `src/film-doc.mjs`，`ops.mjs` 应用编辑 |
| 时间线编辑（片段、轨道、转场、元素） | 能用 | Studio 编辑器 UI + `/api/projects/*` |
| **字幕轨（WebVTT）** | 能用 | `studio/server/caption-tracks.mjs`：`caption-tracks/file`、`from-subtitles`、`sync`、`speech` |
| 字幕样式（字体/描边/位置） | 能用 | `captions.mjs` + `writeSubtitleStyle` |
| 字幕**自动转写** | **半通** | `POST projects/subtitles/transcribe` 在桌面账号路径下直接 **503**（`server.mjs:336`「尚未可用」） |
| 字幕翻译 | 半通 | 同上，`subtitles/translate`、`caption-tracks/translate` 503 |
| 画布（canvas）与角色 | 能用 | `canvas-write`、`canvas-characters.mjs` |
| 导出 | **未验证** | 走 `exports.mjs` → Fission（见第 4 节） |
| 本地语音识别（ASR） | 能用 | `src/local-asr.mjs`（onnxruntime-web，本机跑） |
| 本地抠像 | 能用 | `src/local-cutout.mjs`（同一个 wasm 运行时） |
| 本地语义检索（元素库） | 能用 | `library-semantic.mjs` + `library/vectors.i8`（8 779 条，bge-base-zh） |
| 素材检索（我们自己那份语料） | 能用 | `material-search.mjs` + 向量包（67 156 条） |

## 2. CLI（`openfilm`）

| 命令 | 状态 | 说明 |
|---|---|---|
| `openfilm open / get` | 能用 | `get` 是"取一条素材/元素进工程" |
| `openfilm get music-search / sfx-search / transition …` | 能用 | 元素检索的 CLI 形态，**语义检索已改成本机**（不走服务） |
| `openfilm render / look` | 能用 | 出帧、出片（走浏览器渲染） |
| `openfilm doctor` | 能用 | 环境自检（含 ffmpeg、浏览器、数据目录） |
| `openfilm update` | 能用 | 从 npm 更新 |

## 3. MCP（给 agent）

| 工具 | 状态 | 用途 |
|---|---|---|
| `library.search` | **能用**（本轮新增） | 元素：转场/特效/滤镜/贴纸/文字/模板/音乐/音效，中文语义 + 词法 |
| `material.search` | 能用 | 素材：67 156 条云管家素材，本机向量包 |
| `material.collections` / `material.items` | 能用 | 批次/合集/条目浏览 |
| `materials.take` | 能用 | 取一条素材进 `assets/`（文件名＝云管家名字 + id） |
| `timeline.insert_clip` | 能用 | 插入时间线片段 |
| `wiki.video / timeline / shot` | 能用 | 读项目结构（agent 的"眼睛"） |
| `openfilm.look` | 能用 | 看一眼（出帧） |

**缺**：写字幕轨（`.vtt`）、写音频轨（配音/BGM 落位）、读"当前时长/画幅/镜头数"的校验工具。

## 4. Fission（渲染器）

| 能力 | 状态 | 说明 |
|---|---|---|
| 编译 | **能用** | `dotnet build src/Fission.Cli` → 0 错，14 s（.NET 10.0.300） |
| 启动 | **半通** | 必须注入 `FISSION_ENGINE_PATHS`（ffmpeg/ffprobe/transitions/assets/work/out 七个路径），拒绝猜默认 |
| 输入 | 能用（有限） | 只吃**项目本地文件路径**；`select` 的 role 只有 `video/audio/bgm/intro/outro` |
| 云管家素材 | **不能用** | 没有检索概念，必须先 take 到 `assets/` |
| 文案 / 字幕 / 配音 / BGM 生成 | **不能用** | job 里没有这些字段 |
| 混剪逻辑与审美约束 | **不能用** | 没有"镜头数/画幅/时长/音画对齐"的约束与校验 |

结论：**Fission 是渲染器**。策划、素材、文案、字幕、配音、BGM、校验都应该在它**之前**完成。

## 5. Providers（用户自带 key 的生成能力）

| 能力 | 状态 | 供应商 |
|---|---|---|
| TTS | 能用 | qwen（qwen3-tts-flash）、minimax（t2a_v2）、elevenlabs、doubao |
| ASR | 能用 | qwen（qwen3-asr-flash）、minimax（speech_to_text）、本地 `local-asr` |
| 音乐生成 | 能用 | elevenlabs（music_v2_5）、fal（stable-audio-25 / lyria2）、minimax（music-3.0，可能已闭户） |
| 音效生成 | 能用 | elevenlabs（sound effects） |
| 图像 / 视频生成 | 能用 | fal、doubao、openai 等 |
| 文案 | 不设 verb | 写作是 **agent 自己的模型**（产品设计上如此，Settings 里也这么写） |

---

## 6. 无人声素材：不用 STT，用三路语义

**先把问题说清**：STT（语音→文字）只对"有人说话"的素材有意义。我们语料里大量是空镜、产品特写、环境声，
它们**没有话可转写**，所以"给静音素材做 STT"这条路本身就是错的。静音素材的语义要另取，共三路：

| 来源 | 现在有没有 | 说明 |
|---|---|---|
| ① 已有元数据 | **有** | 云管家的 `name`（如「包装_93」「在晒场晾晒小青柑画面20」「迪士尼小青柑—办公室-送礼」）、批次/合集/一二级分类。名字里已经写了动作、地点、对象 |
| ② 人声转写（ASR） | **有** | 对**有人说话**的素材：`local-asr.mjs` 本机转写 → 文本 → 进检索。这是我们已有的，只是还没接进"素材入库"流程 |
| ③ 视觉理解（抽帧打标） | **没有** | 静音素材的唯一可靠来源：抽 3 帧 → 视觉模型 → 结构化标签（主体/动作/景别/光线/室内外/季节） |
| ④ 音频事件 | **没有** | 非语音声音：雨/风/人群/机器/音乐，用于"氛围类"空镜 |

### 抽帧打标的落地形态（③，建议下一步做）

```
每个素材：ffmpeg 抽 3 帧（10% / 50% / 90% 处）→ 视觉模型（用户自带 key，或本地小模型）
  → 结构化标签：
     { 主体: 人物|手部|包装|产品|茶汤|环境|无主体,
       动作: 冲泡|倒茶|掰柑|晾晒|手持|走|坐|开箱,
       景别: 特写|近景|中景|全景,
       光线: 暖|冷|自然光|室内灯,
       场景: 办公|居家|户外|茶室|货车|晒场,
       人物: 有/无 }
  → 拼成一段检索文本（与 name 合并）→ 同一个 bge-base-zh 编码 → 进向量包
```

代价：67 156 条 × 3 帧 = 20 万帧；按用户自带 key 的视觉模型算，量级是"一次性几小时、增量每天几百帧"。
收益：**空镜第一次变得可检索、可分类**（现在名字只覆盖 12%，空镜 66 条）。

### 关于"没人说话的视频怎么做字幕"

不需要字幕。**字幕只跟著说出来的话走**：没有口播的段落就是"无字幕段"，
它们承担的是节奏（留白）、情绪（空镜）与转场，不该被硬塞字。

---

## 7. 三条产品链路（现状对照）

| 链路 | 现在能不能走通 | 缺什么 |
|---|---|---|
| **A. 口播混剪**（15 s / 9:16 / ≥5 镜） | 零件齐、串不起来 | TTS→真实时长→回填；写 `.vtt` 的 MCP 工具；七条校验器 |
| **B. 空镜/氛围片**（无人声，BGM 驱动） | 检索可用，编排无工具 | 抽帧打标（③）；按 BGM 节拍排片（CutClaw 那套思路） |
| **C. KOC 图文/短口播**（一条产品一句话） | 基本可用 | 只缺"合规 + 场景标签"接进生成流程（claim-check 已有） |

---

## 8. 结论

- **能力不缺**：检索、生成、字幕轨道、渲染器都在；
- **缺的是"串"**：TTS→时长→排片→字幕→校验这条链没有接起来，且 agent 手上没有写字幕/查校验的工具；
- **静音素材的语义**必须靠抽帧打标补，STT 帮不上；
- **Fission 不该有界面**：它的表单式 UI 是"铺满文字"的根源，策划与校验应当回到 Studio 的任务卡。
