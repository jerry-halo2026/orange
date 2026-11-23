# 混剪契约（冻结）：recipe → job → report

日期 2026-11-19 · 适用于 Windows x64 与 macOS arm64 · 实现状态见 `2026-11-19-mix-engine-spike.md`

## 1. recipe（`.film/fission/recipe.json`，画布节点与 agent 共用）

```jsonc
{
  "schema": "orange/mix-recipe/1",
  "groups": [{
    "name": "01-开场",            // 逐字成为 video/ 下一级目录名，也是 SceneGroups[].Name
    "enabled": true, "rule": "random|sequential",
    "takePerOutput": 0,           // ≥1 = 每条必抽满（否则累计 85% 后整组跳过）；0 = 动态补足
    "speed": 1.0,                  // 0.5–4
    "useThenDelete": false, "allowReuse": false,
    "refs": [{ "kind": "asset|dir|saved|cloud", "path": "assets/video/a.mp4", "videoId": "..." }]
  }],
  "script": { "provider": "minimax", "voice": "female-shaonv",
              "lines": ["一条完整口播", "另一条完整口播"] },   // 一行 = 一条成片的配音
  "params": {
    "count": 4, "audioUses": 1, "threads": 4,
    "aspect": "9:16|16:9|1:1", "pick": "sceneOrder|random|sequential",
    "split": "scene|pieces|seconds|range|none", "sceneThreshold": 0.3,
    "avgPieces": 4, "bySeconds": 3,
    "align": 1, "transition": "", "transitionSec": 0,
    "subtitle": false, "subtitleStyle": "white-outline", "subtitlePos": "bottom",
    "subtitleFontSize": 64, "subtitleFontFamily": null,
    "naming": "audioFileName|sequence|randomTitle",
    "hflip": true, "allowVideoReuse": false, "bgmVolume": 0.35, "targetSec": null
  },
  "bgm": [], "intro": [], "outro": []
}
```

规则（已由 `fission-recipe.mjs` 与测试钉住）：
- 组名：非空、≤60、无路径字符、不以点/空格结尾；**忽略大小写后不得重复**（引擎字典是 OrdinalIgnoreCase）；统一 NFC。
- 条数：`min(count, 配音数 × max(audioUses,1))`；`count=0` 不是无限。
- `targetSec` 留空 = 跟随配音；不要用镜头时长求和。

## 2. job（`FissionJob`，字段名即 C# 属性）

映射见 `fission-recipe.mjs:jobFromRecipe`；两条硬约束：
- **`Pick / Align / Naming`** 是引擎真名；写 `PickRule/AlignStrategy/NamingRule` 会被拒（`UnmappedMemberHandling.Disallow`）。
- `OutDir` 不写；`WorkRoot/OutRoot` 不进 paths 文件。

本版新增（Wave 1，需 C# 与 Node 同步）：
| 字段 | 位置 | 说明 |
|---|---|---|
| `SubtitleFontFamily` | `FissionJob`（可选） | ASS 字体族；缺省 `Microsoft YaHei`（Windows 兼容）。macOS 随包 Noto Sans SC 时必须显式给 |
| `FontsDir` | `EnginePaths`（可选） | 字体目录；缺省 Windows 用系统字体目录，macOS 必须由 app 配置给出 |

## 3. staging 目录

```
<project>/.film/fission/work/<batchId>/
  video/<组名>/001.mp4 …
  audio/01.mp3 …            // 一条 = 一条完整口播
  meta.json                 // {"items":[{"file":"01.mp3","text":"整条口播"}]}；items 必须存在
  bgm/ intro/ outro/        // 可选
```

## 4. 运行与结果

- 每次渲染一个新 attempt：`<root>/workspace/<task>/<attempt>/{work,out,cache}` 必须全空。
- 结果只认 `<out>/<jobId>/report.json`（PascalCase）：`Succeeded/Failed/Outputs[{Index,Path,Title,DurationSec,EditPlanPath}]/Failures[]/StopReason`。
- 成功判据：`code===0 && Succeeded>=1 && 每个 Output.Path 在 out 内且存在`。
- 素材组合用尽（`MAT_COMBINATION_DUP` 重试 12 次后仍无新组合）：**不算失败**——该条不出、`Failed=0`、
  `StopReason=materialShort`、`Succeeded < planned`；界面应说"组合用尽，少出 N 条"，不要报渲染失败。
- 失败归因：`attempt-not-fresh / engine-paths / report-missing / report-invalid / timed-out / exit-<n>`。

## 5. 平台差异（必须同时满足）

| 项 | Windows | macOS arm64 |
|---|---|---|
| 引擎发布 | `win-x64` | `osx-arm64` |
| 进程终止 | `taskkill /PID <pid> /T /F` | `spawn(detached:true)` + `kill(-pid, SIGTERM→SIGKILL)` |
| 路径 | 规范长名、大写盘符、无 8.3 | realpath 消 `/var→/private/var`；APFS 大小写行为以真机 `diskutil` 为准；文件名 NFD |
| 字体 | 系统字体目录有效 | `SpecialFolder.Fonts` 无效；必须 `FontsDir` 指向随包字体 |
| 字幕烧录 | 可用（libass） | 可用：随包 ffmpeg 换成 osxexperts 9.0.2（带 libass/fontconfig/freetype），字体随包 Noto Sans SC（OFL） |
| NVENC | 有卡可用，无卡回退 | 不存在，必然 CPU（job 的 `UseNvenc` 由引擎探测回退） |

## 6. 错误码（Node 侧对外）

`recipe-invalid`（逐项 at/why）、`ref-unresolved`、`voice-missing`、`attempt-not-fresh`、`engine-paths`、`cli-missing`、`report-missing`、`report-invalid`、`timed-out`、`render-failed`（附 stderr 首个 `[Fission:*]`）。
