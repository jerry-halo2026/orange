# macOS（Apple Silicon）验证清单

日期 2026-11-19 · 目标机 `192.168.110.96`（用户 `halo`）

> Windows 是首个发布目标；macOS arm64 是**单独验证**的第二条线。它没有被 Windows 的绿测覆盖：
> .NET 渲染器、ffmpeg 二进制、Electron 打包、路径大小写、以及 HFS/APFS 上的文件名规则都不一样。
> 下面这份清单是"第一次在真机上跑通"的最短路径，不是发布流程。

## 0. 先要让这台机器能被连上

现状（2026-11-19 实测）：**ping 通，但 22 / 5900 / 445 / 3283 全部拒绝** —— 远程登录没开。
在 Mac 上打开：

```
系统设置 → 通用 → 共享 → 远程登录（Remote Login）打开
  · 允许用户：halo
  · 想用 VNC 看屏幕的话，同时打开「屏幕共享」
```

打开之后从 Windows 侧验证一次：

```
ssh halo@192.168.110.96 "sw_vers; uname -m; node -v; dotnet --version"
```

预期：`macOS 15.x` / `arm64` / `v22+` / `10.0.x`。

## 1. 机器上要有的东西

| 依赖 | 版本 | 为什么 |
|---|---|---|
| Node.js | ≥ 22（仓库用 26 跑过，22 是下限） | Studio server / 脚本 / 单测 |
| pnpm | 10.x | 工作区安装 |
| .NET SDK | 10.0.3xx | Fission 是 .NET 10 |
| Xcode Command Line Tools | 最新 | Electron 打包与原生模块 |
| ffmpeg | **不要另装**，用 app 自带那份 | 版本必须与 `ffmpeg-runtime.mjs` 固定的一致（9.0.2） |

## 2. 一次性跑完的脚本

`scripts/verify-macos.sh`（随仓库走）依次做七件事，任一失败立刻停：

1. `node -v` / `pnpm -v` / `dotnet --version` / `uname -m` 打印并校验；
2. `pnpm install --frozen-lockfile`；
3. `node infra/migrate.mjs --target local --check`（迁移与账本一致，31 个文件）；
4. 纯逻辑单测（plan / planset / dedupe / claim / copy-rewrite / visual-tags / shot-plan）；
5. `dotnet build workers/fission/src/Fission.Cli`（0 error）；
6. `node --test` 跑 Studio 侧 fission 三件套（engine-paths / plan / batch / batch-jobs / render-routes）；
7. UI 构建（`vite build`）。

```bash
# 在 Mac 上：
cd ~/orange            # 检出位置
bash scripts/verify-macos.sh 2>&1 | tee /tmp/orange-macos-verify.log
```

## 3. macOS 特有的失败点（Windows 上过不代表这里过）

| 点 | Windows 行为 | macOS 预期差异 | 先看哪里 |
|---|---|---|---|
| 路径大小写 | 不敏感 | **敏感**：`Assets/` 与 `assets/` 是两个目录 | `fission-engine-paths.mjs` 的 canonical 目录 |
| 路径规范化 | 8.3 短名要展开 | 无 8.3；但有 `/private/var` 与 `/var` 两种写法（realpath 才统一） | `runFission` 的 canonicalRoot |
| ffmpeg 二进制 | `.exe` | 无后缀；且需要 `chmod +x` | `ffmpeg-runtime.mjs` 的落盘权限 |
| 文件名含中文与空格 | 可以 | 可以（但 NFD 归一化）：`小青柑` 在不同来源可能不同码位 | 素材落盘 `landSaved` |
| .NET 渲染 | CPU 回落 | arm64 原生 `libx264`，NVENC 不存在 → 必然 CPU | `fission-run` 的 NVENC 回落日志 |
| Electron | 打包 exe | 需要 `arm64` target 与签名 | `apps/desktop` 的 build 配置 |

## 4. 第一次真出片（比单测更有说服力）

```
node scripts/fission-smoke.mjs --engine-from-app
```

它做的事：造两条 3 秒测试片段与两段配音 → 建一份计划 → `plan.render` → 断言产物存在、时长误差 < 0.3s。
Windows 上这条路 3.9s 出一条 5s 片；Mac 上第一次跑请记录**实际耗时**（arm64 上 libx264 通常更快）。

## 5. 记录什么

跑完把这三样贴回会话（或写进 `docs/execution/2026-11-19-koc-voiceover/macos-report.md`）：

1. `verify-macos.sh` 的完整输出；
2. 第一次真出片的耗时与产物大小；
3. 任何与 Windows 行为不一致的地方（尤其是路径与文件名）。

## 6. 明确不承诺的

- Intel Mac 与 Linux 客户端不在计划内；
- Apple Developer 签名/公证需要你的证书，没有它只能本机运行；
- Mac 上的 Fission 单测通过 ≠ 发布就绪（打包、签名、自动更新都还没验）。
