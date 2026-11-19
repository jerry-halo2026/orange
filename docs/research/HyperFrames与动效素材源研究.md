# HyperFrames 与动效素材源研究

文档集 U2，2026-11-17。作者：本会话 Lead。目的：在不引入第二套底座的前提下，判断 HyperFrames 生态里**哪些素材能进我们的库、以什么形态进、许可怎么落**，并给出可继续扩展的素材源清单。

证据等级：

- `[仓库]` 直接读 `github.com/heygen-com/hyperframes` 的 `main`（文件原文，2026-11-17 抓取）
- `[文档]` 官方文档站 `hyperframes.heygen.com` 的 mdx 原文（在仓库 `docs/` 下）
- `[站点]` 实际访问的外部页面
- `[二手]` 第三方对比/评测文章，只作市场信息，不作技术依据

> 全部结论只对上述时点负责。仓库在动（`v0.9.60`，2026-11-17 提交）。

---

## 1 结论

1. HyperFrames 是**HTML 原生**的“网页→视频”框架，Apache-2.0，与本项目 [SPEC.md](../../packages/openfilm/SPEC.md) 的 Protocol 0.1 在**契约层高度同构**：都是“无头 Chrome 逐帧求值 + FFmpeg 编码，永不播放”，都要求“同一 t 同一帧”。`[仓库][文档]`
2. 它的**素材价值在 `registry/`**：实测 **457 条**（blocks 210 / components 238 / examples 9），其中 **231 条带 variables**（可参数化）；交付形态是**单文件 HTML 片段**，不是运行时依赖。`[仓库]`
3. 它的**底座价值为零**：`@hyperframes/engine|producer|studio|cli` 是一整套渲染/编辑/发布体系，我们用 playwright + ffmpeg + Studio 已经覆盖，引入即第二套底座。`[仓库]`
4. 两边有 **4 处真实差异**必须在搬运时改：`data-start/data-duration` → `at`；`data-track-index`（只是编辑器行，层叠靠 `z-index`）→ `<section>` 顺序；`window.__timelines[id]` → `window.film.frame(t)`；合成内 `<audio>` → 时间线声音 clip（**我们的页面无声**）。`[仓库][文档]`
5. 参数化能机械对接：他们 `data-composition-variables`（7 种 kind：string/number/color/boolean/enum/font/image）↔ 我们 `data-props`（text/var）。`[文档]`
6. 我们也有一套语义检索（`library/vectors.json`，multilingual-e5-small，384 维），他们是 `catalog-artifact`（bge-small-en-v1.5，384 维，`catalog --query --on-device`）——**同规格不同模型**，可参考其“关键词档 + 本地语义档”的两档设计。`[仓库]`
7. 许可上有一条硬冲突：他们 **Apache-2.0**，我们 `library/` 声明 **CC0**。**原样拷贝不能进 CC0 库**，只能放独立目录 + 通知，或重写后再进库。`[仓库][代码]`
8. 现有库规模：`library/index.json` **158 条** + 8 个 catalogs（templates 14、text-templates 58、transitions-more 46、transitions-move 26、effects-more 48、filters 66、motions 38、stickers-motion 45）≈ **499 条编目**。缺口集中在：社交/系统 UI 卡、数据图表、地图、代码片段、3D 背景、相机运动、光标演示。`[代码]`

---

## 2 HyperFrames 是什么

| 项 | 事实 | 证据 |
| --- | --- | --- |
| 仓库 | `github.com/heygen-com/hyperframes`，"Write HTML. Render video. Built for agents." | `[仓库]` |
| 许可 | **Apache-2.0** | `[仓库]` README/LICENSE |
| 版本 | `v0.9.60`（2026-11-17 最新提交 `chore: release v0.9.60`） | `[仓库]` |
| 作者 | HeyGen（生产使用）；社区采用者含 tldraw、TanStack 等 | `[仓库]` ADOPTERS.md |
| 定位 | HTML + data 属性定时 + 可 seek 动画（GSAP/CSS/Anime.js/Lottie/Three.js/WAAPI），无头 Chrome 逐帧、FFmpeg 编码 | `[仓库]` |
| 与 Remotion 的官方差异 | 授权模型 HTML vs React；**无构建步骤** vs 需打包；库时钟动画需适配 vs 需小心 | `[仓库]` 对比表 |

