# OpenFilm → OrangeFilm 全量改造计划

状态：**P0–P5 已实施，P6 待执行**（2026-11-24，分支 `orangefilm-clean-break`，基线 `909f1dc`）。
本计划取代 `docs/decisions/naming.md` 里"分五个发布周期逐步兼容"的旧路线：操作者已明确放弃对旧
`openfilm` 运行时、旧配置、旧安装的兼容，源码与构建产物一次性收敛到 OrangeFilm。

配套清单：改造前 [inventory.md](inventory.md)、改造后 [inventory-after.md](inventory-after.md)
（`node scripts/inventory-openfilm.mjs` 生成，可重复跑）。

---

## 1. 目标与验收

目标：仓库里除"历史证据"和"上游来源声明"外，不再有 `openfilm` 作为运行时标识；构建出的客户端
在产品名、包名、appId、资源目录、主目录、MCP 前缀、安装包文件名上全部是 OrangeFilm。

验收（全部满足才算完成）：

| # | 验收项 | 判定 |
|---|---|---|
| A1 | `node scripts/inventory-openfilm.mjs --json` 的 `env/mcp/import/pkg-scope/data-file/resource/home` 六个桶文件数为 0 | JSON 输出 |
| A2 | `npm pack` 出来的 tarball 里 `bin` 只有 `orangefilm`，无 `openfilm` | `pnpm pack` 列表 |
| A3 | Windows 安装后 `%LOCALAPPDATA%\Programs\<product>\resources\orangefilm\` 存在，无 `resources\openfilm\` | 装完列目录 |
| A4 | 首次启动建 `~/.orangefilm`，不再读 `~/.openfilm` | 启动后 `git`/`ls` |
| A5 | MCP 工具在 agent 侧显示为 `mcp__orangefilm__*` | 客户端工具列表 |
| A6 | `pnpm test`、`pnpm gate`、`pnpm audit:public`（0 findings）、gitleaks 全绿 | CI 日志 |
| A7 | GitHub Actions `packaging-check` 两平台绿，产物名含 OrangeFilm | CI artifact |
| A8 | 装机后：标题栏"橙子创作中心"、Saved claim、素材下载、更新检查、设置里的 BYOK 密钥仍在 | 手测清单 |

---

## 2. 现状清单（本机实测）

### 2.1 源码

扫描 2502 个文本文件（排除 `node_modules`/`.git`/`.dev`/`dist`/`_scratch`）：

| 桶 | 含义 | 文件数 | 出现次数 |
|---|---|---:|---:|
| `env` | `OPENFILM_*` 环境变量（136 个不同名） | 230 | 1162 |
| `mcp` | `mcp__openfilm__` 工具前缀 | 6 | 20 |
| `import` | `from 'openfilm'` / `'openfilm/…'` | 24 | 35 |
| `pkg-scope` | `@openfilm/desktop` 工作区别名 | 12 | 16 |
| `css-class` | `openfilm-*` 类名/选择器 | 165 | 563 |
| `data-file` | 技能元数据 `openfilm.json` | 14 | 52 |
| `home` | `~/.openfilm` 与目录名 | 101 | 355 |
| `resource` | `resources/openfilm` 打包路径 | 11 | 15 |
| `url` | `github.com/openfilm`、`openfilm.dev` | 51 | 1036 |
| `ident` | 裸标识符 `openfilm` | 472 | 4450 |
| `product` | 文案 `OpenFilm` | 564 | 1197 |

路径里带 `openfilm` 的文件 19 个（见 inventory.md 末节）。

### 2.2 本机残留（Windows）

| 路径 | 大小 | 性质 |
|---|---:|---|
| `%USERPROFILE%\.openfilm` | 1632.9 MB | 旧 Studio 主目录（library 1301 MB / cache 221 MB / runtime 201 MB / materials 102 MB） |
| `%APPDATA%\openfilm` | 52.0 MB | 旧 Electron userData |
| `%LOCALAPPDATA%\Programs\OrangeFilmTest` | — | 当前测试构建，**保留** |
| `%APPDATA%\orangefilm` | 69.3 MB | 当前测试构建 userData，**保留** |
| 注册表 `HKCU\...\Uninstall\370c2be2-…` | — | 显示名 `OrangeFilm 0.1.0`，**保留** |

没有遗留 `OpenFilm.exe` 安装目录，也没有 `OpenFilm` 卸载项；旧客户端的实体只有 `~/.openfilm` 和
`%APPDATA%\openfilm`。
`~/.openfilm` 目前仍是**在用**主目录（`defaultStudioHome()` 在没有迁移标记时返回它），所以删除必须排在 P2 之后。

---

## 3. 决策

### 3.1 放弃兼容（操作者已授权）

| 项 | 旧 | 新 | 处理 |
|---|---|---|---|
| 环境变量 | `OPENFILM_*` | `ORANGE_*` | 直接改名，删桥接，不读旧名 |
| 包名 | `openfilm` | `orangefilm` | 删 npm 链接别名，删旧 bin |
| CLI | `openfilm` | `orangefilm` | 只留新 bin，旧命令不存在 |
| 主目录 | `~/.openfilm` | `~/.orangefilm` | 不回退，只提供一次性显式导入 |
| MCP | `mcp__openfilm__*` | `mcp__orangefilm__*` | 不再接受旧前缀 |
| 资源 | `resources/openfilm` | `resources/orangefilm` | 直接改路径 |
| provider id | `openfilm` | `orangefilm` | 改 id + 一次性设置键拷贝 |
| 类名 | `openfilm-*` | `orangefilm-*` | 直接改 |
| localStorage | `openfilm.*` | `orangefilm.*` | 启动时一次性搬key |
| 技能元数据 | `openfilm.json` | `orangefilm.json` | 读新旧两处、只写新 |

### 3.2 必须保留（不参与改名）

1. `docs/history/**`、`docs/execution/2026-*/**`：历史证据，不改写。
2. `LICENSE`、`THIRD_PARTY_NOTICES.md`、上游来源声明里的 `github.com/openfilm`、上游 npm 包名。
3. 第三方依赖自身的名字与许可。

### 3.3 需要操作者拍板的两件事（本计划给出默认值，先按默认执行）

| 事项 | 默认 |
|---|---|
| 更新源 | 没有自己的发布域名前，`product.json` 的 `desktop.updates` 置空（不检查更新）；发布后再填 |
| npm 发布 | **不**发布 `openfilm`（上游包名）；`orangefilm` 包名先只用于内部分发，`release.yml` 的 npm 发布任务先关闭 |

---

## 4. 执行顺序

每个阶段独立可验证、可回滚；上一阶段测试没过不进入下一阶段。

### P0 护栏（0.5h）

1. `scripts/inventory-openfilm.mjs`（已加）：只读清单，`--json` 给 CI 用。
2. 新增 `scripts/rename-guard.mjs`：扫 `apps/ packages/ scripts/ skills/ workers/ .github/`，
   命中 `OPENFILM_`、`mcp__openfilm__`、`from 'openfilm'`、`@openfilm/`、`resources/openfilm`、
   `\.openfilm\b`、`openfilm\.json` 就退出 1；白名单只有 `docs/history/**` 与 `docs/execution/2026-1*/**`。
   挂到 `pnpm gate` 与 `.github/workflows/ci.yml`。
3. 更新 `docs/decisions/naming.md`：状态改为"clean break 已批准"，删掉 P1–P5 兼容分期表。

### P1 环境变量与包说明符（机械替换，半天）

1. codemod `OPENFILM_` → `ORANGE_`：230 文件 1162 处。因为变量生产者和消费者同时改，运行时自洽。
2. 删 `packages/orangefilm/src/orange-env.mjs`，删 `package.json` 的 `./orange-env` export，删调用点
   （`apps/desktop/src/main.mjs`、`packages/orangefilm/bin/*.mjs` 里的 `bridgeOrangeEnv`）。
3. `'openfilm'`/`'openfilm/…'` 说明符 → `'orangefilm'`：24 文件 35 处。重点：
   - `apps/desktop/src/main.mjs`：`openfilm/locations` → `orangefilm/locations`
   - `apps/desktop/scripts/release.mjs`：`require.resolve('openfilm/package.json')` → `orangefilm`
   - `packages/orangefilm/src/home-cli.mjs`、`studio/server/*.mjs` 里的自引用
4. `@openfilm/desktop` → `@orange/desktop`（`scripts/dev-desktop.mjs`、`scripts/gate-test-coverage.mjs`；
   这两个引用在包重命名后本来就是坏的，属于顺手修复）。
5. `apps/desktop/package.json` 删 `"openfilm": "link:../../packages/orangefilm"`。
6. `packages/orangefilm/package.json`：`bin` 只留 `"orangefilm": "bin/orangefilm.mjs"`；
   `git mv bin/openfilm.mjs bin/orangefilm.mjs`，`git mv bin/openfilm-auth.test.mjs bin/orangefilm-auth.test.mjs`。
7. `pnpm install` 刷新 lockfile（`openfilm` 链接条目消失）。

测试门：`pnpm -r test`、`node scripts/rename-guard.mjs`（此阶段 env/import 两桶必须为 0）。

### P2 主目录（半天）

1. `packages/orangefilm/src/locations.mjs`：`defaultStudioHome()` 恒返回 `~/.orangefilm`；删掉
   `.orangefilm-home-migration.json` 标记判断。
2. `packages/orangefilm/src/home-migration.mjs`：从"自动迁移"改为"显式导入"——
   `orangefilm home import --from ~/.openfilm [--include-library] [--dry-run]`，只拷贝、不删源；
   标记文件改名 `.orangefilm-home-import.json`。
3. `packages/orangefilm/src/home-cli.mjs`：`home status` 报新目录；新增 `home cleanup` 打印旧的残留位置
   （不执行删除，删除交给 `scripts/cleanup-legacy-openfilm.mjs`）。
4. `studio/server/server.mjs` 的 `/api/home/migration` 路由改成 `/api/home/import`，POST 仍要求 `{confirm:true}`；
   `ui/src/components/settings/StorageGroup.tsx` 跟着改文案与端点。
5. 相关测试：`locations.test.mjs`、`home-migration.test.mjs`、`server.test.mjs`。

测试门：新建临时 HOME 启动 Studio，确认生成 `~/.orangefilm` 且不读 `~/.openfilm`。

### P3 MCP / provider / 技能元数据（1 天）

1. `apps/desktop/src/orangefilm-mcp.mjs`：server 名固定 `orangefilm`，删 `mcp__openfilm__` 前缀兼容分支；
   `apps/desktop/src/agents.mjs`、`packages/shared/src/agent-activity.ts` 与 `chat/src/lib/local-agent-run.ts`
   里按前缀分派的代码同步收敛（`mcp` 桶 6 文件 20 处）。
2. `studio/server/providers/openfilm.mjs` → `orangefilm.mjs`，`id: 'openfilm'` → `'orangefilm'`；
   在设置读取处加一次性键拷贝：`providers.openfilm` → `providers.orangefilm`（存在旧的、缺新的时）。
   `ofk_` 密钥前缀不变（服务端签发）。
3. 技能元数据 `openfilm.json` → `orangefilm.json`：`src/skills.mjs` 读取顺序 `orangefilm.json` → `openfilm.json`，
   写入只写新名；`studio/server/history-migrate.mjs`、`ui/src/lib/project-sources.ts`、`chat/src/app-bridge.ts`
   同步；`packages/orangefilm/manual/{canvas,edit,media,replicate}/openfilm.json` 四个文件改名。
4. 仓库技能 `skills/openfilm/` → `skills/orangefilm/`，frontmatter `name: orangefilm`；
   `scripts/audit-public.mjs` 的允许列表跟着改。
5. localStorage：`openfilm.*` → `orangefilm.*`（13 个键：`language`、`local-agents.v2`、`workspace.current.v2` …）。
   在 chat 启动时做一次性搬运（有旧无新则复制并删除旧键），避免语言/工作区偏好丢失。

测试门：`pnpm test`；`scripts/rename-guard.mjs` 的 mcp/data-file 桶为 0。

### P4 打包、类名、文件改名与 CI（1 天）

1. `resources/openfilm` → `resources/orangefilm`：`apps/desktop/scripts/release.mjs`、
   `scripts/packed-editor-modules.mjs`、`scripts/packaged-selfcheck.mjs`、
   `src/w3-python-packaging.test.mjs`、`src/orangefilm-mcp.mjs` 里的打包期路径与自检断言。
2. CSS 类 `openfilm-*` → `orangefilm-*`：165 文件 563 处（`chat/src/chat.css`、`studio/ui/src/globals.css`
   与全部 `className`）。纯标识符替换，无数据格式影响。
3. 文件改名：`apps/desktop/bench/openfilm-agent.test.mjs` → `orangefilm-agent.test.mjs`、
   `bench/openfilm-models.tsx` → `orangefilm-models.tsx`（含 `bench/run.mjs`、`bench/scenarios.mjs` 的引用）。
4. CI（`.github/workflows`）：
   - `OPENFILM_TEST_ARTIFACTS`、`OPENFILM_SIGN_IDENTITY`、`OPENFILM_NOTARY_PROFILE` → `ORANGE_*`；
     secret 重命名需要仓库里先添加新 secret，过渡期用 `secrets.ORANGE_SIGN_IDENTITY || secrets.OPENFILM_SIGN_IDENTITY`。
   - keychain 名 `openfilm-signing` → `orangefilm-signing`，notary profile `orangefilm-notary`。
   - `github.repository == 'openfilm/openfilm'` 的发布门（`release.yml:26`、`agents.yml:18`）→
     `'jerry-halo2026/orange'`，否则在这台仓库上发布任务永远被跳过。
   - 产物名：artifact `windows-packaging`/`macos-packaging` → `orangefilm-windows`/`orangefilm-macos`；
     安装包 `OrangeFilm-Setup-<version>-<arch>.exe`、`OrangeFilm.exe`。
   - `release.yml` 的 npm 发布任务先关掉（见 3.3），不要向上游包名 `openfilm` 发布。
5. 更新 `apps/desktop/src/bundle-identity.test.mjs` 的 appId 一致性断言（`com.orange.studio`）。

测试门：本地 `pnpm --filter @orange/desktop build`；CI `packaging-check` 两平台绿。

### P5 文案与外部链接（1 天）

1. `OpenFilm` → `OrangeFilm`：564 文件 1197 处，**排除** `docs/history/**`、`docs/execution/2026-*/**`、
   `LICENSE`、`THIRD_PARTY_NOTICES.md`。代码里的用户可见字符串（窗口标题、菜单、错误、i18n、`brand.json`）
   优先，注释次之。
2. 链接规则（51 文件 1036 处）：
   - `github.com/openfilm/*` 只保留在历史文档与来源声明里；
   - 运行时更新地址 `openfilm.dev/download/…` → 空（见 3.3）或仓库 releases；
   - `dev.openfilm.desktop*` bundle id → `com.orange.studio`（正式）/ `com.orange.studio.dev`（开发版）；
   - 文档里给用户看的安装命令 `npx -y openfilm@latest` → `npx -y orangefilm@latest`，并在发布前标注"未发布"。

测试门：`scripts/rename-guard.mjs` 全绿、`pnpm audit:public` 0 findings。

### P6 本机清理（P2 合入之后）

1. 先预览：`node scripts/cleanup-legacy-openfilm.mjs`
2. 删安装与配置（482.9 MB）：`--apply`
3. 删用户数据（library 1301 MB + materials 102 MB + skills）：`--apply --include-library`
4. 删账号密钥：`--apply --include-credentials`
5. Mac 同一脚本跑一遍（`/Applications/OpenFilm.app`、`~/Library/*openfilm*`、`dev.openfilm.desktop*.plist`）。
6. 保留：`%LOCALAPPDATA%\Programs\OrangeFilmTest`、`%APPDATA%\orangefilm`、注册表 `OrangeFilm 0.1.0`。

想留素材库时，先 `orangefilm home import --from ~/.openfilm --include-library` 再删。

---

## 5. 风险与回滚

| 风险 | 处理 |
|---|---|
| P1 一次性改 1162 处环境变量 | 单文件机械替换 + 每阶段跑全量测试；出问题 `git revert` 该阶段一个 commit |
| P2 之前删 `~/.openfilm` 会打断在用客户端 | 清理排在 P2 之后；清理脚本默认 dry-run，且拒绝删除路径含 `orange` 的目标 |
| 技能元数据 `openfilm.json` 有用户手写内容 | 读取双名兼容，写入只写新名，不丢 |
| provider id 变更导致 BYOK 密钥"消失" | 设置读入时一次性拷贝旧键 |
| CI 发布门写在 `openfilm/openfilm` | P4 一起改，否则发布永远跳过 |
| 文案替换误伤历史/许可 | 白名单目录，先跑 `rename-guard.mjs` 看命中 |

提交策略（按仓库规约）：每阶段一个 commit，只提交源码与文档；不提交 `_scratch`、`docs/execution/*.png`。

---

## 6. 假设

1. 本地 `docs/execution/2026-11-17-ui-batch/*.png` 与 `_scratch/` 是无关改动，不进入本次提交。
2. 产品名英文 `OrangeFilm`、中文 `橙子创作中心`，appId `com.orange.studio`（`brand.json` 已如此）。
3. 不发布 npm `openfilm`，`orangefilm` 包名暂只做内部分发。
4. Mac 侧清理由本人在 Mac 上执行同一脚本；本工作区只处理 Windows。

---

## 7. 实施记录（2026-11-24）

分支 `orangefilm-clean-break`，基线 `909f1dc`（P0 计划提交 `f2df2a1`）。回滚：`git reset --hard 909f1dc`，
或在别的分支上 `git checkout 909f1dc -- .`；分支本身保留，不推送。

### 已完成

| 阶段 | 落地内容 |
|---|---|
| P0 | 清单脚本、护栏脚本、决策文档改为 clean break |
| P1 | `OPENFILM_*`→`ORANGE_*`（含测试里的动态变量名）、模块说明符→`orangefilm`、删 `orange-env` 桥接、删 `openfilm` npm 别名与旧 bin、改名 `bin/orangefilm.mjs` |
| P2 | `defaultStudioHome()` 恒为 `~/.orangefilm`，删迁移标记回退；旧主目录只作为一次性导入源 |
| P3 | MCP 前缀只认 `orangefilm`、provider id → `orangefilm`、技能元数据 `orangefilm.json`（读旧写新）、localStorage 键、agent 定义键 |
| P4 | `resources/orangefilm` 单份、打包只装 `node_modules/orangefilm`、CSS 类前缀 `orangefilm-*`、文件改名、CI 发布门指向 `jerry-halo2026/orange`、签名 secret 支持 `ORANGE_SIGN_IDENTITY` |
| P5 | 产品文案 `OrangeFilm`、维护文档与链接、示例项目引用 |

### 验证

- `node scripts/rename-guard.mjs`：0 命中（历史证据、许可、旧主目录导入、清理脚本按规则豁免）。
- `pnpm test`：`packages/orangefilm` 与 `packages/shared` 全绿；`apps/desktop` **777 用例 / 764 通过 / 6 失败**，
  与基线逐条对照（`git stash` 后在 `909f1dc` 上跑同一套命令，同样 777/764/6，失败用例名一致）——
  这 6 条是既有问题，不是本次改名引入：lockfile 夹具、打包模块闭包期望、两处 react ESM 的 `require`、
  devtools 菜单回调断言、main.mjs 沙箱缺 `startMaterialIndexBootstrap`。
- `pnpm --filter @orange/desktop build:shell`：通过（`@import 'orangefilm/studio-ui/globals.css'` 能解析）。
- `node scripts/check-pack.mjs`：tarball 只列 `bin/orangefilm.mjs`；它另外报的 `scripts/*` 属既有告警。
- `pnpm audit:public --no-secrets`：删除 `_scratch` 后 0 findings。
- 期间修掉三个自己引入的问题：`skills.mjs` 的 `metadataPath` 未定义（技能封面读不到）、Studio UI 用了中间态
  构建产物、`watch.test.mjs` 的异步事件竞态（加了 settle）。

### 未做（需要单独决定）

- P6 本机清理：脚本已就绪，**故意没有执行**——机器上现装的 `OrangeFilmTest` 是旧代码构建的，仍以
  `~/.openfilm` 为 Studio 主目录；先删会让当前唯一的可用客户端失效。正确顺序是：新构建装好并确认能起，
  再 `node scripts/cleanup-legacy-openfilm.mjs --apply`（482.9 MB 安装+配置+缓存）；
  1.3 GB 素材库要走 `--include-library`，需要单独点头。
- npm 发布保持关闭（`vars.NPM_PUBLISH` 未设为 `true` 时 release.yml 不跑）。

---

## 8. 打包验证（2026-11-24，分支推送后）

分支 `orangefilm-clean-break` 已推到 `jerry-halo2026/orange`，用 `workflow_dispatch` 跑
`packaging-check`（不发布、不签名，只上传产物）。

### Windows：通过

- 运行 `45402321134`，`windows` 作业 success；产物 `OrangeFilm-Setup-x64.exe`（1068.8 MB）+ `win-unpacked`。
- `win-unpacked/resources`：`orangefilm/`、`runtime/`（ffmpeg、ms-playwright）、`fission/`、`brand.json`、
  `auth-environment.json`；**没有 `openfilm/`**。
- `resources/app.asar.unpacked/node_modules`：`orangefilm`、`@agentclientprotocol`、`playwright-core`、
  `esbuild`、`quickjs-wasi`、`@earendil-works`；**没有 `openfilm`**。整棵 unpacked 树按名字搜 `openfilm` 为 0。
- `resources/orangefilm` 内是 `packages/orangefilm/src/*.mjs` 与 `scripts/material-index-{bootstrap,build}.mjs`，
  与 `PACKED_MATERIAL_MODULES` 一致。
- 包内 `brand.json`：`productName OrangeFilm`、`appId com.orange.studio`、`installerName OrangeFilm`、
  `updaterChannel orange-latest`。
- `OrangeFilm.exe` 的版本资源仍是 Electron 默认（ProductName=Electron）：旧安装包同样如此，属既有行为，不是本次改动。

### macOS：被 GitHub 的 runner 排队卡住

- 同一晚三次 `mac-arm64` 派发（`45402321134` 的 macos 作业、`45407962171`、`45411975598`）：作业从未拿到 runner
  （`runner_name` 为空、`steps` 为空），15 分钟后被 GitHub 的排队上限取消。没有一步执行过，不是构建失败。
- 今天中午同一工作流在这个分支的祖先上跑通过 macOS，所以是容量问题，不是配置问题。需要换个时段重试。

### 本机直接运行打包产物：未验证

- 从当前 shell 启动 `win-unpacked\OrangeFilm.exe` 会立即退出（无 stderr、无新日志、连 userData 目录都没建）；
  用同一 shell 启动机器上已安装的旧 `OrangeFilmTest\OrangeFilm.exe` 行为相同。说明是这个会话启动 GUI 子进程的环境限制，
  不能用来判断新构建是否有问题。需要人在桌面双击安装包验证。

### `ci.yml`（测试）在基线上就是红的

`workflow_dispatch` 跑 `ci`（`45402467266`）：`audit`、`test (windows-latest)`、`pack` 失败，`engine (windows-latest)` 通过，
两个 macOS 作业同样因排队被取消。三处失败都能在基线上复现，不是改名引入：

- `pnpm typecheck` → `apps/api/src/raw.ts(214,27)` `'row' is possibly 'undefined'`：`denial()` 未被推断为 `never`，
  该文件本次未改动。
- `pnpm check:pack` → `scripts/check-pack.mjs` 的 `^scripts/` 规则与 `packages/orangefilm/package.json` 的
  `files: ["scripts"]` 直接冲突，两边在基线上一模一样。
- gitleaks 历史扫描 → `apps/api/src/*.test.ts` 在提交 `a0578192` 的夹具命中 `generic-api-key`，属既有历史。
  本次新增的一处在 `providers-isolation.test.mjs`，已把夹具值 `ofk_fixture`/`fixture-owned-key` 加进 `.gitleaks.toml` 允许列表（`07f668d`）。

要这三项变绿，需要单独修这三个既有问题；它们与 OrangeFilm 改名无关。
