# Harness 与客户端集成

文档集 U2（2026-11-13）。起点 `dev @ 3f66692`。职责：说明桌面端作为 ACP 客户端时对外暴露什么、我们如何把 OrangeFilm 自己的 MCP 服务注入进去、写权限与打包边界。

证据分级：`[代码]` 文件:行号、`[实测]` 本机可复跑、`[未验证]` 见末节。

## 1 结论表

| # | 结论 | 证据 |
| --- | --- | --- |
| 1 | 桌面端是 ACP **客户端**，对外只声明最小能力：`fs.readTextFile/writeTextFile=false`、`terminal=false` | `[代码]` `apps/desktop/src/agents.mjs:929-938`（`CLIENT_CAPABILITIES`） |
| 2 | 会话流程 `initialize → session/new → session/prompt`，权限询问走 `session/request_permission`（在聊天里问人） | `[代码]` `agents.mjs:5`（模块注释）、`:1380`（initialize）、`:1398`（`step='session/new'`）、`:1078` |
| 3 | 原实现没有 MCP：`mcpServers: []` | `[代码]` 历史提交 `21f73a7`（OrangeFilm 0.1.3）；现由 `b9104e6` 注入 |
| 4 | 现在注入一个自建 stdio MCP 服务：`mcpServers: [orangefilmMcpServer()]` | `[代码]` `agents.mjs:1388` |
| 5 | dsh 支持 stdio / http 两种 MCP，工具名为 `mcp__<server>__<tool>` | 外部事实（dsh 侧），本仓库不实现 |
| 6 | 该 MCP 暴露 7 个工具，读 5 写 2 | `[代码]` `apps/desktop/src/orangefilm-mcp.mjs:38-102` |
| 7 | MCP 调用**不受** OrangeFilm 自身的 approve 管辖，因此自带写闸门 | `[代码]` `orangefilm-mcp.mjs:11-12`、`:126-146`、`:362` |
| 8 | 写闸门文件 `~/.orangefilm-dev/mcp-write.json`：`version:1` + `allowWrite:true` + 项目绝对路径白名单 | `[代码]` `orangefilm-mcp.mjs:31`、`:128`、`:146` |
| 9 | 编辑器模块打包 3 个文件到 `resources/orangefilm`，路径常量单一来源 | `[代码]` `apps/desktop/scripts/packed-editor-modules.mjs:14-18`、`:24` |
| 10 | 模块定位三级回退：env → 打包目录 → 仓库根 | `[代码]` `orangefilm-mcp.mjs:184-190` |
| 11 | Settings 的 Services / 本地模型改为**账号级 store**，不再依赖隔离 profile | `[代码]` `packages/orangefilm/studio/server/server.mjs:319-324`、`:426-443` |
| 12 | 无登录态时这两类接口 403/503，且**不创建**任何文件 | `[代码]` `server.mjs:318`（403）、`:433`/`:441`（503） |

## 2 ACP 侧事实

### 2.1 客户端能力（为什么这么窄）

```js
// agents.mjs:929-938
export const CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} },
  auth: { terminal: true },
  session: { notices: {} },
  _meta: { parameterizedModelPicker: true, jetbrains: { air: { version: 1, capabilities: ['recommendedValue'] } } },
};
```

`fs`/`terminal` 都是 `false`：桌面端**不**替 agent 读写文件、**不**开终端。所有文件能力都通过我们自己的 MCP 工具给出——这是把「权限面」收窄到一处的前提。`auth.terminal=true` 表示登录仍然交给终端里 agent 自己的方式（`auth: { terminal: true }` 与模块注释 `agents.mjs:5` 一致）。

### 2.2 会话顺序与权限

1. `initialize`：带 `protocolVersion` 与 `CLIENT_CAPABILITIES`（`agents.mjs:1380-1382`；另一处 `:671` 是探测/握手用途）。
2. 可选 `authenticate`（`:1395`）。
3. `session/new`（`:1398`）；恢复旧会话走 `session/resume` / `session/load`（`:1403`、`:1406`）。
4. `session/prompt` 发指令；等待期间的状态文案在 `:1078` 定义（`'session/prompt': 'while answering'`）。
5. `session/request_permission`：agent 要动东西时向**聊天里的人**征求同意（模块注释 `agents.mjs:6`）。

**关键事实**：`session/request_permission` 只覆盖 agent 通过 ACP 声明的动作；MCP 工具调用是另一条通道，不经过它。

## 3 MCP 注入

### 3.1 注入点

```js
// agents.mjs:1388
mcpServers: [orangefilmMcpServer()],
```

历史对比：`21f73a7`（OrangeFilm 0.1.3）时这里是 `mcpServers: []`；`b9104e6` 起注入。原始 0.1.x 的行为因此**没有**任何 MCP 工具可用。

### 3.2 启动方式

- **绝对 command**：不用 `npm`/`npx`/相对路径，避免 PATH 或 cwd 变化导致启动失败。
- `ELECTRON_RUN_AS_NODE=1`：Electron 自带 Node 作为解释器，不要求用户机器装 Node（同 `agents.mjs:384`、`:861` 的既有做法）。
- 启动失败**不抛**：客户端以 `failOnStartupError`（`orangefilm-mcp.mjs:7` 注释）运行，一个 MCP 服务起不来不应拖垮整个对话。