### 2.1 包结构（判断“底座”边界用）

| 包 | 作用 | 我们要不要 |
| --- | --- | --- |
| `hyperframes`（CLI） | init/preview/lint/catalog/add/beats/keyframes/render/share/skills | ❌ |
| `@hyperframes/core` | 类型、解析器、生成器、linter、runtime、frame adapters | ❌（契约可读，代码不用） |
| `@hyperframes/engine` | Puppeteer + FFmpeg 的抓帧引擎 | ❌ 我们有自己的 `src/render.mjs` + playwright |
| `@hyperframes/producer` | 抓帧→编码→混音整条管线 | ❌ |
| `@hyperframes/studio` / `studio-server` | 浏览器编辑器 | ❌ 我们有 Studio |
| `@hyperframes/player` | `<hyperframes-player>` web component | ⏸ 仅在“纯前端嵌入预览”场景有意义 |
| `@hyperframes/shader-transitions` | WebGL shader 转场 | ⏸ 只在需要 GLSL 转场时单独借 |
| `@hyperframes/aws-lambda` / `gcp-cloud-run` | 分布式渲染 | ❌ |
| `@hyperframes/parsers` / `lint` / `inspector` / `share` | 语法解析、lint 规则、检查器、分享 | ❌（lint 规则可当“错误清单”参考） |
| **`registry/`** | **457 个 HTML 片段 + 元数据** | ✅ **只要这个** |

### 2.2 CLI 与技能（不进我们仓库，但要知道它们在做什么）

- CLI：`npx hyperframes init|preview|lint|catalog --query|add <name>|beats|keyframes|render`
- 9 个 agent skill：`/hyperframes`、`/hyperframes-cli`、`/hyperframes-registry`、`/media-use`、`/reverse-any-video`、`/style-sampling`、`/figma`、`/slideshow`、`/remotion-to-hyperframes`
- 其中对我们**只有知识价值**的是 `hyperframes-registry`（怎么在 ~450 条里挑）与 `remotion-to-hyperframes`（帧语义映射）

### 2.3 相关站点

| 站点 | 内容 | 状态 |
| --- | --- | --- |
| `hyperframes.heygen.com` | 官方文档：introduction/quickstart/concepts/reference/catalog/showcase/studio/developers | `[仓库]` 引用，未逐页访问 |
| `hyperframes.heygen.com/catalog` | 组件目录（blocks/components） | `[仓库]` README |
| `hyperframes.heygen.com/showcase` | 成片展示（可看/可读/可 remix） | `[仓库]` README |
| `www.hyperframes.dev` | **社区 playground**（预览、迭代、分享、渲染） | `[站点]` 已访问，登录页 |
| `hyperframes.studio` | Studio 产品站 + 设计系统 gallery（frame.md） | `[仓库]` README，未访问 |
| `static.heygen.ai/hyperframes-oss/...` | 每个 item 的 poster/preview 视频 CDN | `[仓库]` registry-item.json |
| hosted MCP | 仓库内 `server.json`，已发布到官方 MCP registry | `[仓库]` |

---

## 3 契约：能不能吃，取决于这四件事

### 3.1 合成（composition）

```html
<div id="root" data-composition-id="root" data-start="0" data-width="1920" data-height="1080">
  <img class="clip" src="assets/logo.png" data-start="0" data-duration="2" data-track-index="0" />
  <video class="clip" src="assets/video.mp4" data-start="2" data-duration="3" data-track-index="0"></video>
</div>
```

- 定时属性：`data-start`（可为 `intro - 0.5` 相对引用）、`data-duration`、`data-track-index`
- 嵌套：同文件内联，或 `<div data-composition-src="compositions/x.html" data-playback-start data-playback-rate>`，被引用文件用 `<template>` 包裹（路径从项目根解析）
- 轨道**不是层**：层叠靠 CSS `z-index`（官方明确写 “Tracks are not layers”）
- 动画写在脚本里：`window.__timelines["<id>"] = gsap.timeline({ paused: true })`

