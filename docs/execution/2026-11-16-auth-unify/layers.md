# 两层鉴权的来源、失败指针与合并代价（只读研究，分支 `chore/vendor-0.3.2`）

范围与约束：只读阅读 + 只读运行态查询（`GET /api/health`、`GET /api/auth/state`），未改任何代码、未 commit、未启动应用。
唯一新增文件即本文件。行号取自当前 `HEAD`（工作区该文件与 HEAD 一致，`git status` 仅三个 untracked 项）。
配套前置阅读：本目录 `auth-chain.md`（configuration 来源链）、`dev-up.md`（环境启动）。本文只答 Q1–Q3。

---

## 0. 三句话结论

- **Q1**：`desktop-auth.mjs` 整层（`.openfilm-control.json` + `verifyMarker` + `coordination` 协调锁 + `policy.decide`）
  **全部是我们自己的**（`5e6dd2b` / `b56fcdc` / `b8e7a69` / `e2c295b`，全部 2026-11-10）。`upstream-v0.3.2` 与基线 `8b8ef16`
  里**不存在**该文件，也不存在任何 auth 命名的文件；vendor drop 的 `overlay/new-files.txt` 明确把它们列为"新增文件"。
  上游原生只贡献了两个**底座**：`locations.mjs` 的路径解析、`projects.mjs` 的工程读写；连 `projects.mjs` 里我们调用的
  `withProjectAuthority` / `withProjectControlGuard` 也是我们加的（上游 551 行，我们 838 行）。
- **Q2**：`homes` = `[studioHomeDir(), sharedHome()]`，`roots[1]` = `libraryRoot()`，`domainId` = f(`environmentId`，来自
  `ORANGE_AUTH_CONFIG_FILE`)，`coordinationId` = f(isolation `baseRoot`，来自 `.dev/orange-test-control-policy.json` 的
  `baseRoot` + `OPENFILM_ISOLATION_*` 环境)。**这是两个互不相关的指针**。本机磁盘上现存封印值彼此一致
  （`version:1` + `domainId:925b9a04e594f9f181e08dba` = `sha256('orange-desktop\0orange-test-desktop')[:24]`，本机复算一致），
  所以**不是 marker 在拒**；真正导致"登录成功但工程打不开/列表空"的是**第 4 个持久化件 `orange-project-owners.json` 已被
  改名移走（`*.bak-20261116`），全机 0 条 owner 记录**。
- **Q3**：封印层有 8 个真实依赖方（Studio 全 API 门、pages 页授权、saved 作用域、services 作用域、fission 任务 owner、
  CLI 原生读、media 素材守卫、跨进程单写锁）。**推荐 (a) 单指针化**（小改：`desktop-auth.mjs` 两处派生 + 一次迁移；
  不动红线），**(b) 全删**要先补一件东西——`withSourceAuthorization` 目前**没有任何安装点**（死代码），media 素材守卫
  今天完全靠 marker 文件存在与否，删封印=静默放开素材读。

---

## Q1 两层鉴权是不是上游原生

### 1.1 三处版本：文件级比对（结论：上游根本没有这个文件）

```
$ git show upstream-v0.3.2:apps/desktop/src/desktop-auth.mjs
fatal: path 'apps/desktop/src/desktop-auth.mjs' exists on disk, but not in 'upstream-v0.3.2'

$ git show 8b8ef162708033dd3ed06c81dc0afffc95e8b950:apps/desktop/src/desktop-auth.mjs
fatal: path 'apps/desktop/src/desktop-auth.mjs' exists on disk, but not in '8b8ef162708033dd3ed06c81dc0afffc95e8b950'

$ git ls-tree -r --name-only upstream-v0.3.2 | grep -ci auth   → 0
$ git ls-tree -r --name-only 8b8ef16 | grep -ci auth          → 0
```

`auth-service.mjs` 同样不存在（`readDesktopAuthConfiguration` 在 `desktop-auth.mjs:21-31`，`createAuthService` 在
`auth-service.mjs:79`，两者都只在本分支出现）。

逐件存在性矩阵（`git cat-file -e <ref>:<path>`）：

| 文件 | `upstream-v0.3.2` | 基线 `8b8ef16`(v0.3.0) | `HEAD` |
|---|---|---|---|
| `apps/desktop/src/desktop-auth.mjs` | 无 | 无 | 有（205 行） |
| `apps/desktop/src/auth-service.mjs` | 无 | 无 | 有（516 行） |
| `packages/openfilm/studio/server/project-access.mjs` | 无 | 无 | 有（171 行） |
| `packages/openfilm/studio/server/project-control-guard.mjs` | 无 | 无 | 有（218 行） |
| `packages/openfilm/studio/server/isolation-control-policy.mjs` | 无 | 无 | 有（21 行） |
| `packages/openfilm/src/development-isolation.mjs` | 无 | 无 | 有（174 行） |
| `packages/openfilm/studio/server/projects.mjs` | 有（551 行） | 有 | 有（838 行，已改造） |
| `packages/openfilm/src/locations.mjs` | 有 | 有 | 有（+16/-7，已改造：见 1.4） |

