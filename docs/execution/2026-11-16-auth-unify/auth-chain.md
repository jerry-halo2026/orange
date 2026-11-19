# 登录环境来源链（只读研究，分支 `chore/vendor-0.3.2`）

范围：只读阅读，未修改任何代码、未 commit、未启动应用。唯一新增文件即本文件。
结论层级：运行时行为 > 源码注释。行号取自本次阅读快照。

---

## 0. 一句话结论

登录环境只有 **一条** 进入路径：`ORANGE_AUTH_CONFIG_FILE` → `readDesktopAuthConfiguration` → `createDesktopAuth` 的
`configuration` → `createAuthService`。三个字段（environmentId / authOrigin / publishableKey）来自**一个磁盘文件**；
`instanceId` / `epoch` 由 Studio 进程与 controller 自己生成。UI 里那句「无法安全打开本人工作区，未激活本次登录」
不是环境不匹配的直接提示，而是 `desktop-auth.mjs` 登录后置检查（含 marker / owners / 协调锁）的**兜底码**——
其中 environmentId 变化导致的 marker `domainId` 不匹配是换环境后最常踩的一条。

---

## 1. `configuration` 的完整来源链

### 1.1 链（env/文件 → 构造 → 调用点）

```
进程 env（真实来源）
  ├─ 来源 A 开发启动：scripts/start.mjs:18-20  { ...source }（source = process.env）
  │            + launcherEnvironment(env, PATH)（environment.mjs:460-466，白名单 LAUNCHER_FLAGS:457
  │              其中 'ORANGE_AUTH_CONFIG_FILE' 在列）
  ├─ 来源 B bench：bench/app.mjs:34-51 loadBenchAuth()
  │            读 .dev/bench-auth.env（:21-25）→ :49 主动写 process.env.ORANGE_AUTH_CONFIG_FILE
  │            → launch():138 env = launcherEnvironment(process.env, PATH)
  └─ 来源 C 打包运行：无人设置，只有 main.mjs:659 的「有则透传」：
               ...(process.env.ORANGE_AUTH_CONFIG_FILE ? { ORANGE_AUTH_CONFIG_FILE: ... } : {})

  ↓ Electron main 启动
main.mjs:50-53  isolation（prepareDesktopIsolation / isolationEnvironment）
main.mjs:645-662 childEnvironment({ shell, extra })  ← Studio 子进程环境在这里定稿
      · osEnvironment（environment.mjs:109-119）只放行 OS 身份/区域变量，**不会**顺带带出 ORANGE_*
      · 因此 ORANGE_AUTH_CONFIG_FILE 只能靠 :659 这一行显式传入
      · environment.mjs:472-481 childEnvironment 再叠加 isolationEnvironment(...)

  ↓ studio.mjs fork（studio.mjs:73-78：utilityProcess.fork(ENTRY, { env: {...env, OPENFILM_STUDIO_PORT} })）
Studio 工具进程：studio-process.mjs:70  readDesktopAuthConfiguration(process.env)   ← 全应用唯一读取点
  · desktop-auth.mjs:23  environment.ORANGE_AUTH_CONFIG_FILE
  · :24 必须是绝对路径，否则 null
  · :26 lstat：必须是普通文件、nlink===1、size<=32768
  · :28 键集合必须**恰好** {authOrigin, environmentId, publishableKey}（排序后字符串相等）
  · :29 原样返回 JSON 对象（不 freeze、不校验值）

  ↓ controller 装配
studio-process.mjs:69-73 createDesktopAuth({
    configuration: readDesktopAuthConfiguration(process.env),         // ← 3 字段
    home: studioHomeDir(), sharedHome: originalSharedHome(), projects: originalLibraryRoot(),
    coordinationRoot: join(isolation?.baseRoot ?? studioHomeDir(), '.orange-coordination'),
    instanceId: randomUUID(),                                        // ← 第 4 字段：每个 Studio 进程一次
  })

  ↓ 确切调用点
desktop-auth.mjs:99-105 makeService():
    :100 if (!configuration) return null;
    :102 createAuthService({ ...configuration, instanceId, epoch: ++epoch },   ← 唯一的 createAuthService 调用
             { fetch, monotonicNow, requestTimeoutMs: 10000, onInvalidated: fence })
    :103 catch { return null; }        ← 配置非法被吞成「无配置」
    :105 service = makeService();      ← controller 构造期一次
    :139 / :158 退役、失败后重建（epoch++）
```