### 3.2 确定性（determinism）

> "Rendering never plays the animation. It asks for one frame, waits, captures it, then asks for the next, so the same frame always comes out the same."

Frame adapter 契约原文要求：帧数有限非负、支持正/反/随机 seek、同一帧同一状态、**不得使用 wall-clock 计时器与未播种随机**、异步工作在抓帧前结束。

### 3.3 变量（variables）

```html
<html data-composition-variables='[
  {"id":"title","type":"string","label":"Title","default":"Pro"},
  {"id":"accent","type":"color","label":"Accent color","default":"#6c5ce7"},
  {"id":"logo","type":"string","label":"Logo","default":"assets/logo.svg"}
]'>
```

- 7 种 kind：`string`（文本或文件链接）/`number`/`color`/`boolean`/`enum`/`font`/`image`
- 直接绑定：`data-var-text="title"` 等，无需脚本
- 语义元数据 `portrays`（`subject_name`/`competitor_name`/`authority_badge`…）+ `role`（content/style/timing/motion/layout）
- 单次挂载覆盖：`data-variable-values`

### 3.4 与我们 Protocol 0.1 的映射

| 维度 | HyperFrames | OpenFilm Protocol 0.1 | 搬运动作 |
| --- | --- | --- | --- |
| 画面单位 | `data-composition-id` 的 div | 页面 `*.html` + `window.film` | 片段包成一个 page |
| 时间 | `data-start` / `data-duration`（相对引用要算） | `at` + `src#t=in,out` | 算成绝对值 |
| 层叠 | `z-index`（track 只是编辑器行） | `<section>` 顺序（第一个在上），同轨不重叠 | 片段内部保留 z-index，外层一轨一 iframe |
| 动画 | `window.__timelines[id]`（seekable） | `window.film.frame(t)` | 加 `frame(t){ tl.seek(t) }` 壳 |
| 声音 | 合成内 `<audio data-start data-volume>` | **页面无声**，只能是时间线 clip | 上提为 `<audio>` clip |
| 嵌套 | `<template>` + `data-composition-src` | `<iframe src="parts/x/film.html">` | 编成一个 page 最省事 |
| 参数 | `data-composition-variables`（7 kind） | `data-props`（text/var） | 机械映射 |
| 渲染 | Puppeteer 逐帧 + FFmpeg | playwright 逐帧 + FFmpeg | 不需要换 |
| 构建 | 无 | 无 | 一致 |

---

## 4 Catalog 实测（457 条，`docs/research/hyperframes-catalog.json`）

### 4.1 规模

| 维度 | 数 |
| --- | --- |
| 总数 | **457** |
| blocks（整场景，含自己的 timeline） | 210 |
| components（片段，并入你的场景） | 238 |
| examples（整支示例片） | 9 |
| 带 variables（可参数化） | 231 |
| 标 `webgpu`/`webgpu-shader` | 40 |
| 标 `webgl` | 20 |
| 标 `3d` | 22 |

> `registry.json` 记 456 条（examples 8），目录实际 457（examples 9）。差异按目录为准。

### 4.2 标签分布（top 20）

`motion-primitive 125`、`showcase 62`、`transition 52`、`typography 45`、`overlay 43`、`webgpu 40`、`webgpu-shader 36`、`background 34`、`reveal 30`、`video-primitive 29`、`carousel 27`、`images 25`、`deterministic 24`、`3d 22`、`product-demo 20`、`shader 20`、`webgl 20`、`gallery 20`、`effect 20`、`transition-primitive 19`。

### 4.3 分族清单（按 usefulness 排序）