### 1.2 vendor overlay 自证：这些文件是"新增"，不是上游带来的

`overlay/base.json`：

```json
{
  "schema": 1,
  "upstreamTag": "upstream-v0.3.2",
  "upstreamCommit": "e01b37f973aa25f6a0178da74f19e81aeca7d255",
  "productRef": "144be1cfaa94879d5714e33406014544ca661f23",
  "note": "Overlay cut at 7713d38 (v0.3.0). merge-base(HEAD, upstreamTag) is 3eacfd6, older than v0.3.0,
           so the drop is rebuilt as upstream whole tree + new-files.txt + patches/*.patch instead of a merge."
}
```

即：**vendor = 上游整棵树 + `new-files.txt` 里的新文件 + `patches/*.patch`**。`overlay/new-files.txt` 中与鉴权相关的行
（原文逐行）：

```
apps/desktop/src/auth-service.mjs
apps/desktop/src/desktop-auth.mjs
apps/desktop/src/isolation.mjs
packages/openfilm/src/development-isolation.mjs
packages/openfilm/studio/server/isolation-control-policy.mjs
packages/openfilm/studio/server/project-access.mjs
packages/openfilm/studio/server/project-control-guard.mjs
packages/openfilm/studio/server/desktop-auth-entry.test.mjs
packages/openfilm/bin/openfilm-auth.test.mjs
packages/openfilm/studio/server/projects-control.test.mjs
packages/openfilm/studio/server/projects-isolation.test.mjs
packages/openfilm/studio/server/server-isolation.test.mjs
packages/openfilm/studio/server/exports-isolation.test.mjs
packages/openfilm/studio/server/providers-isolation.test.mjs
```

`patches/studio.patch` 里也有 `openfilm-control` 2 处，`patches/openfilm.patch:755/:838/:846` 有我们加的
`assertSourceAccess` 调用与定义（见 Q3）。**没有任何一处是我们从上游继承的。**

### 1.3 逐条：封印四件套是谁写的

| 封印组件 | 首个出现的提交 | 首次出现时的形态 | 判定 |
|---|---|---|---|
| `sealed` 闸门（`:53` `sealed=true`，`:115` `assertActive` 检查） | `5e6dd2b` 2026-11-10 19:36 `wip: preserve incomplete login integration, coordination blocked` | 行 38 `...,sealed=true,...`；行 95 `if(sealed||state.kind!=='active'||!verified)throw deny()` | **我们** |
| `.openfilm-control.json` 写入/校验 | `5e6dd2b` | 行 130-132：`const marker=...join(root,'.openfilm-control.json'); if(existsSync(marker)){...value.version!==1||value.domainId!==domainId...}else writeFileSync(marker,...,{flag:'wx',mode:0o600})` | **我们** |
| `domainId` | `5e6dd2b` | 行 36 `createHash('sha256').update('orange-desktop\0'+(configuration?.environmentId??'unconfigured')).digest('hex').slice(0,24)` | **我们** |
| `verifyMarker()` + `expectedMarker()` + `version:2/coordinationId` | `e2c295b` 2026-11-10 19:52 `wip: constrain isolated coordination to fixed test root` | diff 新增 13 行，见下 | **我们** |
| `coordination` 锁（`project-control-guard.mjs`，`meta.lock`/`registry.json`） | `b8e7a69` 2026-11-10 19:30 `feat: fence native project access and drain shutdown` | 新文件 | **我们** |
| `policy.decide`（`createProjectAccessPolicy`） | `b56fcdc` 2026-11-10 19:30 `feat: add trusted login and project access policies` | 新文件 `project-access.mjs` | **我们** |
| `isolatedControlPolicy`（协调根与 `baseRoot` 绑定） | `e2c295b` | 新文件 `isolation-control-policy.mjs` | **我们** |
| `development-isolation.mjs`（`readIsolationProfile`） | `ee704c8` 2026-11-10 19:17 `feat: add native isolated desktop profile` | 新文件 | **我们** |

`e2c295b` 引入 `verifyMarker` 的原始 diff（`git show e2c295b -- apps/desktop/src/desktop-auth.mjs`）：

```diff
+  function expectedMarker() {
+    const profile=readIsolationProfile();
+    if(!profile)return {version:1,domainId};
+    const trusted=isolatedControlPolicy(profile);
+    const root=process.platform==='win32'?trusted.baseRoot.toLowerCase():trusted.baseRoot;
+    return {version:2,domainId,coordinationId:createHash('sha256').update(root).digest('hex')};
+  }
+  function verifyMarker(path,create=false) {
+    ordinaryControlPath(path);const expected=expectedMarker();
+    if(!existsSync(path)&&create)writeFileSync(path,JSON.stringify(expected)+'\n',{flag:'wx',mode:0o600});
+    const value=JSON.parse(readFileSync(path,'utf8'));
+    if(!value||Object.keys(value).sort().join()!==Object.keys(expected).sort().join()||Object.keys(expected).some(k=>value[k]!==expected[k]))throw deny('project-access-denied');
+  }
@@ projectRecord
+    if(readIsolationProfile())verifyMarker(join(root,'.film','control.json'));
```