`createAuthService` 收到的 5 个字段由 `auth-service.mjs:1` 的 `CONFIG` 常量钉死复刻，校验在 `:82-113`：
`stableId(environmentId)`、`stableId(instanceId)`、`Number.isSafeInteger(epoch)&&epoch>0`、
`authOrigin` 字符串且无空白/反斜杠、`publishableKey` 通过 `header()` 且非特权键（`:31-43`），
最后 `:103-113` 要求 **`https:`**、无 userinfo/query/hash、pathname 为 `/`。

### 1.2 中途的默认值 / 第二处读取 / 跳过校验

| 现象 | 位置 | 说明 |
|---|---|---|
| **默认值（domainId 用）** | desktop-auth.mjs:38 `configuration?.environmentId ?? 'unconfigured'` | 配置缺失时 domainId 仍会算出来（对 `'unconfigured'` 哈希），marker 比较照做 |
| **默认值（超时）** | desktop-auth.mjs:102 `requestTimeoutMs: 10000` | auth-service 允许 1–30000（auth-service.mjs:98-100） |
| **默认值（实例/纪元）** | desktop-auth.mjs:102 `epoch: ++epoch`；studio-process.mjs:72 `instanceId: randomUUID()` | 每次 controller 重建 epoch 自增；每次 Studio 进程重启 instanceId 换新 |
| **第二处 env 读取** | environment.mjs:457（白名单常量，声明式，非运行时读） | 真正断言 `process.env` 的只有 desktop-auth.mjs:23 与 bench/app.mjs:49；auth-environment.mjs:89-97 也在读 env，但**尚未接入启动路径** |
| **「缺失则跳过校验」** | desktop-auth.mjs:100/103/110/140 | 没有「无配置也放行」分支：service 为 null → `getPublicState()` 返回 `signed-out/configuration-required`，`assertActive()` 一律 `deny()`。**但** `:103 catch{return null}` 把「非法配置」和「没有配置」合并成同一状态，且 `readDesktopAuthConfiguration` 对坏 JSON/坏键集合一律 `null`（:30），用户只会看到「尚未配置」，看不到是哪个字段错 |

补充：`environmentId` 还决定 `domainId`（desktop-auth.mjs:38）：

```
domainId = sha256('orange-desktop\0' + (environmentId ?? 'unconfigured')).slice(0,24)
```

即：换环境 = 换 domainId = 磁盘上所有 marker 立刻失效（见 §2）。

---

## 2. 「无法安全打开本人工作区，未激活本次登录」

### 2.1 文本产生点

- 文案：`apps/desktop/shell/Login.tsx:35` — `'project-access-denied': '无法安全打开本人工作区，未激活本次登录。'`
- 显示：`Login.tsx:49` `setError(messages[result.code ?? ''] ?? …)`（提交后失败时）；
  另一处 `Login.tsx:66` 会用 `state.reason` 查同一张表。
- 运输：`Login.tsx:46` `POST /api/auth/sign-in`（同源，由 Studio 提供）
  → `packages/openfilm/studio/server/server.mjs:291` `json(res,200,await desktopAuth.signIn(await readJson(req)))`
  （前置同源校验 `:288-289`，`authorize(req)` `:285` 校验 `x-studio-key`）。

### 2.2 代码产生点

**`apps/desktop/src/desktop-auth.mjs:160`** —— `signIn()` 成功路径的 `catch` 兜底：
`return Object.freeze({ ok:false, code:'project-access-denied', state:getPublicState() })`。

成功路径块 `:143-155` 内任何一步抛错都会归到这个码（`:156-161` 清场）：