### 3.3 工具面（7 个）

| 工具 | 类型 | 位置 |
| --- | --- | --- |
| `materials.search` | 读 | `orangefilm-mcp.mjs:38` |
| `materials.take` | 写 | `:55` |
| `wiki.video` | 读 | `:68` |
| `wiki.timeline` | 读 | `:73` |
| `wiki.shot` | 读 | `:78` |
| `timeline.insert_clip` | 写 | `:83` |
| `orangefilm.look` | 读 | `:102` |

dsh 侧工具名会被拼成 `mcp__<server>__<tool>`，所以模型看到的是 `mcp__orangefilm__materials.search` 这类名字（`<server>` 为注入时的服务名）。

## 4 写闸门（我们自己的，不是 ACP 的）

**为什么需要**：MCP 通道不经过 OrangeFilm 的 approve 对话框，agent 拿到的写能力没有第二道人工确认。所以服务端自己判定：

```json
// ~/.orangefilm-dev/mcp-write.json    orangefilm-mcp.mjs:128
{ "version": 1, "allowWrite": true, "projects": ["C:\\work\\a-film", "/home/me/b-film"] }
```

判定规则（`orangefilm-mcp.mjs:126-146`、`:362`）：

1. 文件不存在、无法解析、`version !== 1`、`allowWrite` 不是字面量 `true` → 一律拒绝；
2. 目标项目必须是 `projects` 数组中某一项的**绝对路径**（或其后代）；
3. 拒绝时返回明确 code 与「去哪里授权」的提示字符串，不静默降级；
4. 读工具不受闸门影响——缺文件时读依然可用。

**审计**：写操作落审计日志，**不记录媒体的绝对路径**（只记项目标识与动作），避免日志变成素材位置清单。

## 5 打包与模块定位

```js
// apps/desktop/scripts/packed-editor-modules.mjs:14-18
export const PACKED_EDITOR_MODULES = Object.freeze([
  'packages/orangefilm/src/film-doc.mjs',
  'packages/orangefilm/src/clip-motion.mjs',
  'packages/orangefilm/studio/server/ops.mjs',
]);
export const PACKED_EDITOR_ROOT = 'orangefilm';   // :24
```

复制脚本（`release.mjs:136` 循环）与加载端读同一个常量，避免「打包的路径」和「加载的路径」漂移。

定位三级回退（`orangefilm-mcp.mjs:184-190`）：

1. `ORANGE_EDITOR_MODULES` 环境变量（测试与搬移安装时用）；
2. `<resources>/orangefilm/...`（安装态）；
3. 仓库根（开发态，`dirname(import.meta.url)` 上溯三级）。

第 2 步用**具体文件存在性**（`packages/orangefilm/src/film-doc.mjs`）判定，而不是只看目录存在——空目录不会被误认成有效打包。加载是懒的（`:193-198`），只在某个工具真正需要时才 `import`，保证启动便宜。

## 6 Settings 的账号级边界

原状：`providers` / `local-models` 在没有隔离 profile 时直接 503（`server.mjs:321`、`:324` 的 `account-resource-unavailable`），安装态因此用不了自己的 Key。

现状：改为**账号级 store**，按登录主体分文件：

- 路径 `<studioHome>/services/<companyKey | acct-<sha256(environmentId, subjectId)>>.json`（`services-store.mjs:8`、`:50-51`）；
- 目录 `0o700`（`services-store.mjs:57`），文件 `0600`；
- 无登录态：`assertActive()` 先拦成 403（`server.mjs:318`），`providers`/`local-models` 在无账号时 503（`:433`、`:441`），**且不创建目录或文件**——不留下「半个账号」；
- 有账号：`withAccountServices()` 把请求包进该账号的 store（`:431`、`:443`），仍然不回传任何 Key。

## 7 未验证 / 待定

| 项 | 状态 | 说明 |
| --- | --- | --- |
| dsh 的 approval 机制是否覆盖 MCP 工具调用 | **未验证** | 目前按「不覆盖」设计并自建写闸门；如果 dsh 实际会拦，则闸门是冗余的第二道（可保留但不能当成唯一依据） |
| 应用内 `edit` / `files-bring` 走外部进程直连是否必被拒 | **未验证** | 未构造外部进程直连这些入口的用例 |
| `failOnStartupError` 的确切设置点 | 待核 | 本仓库只有注释引用（`orangefilm-mcp.mjs:7`），设置方在 ACP 客户端依赖内，未在本次核对到行号 |
| `mcpServers` 在不同 agent（Codex / Claude Code / Cursor）下的实际注入效果 | 未验证 | 未逐 agent 实测工具是否出现在各自会话里 |
| 审计日志的保留期与轮转 | 待定 | 只落地了「写操作必记、不含媒体绝对路径」 |
| Windows 之外的项目路径白名单归一化 | 未验证 | `projects` 里给了 POSIX 示例，但大小写/尾随分隔符的匹配规则未测 |