注意这段同时把 marker 分成**两个域**：`.openfilm-control.json`（目录域：home/sharedHome/projects 根）与
`.film/control.json`（工程域：每个工程内）。两个域用同一套 `expectedMarker()` 比较。

### 1.4 上游原生只提供的"底座"（不是封印）

```js
// apps/desktop/src/desktop-auth.mjs:9-14 —— 全部从 bundled openfilm/studio 解析，即 packages/openfilm/...
const nativeServer=pathToFileURL(createRequire(import.meta.url).resolve('openfilm/studio'));
const {createProjectAccessPolicy}=await import(new URL('./project-access.mjs',nativeServer));        // 我们
const {createProjectControlGuard,ordinaryControlPath}=await import(new URL('./project-control-guard.mjs',nativeServer)); // 我们
const {withProjectAuthority,withProjectControlGuard}=await import(new URL('./projects.mjs',nativeServer));  // 混合
const {isolatedControlPolicy}=await import(new URL('./isolation-control-policy.mjs',nativeServer));   // 我们
const {readIsolationProfile}=await import(new URL('../../src/development-isolation.mjs',nativeServer)); // 我们
```

- `openfilm/studio` 实际解析到 `D:\dev\orange\packages\openfilm\studio\server\server.mjs`（junction
  `apps/desktop/node_modules/openfilm -> D:\dev\orange\packages\openfilm`），所以**这些"native"文件全是我们仓库里的副本**，
  不存在"从上游包里拿到封印"的可能。
- 上游 `projects.mjs`（`git show upstream-v0.3.2:...projects.mjs | grep 'export function'`）导出
  `openProject / createProject / listProjects / listFolders / projectById / markOpened / locateProject / renameProject /
  deleteProject / forgetProject / moveLibrary …`，**没有** `withProjectAuthority`、`withProjectControlGuard`、
  `homeResources`、`.openfilm-control.json`（`grep -c withProjectAuthority` → 0）。
  我们新增的是 `projects.mjs:58 export function withProjectAuthority`、`:694 export function withProjectControlGuard`、
  `:702 homeResources`、`:844-847` 的 marker 遍历。
- 上游 `locations.mjs` 的 `studioHomeDir()`(:22) / `sharedHome()`(:28) / `libraryRoot()`(:94) 是原生的**兜底**逻辑，
  但**我们也改过**（`git diff --stat upstream-v0.3.2 HEAD -- packages/openfilm/src/locations.mjs` → `+16 -7`）：
  每个访问器被包进 `isolatedLocation(key, fallback)`（`:21`）→ 先 `readIsolationProfile()`，有 profile 就
  `assertIsolationPath(p, p.paths[key], key)`。**这一点很关键**：isolation profile 被注入到"路径解析"层，
  所以 `home/sharedHome/projects` 的值会随 `OPENFILM_ISOLATION_*` 开关整体切换 —— 这正是 Q2 里
  `homes/roots` 与 `coordinationId` 被同一开关一起牵动的原因。
- 上游 `.film/` 只有 `id / settings / history / chat / logs / cache`，**没有** `control.json`：
  `git show upstream-v0.3.2:packages/openfilm/studio/server/projects.mjs | grep '\.film'` 的注释列表里无 control 项，
  `git grep -c 'control.json' upstream-v0.3.2` → 无匹配。

**Q1 判定：`desktop-auth.mjs` 的封印层 100% 是我们的 vendor 改造，不是上游原生。** 上游 v0.3.2 的"登录"是另一件东西：
`packages/openfilm/studio/server/sign-in.mjs`（PKCE 打开供应商网页换 provider key）+ `account.mjs`（校验 key 可用），
与工程访问控制、`.openfilm-control.json`、协调锁**没有任何关系**；`auth-service.mjs` 的 Supabase 令牌链也是我们新写的。

---

## Q2 失败的真正指针

### 2.1 `homes` / `roots` 的解析链（函数名 + file:line）