| # | 触发点 | 具体条件 |
|---|---|---|
| 1 | `:144` `service.getVerifiedEvidence()` 为 null | 在线两步校验刚过但证据已被并发失效（tick/expired/dispose） |
| 2 | `:145` `loadOwners()`（`:59-71`） | `orange-project-owners.json` 不存在→空数组（不报错）；存在但非普通文件 / nlink≠1 / >1MB / 坏 JSON / `version!==1` / 键集合不符 / 记录字段缺失 / environmentId+projectId 重复 → `deny('project-access-denied')` |
| 3 | `:146` `mkdirSync`（homes、projects 根） | 目录不可写 / 路径不被 `ordinaryControlPath`（project-control-guard.mjs:37-41，祖先不得是符号链接、文件不得多硬链接）接受 |
| 4 | `:147` `guard.acquireControlledReservation({homes, roots, targets:[]})` | 协调根 `coordinationRoot` 上的 registry/meta.lock 被他人占用或残留 |
| 5 | `:148` 再次 `getVerifiedEvidence()` | 期间被 dispose/expired（异步间隙） |
| 6 | `:150-153` `verifyMarker(join(root,'.openfilm-control.json'), true)` → `:50` | **marker 内容与 `expectedMarker()`（`:39-45`）不全等**：`version` / `domainId` / `coordinationId` 任一不同即 `deny('project-access-denied')` |

其中第 6 条是「换环境」的直接后果：

```
expectedMarker() （desktop-auth.mjs:39-45）
  readIsolationProfile() 为空 → { version:1, domainId }
  有 isolation profile        → { version:2, domainId, coordinationId = sha256(baseRoot) }
domainId = f(environmentId)                     ← :38
coordinationId = f(isolation baseRoot)          ← :44
```

所以三类「不匹配」的归属必须分清：

- **domainId 不匹配**（登录环境 environmentId 变了，或首次在另一台/另一 profile 上写过 marker）→ 命中 §2.2 第 6 条，
  产生这句 UI 文案。
- **coordinationId / version 不匹配**（有/无 isolation profile、隔离根变了）→ 同一条第 6 项，同一句文案。
- **epoch / instanceId 变化** → **不产生**这句文案。它们只进入 `createProjectAccessPolicy` 的身份元组
  （project-access.mjs:1-3、:22、:75），在**之后**的 `authorizeProject`（desktop-auth.mjs:134 `policy.decide`）
  失败时以 `project-access-denied` 出现（走 403，不是登录响应）。epoch 由重建 controller 自增（:102），
  instanceId 每个 Studio 进程重生成（studio-process.mjs:72），policy 在 `:154` 用同一份 evidence 新建，故二者
  单独变化**不会**让刚成功的登录失败。
- **token 过期**走另一条：auth-service.mjs:177/396-399 → `expired` → `Login.tsx:34` 的「登录已到期…」文案。

### 2.3 之后客户端做什么

```
desktop-auth.mjs:156-161  catch:
   sealed=true; reservation?.close(); reservation=null;
   service.dispose();            ← auth-service.mjs:503-506 → invalidate('disposed')，session=null（令牌丢弃）
   service=makeService();        ← 全新 service，epoch+1，everActivated=false（可立即重试，不触发 switch-required）
   verified=null; notify(getPublicState())

studio-process.mjs:75-85 onState → send({type:'auth', state, scope:null})
   :84 state.kind!=='active' → studio?.sealAccess()   （Studio 侧访问被封）

main.mjs:523-537 onAuth：
   else 分支（:533-537） materialDraftStore.lock(); saveState(); desktopAuthActive=false;
                        broadcast('desktop:auth', {...next, uiGeneration}); showPage(HOME)

shell/main.tsx:38 native.onAuth → gate.native(next)（auth-generation.ts:45-57：非 active 直接落状态）
shell/main.tsx:61 !active → 渲染 <Login>；Login.tsx:49 保留 setError 文案，表单不清空、不禁用（locked 只由
               configuration-required / preservation-* / disposed 触发，Login.tsx:41）
```

