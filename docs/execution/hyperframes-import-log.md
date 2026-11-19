# HyperFrames 素材导入日志

执行口径：把 [HyperFrames](https://github.com/heygen-com/hyperframes) 官方 `registry/` 的片段，改写成 OpenFilm 原生库条目，使 **Studio chat 里的 agent 用既有的 `openfilm get` 就能搜到、`--take` 就能用**。不引入任何新运行时。

来源与固定版本：

| 项 | 值 |
| --- | --- |
| 仓库 | `github.com/heygen-com/hyperframes` |
| 许可 | **Apache-2.0**（每个改写页面的头部注释都写明来源、许可与改写点） |
| 基线 | `v0.9.60`，抓取时 `main`（2026-11-17），原始片段留存在 `.dev/hyperframes/v0.9.60/` |
| 解析与清单 | `docs/research/hyperframes-catalog.json`（457 条元数据）、`docs/research/HyperFrames与动效素材源研究.md` |

## 1 已导入（首批 2 条）

| id | 来源 | 抽屉分类 | 时长 | 改写要点 |
| --- | --- | --- | --- | --- |
| `text/hf-lt-clean-bar` | `blocks/lt-clean-bar`（3.2 KB） | 文字 → 人名地点 | 4.8s | GSAP timeline → 纯 `frame(t)`；删 CDN GSAP 与 Montserrat；页面改成自己的盒子 760×160；`Name`/`Role`/`Accent`/`Card`/`Font` 五个 `data-props` |
| `text/hf-caption-highlight` | `components/caption-highlight`（8.4 KB） | 文字 → 字幕 | 8s | 同上；删掉示例的 `#hl-video` 背景视频（本页是覆盖层，影片从下面透出）；示例文案里的品牌词换成 OpenFilm；盒子 1720×130；`Color`/`Accent`/`Second accent`/`Font`/`Weight` 五个 `data-props` |

两条都**逐帧由 `t` 计算**，没有 `play()`、没有 wall clock、没有 `Math.random()`（SPEC §3）。

## 2 放哪里、为什么

- 页面与元数据：`packages/openfilm/library/text/hf-<name>/{saved.json, files/<name>.html, poster.jpg, preview.mp4}`
- 编目：**`packages/openfilm/library/catalogs/hyperframes.json`**（新建）
  - 理由：`library/index.json` 是上游文件，我们的条目放进去就要维护一个巨大的 overlay patch；`catalogs/*.json` 本来就会被 `library.mjs` 合并（`catalogFiles()`），新增文件即可，`index.json` 保持上游原样（158 条未动）。
- 生成物：`library/search.json` 由 `node scripts/library-search-index.mjs` 重算（2.29 MB），属脚本产物，不是手改。

## 3 验证记录（本机实测）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 页面结构 | `film-doc.readFilmFile(film.html)` | `problems: 0`，2 轨各 1 clip |
| 逐帧与确定性 | `openfilm look saved/openfilm/text-hf-lt-clean-bar/hf-lt-clean-bar.html 1.2` | `✓ drawn again after another frame: same picture` |
| 同上（字幕） | `openfilm look … hf-caption-highlight.html 0.9` / `3.2` | 同上；0.9s 画面为 “EVERY GREAT VIDEO **STARTS**” 红扫高亮 |
| 预览图 | `node scripts/library-previews.mjs text/hf-lt-clean-bar text/hf-caption-highlight` | `poster.jpg` + `preview.mp4` 生成（640×360，2s） |
| 检索 | `openfilm get text --prompt "caption highlight"` | **第 1 名** `openfilm/text/hf-caption-highlight` |
| 检索 | `openfilm get text --prompt "lower third"` | 语义档可用时约第 9 名；语义档不可用时**第 2 名**（见 §4） |
| 取用 | `openfilm get text --take text/hf-lt-clean-bar` | 打印可直接粘进 `film.html` 的 `<iframe … data-props='…'>`；落到 `saved/openfilm/text-hf-lt-clean-bar/hf-lt-clean-bar.html` |
| 测试 | `node --test src/library-search.test.mjs`（`packages/openfilm`） | 9 pass / 0 fail / 1 skipped（跳过项需要语义模型，见 §4） |

> 本机 `ffmpeg` 不在 PATH，`library-previews.mjs` 用的是 `apps/desktop/.dev/…/ffmpeg-9.0.2/ffmpeg.exe`（临时加 PATH）。产品发布时按既有 `openfilm doctor` 要求安装 ffmpeg。

## 4 发现：语义检索是远端服务，本地新条目不在其中

`src/library-semantic.mjs:72-93` 的 `nearest()` 是 **`POST https://openfilm.dev/v1/library/search`**（或 `OPENFILM_API_URL`），返回的是**已发布库**的 id。`searchLibrary()` 把关键词结果与它做 RRF 融合（`DEPTH=50, RRF_K=60`）。

后果（实测）：

- 语义档可用时：`小写第三` 这类查询里，凡是"关键词+语义"双命中的旧条目都会排在只有关键词命中的新条目之前 → `hug-lt-clean-bar` 落到约第 9 名，`--limit 8`（默认）看不到。
- 语义档不可用时（`OPENFILM_API_URL` 不可达，或设置 `libraryOff: true`）：纯关键词排序，`hf-lt-clean-bar` **第 2 名**、`hf-caption-highlight` **第 1 名**。

结论与建议（**待确认的唯一配置项**）：

1. 我们的产品是离线优先、且不应把用户的检索词发到 openfilm.dev —— 建议在设置里关闭该档：`<studio home>/providers.json` 写 `{"libraryOff": true}`（或在 Settings → Services 关闭"按意思搜索"）。这样：
   - 检索完全本地、确定；
   - 我们新增的库条目排名正常；
   - 语义档"缺失"的代价对 457 条规模而言可接受（关键词 + 标签足够）。
2. 若一定要保留语义档，则新条目需要**向量化并发布**（`node scripts/library-vectors.mjs` 需要 `library/models/` 下的 multilingual-e5-small 与 onnxruntime-web，当前本机没有），或接受它们排在后面。

## 4.1 检索默认值：本构建按字面搜索（已改）

`studio/server/keys.mjs` 的 `readSettings()`，在**没有 providers.json** 时的默认值由 `libraryOff: false` 改为 **`libraryOff: true`**：

- 我们的构建默认不把检索词发去 `openfilm.dev`（离线优先、不外传）；
- 语义档只认识已发布条目，本地新增的库条目在那里不存在，融合排序会把它们压到后面（见 §4）；
- 关闭后：`openfilm get text --prompt "lower third"` 里 `hf-lt-clean-bar` **第 2 名**（无任何环境变量），`caption highlight` **第 1 名**；`transition` 的 `hf-stripes-wipe` / `hf-tilt-3d` 均第 1 名。
- 跟随的契约改动：`studio/server/keys.test.mjs` 的那条测试由"默认开启"改为"默认按字面，开启是人的选择"，其余断言保留（开关双向 + 非法值 400）。

> 这两处是 native-extension：重建 overlay 时要把 `studio/server/keys.mjs` 与 `studio/server/keys.test.mjs` 的 hunk 收进 `overlay/patches/openfilm.patch`（现在只是工作树改动）。

## 4.2 转场：5 条 CSS motion 预设（已加，P1 第一批）

不搬 HyperFrames 的 WebGL 转场（`whip-pan`/`sdf-iris`/`flash-through-white`/`light-leak` 实为 canvas；我们的 `place:"cut"` 覆盖层没有 from/to 双纹理通道），而是补**我们缺的纯 CSS 切点运动**，写进 `catalogs/hyperframes.json`（我们自己的编目）：

| id | 组 | 机制 |
| --- | --- | --- |
| `motions/hf-cover-rise` | slide | 下一镜从下方盖上，旧镜下沉变暗 |
| `motions/hf-tilt-3d` | camera | 两镜沿 X 轴倾倒（`rotate: x`） |
| `motions/hf-iris-corner` | mask | 左上角 `clip-path: circle()` 展开，旧镜收向另一角 |
| `motions/hf-stripes-wipe` | mask | `repeating-linear-gradient` 遮罩横扫 |
| `motions/hf-zoom-blur` | camera | 两镜带模糊冲近，新镜清晰落位 |

`openfilm get transition --take motions/hf-stripes-wipe` 会打印 `@keyframes … { … }` 与直接可用的 `animation:` 行。五条都有 `poster.jpg` + `preview.mp4`（`library/motions/hf-*/`）。

## 4.3 第二批：5 个下三分之一 + 6 个字幕样式（已加，B3）

全部页面是纯 `frame(t)`，零第三方依赖，页面盒子等于元素本身尺寸（`low: true`，由 host 放在画面下方）。

| id | 来源（HyperFrames） | 盒子 | 机制 |
| --- | --- | --- | --- |
| `text/hf-lt-bold-block` | `blocks/lt-bold-block` | 780×170 | 黑色块从左揭开，姓名上升、职位以字距大写跟上 |
| `text/hf-lt-mask-reveal` | `blocks/lt-mask-reveal` | 860×150 | 无卡片，两行分别从左被"揭"出，强调线横扫 |
| `text/hf-lt-side-rule` | `blocks/lt-side-rule` | 720×160 | 竖线生长，姓名与职位自左滑入 |
| `text/hf-lt-soft-pill` | `blocks/lt-soft-pill` | 760×150 | 毛玻璃胶囊 + 圆点，缩放淡入 |
| `text/hf-lt-dark-card` | `blocks/lt-dark-card` | 800×176 | 深色卡上浮，强调色竖条生长 |
| `text/hf-caption-kinetic-slam` | `components/caption-kinetic-slam` | 1720×130 | 逐词砸入（1.28→1 带缓冲） |
| `text/hf-caption-pill-karaoke` | `components/caption-pill-karaoke` | 1720×130 | 每个词一枚软胶囊，正在说的填满强调色 |
| `text/hf-caption-neon-glow` | `components/caption-neon-glow` | 1720×130 | 霓虹青/品红双色发光，当前词最亮 |
| `text/hf-caption-matrix-decode` | `components/caption-matrix-decode` | 1720×130 | 当前词从乱码解出（由 `t` 与字符位置决定，确定性） |
| `text/hf-caption-clip-wipe` | `components/caption-clip-wipe` | 1720×130 | 当前词从左 `clip-path` 擦入 |
| `text/hf-caption-weight-shift` | `components/caption-weight-shift` | 1720×130 | 其余词细而暗，当前词加粗放大 |

验证：11 条都生成了 `poster.jpg` + `preview.mp4`；抽查 `hf-lt-soft-pill` 的 `openfilm look 1.2` 通过确定性检查；`openfilm get text --prompt "neon glow caption"` 命中 `hf-caption-neon-glow`；`--take text/hf-lt-soft-pill` 打印 clip 行并落盘。

> 说明：`matrix-decode` 的卡片图必然停在"乱码未解完"的瞬间（它就是效果本身）；页面对未说到的词保持可读，只有正在说的词在解码。

## 4.4 第三批：6 张社交/系统卡 + 4 张数据卡 + 4 个光标演示（已加，B4）

| id | 盒子 | 时长 | 机制 |
| --- | --- | --- | --- |
| `text/hf-x-post` | 760×320 | 5s | 帖子卡：头像、姓名/账号、正文、互动数，逐行浮起 |
| `text/hf-yt-comment-card` | 780×220 | 4.5s | 评论卡整体上滑 |
| `text/hf-macos-notification` | 720×150 | 4s | 通知横幅落下、停留、滑走 |
| `text/hf-spotify-card` | 660×200 | 5s | 正在播放：封面、曲名、进度条填充 |
| `text/hf-thread-message-stack` | 780×420 | 6s | 三个气泡依次弹出，最后一条前有"正在输入" |
| `text/hf-instagram-follow` | 640×180 | 4.5s | 关注卡，按钮自按并变成 Following |
| `text/hf-bar-chart-race` | 1000×460 | 5s | 条形图依次生长（96/64/18%） |
| `text/hf-line-graph` | 1000×420 | 4.5s | 折线用 `stroke-dashoffset` 画出，端点跟随 |
| `text/hf-number-wheel` | 640×260 | 4s | 数字逐位滚动到 20481 |
| `text/hf-progress-ring` | 480×480 | 4s | `conic-gradient` 环填充到 78% |
| `text/hf-agent-cursor` | 900×520 | 4s | 光点光标沿路径滑动并点击出环，带标签 |
| `text/hf-cursor-click` | 700×380 | 3s | 箭头光标点击，两圈涟漪 |
| `text/hf-cursor-drag-select` | 900×520 | 4s | 拖拽出虚线选框，覆盖三个卡片 |
| `text/hf-cursor-highlight` | 900×520 | 4s | 光标移到面板，强调色描边 + 标签 |

新增抽屉分组（写在我们自己的编目里）：`social`（社交卡）、`data`（数字与图表）、`cursor`（光标与点击）。

验证：14 条全部生成 `poster.jpg` + `preview.mp4`；`get text --prompt "x post card"` → `hf-x-post`，`"bar chart ranking"` → `hf-bar-chart-race`，`"cursor click demo"` → `hf-cursor-click` / `hf-agent-cursor`；`--take text/hf-macos-notification` 打印 clip 行；实机 Studio 的 `/api/library` 返回 **32 条**（27 text + 5 transition），分组 `lower/caption/social/data/cursor/slide/mask/camera` 全部在位。

修过的两处：`x-post` 的 `.x-head` 曾被 `display:block` 覆盖掉 flex（姓名与账号黏在一起）；`bar-chart-race` 早期读 `dataset.v` 时条宽恒定，改为常量表。

## 4.5 B5 探针结论：WebGPU 不可用，改用我们自己的两种背景（已加）

**探针**（`.dev/probe-gpu/probe-webgpu.html` / `probe-webgl.html`，用 `openfilm look` 在真实 host 里渲染）：

| 能力 | 结果 |
| --- | --- |
| `navigator.gpu` | 存在，但 `requestAdapter()` 返回 **null** → 画面里写着 `webgpu: no adapter`；同一页面在 0.2s 与 1.2s 两帧**字节完全相同**（没有画面更新） |
| WebGL2 | `webgl: ok WebGL 2.0 (OpenGL ES 3.0 Chromium)`，0.2s 与 1.2s 两帧**不同**（清屏色随时间变化） |

**因此**：

- HyperFrames 的 40 条 `webgpu` 块**全部放弃**。它们的源码只有 ~760 字节，实质是 `<canvas data-shader="Aurora">` 挂到共享运行时 `lib/shaders.iife.js` —— 既是第二套运行时，又依赖我们没有的 GPU 适配器。
- `webgl` 一族可行，但要按我们自己的 shader 写（`preserveDrawingBuffer: true`，只在 `frame(t)` 里画）。

**补上两个背景**（`cat: effect`，`group: background`，1920×1080）：

| id | 实现 | 说明 |
| --- | --- | --- |
| `effects/hf-mesh-gradient` | 纯 CSS（四个径向渐变球体 + 模糊 + 颗粒） | 零 GPU、零依赖；`--g1..--g3`/`--base` 四个颜色可改 |
| `effects/hf-aurora` | **自写 WebGL2 片元着色器**（fbm 极光 + 星点 + 地平线辉光） | 证明 WebGL 路径在生产 host 可用；`preserveDrawingBuffer: true`，只由 `frame(t)` 驱动 |

验证：两张 `poster.jpg` 正常（极光绿/紫丝带、紫粉青网格渐变）；`openfilm get effect --prompt "aurora night background"` → `effects/hf-aurora`；`--take effects/hf-aurora` 打印 `<iframe src="saved/openfilm/effects-hf-aurora/hf-aurora.html#t=0,8">`；实机 Studio 的 `/api/library` 返回 **34 条**（27 text + 5 transition + 2 effect）。

## 4.6 实机 GUI 验证（真起 Studio 窗口点出来的）

环境：从源码 checkout 起 Studio（scratch 的 `OPENFILM_HOME/LIBRARY/SAVED/SHARED_HOME`），headless Chromium（`--use-angle=swiftshader`，`locale=en-US`），打开一个只有一页 `page.html` 的 1280×720 工程。

| 步骤 | 结果 | 截图 |
| --- | --- | --- |
| 打开 Material library → Text | 分类栏出现 `Media/Skills/Templates/Captions/Voices/Sounds/Music/Text/Stickers/Filters/Effects/Transitions` | `02-drawer.png`、`03-text.png` |
| 展开 `Text templates` | 左侧组列表含 `All/Titles/Names and places/Badges/Numbers/Captions/**Social cards**/**Cursor and clicks**/Callouts/Shopping/…` | `11-text-templates.png` |
| 选 `Names and places` | 卡片区出现我们的六张下三分之一：`Lower third, clean bar` / `bold block` / `mask reveal` / `side rule` / `soft pill` / `dark card`；另有 `Location`、`Name card, …` 等原有条目 | `12-group-names-and-places.png` |
| 单击卡片 | 画面上出现该页的预览（trial） | `22-preview.png` |
| 双击卡片 | 时间线新增 `hf-lt-clean-bar`（V2，4.8s），提示 `Added to the timeline: Lower third, clean bar` | `23-inserted.png` |
| 检查器 | `Properties` 里正是我们的四个变量与两个文本位：`Name`、`Role`、`Accent`(#FF5A36)、`Card`(#FFFFFF)、`Font`(PingFang SC)；`Position & size` 386/551、508×107 | `23-inserted.png` |
| 写盘结果 | `film.html` 得到 `<iframe id="hf-lt-clean-bar" src="saved/openfilm/text-hf-lt-clean-bar/hf-lt-clean-bar.html#t=0,4.8" size="508x107" style="left:386px;top:551px;width:508px;height:107px" data-props='[…]'>` | 脚本输出 |

**一个环境上的坑（记录备查）**：GUI 脚本被我中途 `Select-Object -First N` 截断过输出，node 进程被杀，Studio 的事务锁留在
`%USERPROFILE%\.openfilm-control-coordination\meta.lock`（0 字节），之后每次 `openProject` 都报 `Project control is busy.`（409）。
清掉这个 0 字节残留锁后恢复正常。以后跑 GUI 自动化要避免截断管道，或先清这个锁。

**一个外观问题（不阻塞）**：抽屉卡片缩略图对"白字透明底"的页面会显示成暗块（卡片显示的是预览帧，不是 `poster.jpg`）。内容与插入都正常，hover 会播放 `preview.mp4`。若要更好看，后续可给这几页的 poster 换一个中灰底（属上游 `scripts/library-previews.mjs` 的渲染约定，改动需走 native-extension）。

## 4.7 客户端（真实桌面 app）验证：API 登录 + 取用 + 插入

桌面 app 起在 dev 模式（`pnpm dev:all` → Electron + Studio `127.0.0.1:4757` + film `localhost:4758`），app 内的 Studio 走 `desktopAuth`：未登录时所有 API 403 `authentication-required`。

用 `.dev/bench-auth.env` 里的测试账号（**不打印**）通过 app 自己的接口登录，再走完整链路：

| 步骤 | 接口 | 结果 |
| --- | --- | --- |
| 登录 | `POST /api/auth/sign-in`（需 `Origin: <studio origin>` + `x-studio-key`） | `200 {"ok":true,"state":{"kind":"active"}}` |
| 会话 | `GET /api/auth/state` | `active` |
| 库 | `GET /api/library` | `200`，8778 条，**我们 34 条**（text 27 / transition 5 / effect 2） |
| 建工程 | `POST /api/projects` | `200` |
| 取用 | `POST /api/projects/:id/saved/take {path:"openfilm/text/hf-lt-clean-bar"}` | `200`，返回带 `data-props` 的 clip |
| 插入 | `POST /api/projects/:id/edit {ops:[{op:"insert", clip, newTrack:0}]}` | `200` |
| 落盘 | `GET /api/projects/:id` 的 `text` | 含 `<iframe id="hf-lt-clean-bar" src="saved/openfilm/text-hf-lt-clean-bar/hf-lt-clean-bar.html#t=0,4.8" at="1" size="760x160" style="left:80px; top:470px; width:760px; height:160px" data-props='[…]'>` |

三条踩过的坑（脚本里已处理，记下来免得再踩）：

1. 登录路由是 **`/api/auth/sign-in`**（不是 `/api/sign-in`），且必须带 `Origin: <studio origin>`，否则 403「Authentication must come from this Studio」。
2. 会话封存/切换时 Studio 会**重启**：期间连接被拒（ECONNREFUSED），且 `~/.openfilm-dev/run.json` 里的 launch key 会**轮换** → 每次请求重新读 run.json，并对 `ECONNREFUSED / UND_ERR_SOCKET` 重试。
3. 空工程没有轨道：`insert` 用 `newTrack: 0`（`track: 1` / `newTrack: 1` 会分别报 “no track 1” / “no place 1 for a new track”）。
4. 切换账号时如果返回 `switch-required` / `locked(preservation-pending)`，先 `POST /api/auth/sign-out` 再登录。

验证后清掉了 6 个 `API Client Check *` 测试工程（`DELETE /api/projects/:id` → 200）。

## 5 下一批（按计划 B2-B5，尚未开工）

- CSS 转场 → `library/catalogs/motions.json`（从 `transitions-*` 提取，去掉 demo 外壳与 info-bar）
- 下三分之一 5 条、字幕 6 条、社交/系统卡 6 条、数据 5 条、光标 4 条
- 纯 DOM 才搬；`whip-pan`/`sdf-iris`/`flash-through-white`/`light-leak` 实为 WebGL（无 from/to 纹理通道），不搬
- 转换器：`node scripts/hyperframes-import.mjs --name <name> --kind block|component`（抓取 → 离线化 → 生成 `saved.json` 与编目条目 → 打印待移植的 timeline 行）

## 6 许可记账

每个由 HyperFrames 片段改写的页面，文件头注释含：来源仓库、片段名、Apache-2.0、固定版本、改写点。`THIRD_PARTY_NOTICES.md` 后续按批次汇总（本批为 2 条，尚未写入；写入时按"仓库 + 许可 + 片段名 + 版本"一行一条）。
