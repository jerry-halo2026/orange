# 画布混剪、MiniMax 音色与 macOS 钥匙串（2026-11-20）

## 1. 画布混剪：从“只显示”到能用

原因三条，都是实现缺口：

1. **面板只读**：`MixPanel` 只画摘要，注释写着“recipe is written by the batch page and agents”；
   新建的 mix 节点 `recipe: {}`，Run 永远 disabled。
2. **没有配方入口**：`startMix` 一直会 POST `/api/fission-render/recipe`（`run:true`），但没有人能填写
   `groups / script / params`。
3. **翻译键缺失**：`canvas.mix.*` 在五个语言表里一个都没有，节点和菜单显示的是原始 key。

现在：

- `MixPanel` 可直接写配方：
  - 场景组：`添加文件夹`（系统目录选择，`api.pickFolder`）→ `{kind:'dir', path}`；可移除；
  - 口播文案：一行一条（每条对应一条成片的配音）；
  - 配音服务 + 音色：MiniMax / Qwen / ElevenLabs / Inworld / Cartesia，音色用 `VoicePicker`；
  - 数量 / 目标时长 / 画幅 / 烧录字幕；
  - Run：POST 同一渲染路由，面板回显批次、状态、停止原因与产物数。
- `board.setData` 类型放开到 `MixData`，配方随节点写回画布文档。
- 五个语言补齐 `canvas.mix.*`（标题、运行、批次、场景组、refs、文案、音色、数量、时长、画幅、字幕、
  停止原因、添加/移除文件夹、未填写提示）。

### E2E（点击级）

`apps/desktop/bench/canvas-mix-e2e.test.mjs`：切画布 → 添加「批量混剪」→ 添加文件夹（页面边界打桩）→
写口播 → 选 MiniMax（自动落到 `female-shaonv`）→ 数量 1 → 开始混剪 → 断言发出去的 recipe
（组名/文案/provider/voice/count）与面板回显（`canvas-b1`、已出片）。

- Windows：**通过 18.5 s**
- macOS arm64：**通过 22.0 s**
- 引擎真渲染仍由 `mix-e2e.test.mjs` 双端验证（不重复打桩）。

## 2. MiniMax 音色

`packages/openfilm/library/voices.json` 新增：

- provider `minimax`（`speech-2.8-hd` / `speech-2.8-turbo`），24 个系统音色：
  `female-shaonv / female-yujie / female-tianmei / female-chengshu`、
  `male-qn-qingse / jingying / badao / daxuesheng`、
  `presenter_male / presenter_female`、`badao_shaoye`、`tianxin_xiaoling`、`qiaopi_mengmei`、
  `wumei_yujie`、`diadia_xuemei`、`danya_xuejie`、
  `Chinese (Mandarin)_Reliable_Executive / News_Anchor / Mature_Woman / Unrestrained_Young_Man`、
  `Cantonese_CuteGirl / GentleLady`、`English_expressive_narrator / Graceful_Lady`。
- provider `qwen`（`qwen3-tts-flash`）：`Cherry / Serena / Ethan / Chelsie / Dylan`。

音色 ID 来自官方系统音色列表（<https://platform.minimax.io/docs/faq/system-voice-id>）。
`library.test.mjs` 校验通过（provider 列表、每个服务有音色、`featured/uses` 字段齐全）。

## 3. BGM：先支持本地上传

混剪面板新增 BGM 区：

- **上传 BGM**：选本地音频（`audio/*`）→ 导入工程 `assets/` → 配方 `bgm: [{kind:'asset', path}]`；
- 已选 BGM 以文件名列出，可移除；
- 拖本地音频文件到面板同样按上传处理。

> 元素库里的音乐：`library/audio.json` 有 **1222 条 music 目录项**，但仓库里没有对应音频文件（`library/` 下没有
> `audio/music/*.mp3`），所以现在只能看到目录、不能真正出片用。等供应商音乐接入后，`mix-recipe` 的 `bgmPath`
> 换成供应商返回的文件即可，接口不变。

E2E 已覆盖：Windows / macOS 的 `canvas-mix-e2e` 都会上传一段 WAV 并断言发出去的 `recipe.bgm[0].path`。

## 4. 从素材中心拖到混剪面板

`MixPanel` 现在接受素材面板/素材中心拖来的东西（`application/x-openfilm-resource`）：

- 云端素材卡（带 `material.videoId`）→ 场景组里加 `{kind:'cloud', videoId}`；
- 项目文件 → `{kind:'asset', path}`；
- 收藏 → `{kind:'saved', path}`。

拖到面板上即新增一个以素材名命名的场景组；「添加文件夹」仍走系统目录选择。
（画布本身也仍接受从系统拖文件进来，先导入工程再放成文件节点。）