```
studio-process.mjs:69-72
  createDesktopAuth({
    configuration: readDesktopAuthConfiguration(process.env),          // :70 → desktop-auth.mjs:21-31
    home:      studioHomeDir(),                                        // :71
    sharedHome:originalSharedHome(),                                   // :71
    projects:  originalLibraryRoot(),                                   // :71
    coordinationRoot: join(isolation?.baseRoot ?? studioHomeDir(), '.orange-coordination'),  // :72
    instanceId: randomUUID(),                                          // :72
  })
        ↑ :68 从 native 包导入：{libraryRoot, sharedHome, studioHomeDir} = await import(join(nativeRoot,'src','locations.mjs'))

locations.mjs:22  studioHomeDir() = OPENFILM_HOME || ~/.openfilm            （isolation 时用 profile.paths.home）
locations.mjs:28  sharedHome()    = OPENFILM_SHARED_HOME || studioHomeDir()
locations.mjs:94  libraryRoot()   = chosenFolder('projectsFolder') ?? libraryDefault()
locations.mjs:77-82 chosenFolder('projectsFolder') ← sharedHome()/prefs.json 的 projectsFolder
locations.mjs:54-55 libraryDefault() = OPENFILM_LIBRARY || ~/Videos/OpenFilm/Projects（win）

main.mjs:648  childEnvironment(extra) 里下发
  OPENFILM_HOME: IDENTITY.studioHome ?? process.env.OPENFILM_HOME ?? join(home,'.openfilm')
  ...(IDENTITY.sharedHome ? { OPENFILM_SHARED_HOME: IDENTITY.sharedHome } : {})
flavor.mjs:30-33  dev 风味：studioHome = ~/.openfilm-dev，sharedHome = ~/.openfilm
```

`desktop-auth.mjs` 内部如何组合：

```js
36:  const roots=[resolve(home),resolve(projects)];                 // roots[0]=home, roots[1]=projects（库根）
37:  const homes=[...new Set([resolve(home),resolve(sharedHome)])]; // 去重后的两个 home
147: reservation=await guard.acquireControlledReservation({homes,roots:[roots[1]],targets:[]});
150-153: for(const root of [...homes,roots[1]]) verifyMarker(ordinaryControlPath(join(root,'.openfilm-control.json')),true);
```

**本机实际取值**（`GET /api/health` 返回 `home:"a43f6a6c…2eb44d"`，与 `sha256('C:\\Users\\Administrator\\.openfilm-dev')`
逐字符相符 → 运行中的 Studio 就是 dev 风味）：

| 变量 | 值 |
|---|---|
| `home`（`roots[0]`） | `C:\Users\Administrator\.openfilm-dev`（`OPENFILM_HOME` 由 flavor dev 下发） |
| `sharedHome`（`homes[1]`） | `C:\Users\Administrator\.openfilm` |
| `projects`（`roots[1]`） | `C:\Users\Administrator\Videos\OpenFilm\Projects`（`prefs.json` 无 `projectsFolder` → `libraryDefault()`） |
| `coordinationRoot` | `C:\Users\Administrator\.openfilm-dev\.orange-coordination`（非隔离 → `studioHomeDir()`；隔离时 = `isolation.baseRoot`） |
| `domainId` | `sha256('orange-desktop\0'+environmentId)[:24]`，`environmentId` 取自 `.dev/auth-runtime.json` = `orange-test-desktop` → `925b9a04e594f9f181e08dba`（**本机复算一致**） |
| `coordinationId` | `sha256(fold(isolation.baseRoot))`；非隔离时**不存在该键**（`version:1`）；隔离时 `.dev/orange-test-control-policy.json` 的 `baseRoot=E:\CodexData\cli-chain-20261112` → `7e088fbe…4437c6`（与 `E:\CodexData` 下 24 个 v2 marker 逐个一致） |

### 2.2 `.openfilm-control.json` 的内容结构与写入者

```json
{"version":1,"domainId":"925b9a04e594f9f181e08dba"}
```
```json
{"version":2,"domainId":"925b9a04e594f9f181e08dba","coordinationId":"7e088fbed77253a61b88758ceb1e534cb38b7c3d198088df3d767b76624437c6"}
```

- 字段域：`version`（1|2，整数）、`domainId`（24 hex）、`coordinationId`（64 hex，仅 v2）。**没有**工程 id、没有 subject、
  没有 environmentId 明文——即 marker 只表达"这把封印属于哪个域"，不表达"谁"。
- 结构校验还有第二份，独立于 `verifyMarker`：`project-control-guard.mjs:47-52`
  `if(value?.version===2){plain(value,['version','domainId','coordinationId']); /^[a-f0-9]{64}$/...} else {plain(value,['version','domainId']); if(value.version!==1) throw}`。
- 唯一写入者：`desktop-auth.mjs:48`（目录域）与 `:181-182`（工程域），都是
  `writeFileSync(path, JSON.stringify(expected)+'\n', {flag:'wx', mode:0o600})` —— **`wx` 只能新建，永不覆盖**。
  因此一次不匹配就永久不匹配，只能人工删除/改名（本机 11-16 的 `*.bak-20261116` 就是这个动作的痕迹）。
  其它代码只读不写：`project-control-guard.mjs:61/64/73`（祖先遍历）、`projects.mjs:844-847`（打开工程时的 `home`+`root` 双 marker）、
  `media-links.mjs:166`（素材读守卫）、`bin/openfilm.mjs:405-414`（CLI 原生读守卫）。

### 2.3 `verifyMarker(marker, true)` 到底比对了什么（逐字段）

