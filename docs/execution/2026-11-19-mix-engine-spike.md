# 混剪引擎 Spike A：批量语义实测（2026-11-19）

> 目的：在动任何界面之前，证明「文件夹顺序 + 文案 + 配音 → 直接出 N 条」这条链路在 Fission 引擎里成立，
> 并把实测出来的语义写死，供 Node 侧生成 job 时对照。
>
> 环境：Windows，.NET SDK 10.0.300，FFmpeg 2022-05-16（gyan），Fission CLI 由本检出 `dotnet build` 产出。
> 证据目录：`.dev/fission-spike/`（不入库）；本文只记结论与可复现步骤。

## 1. 实测结论（4 条）

1. **一条成片只吃一条配音**：`PickAudio = audios[cursor % n]`。两条配音、`AudioUses=2`、`Count=4` → 正好出 4 条，
   每条对应一条配音，`ConsumeLog` 里 `AudioUseIndex` 分别是 1/2。**配音的单位是"一条完整口播"，不是句子。**
2. **条数公式实测**：`Count=4, AudioUses=1, 配音 2` → **只出 2 条**（`planned = min(4, 2×1)`）；
   `AudioUses=2` 才出 4 条。界面上"出 N 条"必须写成 `min(Count, 配音数 × AudioUses)`，不能只写 Count。
3. **`SceneGroups` 是白名单，且组的"必选"只有 `TakePerOutput≥1` 才成立**：`TakePerOutput=0` 的组在累计时长达到
   `目标×0.85` 后被整组跳过。实测第 1 条只用了 `01-开场` 的两段（6s ≥ 4.25s），`02-卖点` 没出现；
   另外 3 条两组都用了。**要保证每条都含某组，必须给该组 `TakePerOutput≥1`。**
4. **字幕文本只来自 `AudioDir` 父目录的 `meta.json`**：实测 `subtitles.outcome="applied"`，
   cues 由文本按句切分、按字数比例铺满（`sentence-weighted-approximation`），最后一句收到目标时长。

## 2. 修掉的两个真缺陷（本次已改）

- `packages/openfilm/studio/server/fission-plan.mjs`：job 字段名 `PickRule / AlignStrategy / NamingRule`
  → 引擎真名 `Pick / Align / Naming`。改前三个字段被反序列化**静默忽略**，整批实际按默认值跑
  （随机选材、音频名命名）。
- `workers/fission/src/Fission.Cli/EngineRunConfiguration.cs`：job 反序列化加
  `UnmappedMemberHandling.Disallow`。实测把 `PickRule` 塞回 job 会得到
  `[Fission:CFG_ARGS] … The JSON property 'PickRule' could not be mapped …`、退出码 2 —— 以后拼错字段当场报错。

## 3. 复现步骤（脱敏）

```text
# 1) 造素材：两个场景组各 3 条 3s 片段；两条 5s 音频；meta.json 的 items[].file 与音频同名
inputs/b1/video/01-开场/g1_*.mp4
inputs/b1/video/02-卖点/g2_*.mp4
inputs/b1/audio/01.mp3, 02.mp3
inputs/b1/meta.json  { "items": [{ "file": "01.mp3", "text": "…" }, …] }

# 2) job（节选）：场景组 + 条数 + 配音策略 + 字幕
{ "VideoDir": "…/video", "AudioDir": "…/audio",
  "SceneGroups": [{ "Name": "01-开场", "Rule": "Random", "TakePerOutput": 0 }, …],
  "Count": 4, "AudioUses": 2, "Threads": 2, "SplitMode": "Scene",
  "Pick": "SceneOrderRandomWithin", "Align": "TrimLonger", "Naming": "Sequence",
  "SubtitleEnabled": true, "TargetDurationSec": null }

# 3) 跑（workspace 每次必须是全新目录）
dotnet Fission.Cli.dll run --paths engine-paths.json \
  --workspace <fresh>/workspace --task t1 --attempt a1 --job job.json

# 4) 看结果：out/job<时间戳>/report.json + <title>.edit-plan.json
```

## 5. Phase 2 集成验证（同日追加）

- **recipe → 引擎端到端**：`normalizeRecipe → stageRecipe → jobFromRecipe → runFissionJob` 跑真 ffmpeg：
  `{ code: 0, succeeded: 4, stopReason: "countReached" }`；两条配音各用两次；`Naming=AudioFileName` 体现为 `01/02` 文件名。
- **字幕字体字段生效**：recipe 给 `subtitleFontFamily: "PingFang SC"` → `edit-plan.subtitles.style.assStyle` 的 Fontname 为
  `PingFang SC`，`outcome=applied`；未给时回退 `Microsoft YaHei`（C# 默认值，保持 Windows 行为）。
- **`FontsDir` 不再被静默丢弃**：`EnginePathsSource.Parse` 已映射该可选键；没有它时 macOS 会走无效的
  `SpecialFolder.Fonts`。
