# Fission 本地运行时：ffmpeg 物化与实测（2026-11-16，HEAD 2427590）

结论：**本地混剪服务已可用**。真实接口 `GET /api/fission-local/jobs` 登录后返回 **200 `[]`**；仓库自带 UI 冒烟
（`apps/desktop/bench/fission-smoke.test.mjs`）**12/12 通过**，面板不再报「本地混剪服务未配置或当前不可用」。
未改任何生产代码。

## 1. ffmpeg 从哪来（仓库既有机制，不需要新代码）

- `apps/desktop/src/ffmpeg-runtime.mjs:29-47` 钉死各平台的构建：`win32-x64` = **gyan.dev 的 essentials 9.0.2**
  （`ffmpeg-9.0.2-essentials_build.zip`，zip sha256 `60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba`），
  只从 zip 里取出 `bin/ffmpeg.exe` / `bin/ffprobe.exe`，并写 `LICENSE` / `README` / `SOURCE`。
- 打包时由 `apps/desktop/scripts/release.mjs:231-233`（2b 步）调用 `fetchFfmpeg(join(work,'runtime','ffmpeg'),
  {license:true})`；`scripts/fission-publish.mjs:13-16,146-147,164-165` 不复制 ffmpeg，只是把 Fission 的
  `paths.FFmpeg/FFprobe` **指向同一个** `resources/runtime/ffmpeg`（`FFmpeg6` 有意不打包，转场走 FFmpeg 9 的 xfade）。
- 所以「下载」是设计内的正常路径，不是兜底。`resources/` 目录在源码树里本来不存在（`.release/work` 才是打包产物），
  它只在安装包里由 2b 步落成。

## 2. 物化（用仓库同一函数，不做假 exe）

```
node -e "import('./apps/desktop/src/ffmpeg-runtime.mjs').then(m=>m.fetchFfmpeg(
  'D:/dev/orange/apps/desktop/resources/runtime/ffmpeg',{platform:'win32',arch:'x64',license:true}))"
```

- 用时 134 s；zip 校验按其钉死的 sha256 通过（不匹配则不落盘）。
- 结果 `apps/desktop/resources/runtime/ffmpeg/`：

| 文件 | 字节 | sha256 |
| --- | --- | --- |
| `ffmpeg.exe` | 105,423,872 (100.5 MiB) | `3256173f…1ed8edec` |
| `ffprobe.exe` | 105,221,120 (100.3 MiB) | `f0d36ecb…f17e9a65c52` |
| `LICENSE` / `README` / `SOURCE` | 35,147 / 41,577 / 172 | — |

- 版本：`ffmpeg version 9.0.2-essentials_build-www.gyan.dev` / `ffprobe version 9.0.2-essentials_build-www.gyan.dev`。
- 合计约 **210.6 MB**（两个 exe）。

## 3. `.dev/fission-runtime/runtime.repo.json`

```json
{
  "cli": "D:\\dev\\orange\\workers\\fission\\src\\Fission.Cli\\bin\\Release\\net10.0\\Fission.Cli.dll",
  "dotnet": "C:\\Program Files\\dotnet\\dotnet.exe",
  "paths": {
    "FFmpeg": "D:\\dev\\orange\\apps\\desktop\\resources\\runtime\\ffmpeg\\ffmpeg.exe",
    "FFprobe": "D:\\dev\\orange\\apps\\desktop\\resources\\runtime\\ffmpeg\\ffprobe.exe",
    "TransitionsDir": "D:\\dev\\orange\\apps\\desktop\\resources\\runtime\\ffmpeg",
    "AssetsRoot": "D:\\dev\\orange\\apps\\desktop\\resources\\runtime\\ffmpeg",
    "LocalAssetsRoot": "D:\\dev\\orange\\apps\\desktop\\resources\\runtime\\ffmpeg"
  }
}
```

两个校验器都说通过：`scripts/fission-publish.mjs:configurationProblems` → `[]`；
`bench/fission-runtime.mjs:configurationIssues`（再加上 `readLocalFissionConfiguration` 的「文件是文件、目录是目录」）→ `[]`。

## 4. 实测

用仓库自己的源码应用起一次（bench 味：同一 `apps/desktop` 源、独立 home 与端口，不动 `~/.openfilm-dev` 里
另一个正在跑的 dev 实例），带 `ORANGE_FISSION_CONFIG_FILE=runtime.repo.json` 与
`ORANGE_AUTH_CONFIG_FILE=D:\dev\orange\.dev\auth-runtime.json`（`environmentId=orange-test-desktop`），脚本：
`.dev/fission-runtime/probe-fission.mjs`。

| 步骤 | 结果 |
| --- | --- |
| `GET /api/fission-local/jobs`（登录前） | **403** `authentication-required`（路由先判身份，再看服务） |
| `POST /api/auth/sign-in` → `GET /api/auth/state` | 200，`active` |
| `GET /api/fission-local/jobs`（登录后，`runtime.repo.json`） | **200 `[]`** |
| 同样步骤，旧 `runtime.local.json`（对照） | **503** `fission-local-unavailable` |

对照能复现原故障：`runtime.local.json` 的 `cli` 指 `E:\CodexData\worktrees\orange-budget-cap\…\Fission.Cli.dll`（已不存在），
`FFmpeg` 指 `D:\dev\7d\bin\ffmpeg.exe`（2022 年旧版），`readLocalFissionConfiguration` 直接拒掉 → 工具进程里
`localFission=null` → 每个 `/api/fission-local/*` 都 503 → 面板那句「未配置或当前不可用」。

仓库自带 UI 冒烟（`ORANGE_FISSION_CONFIG_FILE` 已导出）：

```
node --test apps/desktop/bench/fission-smoke.test.mjs
Fission runtime: ORANGE_FISSION_CONFIG_FILE (…runtime.repo.json)
  ok service (real): ready, 0 batch(es)
  ok step-1-scene-groups / step-2-preset / step-3-export / start-batch / draft-request
  ok real-route-payload (real): 真实路由回 202 -> failed/fission-selection-invalid
Fission smoke: 12/12 links ok
pass 1 / fail 0
```

即：入口「超级混剪」能开，服务探针 200，三步向导（场景组卡、预设摘要、导出估算、批量请求）全部走到，真实路由接受
页面发出的 payload（202），只在页面编造的 `selectionId` 上失败——与配置无关。

## 5. 是否需要改代码

- Fission / ffmpeg 链路：**不需要**。`release.mjs` 的 2b→2d 顺序本来就产出这套布局。
- 唯一遗留（非代码，忽略规则）：`apps/desktop/resources/` 现在以 210 MB 未跟踪出现在 `git status`（根 `.gitignore`
  没有它，`apps/desktop/.gitignore` 只有 `.dev/`、`.release/`）。建议加一行 `apps/desktop/resources/`；在加之前不要
  `git add -A`。
- 备注：`fission doctor` 仍读旧默认目录 `D:\dev\7d`（并用那里的 ffmpeg6 报 gltransition），它**不**读本配置，不能当作本链路的
  证据；Fission 真正的引擎路径来自 `paths.json`（由服务从 `runtime.paths` 写出）。
- 备注：`.NET 10.0.8` 运行时在机器上（`dotnet --list-runtimes`），`Fission.Cli.dll`（net10.0，70,144 B）能启动并打印用法，
  所以 `dotnet` 这一项不是隐患。