## 5. agent 的检索 → 混剪配方

新路由 **`POST /api/materials/mix-recipe`**（`material-mix-recipe.mjs`）：

```json
{ "query": "油弃乌龙茶", "count": 10, "line": "油弃乌龙茶，冲泡三分钟就好",
  "provider": "minimax", "voice": "female-shaonv", "aspect": "9:16",
  "bgmPath": "assets/bgm/light.mp3" }
```

它按查询词在**本地索引**里匹配：先产品名、再分组名、最后批次名；命中的云端 `videoId` 去重后组成一个场景组，
配上口播（`script.lines` 一条 + `audioUses=count` 出 `count` 条）、9:16、字幕（darwin 用随包
`Noto Sans CJK SC`），可带 BGM。返回 `{recipe, matched, problems}`；没有命中会明说，不编素材。

拿到 recipe 后直接 `POST /api/fission-render/recipe`（`run:true`）就能出片——与画布/向导同一条路由。
向量检索在 `material-search.mjs` 里（先 `media_search` 向量，失败退 lexical，再退本地索引）；
素材库目前没有音乐库（`library/sounds` 只有音效），BGM 需要工程里已有的 `assets/bgm/*` 或用户给的路径。

实测（`apps/desktop/bench/mix-recipe-route.test.mjs`，Windows）：`query: "茶"` → matched 40 →
组「柠檬宝藏茶200g罐」→ 10 条、9:16、字幕开 → dry-run `Count=10` 通过。

## 7. 画布拖放与“加不了文件夹”

- 「添加文件夹」走 `POST /api/pick-folder`（系统对话框，`folder-picker.mjs`），画布面板里已接；
  之前看到加不了，是因为安装的 app 还是**旧构建**（面板是只读版）。本轮已重建 shell 与安装包。
- 混剪面板现在接受素材面板/素材中心拖来的卡片：云端卡（`material.videoId`）→ `cloud` ref；
  项目文件 → `asset`；收藏 → `saved`。拖上去即新增一个场景组。
- 画布本身仍支持从系统拖文件（先导入工程）。

## 8. 已知缺口

- 素材库没有 BGM 音乐（只有音效），"配好 BGM" 目前需要工程 `assets/bgm/*` 或显式 `bgmPath`；
  要么补一套授权音乐库，要么接供应商音乐。
- 向量检索依赖本地 `media_doc` 数据库与嵌入包（BGE/base）；没有时自动退 lexical/索引，不报错但不叫“向量”。

## 10. 首页收敛与 macOS 黑屏

- **首页三块大卡去掉**（超级混剪 / 创作中心 / 素材中心）：Launcher 现在只留最近项目列表 + 顶部两个紧凑入口
  （超级混剪、素材中心），创作中心由工程本身承担。`fission-smoke` 已改用顶部入口，12/12 通过。
- **macOS 呼起黑屏**：`safeStorage`（钥匙串）在主进程里是同步调用；未签名构建每次打包签名变化，
  macOS 会弹“允许访问钥匙串”，用户不点主进程就卡住，窗口黑屏。现在：
  - macOS 默认**不碰钥匙串**，BYOK Key 用 0600 文件式封装（`raw:`）；
  - 签名之后可用 `OPENFILM_KEYCHAIN=1` 重新启用钥匙串；
  - `unseal` 解不开旧 `enc:` 数据时返回空串，不会再抛。
- 素材服务凭据路径修到 `<userData>/.dev/zhishang/`（apps/api 要求路径含 `.dev`），并首次写入空的
  `bindings.local.json`；Mac 安装包重建后日志为 `material service ready` + `bindings loaded count=0`。
- 设置对话框状态改为共享 store：素材面板“打开设置”能真正跳到云管家分区。

## 11. 仍未做

- 批量混剪**向导**选择云管家素材（向导仍只认本地文件夹；云端批次目前走画布/agent recipe）。


## 9. macOS 钥匙串

只有 **BYOK（自己的模型 API Key）** 走 `safeStorage`（`apps/desktop/src/main.mjs:500`）：

- macOS → 登录钥匙串里的 “Electron Safe Storage” 条目；Windows → DPAPI；磁盘上只留 `enc:` 密文。
- 会弹窗要求授权，通常是**签名变化**：当前是未签名/ad-hoc 构建，每次打包签名标识不同，钥匙串认为
  “另一个程序”要读条目。固定 Developer ID 签名后不再询问。
- 登录态、素材凭据都不走钥匙串（`auth-runtime.json` / 账号目录 / `.dev` 凭据文件）。

可选：签名；或未签名开发构建把 BYOK Key 存为 `0600` 文件、不碰钥匙串。