- **C# 测试基线**：HEAD（83f378c）`dotnet test` = 48 失败 / 245 通过 / 293 总计；本工作区 = **同样 48 失败 / 250 通过 /
  298 总计**（5 条新增全过）。失败集合与本次改动无关（FissionEditPlan 的真实媒体用例、EngineRunConfiguration 的
  InnerException 断言、symlink/junction 用例），零回归。
- 顺带修复：MiniMax `music` 分支同样把 `--out` 当路径，已改为 `landing('audio/music', …)` 并补测试。

## 6. macOS 首次真机（2026-11-20，`halo@192.168.110.96`）

环境（实测）：macOS 27.0.1 / arm64 / Xcode CLT 已装；Node v22.23.5（用户级）、.NET SDK 10.0.404（用户级）、
ffmpeg+ffprobe 用产品自己 pin 的 Shaka n8.1.2（两个 sha256 与 `ffmpeg-runtime.mjs` 一致）；APFS；磁盘 878 GiB 可用。
**注意**：`ffprobe-static` 的 `bin/darwin/arm64/ffprobe` 实际是 x86_64，本机无 Rosetta，直接用会 `bad CPU type`。

结果：
- `dotnet build Fission.Cli`（arm64）成功，0 警告 0 错误，7.4 s。
- 同一条 recipe（两组素材、两条完整口播、`Count=4`、`AudioUses=2`、`Threads=2`）真机出片：**4 条 / `countReached` / 3 s**（Windows 同参数 9.6 s）。
- **字幕平台阻塞**：Shaka 的 arm64 构建**没有 `ass` / `subtitles` / `drawtext`** 滤镜。带字幕的 job 会让整批 0 条，
  报 `ENC_FFMPEG_EXIT`（ffmpeg exit 8），`stopReason` 落成 `materialShort`——这会误导排障。
- 已加平台守卫：`jobFromRecipe` 在 `darwin` 上收到 `subtitle:true` 时**不开字幕**并返回一条明确说明；
  真机复跑同一 recipe：**4/4、`countReached`、3 s**，`notes` 里写明"macOS 的渲染器没有 libass"。

结论：macOS 的混剪主链路可用；**烧录字幕在换到带 libass 的 ffmpeg 构建之前不可用**（三个选项：
① 随包 Homebrew 的 ffmpeg + 其 dylibs；② CI 自建带 libass/fontconfig 的静态 arm64 构建；③ 首版 mac 不带字幕）。
当前实现取 ③，并且不静默失败。

### 6.1 随包产物的 macOS 冒烟（同一台机）

用产品自己的 `publishFission({ platform:'darwin', arch:'arm64' })` 打出 `~/pack/fission`，把 Shaka 的
`ffmpeg/ffprobe` 放进 `~/pack/runtime/ffmpeg`，再跑 `node scripts/fission-smoke.mjs --packaged ~/pack`：

- 打包结果：`Fission.Cli`（apphost）、`fission-host`、`transitions/assets/local-assets`、`fission-config.template.json`
  （`cli: fission/Fission.Cli`、`FontsDir: fission/fonts`、`fonts: false` 的 warning 符合预期）。
- 第一次失败暴露了一个**只在 macOS 出现的 host bug**：host 用 `first.EndsWith(".dll")` 决定丢 1 个还是 2 个参数；
  mac 的 `cli` 是 apphost（无 `.dll`），于是它只丢了 host 自己，把 apphost 路径留在 `run` 前面，CLI 当成未知动词，
  报 `CFG_ENGINE_PATHS`——安装后每一次渲染都会失败。已改成固定 `skip = 2`（丢 host 与 cli），并加测试钉住。
- 修复后：**2/2 完成（6.7 s）**，产物 `smoke-001.mp4` 90 KB、`smoke-002.mp4` 1227 KB。

### 6.2 源码与工具链（真机现状）

- 整份源码 120 MB 已同步到 `~/orange`；Node 22.23.5 / .NET 10.0.404 / Xcode CLT 均用户级安装，无需 sudo。
- 应用本体（Electron，未签名）构建在 `~/mac-app-build.sh` 中：`pnpm install --frozen-lockfile` +
  `pnpm --filter @openfilm/desktop release -- --unsigned --arch=arm64 --dir`，进行中；完成后按"右键盘打开"安装验收。


### 6.3 客户端 E2E（Windows bench 应用，真实 Electron + Studio + 引擎）

测试：`apps/desktop/bench/mix-e2e.test.mjs`（登录 → 建工程 → 生成素材 → recipe dry-run → `run:true` → 产物落盘 → 截图）。
结果：**10/10 links ok**（约 46 s），`job.Pick=SceneOrderRandomWithin / Align=1 / Naming=AudioFileName`，
`render.code=0`、`succeeded>=2`、`countReached`，每个 `Outputs[].path` 存在且 >1KB。

它逼出的两个**产品缺陷**（已修，均有单测）：
1. `render-batch-bridge` 直接读工程：没有 `desktopAuth.runNative` 时 `projects.mjs` 抛 `control-required`，
   被 catch 吞成“没有这个工程” → 安装后的应用里 `/api/fission-render/*` 永远 404、批量出片页永远空
   （也解释了之前“批量页只有一句话”）。现在工程读取跑在 native 授权上下文里。
