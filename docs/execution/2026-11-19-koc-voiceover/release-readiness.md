# 真机验收 · CI/CD · 发版：整机走一遍

日期 2026-11-19 · 目标：**OrangeFilm 整个产品**在 Windows 与 macOS（Apple Silicon）真机上验收 → 过 CI → 发版

> 这一页只管"怎么证明它能用"，不管设计。凡是写着**必须**的，都是发版前必须有证据的；
> 写着**暂不**的，是这版不做（Intel Mac、Linux 客户端）。

---

## 1. 谁在什么时候跑什么

| 阶段 | 在哪 | 跑什么 | 通过标准 |
|---|---|---|---|
| ① 本机 | Windows 开发机 | `pnpm typecheck` + `pnpm test` | 全绿；已知既有失败单独记账（见第 5 节） |
| ② 本机真机 | Windows | 第 3 节「整机流程」全过 + `scripts/fission-smoke.mjs` | 八条流程全过，冒烟出片成功 |
| ③ 真机 | macOS arm64（`192.168.110.96`，用户 `halo`） | `bash scripts/verify-macos.sh` + 第 3 节 | 同上；并记录与 Windows 不一致处 |
| ④ CI | GitHub Actions `ci.yml`（ubuntu / macos-15 / windows） | 同一套 `pnpm test` + `pnpm typecheck` | 三个 runner 全绿 |
| ⑤ 打包 | `desktop.yml`（tag `v*`） | Windows 安装包 + macOS arm64 签名/公证 | 产物可安装、可启动、可出片 |
| ⑥ 发版 | GitHub Release（草稿 → 发布） | 人工确认 | 下载链接可用；更新源 meta 正确 |

**顺序不能反**：②③ 没过不要碰 ⑤；⑤ 的签名密钥没配就不要打 tag。

---

## 2. CI 现状与这次补的缺口

仓库已有三条流水线（上游 OpenFilm 自己的）：

| 文件 | 触发 | 做什么 |
|---|---|---|
| `ci.yml` | push main / PR / 手动 | 三平台 `pnpm typecheck` + `pnpm test`，Linux 额外装 ffmpeg 与 Playwright |
| `desktop.yml` | tag `v*` / 手动 | 各平台打安装包，Mac 签名 + 公证，产出**草稿** Release 与更新源 |
| `release.yml` | push main | changesets 开「Version packages」PR；合并后发 npm 包（OIDC 可信发布） |

**这次补的缺口**（2026-11-19）：`packages/openfilm` 的测试 glob 只覆盖 `studio/ui/src/components/*.test.ts`，
**子目录里的测试从来不在 CI 里跑**。批量出片页的模型测试在 `components/batch/`，于是它一直"本地绿、CI 不跑"。
已补 `studio/ui/src/components/*/*.test.ts`。

> 这条值得单独记：一个测试写得再好，只要 glob 没覆盖它就是**不存在**。

---

## 3. 整机流程（Windows 与 macOS 各跑一遍，八条）

每条都要给出**证据**：截图或产物路径，不能只说"能跑"。

| # | 流程 | 怎么做 | 通过标准 |
|---|---|---|---|
| 1 | 安装与首启 | 装安装包 → 启动 | 无白屏；首启引导可跳过；重启后还在 |
| 2 | 建工程 | 新建工程 | 工程目录结构齐全（`film.html`、`.film/`） |
| 3 | 素材进来 | 素材中心取一条云管家素材；再放一个本地目录（如 `D:\dev\sucai\油弃乌龙茶`） | 两条都在 `assets/` 里，文件名带 id，缩略图能看 |
| 4 | 检索 | 中文语义检索（"小青柑 冲泡 特写"）与元素检索（"悲伤的告别"） | 结果相关；warm 查询 < 100 ms（Windows 实测 48–55 ms） |
| 5 | 一句话 → 计划 | 给 5 句文案 + 素材候选 | 生成 plan；七条校验 + 合规都返回；同名重复被闸门拦下 |
| 6 | 出片 | 批量出片 2 条 | 产物在 `.film/fission/out/`；时长误差 < 0.3 s；页面进度从 0/N 走到 N/N |
| 7 | 字幕 | 写 `captions/<planId>.vtt` | 用播放器打开，字幕与镜头对齐 |
| 8 | 导出与重开 | 导出成片；关掉再打开工程 | 时间线还在；导出文件可播 |

## 4. macOS 特有四件事（Windows 绿不代表这里绿）

1. **路径大小写敏感**：`Assets/` 与 `assets/` 是两个目录 → `fission-engine-paths.mjs` 的 canonical 目录；
2. **`/private/var` vs `/var`**：`realpathSync.native` 才统一，`runFission` 的 canonicalRoot；
3. **ffmpeg 无后缀且需可执行位**：`ffmpeg-runtime.mjs` 落盘后要 `chmod +x`；
4. **中文文件名 NFD 归一化**：`小青柑` 在不同来源可能是不同码位 → 素材落盘的 `landSaved`。

## 5. 已知的既有失败（不是这次引入的，发版前要么修要么明文记账）

| 测试 | 症状 | 处理 |
|---|---|---|
| `library-semantic.test.mjs` | 缺 e5 模型文件 | 换 bge-base 之后该测试该重写或删 |
| `keys.test.mjs`（1 条） | `configured: true` 断言过期 | 改断言 |
| `library-semantic-isolation.test.mjs` | 需要 `ORANGE_SERVICES_TEST_ROOT` | 补环境或跳过 |
| `tsc -p studio/ui` | `material-center/index-tree.ts` 的 `IndexEntry` 形状 | 修类型（1 行） |

## 6. 发版前的最小清单

```
[ ] ci.yml 三平台全绿
[ ] Windows 真机八条流程有证据
[ ] macOS arm64 八条流程有证据 + verify-macos.sh 全绿
[ ] fission-smoke 两平台各一次，记录耗时
[ ] 已知失败四点已修或已记账
[ ] desktop.yml 的签名密钥齐（OPENFILM_SIGN_IDENTITY / APPLE_TEAM_ID / 证书 / API key）
[ ] tag 用统一版本号 v<version>（每个 package 的 version 一致）
[ ] Release 先出草稿，人工点发布
```

## 7. 暂不做

- Intel Mac、Linux 客户端；
- 自动更新源之外的渠道（应用商店、国内第三方市场）；
- 未经签名的 macOS 分发（只能本机运行）。