令牌处理结论：**只存在于 auth-service 的闭包 `session`（auth-service.mjs:420）**。全仓无持久化、无 refresh 使用、
无 SDK；`dispose()` 后即不可达。远程会话**未被撤销**（该失败路径不发 `/auth/v1/logout`，只有显式 signOut 才发，
auth-service.mjs:494）。用户**留在登录页**，可以立刻重试；工程文件与 owners 记录均不被改动。

---

## 3. `.dev/auth-runtime.json` vs 本地 Docker：是不是同一结构

**字段结构：是同一个。** 两者都恰好三键：

```
.dev/auth-runtime.json（本机实际内容，键序 authOrigin,environmentId,publishableKey）
  environmentId: 'orange-test-desktop'
  authOrigin   : https://<项目>.supabase.co          ← 托管环境（值不在此抄录）
  publishableKey: <anon JWT>                          ← 同上

auth-environment.mjs:23-27 LOCAL_DOCKER
  environmentId: 'orange-local-docker'
  authOrigin   : 'http://127.0.0.1:54321'
  publishableKey: 'local-anon-key'
```

三键集合与 `desktop-auth.mjs:28` 的严格键集合**完全一致**，也与 `ENVIRONMENT_FIELDS`（auth-environment.mjs:20）一致。
故文件级可直接互换，**差异全在取值层面**：

1. **协议是硬冲突**：`http://127.0.0.1:54321` 会被 `auth-service.mjs:104-113` 判为 `invalid-configuration`
   （必须是 `https:`，且 `pathname==='/'`；测试 `auth-service.test.mjs:21-25` 正钉住 http 被拒）。
   `desktop-auth.mjs:103` 把它吞成 `service=null` → UI 只显示「尚未配置隔离开发环境的登录连接」
   （`Login.tsx:27`）。→ 想用本地 Docker，必须让 authOrigin 是 https（TLS 终结在 54321 前，或 compose 里上 TLS），
   否则不论怎么切文件都不会成功。
2. **environmentId 变了 = domainId 变了**（desktop-auth.mjs:38）→ 现存 `.film/control.json`、
   `.openfilm-control.json`、`orange-project-owners.json`（:123 按 `environmentId+projectId+subjectId` 匹配）全部失效，
   登录会落到 §2.2 第 6 条。切换必须附带迁移/清理，而不是期望自动重建（`verifyMarker` 只在 `existsSync` 为假时
   `wx` 新建，:48；内容不符一律拒绝，:50）。
3. **凭据来源不同**：`.dev/bench-auth.env` 里的 `ORANGE_BENCH_EMAIL/PASSWORD` 必须换成该环境的账号
   （bench/app.mjs:44-48；缺一即 bench 跳过，:58-68）。
4. `readDesktopAuthConfiguration` 不接受内联 JSON：`ORANGE_AUTH_ENV`（auth-environment.mjs:97-110）目前**不被**
   desktop-auth 认（desktop-auth.mjs:23 只读文件路径）。

**切换要改的地方（按依赖序）**
`auth-environment.mjs:23-27`（LOCAL_DOCKER.authOrigin 用 https）→ `.dev/auth-runtime.json` 三键取值 →
`.dev/bench-auth.env` 的 `ORANGE_AUTH_CONFIG_FILE` 指向与账号 → 一次性清理/迁移 marker + owners（`home`、
`sharedHome`、`projects` 根、每个项目 `.film/control.json`）→ 重签。
另注：本仓 `chore/vendor-0.3.2` 工作区里 `auth-environment.mjs` / `auth-environment.test.mjs` 为未跟踪新文件
（`git status` 显示 `??`），尚未接入任何启动路径（grep 全仓只有它自己的测试引用）。

---

## 4. 发行包有没有把环境写进 `resources/`

**没有。**

- `scripts/release.mjs:300-304` `extraResources` 只有三项：`runtime`（ffmpeg/浏览器，:229-237）、
  `fission`（:243）、`PACKED_EDITOR_ROOT`（:249-254）。**没有** `auth-environment.json`，也没有任何
  environmentId/authOrigin/publishableKey 文件。