```js
46: function verifyMarker(path,create=false) {
47:   ordinaryControlPath(path);const expected=expectedMarker();
48:   if(!existsSync(path)&&create)writeFileSync(path,JSON.stringify(expected)+'\n',{flag:'wx',mode:0o600});
49:   const value=JSON.parse(readFileSync(path,'utf8'));
50:   if(!value||Object.keys(value).sort().join()!==Object.keys(expected).sort().join()||Object.keys(expected).some(k=>value[k]!==expected[k]))throw deny('project-access-denied');
51: }
```

逐项：

1. `ordinaryControlPath(path)`（`project-control-guard.mjs:37-41`）：绝对路径；**每一级祖先**不得是符号链接/junction；
   若是文件则 `nlink` 必须为 1。→ 失败抛 `control-invalid`（`status:403`）。
2. `existsSync(path) && create` → 不存在就写入期望值（`wx`,0600）。
3. **键集合必须完全相等**（排序后字符串比较）：v1 `{version,domainId}` vs v2 `{version,domainId,coordinationId}`
   → **多一个键或少一个键都拒**。这是 v1↔v2 切换即全盘失效的机制。
4. **每个期望键的严格 `!==` 比较**（不做类型转换、不看额外语义）：`version`、`domainId`、`coordinationId` 三选一不等即拒。
5. `JSON.parse` 失败（空文件/损坏/`create=false` 时文件不存在）不被兜住 → 在 `signIn` 里被 `catch` 转成
   `code:'project-access-denied'`（`:156-161`），在 `projectRecord` 里直接抛 → `ownsProject` 返回 false（`:174`）。
6. `create` 语义：登录时 `:152 verifyMarker(marker,true)`、`:182`（新建工程）→ 允许**新建**；打开已存在工程时
   `:122 verifyMarker(join(root,'.film','control.json'))`（**无 create**）→ 工程没有 `.film/control.json` 就永不放行。
   注意 `:122` 外面还套了 `if(readIsolationProfile())`，**非隔离模式下工程级 marker 完全不检查**。

### 2.4 本机三个路径的 auth 相关文件（文件名+大小+时间，未读内容）

`C:\Users\Administrator\.openfilm`（= `sharedHome`）：

```
-a---- 52  2026/11/12 22:51:59  .openfilm-control.json.bak-20261116     ← 原 v1 marker，已改名（封印缺位）
-a---- 48  2026/11/07 12:23:54  key
-a---- 182 2026/11/16 09:56:08  prefs.json
-a---- 354 2026/11/16 10:43:19  studio.json
-a---- 45  2026/11/16 10:43:16  update.json
       （无 orange-project-owners.json）
```

`C:\Users\Administrator\.openfilm-dev`（= `home`）：

```
d-----        2026/11/16 14:16:20  .orange-coordination\            （内含 registry.json 323B @2026/11/13 10:32:32）
d-----        2026/11/13 09:12:04  material-cache\
d-----        2026/11/13 00:47:34  orange-accounts\
-a---- 52  2026/11/12 22:51:59  .openfilm-control.json.bak-20261116      ← v1 marker，已改名（封印缺位）
-a---- 225 2026/11/13 00:47:34  orange-project-owners.json.bak-20261116  ← owner 登记表，已改名（0 条记录）
-a---- 235 2026/11/13 00:18:48  orange-saved-owners.json.bak-20261116
-a---- 182 2026/11/12 22:52:02  prefs.json
-a---- 141 2026/11/16 14:18:56  run.json                              （pid 40784, origin 127.0.0.1:4757）
-a---- 45  2026/11/12 22:52:02  update.json
```

`D:\dev\orange\.dev\home`：**不存在**（隔离 profile 的 home 是 `E:\CodexData\<...>\home`，与之无关）。

另两个仍在位的封印（用于对照）：

```
C:\Users\Administrator\Videos\OpenFilm\Projects\.openfilm-control.json          52B  2026/11/12 22:51:59  v1, domainId 925b9a04…
C:\Users\Administrator\Videos\OpenFilm\Projects\P08 素材验证\.film\control.json  52B  2026/11/13 00:47:34  v1, domainId 925b9a04…
```

`E:\CodexData\cli-chain-20261112\**` 下另有 24 个**已隔离态** v2 marker（`home/projects/shared-home` 三份一套），
全部 `coordinationId=7e088fbe…`。

### 2.5 结论：是因为哪个值不一致才拒的

按运行态证据分层，**不是一个原因**：

1. **不是 marker 在拒（今天）**。现存 4 个 marker 的 `version/domainId` 完全一致（`v1` + `925b9a04…`），
   `925b9a04…` 与 `sha256('orange-desktop\0orange-test-desktop')[:24]` 本机复算逐字符相同；缺失的两个 home marker
   在 `:48` 会用 `wx` 新建同样的 v1 值。**→ 现在的登录在 `:150-153` 处会通过**。