**转场（33）**：`transitions-{3d,blur,cover,destruction,dissolve,distortion,grid,light,mechanical,other,push,radial,scale}`、`beat-freeze-cut`、`chromatic-radial-split`、`cinematic-zoom`、`cross-warp-morph`、`domain-warp-dissolve`、`editorial-flash-overlay`、`flash-through-white`、`glitch`、`gravitational-lens`、`hw-scribble-transition`、`light-leak`、`mk-clone-wall-transition`、`organic-light-leak-overlay`、`ridged-burn`、`ripple-waves`、`sdf-iris`、`swirl-vortex`、`thermal-distortion`、`whip-pan`

**下三分之一（13）**：`lt-{accent-underline,bold-block,clean-bar,color-block,dark-card,kicker-name,mask-reveal,neon-border,side-rule,soft-pill,stack-bars}`、`lower-third-bild`、`news-ticker`

**字幕组件（16）**：`caption-{camera-follow,clip-wipe,editorial-emphasis,emoji-pop,glitch-rgb,gradient-fill,highlight,kinetic-slam,matrix-decode,neon-accent,neon-glow,parallax-layers,particle-burst,pill-karaoke,texture,weight-shift}`

**标题/字体（9）**：`code-slice-hero`、`hw-path-text`、`hw-title`、`hw-write-title`、`mk-callout-highlight`、`mk-clone-wall-transition`、`weight-wave`、`wireframe-portal-title`、`yt-prism-title`

**社交/系统 UI（13）**：`editorial-flash-overlay`、`freeze-frame-dressing`、`instagram-follow`、`macos-notification`、`reddit-post`、`spotify-card`、`thread-message-stack`、`tiktok-follow`、`x-post`、`yt-comment-card`、`yt-lower-third`、`caption-emoji-pop`、`caption-highlight`

**数据/图表/地图（21）**：`bar-chart-race`、`data-chart`、`hw-pipeline`、`mk-line-graph`、`mk-progress-stat`、`mk-specs-list`、`oscilloscope-trace`、`spain-map`、`us-map`、`us-map-bubble`、`us-map-flow`、`us-map-hex`、`week-in-merges`、`world-map`、`animated-bar-chart`、`conic-progress-ring`、`decline-chart`、`logo-wall`、`mk-usage-arc`、`number-wheel`、`star-rating-fill`

**HTML-in-canvas / 玻璃质感（12）**：`ios26-liquid-glass`、`liquid-glass-notification`、`liquid-glass-widgets`、`macos-tahoe-liquid-glass`、`vfx-iphone-device`、`vfx-liquid-background`、`vfx-liquid-glass`、`vfx-magnetic`、`vfx-portal`、`vfx-shatter`、`vfx-text-cursor`、`filmed-screen`

**WebGPU 背景（40，二期）**：`aurora`、`blob`、`chrome-orb`、`color-wheel`、`falling-lines`、`flowing-gradient`、`fractal-noise`、`frost`、`frost-sequence-camera-orbit`、`gabor-noise`、`godrays`、`goo`、`heatmap`、`hologram`、`holographic`、`lens-flare`、`light-edge`、`liquid-metal`、`marble`、`mesh-gradient`、`nebula`、`obsidian`、`plasma`、`plastic`、`prism`、`ripples`、`sine-wave`、`spiral`、`strands`、`stripes`、`sun-burst`、`swirl`、`thin-film`、`voronoi`、`water`、`waveform`、`worley-noise` 等

**组件原子（238）**：`motion-primitive` 101、`video-primitive` 28、`cursor` 14、`effect` 9、`prop` 8、`transition` 7、`camera` 5、`text` 5、`handwritten` 5、`data` 4 …

### 4.4 每个 item 的元数据形状

`registry-item.json`：

```json
{ "name": "blur-in", "type": "hyperframes:component", "title": "Blur In",
  "description": "…", "tags": ["video-primitive","blur-in","text-effect"],
  "files": [{ "path": "blur-in.html", "target": "compositions/components/blur-in.html", "type": "hyperframes:snippet" }],
  "variables": [{ "id":"size","type":"number","role":"style","default":52,"min":24,"max":120,"unit":"px" }, …],
  "preview": { "poster": "https://static.heygen.ai/…png" } }
```