- `files`（:297）只含 `src/**`、`shell/dist/**`、`apps/api/**`、`package.json`、`node_modules/**`。
- `apps/desktop/package.json` 完全没有 `build`/`extraResources` 配置（electron-builder 配置内联在
  release.mjs:261-333），所以「发行包里的环境」当前**只在 stage 之外的代码里**，即：安装后
  `process.env.ORANGE_AUTH_CONFIG_FILE` 无人设置（`main.mjs:659` 有则透传），
  `studio-process.mjs:70` 得到 null → 装机版永久停在 `configuration-required`。
- `--dir` 自检 `release.mjs:355-366` 只校验 fission/ffmpeg，故缺 auth 描述不会被发现。

**`resolveEnvironment({resourcesDir})` 该接在哪一行**

唯一合适接点是 **`apps/desktop/src/main.mjs:645-662` 的 `childEnvironment(...)` 组装处**，具体替换
`:659` 那一行「有则透传」：

```
（建议）main.mjs ~:643 之前
  import { resolveEnvironment } from 'openfilm/auth-environment'    // 或 '../../packages/openfilm/src/auth-environment.mjs'
  const authEnvironment = resolveEnvironment({
    resourcesDir: app.isPackaged ? process.resourcesPath : undefined,
    requireDescription: app.isPackaged,      // 装机缺描述 = 安装包问题，早失败（auth-environment.mjs:124-130）
  });
  const authConfigFile = writeAuthRuntimeFile(DATA, authEnvironment);  // 只写 3 字段，0600，路径 join(DATA,'auth-runtime.json')

main.mjs:659 改为
  ...(authConfigFile ? { ORANGE_AUTH_CONFIG_FILE: authConfigFile } : {})
```

选择这条的理由：`desktop-auth.mjs:21-31` 只认**文件路径**，且要求键集合恰好三键；`resolveEnvironment` 的返回值带
`source`/`local`（auth-environment.mjs:122/131），**整体传进 `configuration` 会因多键被 `snapshot()` 拒绝
（auth-service.mjs:21 + 测试 :84-123）**，所以必须先做「只取三字段」的物化。写文件也满足
`ordinaryControlPath`（project-control-guard.mjs:37-41）：DATA 下普通文件、nlink=1 即可（注意：若 userData 目录
本身在符号链接下，:39 会拒绝，需要在部署侧确认）。

配套（同一处改动范围内）：
- `scripts/release.mjs:300-304` 增一条 `{ from: <提交进仓库的 auth-environment.json>, to: '.' }`；
  `:355-366` 的 `wanted` 加 `join(resources,'auth-environment.json')`，让缺描述在 `--dir` 时直接失败。
- `packages/openfilm/package.json` 的 `exports` 目前导出 `./studio*`、`studio/server/**` 等，未见
  `./auth-environment`；要么加一条 export，要么按相对路径 import（native-first：优先在包内加 export）。
- `environment.mjs:457` LAUNCHER_FLAGS 已有 `ORANGE_AUTH_CONFIG_FILE`，开发路径无需改动。

---

## 5. 现有测试钉住了什么 / 不能破的红线

### 5.1 `apps/desktop/src/auth-service.test.mjs`（1008 行，26 组）