2. **真正在拒的是 owner 登记表**：`desktop-auth.mjs:52` `const file=join(home,'orange-project-owners.json')` →
   `:59-71 loadOwners()`；本机 `~/.openfilm-dev/orange-project-owners.json` **已被改名为 `.bak-20261116`**，
   `~/.openfilm` 从来没有过这份文件 → `loadOwners()` 返回 `[]` → `:123` 的
   `record=loadOwners().find(r=>r.environmentId===evidence.environmentId && r.projectId===project.id && r.subjectId===evidence.subjectId && samePath(r.root,root))`
   恒为 `undefined` → `:124 throw deny('project-access-denied')`。
   连带效果：`:185 listOwnedProjects()` 用 `ownsProject` 过滤 → **工程列表为空**；`:126 authorizeProject` 一律 403。
   这与 `orange-project-owners.json.bak-20261116` 里残留的记录
   （`environmentId:"orange-test-desktop"`, `subjectId:"d1be9826-…"`, `projectId:"4_-QQtAz8Wru"`, `root:"…\\P08 素材验证"`）互相印证：
   **记录存在时能开，改名移走后永远开不了，而且 `signIn` 不会重新收养已有工程**（没有"adopt existing projects"路径）。
3. **运行态交叉验证**：`GET /api/auth/state` → `{"kind":"signed-out","reason":null}`。`reason:null` 说明
   `service!==null`（配置已就位），但**从未尝试过登录**；`~/.openfilm-dev/.orange-coordination/registry.json` 的
   mtime 仍停在 `2026/11/13 10:32:32`（今天 14:16-14:18 只重建了目录），说明 **11-13 之后没有任何一次登录走到 `:147`**。
   即：今天没有人再触发失败，"拒"发生在 11-13 及之前，而 11-16 的人工清理只清了 home 侧，没清库根 marker、也没恢复 owner 表。
4. **结构性隐患（下一个坑，现在没触发）**：两个指针彼此无关——
   `domainId=f(environmentId)`（自由字符串标签，本机是 `orange-test-desktop`，与它指向的真实 Supabase 项目
   `https://qcpgqehqjescuwqhnmie.supabase.co` **没有任何绑定关系**）；`coordinationId=f(isolation baseRoot)`（文件系统根）。
   于是三个方向都会"同一份数据两种域"：
   - 同一 Supabase 项目换 `environmentId` 标签 → `domainId` 变 → 全部 marker 失效（`wx` 不可覆盖 → 必须手工删）；
   - `environmentId` 不变但指向另一 Supabase 项目 → 旧封印继续有效（**跨环境串用**）；
   - 只要 `OPENFILM_ISOLATION_PROFILE/ROOT` 一开一关，`version` 从 1 跳到 2 → **键集合比较直接失败**（`:50` 第一半条件）。
   这就是本机出现 `.bak-20261116` 这种"人工拆封印"操作的根因，也是"两个指针"的真实代价。

---

## Q3 能否合并成"只保留 Supabase 鉴权"

### 3.1 谁在依赖封印（全部调用点）

`verifyMarker` / `policy.decide` / `sealed` / marker 文件 / 协调锁 的实际依赖方：

| # | 调用点 | 依赖什么 | 用途 |
|---|---|---|---|
| 1 | `server.mjs:298-299` `desktopAuth.assertActive()` | `sealed` + `verified` + `policy` | Studio `/api/*` 全量门禁：非 active 一律 403 `authentication-required` |
| 2 | `server.mjs:287-296` `/api/auth/{state,sign-in,sign-out}` | `getPublicState/signIn/signOut` | 登录入口（同源 + `x-studio-key`） |
| 3 | `server.mjs:786/790/792` `authorizeProjectId/authorizeProject` | `policy.decide('restricted')` + owners | 工程级 API（打开、读、写）授权 |
| 4 | `server.mjs:1309-1310` `desktopAuth.runNative(run)` | 协调锁 + `withProjectAuthority/withProjectControlGuard` | 所有原生工程 IO 走"受控预订 + 权威上下文" |
| 5 | `server.mjs:1366/1380-1383` `/api/open` 等 | `assertActive` + `authorizeProject` | 打开工程/页面入口双检 |
| 6 | `server.mjs:1394-1395` `sealAccess()` | `onState` 非 active | 登出/失效时**立刻断流**（WS + pages） |
| 7 | `pages.mjs:194-198,229-231` | `authorizeProject` / `runNative` | Studio 页面（`:4758`）授权与 403 文案 |
| 8 | `saved-owners.mjs:41,52-60` `createSavedAccess` | `assertActive` / `windowScope()` | "我保存的"按账号作用域隔离 |
| 9 | `services-store.mjs:73-79` `withAccountServices` | `assertActive` | 账号级 providers 存储作用域 |
| 10 | `orange-routes.mjs:41-68` → `fission-local.mjs:80-82,142` | `assertSession(owner)`、`ownerKey(environmentId+subjectId)` | 本地 Fission 任务 owner 校验 |
| 11 | `fission-import.mjs:238` | `assertSourceAccess(...)` + ticket | 素材导入的许可票据 |
| 12 | `media-links.mjs:54-62` `linkAllowed` → `:157-170 assertSourceAccess` | `.openfilm-control.json` / `.film/control.json` **文件存在性** | 素材来源守卫：受控路径不得被"无封印的本地读者"读走 |
| 13 | `bin/openfilm.mjs:405-414` | `createProjectControlGuard().withNativeAccess`（deny=true） | 独立 CLI 在受控工程上拒绝原生执行（"controlled projects must use the logged-in Studio"） |
| 14 | `projects.mjs:844-847`（打开工程时 home+root 双 marker） | marker 遍历 | 原生 open 路径不得绕过封印 |
| 15 | `desktop-auth.mjs:181-182` `registerCreatedProject` | `.film/control.json` 写入 | 新工程入册即上封印 |
| 16 | `verifyMarker` 调用点 | `:122`（工程域，仅隔离时）、`:152`（登录）、`:182`（新建工程） | 见 Q2 |
| 17 | `policy.decide` 唯一调用点 | `desktop-auth.mjs:134`（`'restricted'`） | 工程句柄 + 有效期材质（`project-access.mjs:124-136`） |
| 18 | `sealed` 唯一持有者 | `desktop-auth.mjs:53,78,84,115,157,164,205` | 封/解闸门；注意 `local-agents-ipc.mjs:162-165,580-595` 的 `sealed` 是**无关**的 agent IPC 退役标志 |