2. 引擎路径只认 `<dataDir>/runtime/ffmpeg-<ver>`：安装后的应用把 ffmpeg/host 写在
   `ORANGE_FISSION_CONFIG_FILE`，真实安装会 503。现在桥接层优先读该配置，`runFission`/`fission-runner`
   也从它取 host 与 CLI，不再按 cwd 猜。

### 6.4 客户端 E2E 双平台（bench 应用，真实 Electron + Studio + 引擎）

| 测试 | Windows | macOS arm64 |
|---|---|---|
| `fission-smoke.test.mjs`（登录→开片→超级混剪→三步向导→批次/草稿） | **12/12** | **12/12** |
| `mix-e2e.test.mjs`（recipe dry-run→真渲染→产物落盘→截图） | **10/10**（4 条，`countReached`） | **9/9**（3 条，`materialShort`） |

两条测试暴露并修掉的产品/引擎问题：
1. 工程读取缺 `desktopAuth.runNative` → 安装后 `/api/fission-render/*` 永远 404（批量页永远空）。
2. 引擎路径只认 `<dataDir>/runtime/ffmpeg-<ver>` → 真实安装 503；现在优先 `ORANGE_FISSION_CONFIG_FILE`，
   `runFission`/`fission-runner` 也从它取 host/CLI。
3. **`MAT_COMBINATION_DUP` 的语义**：小素材池（2 组×2 片、2 条配音、`AudioUses=2`、`Count=4`）会碰到
   "组合已产出过"。旧行为把这一条记成失败（`Failed=1`、退出码 4、`stopReason=countReached`，会误导）；
   现在按**素材组合用尽**处理：不出这一条、不记失败、批次以 `materialShort` 收尾、`Succeeded < planned`，
   前端可以如实说"组合用尽，少出 N 条"。重试预算同时从 3 提到 12。
4. 测试侧修正（非产品）：`mix-e2e` 的字幕断言按平台（darwin 无 libass → 产品会主动关字幕并给说明）；
   `fission-smoke` 先展开「高级设置（原来的向导）」再断言步骤栏；bench 的配置校验按 `process.platform`、
   `FontsDir` 允许缺席；`ffmpeg.exe/ffprobe.exe` 素材目录必须 **copy 不能硬链**（`nlink===1` 是 app 的校验）。

### 6.5 macOS 字幕（libass）已解决

- **二进制 pin 换成 osxexperts 的 9.0.2 arm64 静态构建**（与 Windows 的 9.0.2 同版本），配置里带
  `--enable-libass --enable-fontconfig --enable-libfreetype --enable-libharfbuzz --enable-libfribidi`。
  `ffmpeg-runtime.mjs` 的 `darwin-arm64` 改为两个各自的 zip + **zip sha256 + 解包后二进制 sha256** 双重校验：
  - ffmpeg.zip `4597f0f3…78bcb`，ffmpeg `6deb2860…8553c`
  - ffprobe.zip `c765d316…164e`，ffprobe `8d56278e…d3f2`
  - 下载目录随之变为 `runtime/ffmpeg-9.0.2`；license 仍写 `COPYING.GPLv3`（9.0.2）与源码地址。
- **字体随包**：`fission-publish` 在打包时下载 `NotoSansSC-Regular.otf`（16.4 MB，OFL，
  sha256 `2c76254f…5b74b`）与 `Sans/LICENSE`（`6a73f954…e2bf2`）到 `fission/fonts/`，写进 `FontsDir`；
  下载失败只 warning（Windows 仍用系统字体），成功时 `fonts: true`。
- **平台守卫移除**：`jobFromRecipe` 不再在 darwin 上删 `SubtitleEnabled`；两个平台都开字幕。
- **实测**：随包 ffmpeg `-filters` 有 `ass`/`subtitles`；烧录对比帧 `YAVG=0.897`（有/无字幕差异明显）；
  客户端 E2E —— Windows 10/10（`edit-plan.subtitles.outcome=applied`），macOS **9/9**（job `字幕 true`、
  产物 `subtitles.outcome=applied`、3 条 `materialShort`、截图齐全）。

## 7. 对实现的约束（写进 recipe → job 生成器）

- `TargetDurationSec` 留空 = 跟随配音；不要拿 `Σ镜头时长` 当目标（会裁掉最后一句）。
- `meta.json` 必须**始终**有 `items` 键（缺失会让引擎抛 `KeyNotFoundException`，不是失败报告）。
- `Count=0` 不是"无限"：等于 `配音数 × max(AudioUses,1)`。
- `AudioUses=0` = 不限次且永不归档；`=1` 才会归档。
- `UseThenDelete` 的跨批次缓存在受控运行里落 `{attempt}/cache`，换批次即重置；不要向用户承诺"跨批次不再用"。
- 字幕 ASS 画布固定 1080×1920；非 9:16 输出首版不要开字幕。