| 组 | 钉住的行为 |
|---|---|
| 01-04 | 工厂存在；`http://` origin 在**任何传输之前**被拒（:21-25）；config/deps 的 snapshot 语义（访问器不触发、Proxy ownKeys 抛错、未知字段、`instanceId:''`、`epoch:0`/`1.5`、8193 长 key、`sb_secret_`/`service_role` 拒绝）；证据形状必须是 `{environmentId,subjectId,instanceId,epoch,establishedAtMs,expiresAtMs}` 且 frozen；端点固定 `/auth/v1/token?grant_type=password` 与 `/auth/v1/user`；证据可直接喂 `createProjectAccessPolicy` 并放行 |
| 05-07 | 输入 own-data-only、密码不 coerc、body 与输入逐字节一致；响应侧 64KB/JSON content-type/redirect/`token_type`/`expires_in`/subject 形状；`is_anonymous` 必须显式 `false`；`factors` 只允许 `unverified`；`invalid_credentials`→`authentication-rejected`，其余 4xx→`verification-unconfirmed` |
| 08-09 | 有效期从**交换开始**的单调时钟算（忽略 `expires_at`）；超时=可配置上限（5ms 用例）；忽略 abort 的 fetch/挂起流都不得拖住 |
| 10-12 | 单飞、generation 栅栏、dispose 后迟到响应不得复活；时钟非有限/回退/重入 → `clock-anomaly` 且**粘滞**；恶意 Proxy 重入不得越过 disposal |
| 13-14 | revalidate「未知失败保留有限旧权、已知失败即撤销」；撤销后 `not-active`、再登录 `switch-required`；signOut 同步失效、幂等、终态（disposed）不可复活 |
| 15-16 | 公开输出不得含 token/refresh/key/email/password/origin/subject/上游 prose（:769-800）；`onInvalidated` 可选、own-data、可被快照 |
| 17-26 | 401/403 必须**先**退役证据再 abort/cancel body（hook→abort→body 顺序）；四种失效动作同步清证据并只通知一次；回调抛错/拒绝/thenable 不得逃逸；嵌套 dispose/signOut 不得递归通知；native promise 只挂防御性 rejection sink |

### 5.2 `apps/desktop/src/desktop-auth.test.mjs`（194 行）

- `createDesktopAuth({configuration,home,sharedHome,projects,coordinationRoot,instanceId}, deps)` 签名与
  `configuration:null → reason==='configuration-required'`、`readDesktopAuthConfiguration({})===null`、
  合法文件原样返回（:50-61）。
- 公开状态无密钥/URL/subject（:46）。
- owners 记录 schema `{version:1,projects:[{environmentId,projectId,root,subjectId}]}` 与「另一 subject 不能打开」（:63-79）。
- 登出同步封禁、进行中操作等待退役、期间登录 `preservation-pending`（:81-90）。
- 退役失败 → `preservation-failed` 粘滞；过期 → `assertActive` 抛 `authentication-required`（:92-101）。
- Login 组件契约：`configuration-required` 状态必须渲染「配置」且输入 `disabled`（:103-115）。
- main.mjs 的 `saveState`/`onAuthRetire` **按源码字节抽取执行**（:137-175）：retirement 必须先严格保存再销毁视图；
  失败一律 `return false`，不得销毁。
- `onRetired` 必须在真实操作与 guard 释放之后（:177-186）；协调锁被占时不得报退役成功（:188-193）。

### 5.3 `apps/desktop/bench/auth-gate.test.mjs`（70 行）

- 未登录 & 密码错一格时 `/api/open` 恒 403 `authentication-required`（:44-55）；
- `/api/auth/sign-in` 必须同源（带 `origin`）且带 `x-studio-key`（:35-42，对应 server.mjs:285-289）；
- `/api/auth/state` 成功后 `kind==='active'`（:57-60）。

### 5.4 红线清单（改这条链时不能碰）

1. **https-only**：不得为本地 Docker 放宽 `auth-service.mjs:103-113`（破 test 02/03）。
2. **config 只认三键**：`resolveEnvironment` 的 `source`/`local` 不得进入 `configuration`（破 `snapshot` 与 test 03）。
3. **publishableKey 必须是公开键**：`sb_secret_`/`service_role` 一律拒（auth-service.mjs:31-43）。
4. **marker 不可自动重建**：`verifyMarker` 的内容不符必须拒绝，不得为了「换环境能登」改成 create/覆盖
   （desktop-auth.mjs:48-51；这条是 `project-access-denied` 文案的唯一正当来源）。
5. **公开状态与错误码不得带 origin/key/subject**（test 15、desktop-auth test :46）：新增诊断只能给 code + 字段名。
6. **`/api/auth/*` 的同源 + `x-studio-key` 门**不变（server.mjs:285-289，auth-gate 测试）。
7. **退役次序**：先严格保存、再关视图、再 `onRetired`；失败即 `preservation-failed` 且不得销毁（desktop-auth test :137-193）。
8. **`configuration-required` 的 UI 语义**（禁用输入 + 含「配置」）保留（desktop-auth test :113-114），
   只是文案/来源可改为 resolver 的结构化错误。