### 3.2 去掉后会不会破坏（逐条）

| 风险面 | 有封印时 | 去掉后 | 严重度 |
|---|---|---|---|
| **本机工程被别的进程打开**（并发写） | 协调锁 `registry.json` + `meta.lock` 提供跨进程 `reservations/readers` 与 `overlaps` 冲突检测（`project-control-guard.mjs:83-93,137-158`）；第二实例拿到 `control-busy`(409) | 回到上游行为：谁都能同时写同一工程（上游 `projects.mjs` 没有锁） | **高**（数据损坏风险，非越权） |
| **CLI 越权** | `bin/openfilm.mjs:405-414` + `assertSourceAccess` marker 扫描 → 独立 `openfilm look/render` 在受控工程上直接退出码 1 | CLI 恢复上游能力：能读任何工程（`look/render` 会真的执行） | **中**（行为回退，非新漏洞） |
| **我们 `media-links.mjs` 的素材来源守卫** | `linkAllowed()` → `assertSourceAccess()`：路径或任一祖先含 marker 即 `403 source-access-denied`（`:157-170`，`overlay/patches/openfilm.patch:755` 是我们加的调用，`:846` 是函数本体） | **静默失效**：`assertSourceAccess` 第一分支用 `sourceAuthority.getStore()`，而 `withSourceAuthorization`（`:146-152`）**全仓没有任何安装点**（`git grep withSourceAuthorization` 只有定义处和 patch 文件）→ 没有 marker 就没有任何拦截，`return null` 放行 | **高**（素材边界真的会开） |
| **工程归属（owners）** | 按 `environmentId+projectId+subjectId+root` 认领；换账号看不到别人工程 | 回落到 `listProjects()` = 库目录里所有工程 → 任何能登录的人看到全部工程 | **中**（多账号场景是隐私回退；单账号无感） |
| **saved / services 作用域** | `assertActive` + `windowScope`（`:172`）= `sha256(environmentId+subjectId)` | 只要保留 `assertActive`/`windowScope` 就能保留，**不必依赖 marker** | 低（可直接迁移） |
| **登录后工作保存/退役次序** | `fence`/`beginRetirement`/`onRetired`（`:77-98,205`） | 与 marker 解耦，可保留 | 低 |

### 3.3 方案 (a)：保留封印层，但与 Supabase 环境绑成同一派生链（消除两个指针）

**做法（最小改动面）**

1. `desktop-auth.mjs:38` 的 `domainId` 改为把**真实环境**一起绑进去：
   `domainId = sha256('orange-desktop\0' + environmentId + '\0' + new URL(authOrigin).host)[:24]`
   （或直接用 Supabase project ref；`authOrigin` 已在 `configuration` 里，`auth-service.mjs:103-114` 已校验为 https origin）。
   这样"同一 Supabase 项目 + 不同标签"与"同标签 + 不同项目"都不再产生同一把封印。
2. `:39-45 expectedMarker()` 去掉独立指针：`coordinationId` 改为 `sha256(fold(baseRoot) + '\0' + domainId)`
   **或**统一成 `version:2` 恒定、`coordinationId = domainId` 派生（隔离根只进 `isolatedControlPolicy` 的审批，不再进 marker）。
   推荐前者：保留"隔离根换了必须重封"的语义，但把它挂在同一派生链上。
3. `:50` 的键集合比较放宽为"期望键全部相等 + 忽略 `coordinationId` 在非隔离态"（或固定 v2 单形态），一次性消除 v1/v2 双形态。
4. 迁移脚本（一次性、可回滚）：对 `homes ∪ {roots[1]} ∪ 每个工程` 重算并**原地重写** marker（不能靠 `wx`），
   同时给 `orange-project-owners.json` 加"登录时按 `subjectId` 收养已存在工程根"的分支（补 `:123` 缺的 adopt 路径）。