### 4.5 他们的检索怎么做（可借鉴）

- `registry.json` 是清单；`catalog-artifact/local-vectors.*` 是 **384 维 bge-small-en-v1.5** 的本地语义索引（一条一行，`{model, revision, dimensions, names}` + Float32 二进制）
- 两档：`words`（离线关键词，默认）与 `--on-device`（一次性下载模型后按语义排序）
- `catalog --query --json` 会给出 tier，并在没有命中时预填 `report_gap`
- 我们的 `library/search.json` + `library/vectors.json`（multilingual-e5-small，384 维）是同一思路、更贴中文

---

## 5 我们现有库的规模与缺口

| 来源 | 条目 |
| --- | --- |
| `library/index.json` | **158**（text 90 / effect 22 / sound 20 / transition 15 / sticker 11） |
| `catalogs/templates.json` | 14 |
| `catalogs/text-templates.json` | 58 |
| `catalogs/transitions-more.json` / `transitions-move.json` | 46 / 26 |
| `catalogs/effects-more.json` / `filters.json` / `motions.json` / `stickers-motion.json` | 48 / 66 / 38 / 45 |
| 目录条目（`library/<cat>/*/`） | text 78、templates 14、transitions 61、effects 71、motions 64、stickers 56 |

**结论**：我们的强项是**中文文案 + 一个字/词的样式体系（90 条 text）+ 库内模板（14 条整片）**；HyperFrames 的强项是**场景级花活**（转场 33、字幕样式 16、社交卡 13、图表地图 21、WebGPU 背景 40、光标演示 14）。两者互补，不冲突。

---

## 6 外部动效素材源清单

> 判定：**搬** = 可直接拷 HTML/CSS/JS 片段；**改** = 需转成 `window.film` 页面或改驱动方式；**参考** = 只看设计；**不用** = 引入新运行时/许可不允许。

### 6.1 免框架 HTML/CSS/JS 片段（最贴合我们）