9. **单调时钟与「未知失败保留旧权」语义**不动（test 08/13/19）：不要把本地 Docker 的健康探测塞进 revalidate 路径。

---

## 6. 调用链图（文字式）

```
[env]  ORANGE_AUTH_CONFIG_FILE ────────────────┐
         │ start.mjs:20 / bench/app.mjs:49      │  (打包版: 无人设置)
         ▼                                      │
[main]  main.mjs:645-662 childEnvironment(extra:659 透传)
         ▼ studio.mjs:73-78 utilityProcess.fork(env)
[studio]studio-process.mjs:70 readDesktopAuthConfiguration(process.env)   ← 唯一读取点（:21-31 校验形状）
         ▼ studio-process.mjs:69-73 createDesktopAuth({configuration, instanceId:randomUUID(), ...})
         ▼ desktop-auth.mjs:99-105 makeService → :102 createAuthService({...cfg, instanceId, epoch:++epoch}, deps)
                 │ (auth-service.mjs:82-113 五字段 + https 校验；失败→:103 catch→service=null→configuration-required)
                 ▼
[render] Login.tsx:46 POST /api/auth/sign-in
         ▼ server.mjs:288-291（同源 + key）desktopAuth.signIn
         ▼ desktop-auth.mjs:137-162
               service.signIn → auth-service.mjs:363-432
                    :387 POST /auth/v1/token?grant_type=password   (headers: apikey=publishableKey)
                    :400 GET  /auth/v1/user                        (Bearer access_token)
                    :412-420 verified evidence{environmentId, subjectId, instanceId, epoch, t0, deadline}
               ▼ 成功后的「工作区准入」（失败一律 :160 project-access-denied）
                    :145 loadOwners(orange-project-owners.json)
                    :146 mkdir(home, sharedHome, projects)
                    :147 guard.acquireControlledReservation(coordinationRoot)
                    :150-153 verifyMarker(.openfilm-control.json) ← domainId(=f(environmentId))/coordinationId
                    :154 verified=evidence; policy=createProjectAccessPolicy(evidence); sealed=false
               ▼
         studio-process.mjs:75-85 onState → main.mjs:523-537 onAuth（active: desktopAuthActive=true / 否则回 HOME）
         ▼ shell main.tsx:38/61 → Login 或 Studio
```

---

## 7. 供 Lead 参考的「最小改动点」（≤8，按依赖序）

1. 定标：决定 `.dev/auth-runtime.json` 与 `resources/auth-environment.json` 共用三键 schema（已一致），并把
   `LOCAL_DOCKER.authOrigin` 定为 **https**（auth-environment.mjs:23-27），否则本地栈永远进不了 `createAuthService`。
2. 在 `packages/openfilm/package.json` 增 `./auth-environment` export，使 desktop 可从包内导入（native-first）。
3. `main.mjs:643` 前后调用 `resolveEnvironment({resourcesDir: app.isPackaged && process.resourcesPath,
   requireDescription: app.isPackaged})`，物化成 `join(DATA,'auth-runtime.json')`（只写三键、0600）。
4. `main.mjs:659` 改为传该物化路径（保留显式 env 优先）；`studio-process.mjs:70` 不动。
5. `scripts/release.mjs:300-304` 增 `auth-environment.json` 到 `extraResources`；`:355-366` 的 `--dir` 校验加同一文件。
6. 换环境时的迁移工具/步骤：清理或迁移 `.openfilm-control.json`、`.film/control.json`、
   `orange-project-owners.json`（不得修改 `verifyMarker` 的严格比较）。
7. 诊断：把 `AuthEnvironmentError`（code + `missing`）写进启动日志，并给 `configuration-required` 一个可区分的
   reason（不带 origin/key），`Login.tsx:27` 按 code 分支。
8. 测试：新增「main 装配 → 写到 DATA → Studio env 收到路径」的集成用例；既有 auth-service / desktop-auth /
   auth-gate 断言一条不改。