**代价**：`desktop-auth.mjs` 改 3 处（约 15 行）+ 新增 1 个迁移脚本 + 改 `desktop-auth.test.mjs` /
`desktop-auth-entry.test.mjs` 的期望值；不触碰 `auth-service.mjs` 的任何断言（红线 1/3/5/9 全保）。
**风险**：撞 `auth-chain.md §5.4` 红线 4（"marker 不可自动重建"）——所以**只能在迁移脚本里重写**，不能在 `verifyMarker` 里放宽；
owner 收养是新语义，需要一条"只收养 `below(roots[1], root)` 且 `subjectId` 一致"的断言防止越权；
历史 v2 marker（`E:\CodexData` 那 24 个）会全部失效，需要重建——好在它们是测试根，可弃。

### 3.4 方案 (b)：彻底删掉封印层，只保留 Supabase 令牌 + RLS

**做法**：删 `project-access.mjs` / `project-control-guard.mjs` / `isolation-control-policy.mjs` 的调用与 marker 读写；
`desktop-auth.mjs` 收缩成"`auth-service` + `assertActive` + `windowScope`"；`projects.mjs` / `media-links.mjs` 回退上游实现；
`server.mjs`/`pages.mjs`/`orange-routes.mjs`/`saved-owners.mjs` 改为只做令牌门；工程归属交给 Supabase 表 + RLS。

**代价**：改动面最大（4 个新文件删除、`projects.mjs` 287 行新增回退、`media-links.mjs` 43 行回退、`server.mjs` 十余处改门禁），
且**必须先补**两件事，否则是净损失：
1. `withSourceAuthorization` 装上真正的 Studio 侧授权回调（今天没有安装点），否则素材守卫归零；
2. 跨进程单写保护：要么在 RLS 之外补一个轻量工程租约（否则两个 Studio 写坏同一工程），要么明确接受"回上游语义"。
**测试面**：`project-access.test.mjs`、`project-control-guard.test.mjs`、`projects-control.test.mjs`、
`projects-isolation.test.mjs`、`server-isolation.test.mjs`、`desktop-auth-entry.test.mjs`、`openfilm-auth.test.mjs`、
`auth-gate.test.mjs`（合计 9 个文件直接引用封印符号）需要删除或重写——这部分成本比代码本身更大。
**风险**：这是"降级到上游"，可解释、可回滚（保留分支），但会把 `media-links` 素材边界临时打开，且 RLS 需要
真实表结构（当前 `apps/api/src/authorization.ts` 只有薄薄一层，未见工程表迁移）。

### 3.5 推荐

**推荐 (a)，并把 (b) 拆成独立分支延后。** 理由：

- 今天我们看到的失败**不是"两层"造成的**，而是 `orange-project-owners.json` 被移走且 `signIn` 没有收养路径（Q2.5-2）。
  先做 (a) + 收养分支，能立刻恢复"登录即能用"，代价 ~15 行 + 1 个脚本；
- (b) 的净收益（少一层指针）只有 2 个文件级的简化，却要付出 9 个测试文件与素材守卫的重建，**风险/收益比最差**；
- 真正的架构债是**两个指针彼此无关**，(a) 正面消除它（domain 绑真实 origin，coordination 挂在 domain 上），
  而 (b) 只是把指针删掉、把问题搬到 RLS 表设计里，且前提（RLS 表 + 素材授权回调）现在都不存在。

若 Lead 要一步到位"只留 Supabase"，建议顺序：**(a) 先上（保可用）→ 单独分支做 (b)，且 (b) 的第一步必须是
`withSourceAuthorization` 安装点 + 工程租约，然后再删 marker。** 反过来做会先破素材边界。

---

## 附：本次所用命令与运行态读取（可复现）

```
git cat-file -e <ref>:<path>                       # 三 ref 存在性矩阵
git log --diff-filter=A -- <path>                  # 每个文件的引入提交
git show upstream-v0.3.2:packages/openfilm/studio/server/projects.mjs | grep 'export'
git grep -c 'withProjectAuthority' upstream-v0.3.2 # 0
git show e2c295b -- apps/desktop/src/desktop-auth.mjs            # verifyMarker 引入 diff
git show 5e6dd2b:apps/desktop/src/desktop-auth.mjs | grep sealed # 首版即含封印
cat overlay/base.json ; grep -n 'auth' overlay/new-files.txt
GET http://127.0.0.1:4757/api/health              → home:"a43f6a6c…" = sha256('C:\Users\Administrator\.openfilm-dev')
GET http://127.0.0.1:4757/api/auth/state          → {"kind":"signed-out","reason":null}
  (header x-studio-key 取 ~/.openfilm-dev/run.json；只读 GET，未启动任何进程)
```

未做：未改任何源码、未 commit、未启动应用、未读取 `.dev/auth-runtime.json` 的 `publishableKey` 明文（只核长度与前缀）。