| 站 | 内容 | 许可 | 判定 | 优先级 |
| --- | --- | --- | --- | --- |
| [HyperFrames registry](https://github.com/heygen-com/hyperframes/tree/main/registry) | 457 条 blocks/components/examples | Apache-2.0 | **改**（四条改写） | P0 |
| [Animista](https://animista.net/) | CSS `@keyframes` 生成器，可调 easing/delay/时长 | **FreeBSD**（保留版权声明，商用 OK）`[站点]` | **搬**（CSS 动画我们 host 会自动定格到 t） | P0 |
| [NudaUI](https://github.com/sgomez-dev/nudaui) | 复制粘贴的 CSS/JS 组件（Command Palette、主题切换、Hero、定价表、视频播放器等）`[二手]` | 未核 | 参考 / 改 | P2 |
| css-loaders / Uiverse 类 | 纯 CSS 加载与 UI 动效 | 未核（多为 MIT） | 参考 | P2 |

### 6.2 JS 动画库

| 库 | 内容 | 许可 | 判定 |
| --- | --- | --- | --- |
| [GSAP](https://gsap.com/) | timeline + 全部插件（SplitText/MorphSVG…） | 自 2025-05 起**全免费**（含商用，Webflow 收购后）；GreenSock Standard License（非 OSI）`[二手/站点]` | **改**：只允许 `paused` + `seek(t)`，禁 `play()`、禁依赖首帧的 `to()` |
| [Motion](https://motion.dev/) | React/JS/Vue 动画（layout/scroll/gesture/spring/3D） | 自述 free & open source（具体许可未核） `[站点]` | 参考；我们不需要它的 React 层 |
| Anime.js | 轻量 timeline | MIT（未核） | 改 |

### 6.3 GLSL / WebGL / WebGPU

| 源 | 内容 | 许可 | 判定 |
| --- | --- | --- | --- |
| [gl-transitions](https://gl-transitions.com/) | **193 个** GLSL 转场，61 位作者；自动转 SkSL/WGSL/Metal/GLSL ES 3.00 | 每条由作者署名，“free license”（**逐条核**）`[站点]` | 改（写成 WebGL 页面，需 `preserveDrawingBuffer: true`） |
| three.js examples | 官方示例（MIT） | MIT | 改 |
| Shadertoy | 大量 shader | **逐条不同，很多禁商用** | 只用思路，不拷代码 |

### 6.4 Lottie / Rive（**不建议**）

| 源 | 许可事实 | 判定 |
| --- | --- | --- |
| LottieFiles 免费档 | 官方商业使用政策：**Free/Individual 计划禁止商用**；文件本身是 Lottie Simple License（非 OSI，带 share-alike 味道） `[站点]` | 不用 |
| Rive Marketplace / Community | **CC BY 4.0**，需署名；且要 Rive runtime（新底座） | 不用 |
| IconScout 等 | 订阅制，不可再分发 | 不用 |

### 6.5 其它“网页→视频”引擎（只做参照，不引入）

| 引擎 | 授权模型 | 与我们关系 |
| --- | --- | --- |
| Remotion | React/TSX + 打包器 | 素材可借，运行时不用 |
| Motion Canvas | TS 库 + 编辑器 | 不用 |
| Revideo | Motion Canvas 的程序化视频分支 | 不用 |
| editly | JSON/JS 声明式剪辑 | 不用 |
| OpenMontage | —（第三方对比文提及） | 不用 |
| 市场数据 | 2026-11-11 前后 star：HyperFrames 82.5k、Remotion 72.4k `[二手]` | 仅供判断生态热度 |

### 6.6 组件注册表（Remotion 系，需 React 底座）

| 源 | 内容 | 判定 |
| --- | --- | --- |
| [snapcn](https://snapcn.dev/docs/components) | Remotion 组件市场；Pro 组件 registry 端点返回 **402 需付款**（实测） | 不用（或离线出片） |
| [remocn](https://github.com/remocn/remocn) | shadcn registry 形式分发的 Remotion 动画/转场/背景/模板 | 不用 |

---

## 7 适配判定矩阵

| 素材形态 | 典型来源 | 我们怎么吃 | 成本 |
| --- | --- | --- | --- |
| 纯 CSS `@keyframes` 片段 | Animista、HyperFrames 纯 CSS 组件 | 包成 page，**动画由 host 自动定格**；只补 `window.film` 壳 | 低 |
| GSAP/JS timeline 片段 | HyperFrames 多数 blocks | 包成 page，`frame(t){ tl.seek(t) }`；`fromTo` 化 | 中 |
| 合成内带音频 | HyperFrames blocks | 音频上提为 `film.html` 的 `<audio>` clip | 中 |
| WebGL/WebGPU | HyperFrames webgpu 族、gl-transitions | 写成 canvas 页；WebGL 需 `preserveDrawingBuffer`；WebGPU 待验证 | 高 |
| React/Remotion 组件 | snapcn、remocn | 离线渲染成 mp4，或重写 | 高（且引底座） |
| Lottie/Rive | LottieFiles、Rive | 不用（许可/运行时） | — |

---

## 8 许可红线

1. **Apache-2.0 的原码不能进 `library/`**：`library/LICENSE.md` 对我们库内容声明 **CC0 1.0**，Apache-2.0 不能重许可为 CC0。原样搬运只能放独立目录（如 `overlay/third-party/hyperframes/<name>/` 或工程内 `scenes/`），并在 `THIRD_PARTY_NOTICES.md` 记来源/许可/修改。
2. **要进 CC0 库必须重写**：只借视觉与动效思路、自己写 HTML/CSS/JS（clean-room），才能沿用 CC0。
3. **GSAP 不是 OSI 许可**：免费可商用，但属 GreenSock 自有许可；不想引第三方许可的片段改用 CSS/WAAPI（我们的 host 两者都支持）。
4. **LottieFiles 免费档禁商用**；**Rive 需 CC BY 署名 + runtime**。两者都不进库。
5. **gl-transitions 逐条核许可**：集合本身“free license”，但每个 shader 有作者署名要求。
6. **预览资源不落库**：`static.heygen.ai` 上的 poster/preview 只作对照，不进仓库（体积与再分发都不合适）。

---

## 9 建议的填充顺序

### P0（先做，收益最高、风险最低）

1. **转场 8 条 → 重写进 `library/transitions/`**：`whip-pan`、`sdf-iris`、`flash-through-white`、`light-leak`、`glitch`、`beat-freeze-cut`、`ridged-burn`、`swirl-vortex`
   验收：`openfilm get transition --prompt "whip pan"` 命中；`--take` 打印 clip 行；`openfilm look` 逐帧对照原 preview。
2. **字幕样式 6 条 → 重写进 `library/text/`**（或 `fonts/` 下的 caption 组）：`caption-highlight`、`caption-kinetic-slam`、`caption-pill-karaoke`、`caption-neon-glow`、`caption-matrix-decode`、`caption-clip-wipe`
3. **下三分之一 5 条**：`lt-clean-bar`、`lt-bold-block`、`lt-mask-reveal`、`lt-side-rule`、`news-ticker`（我们已有 `news-ticker` 风格，注意去重）
4. 每进一条：`saved.json` + `files/` + `poster.jpg` + `preview.mp4`，再跑
   `node scripts/library-search-index.mjs` / `node scripts/library-previews.mjs` /（可选）`node scripts/library-vectors.mjs`

### P1

5. **社交/系统 UI 卡 6 条**：`x-post`、`yt-comment-card`、`macos-notification`、`spotify-card`、`thread-message-stack`、`instagram-follow`
6. **数据/地图 5 条**：`bar-chart-race`、`mk-line-graph`、`conic-progress-ring`、`number-wheel`、`world-map`
7. **光标演示 4 条**：`agent-cursor`、`cursor-annotate`、`cursor-drag-drop`、`cursor-marquee-select`（做“软件演示/教程”类片子刚需）

### P2

8. **WebGPU 背景族**（40 条里挑 6-8 条）：先验证我们的 playwright Chromium 是否稳定开 WebGPU；不行就降级为 CSS/Canvas 重写
9. **gl-transitions** 选 5 条转 WebGL 页
10. **examples 9 条**：不搬代码，作为“整片节奏”参考，必要时做成 `examples-index` 的示例工程

---

## 10 未验证 / 待验证

| 项 | 状态 | 怎么验 |
| --- | --- | --- |
| WebGPU 在 `playwright-core` 内置 Chromium 下能否稳定抓帧 | 未验证 | 拿 `aurora`/`mesh-gradient` 原片段包壳，`openfilm look 0-2` 看是否空白/错帧 |
| WebGL 片段是否需要 `preserveDrawingBuffer` 之外的处理（合成层、DPR） | 未验证 | 同上，含 `preserveDrawingBuffer: true` 对照 |
| GSAP 包体（约 50 KB min）与首帧 `ready` 时序 | 未验证 | 打包后看 `ready` 是否覆盖 timeline 构建 |
| `SVG filter`（`feTurbulence` 等）在 1080p 的渲染耗时 | 未验证 | `openfilm render` 计时，对比纯 CSS |
| HyperFrames `examples` 的 `<template>` 结构能否一对一映射 | 部分 | 只读了 compositions 文档，未逐个读 9 个 example |
| Animista 生成的 keyframes 是否全部 t 可定格（有无 `transition`/JS 依赖） | 未验证 | 抽样 10 条跑 `look a-b` |
| `library/` 引入重写后的条目对 `search.json` 体积的影响 | 未验证 | 每批后看 `search.json` 大小与检索延迟 |
| 我们 `export` 出来的 `preview.mp4` 与上游 preview 的可比性 | 未验证 | 同 t 抽帧 diff |

---

## 附：数据文件

- [`hyperframes-catalog.json`](./hyperframes-catalog.json)：457 条全量元数据（`kind`/`name`/`title`/`tags`/`about`/`files`/`vars`/`video`），由 `registry-item.json` 逐条抓取（2026-11-17）。
  用途：后续挑选、做映射脚本、比对重写进度。**不含任何源码**。
