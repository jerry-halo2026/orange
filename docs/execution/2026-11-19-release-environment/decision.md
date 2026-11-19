# 发行基线决策（2026-11-19）：v0.1.0、全专有许可、干净提交历史

## 1. 为什么有这一轮

2026-11-19 发现两件事同时成立：

1. **装机版没有登录环境**。`release.mjs` 只从 `.dev/auth-runtime.json`（git 忽略、只存在于一台机器）取环境，缺了只 `console.warn`；自检只在 `--dir` 时跑。结果：干净树（`git archive` 到 Mac、CI、别人接手）打出来的安装包没有 `resources/auth-environment.json`，装完只能停在 `configuration-required`，而窗口把这句话显示成「尚未配置隔离开发环境的登录连接。请提供安全本地配置」——让刚下载安装的人去提供本地配置。
2. **对外身份仍是上游的**。`brand.json` 早已写着 `appId: com.orange.studio`，但 `release.mjs:380` 把 appId 硬编码成 `dev.openfilm.desktop`，于是每个安装包的 bundle id / Windows AppId 都登记在上游名下。

## 2. 决策

### D1 版本基线：产品版本从 `v0.1.0` 起，只有一个版本号

| 包 | 版本 | 谁在用 |
| --- | --- | --- |
| `apps/desktop` | **0.1.0** | `app.getVersion()`：窗口版本、更新比较、`stepAside` 目录、Windows 版本资源；`desktop.yml` 校验 tag 必须等于它 |
| `packages/openfilm` | 0.3.0（不动） | 被 `npm pack` 打进安装包的库；保留为 vendored 基线记号 |
| `packages/shared` | 0.3.0（由 0.3.2 对齐） | 内部依赖 |

配套：`.changeset/config.json` 的 `fixed` 只留 `[openfilm, @openfilm/shared]`，`ignore: ["@openfilm/desktop"]`，`privatePackages.version: false`，`changelog.repo` 指向本仓库。桌面版本由 tag 决定，不被 changeset 拉扯。

### D2 许可：全专有，MIT 清零

- `LICENSE`（根、`packages/openfilm`、`packages/shared`）为英文专有条款：All rights reserved；禁止未授权复制/修改/衍生/再分发；禁止未授权 agent 修改；**例外：所有权人与所有权人明确授权的自动化代理**。
- `THIRD_PARTY_NOTICES.md`（两处）删除；第三方依赖各自的许可文件随 `node_modules` 分发，不由本仓库 LICENSE 重新授权。
- 四个 `package.json`：`license: "UNLICENSED"`；`packages/openfilm` 由可发布改为 `private: true`；`check-pack.mjs` 的断言从「必须非私有」改为「必须私有且 UNLICENSED」，堵死 `npm publish`。
- 源文件加英文版权头（`© 2026 OrangeFilm…`），`scripts/license-header.mjs` 提供模板与检查，`scripts/audit-public.mjs` 增加 `header` 检查：缺头即失败。
- **责任归属**：许可按所有权人（Ethan）明确指示执行——「去掉 MIT，出了问题我负责」。本文件记录该指示，不构成法律意见。

### D3 语言策略：门禁英文，内部中文

对外约束文件（`LICENSE`、`AGENTS.md`、`README.md` 顶部、`CLAUDE.md`、`.github/copilot-instructions.md`、`.cursor/rules/proprietary.mdc`、版权头、`check-pack`/`audit-public` 报错）全英文；`README.zh-CN.md` 只留一句中文底线声明；内部决策与证据文档（本目录、`docs/execution/**`）保持中文。

### D4 提交历史：单一根提交，旧历史离线保全

- 旧 704 提交（含外部作者与上游字样）在改写前用 `git bundle create … --all` 存到 `.dev/private-archive/`（79 MB、242 refs，`git bundle verify` 通过）。
- 新主线为单一根提交 `OrangeFilm v0.1.0`；`dev`、`main` 指向它；远端只留 `main`。
- 树内证据（`docs/history/**`、`overlay/**`、`scripts/vendor/**`、上游 CHANGELOG、第三方资产许可）移入同一归档目录，不删除。
- 代价：所有 SHA 变化，`AGENTS.md` 与 `docs/execution` 中的旧提交号改为「新 SHA / 见归档」。

### D5 发布环境：构建输入，不再依赖本机文件

- `apps/desktop/release/environment.json`（受 git 管理，严格三键）是打包环境的来源；`ORANGE_AUTH_ENV` / `ORANGE_AUTH_CONFIG_FILE` 可覆盖；三者都没有则构建在 electron-builder 之前失败。
- `.dev/auth-runtime.json` 只是开发运行时指针，**不再是打包输入**。
- 自检从「仅 `--dir`」改为所有构建类型都跑；失败产物移入 `out/incomplete/`，不再以可发布文件名留在 `out/`。
- 窗口说真话：`auth-environment-missing/incomplete/unreadable` → `install-incomplete`（「安装包不完整」），只有真正的开发缺配置才是 `configuration-required`。
- `.gitleaks.toml` 为 `apps/desktop/release/environment.json` 加 allowlist：该 `publishableKey` 是 Supabase 的客户端公开键，本来就在每个安装包里；构建期拒绝 `sb_secret_` 与 `service_role`。

## 3. 与计划的偏离

- 工作树与分支清理**没有**为每条有独有提交的分支打 `archive/*` tag，改为依赖 bundle + `.dev/hygiene/inventory.{json,md}` + `.dev/hygiene/patches/*.patch`。原因：tag 会把旧提交钉在仓库里，与 D4 直接冲突。详见 `docs/execution/2026-11-19-repo-hygiene/inventory.md`。

## 4. 未做（下一阶段）

- 内部标识重命名：`openfilm` 包名、`@openfilm/*` scope、`OPENFILM_*` 环境变量、`~/.openfilm`、`resources/openfilm`、`providers/openfilm.mjs`；两库包版本随之归零 `0.1.0`。
- Apple 证书与公证：本轮按所有权人指示跳过，CI 以 `--unsigned` 构建 mac arm64。
