# 打不开工程 Studio：只读调查

仓库 `D:\dev\orange`，分支 `chore/vendor-0.3.2`。未改源码、未 commit、未启停应用。

## 0. 环境与实测条件

`~/.openfilm-dev/run.json`：

```json
{"pid":43076,"origin":"http://127.0.0.1:4757","filmOrigin":"http://localhost:4758","key":"98b0ad510955ac529cb5e524e427cd05220d9b3063e14599"}
```

pid 43076 = electron 主进程，StartedAt 15:20:49；即 Studio server 跑在 electron 主进程内（不是独立 child），**应用在跑，可实测**。
下文所有请求都带 `x-studio-key: <run.json key>` + `origin: http://127.0.0.1:4757`。

工作区未提交改动（`git status`）：

```
 M apps/desktop/src/desktop-auth.mjs                  (+30/-5)
 M packages/openfilm/studio/server/project-control-guard.mjs (+5/-1)
?? docs/execution/2026-11-16-auth-unify/
?? packages/openfilm/src/auth-environment.mjs(.test.mjs)
```

`git log --oneline -25` 里 `desktop-auth.mjs` 最近一次提交是 `a5cfb04`（不在近 25 条内），**封印降级是未提交的工作区改动，不是提交引入的**。

## 1. 打开工程的确切 HTTP 链路（逐个实测）

只有两条 open 接口，`/api/projects/:id/open`、`/api/studio/*` **不存在**（`server.mjs:332` 只有 `POST /api/open`；`server.mjs:268` 是 `GET /open` 302 跳板；`server.mjs:773-788` 的 `projects/:id/*` 只有 folder/locate/duplicate）。

| # | 请求 | 结果 |
|---|---|---|
| 1 | `GET /api/health` | 200 `{"product":"openfilm-studio","version":"0.3.0","home":"a43f6a6c…","filmOrigin":"http://localhost:4758","app":true}` |
| 2 | `GET /api/auth/state` | 200 `{"kind":"active","reason":null}` |
| 3 | `GET /api/projects` | 200，2 条：`4_-QQtAz8Wru` = `C:\Users\Administrator\Videos\OpenFilm\Projects\P08 素材验证`；`XIiAHGp_Spwi` = `…\未命名` |
| 4 | `POST /api/open` `{"path":"…\\P08 素材验证","fallback":0}` | **200** `{"project":{…},"url":"http://127.0.0.1:4757/open?key=…&to=%2Fprojects%2F4_-QQtAz8Wru","pages":0}` |
| 5 | `GET /open?key=…&to=/projects/4_-QQtAz8Wru` | **302** `location: /projects/4_-QQtAz8Wru?key=…`，`set-cookie: openfilm_studio_4757=…` |
| 6 | `GET /projects/4_-QQtAz8Wru?key=…` | **200**，2153 B，引 `/assets/index-63BR9syP.js`、`/assets/index-biN7Dh-s.css` |
| 7 | `GET /assets/index-63BR9syP.js` / `…css` | **200 / 200** |
| 8 | `GET /api/projects/4_-QQtAz8Wru` | **200**，`rev":"d29913628c433fcd"`，`stage 1920x1080` |
| 9 | `POST /api/open` `{"fallback":0}`（无 path） | 200，落到最后一个工程 |

**结论：服务端整条链路是通的**，200/302 全绿，鉴权、owner 表、policy 都过。

点击工程卡片走的不是 `/api/open`：`App.tsx:61 open()` → `studioHost.tabs.open(id)`（`preload.cjs:55` `desktop:tabs:new`）→ `main.mjs:330 newTab` → `main.mjs:323 showTab` → `main.mjs:317 showPage` → `page-presentation.mjs:43 show`。

`/api/open` 是 File › Open Project 那条（`main.mjs:455`），它额外经 `toPages({type:'open'})`（`server.mjs:347`）→ `main.mjs:392 openInTabs` → 同样落到 `newTab/showTab`。

所以"进不了编辑器"发生在**主进程的原生页面挂载**这一步，不在 HTTP。

## 2. 两段各自独立的失败（都有证据）

### 2a. 上一实例（15:08 那次，dev-run8）：`reservation` 为 null → 所有 native 接口 500

`~/.openfilm-dev/auth-diag.log`（全文 1 行）：

```
2026-11-16T07:08:35.493Z	step=reservation	code=control-invalid	message=Project control is invalid.
```

`%APPDATA%\OpenFilm Dev\logs\studio.log`（无时间戳，按顺序）：

```
281: [auth] sign-in failed at reservation: Project control is invalid. (control-invalid)
288: [auth] sign-in failed at reservation: Project control is invalid. (control-invalid)
289: [auth] sign-in failed at reservation: Project control is invalid. (control-invalid)
297: [auth] seal failed at reservation: Project control is invalid. (control-invalid) — signed in anyway
298-433: TypeError: Cannot read properties of null (reading 'run')            ×34
    at file:///D:/dev/orange/apps/desktop/src/desktop-auth.mjs:224:62
    at async Object.runNative (.../desktop-auth.mjs:225:44)
    at async route (file:///D:/dev/orange/packages/openfilm/studio/server/server.mjs:1310:18)
```

第 281/288/289 行是**降级补丁之前**的构建（"sign-in failed"）；第 297 行起是**降级补丁之后**（"signed in anyway"）。降级把 `reservation` 置 null（`desktop-auth.mjs:172`），而 `runNative` 在 `desktop-auth.mjs:224` 无条件 `reservation.run(...)` → TypeError → `server.mjs:1310` 无 code → 500。

这就是"能登录、能看列表，但一操作就炸"的那一版。**当前实例已不复现**（见 2b），因为 `project-control-guard.mjs:147` 的 BOM 容忍补丁（15:19:59 落盘）在 15:20:49 重启后生效，封印已成功：`/api/projects`、`/api/open`、`/api/projects/:id` 实测全 200，且 auth-diag.log 不再新增。

### 2b. 当前实例（15:20:49 起，dev-run9）：页面挂载失败

`studio.log` 尾部（当前实例，材料服务端口 54468 之后）：

```
441: page: could not prepare replacement (Current display surface not available for capture)
442: page: could not prepare replacement (Current display surface not available for capture)
443: page: could not prepare replacement (Current display surface not available for capture)
444: page: could not prepare replacement (Current display surface not available for capture)
```

来源：`prepare()`（`main.mjs:283-298`）→ `preparePage`（`page-presentation.mjs:77`）→ `paintPage`，其中

- `page-presentation.mjs:109-117`：`await Promise.race([contents.capturePage({…1×1}, {stayHidden:true}), timeout])`，`finally` 里只 `clearTimeout`，**没有 catch**；
- `capturePage` 以 `Current display surface not available for capture` reject → `preparePage` reject → `page.ready` reject；
- `page-presentation.mjs:36-41 failed()` → `onError` → `fallback = HOME`（`main.mjs:284`）→ `show('home')`，而 HOME 已 `loaded && current`，`page-presentation.mjs:49` 直接返回 true；
- 结果：**界面停在工程列表，标签点了不动**，正是"点开后进不了编辑器"。

机制：`main.mjs:288` 把新 view `addChildView(v, 0)` 插到最底层、`main.mjs:289` `setVisible(true)`，但上一层（HOME/旧页）盖着它；被完全遮挡的 view 还没有可截取的 display surface，`stayHidden` 截帧直接 reject，而这条 reject 被当成了"页面没准备好"的致命错误。

这条 `capturePage` 等待是 **0.3.2 vendoring 带进来的**：

```
$ git log --oneline -S "capturePage" -- apps/desktop/src/page-presentation.mjs
6968c7d wip(vendor): upstream 0.3.2 tree with our layer kept, statically coherent
$ git blame -L 109,117 -- apps/desktop/src/page-presentation.mjs
6968c7d (Ethan 2026-11-13 109)  if (contents.capturePage) {
6968c7d (Ethan 2026-11-13 112)    contents.capturePage({ x: 0, y: 0, width: 1, height: 1 }, { stayHidden: true }),
```

基线 `8b8ef16` 的 `preparePage` 只有 `executeJavaScript(waitForPageFrame(paintTimeoutMs))`，**没有 capturePage、没有 readySelector**（`git show 8b8ef16:apps/desktop/src/page-presentation.mjs`）。所以 2b 是 6968c7d 引入的回归，不是上游 0.3.0 行为。

## 3. `desktop-auth` 两个已改点的影响

- `signIn` 降级（`desktop-auth.mjs:162-183`）：catch 里 `evidence` 存在即 `ok:true`。**这个改动确实造成了 2a**：它把"封印失败"从"登录失败"改成了"登录成功但 reservation=null"，把失败推迟到了第一次 native 调用，并让 UI 显示成"已登录"。
- `authorizeProjectId`（`desktop-auth.mjs:198`）本身**不是 500 的出处**：它先 `assertActive()`（`verified` 仍被降级路径设上了，`desktop-auth.mjs:174`），再查 owners、`authorizeProject({id, path:item.root})`；`policy` 也已被重建（`:175`）。`reservation` 为 null 时它并不解引用 reservation。
- 真正 500 的是 `runNative` 的 `desktop-auth.mjs:224`：`reservation.run(...)`。执行顺序上它早于任何 `authorizeProjectId`，所以 2a 里 `/api/projects/:id` 也 500，而 `authorizeProjectId` 根本没被执行到——不是它抛的。
- 但两者叠加的语义问题成立：**降级让 `assertActive()` 通过 + `authorizeProjectId` 通过 + `runNative` 崩**，比干脆 403 更难诊断。

## 4. 前端侧（`ProjectView.tsx` / `api.ts`）

**不相关。** `api.ts:80-97 call()` 只是 `fetch('/api/'+path)`，`api.ts:99 p(id)='projects/'+id`，`ProjectView` 打开工程即 `GET /api/projects/:id`，实测 200（第 8 条）。`api.ts` 近 5 次提交里最近一次是 `f717b8c`（签名对齐），`ProjectView.tsx` 最近是 `98ea687`（上游工作区系统移植），都没有改打开工程的成功路径。

品牌 / `product-links` / 云管家 UI 的改动集中在 `c7f9c1c`（`brand.json`、`brand.generated.ts`、shell 的 `AccountExit.tsx`、`chat/BrandLogo.tsx`、bench 目录）与 `c3149f4`（`host.ts` 加 notifications），**不触碰** `server.mjs:332`、`projects.mjs`、`main.mjs` 的页面挂载。前端不是失败点。

## 5. 相关日志原文

`~/.openfilm-dev/auth-diag.log`：

```
2026-11-16T07:08:35.493Z	step=reservation	code=control-invalid	message=Project control is invalid.
```

`%APPDATA%\OpenFilm Dev\logs\studio.log`（相关行，其余为 materials-api 噪声）：

```
281: [auth] sign-in failed at reservation: Project control is invalid. (control-invalid)
288: [auth] sign-in failed at reservation: Project control is invalid. (control-invalid)
289: [auth] sign-in failed at reservation: Project control is invalid. (control-invalid)
297: [auth] seal failed at reservation: Project control is invalid. (control-invalid) — signed in anyway
298: TypeError: Cannot read properties of null (reading 'run')
    at file:///D:/dev/orange/apps/desktop/src/desktop-auth.mjs:224:62
    at async Object.runNative (file:///D:/dev/orange/apps/desktop/src/desktop-auth.mjs:225:44)
    at async route (file:///D:/dev/orange/packages/openfilm/studio/server/server.mjs:1310:18)
…（同一栈共 34 次，298–433 行）
441: page: could not prepare replacement (Current display surface not available for capture)
442: page: could not prepare replacement (Current display surface not available for capture)
443: page: could not prepare replacement (Current display surface not available for capture)
444: page: could not prepare replacement (Current display surface not available for capture)
```

`.dev/logs/dev-run9.err.log`（当前实例 stderr，启动期；`fromPage` 要求 `desktopAuthActive`，登录前必然抛）：

```
Error occurred in handler for 'desktop:tabs:list': Error: not the window's page
    at file:///D:/dev/orange/apps/desktop/src/main.mjs:746:33
Error occurred in handler for 'desktop:tabs:report': Error: not the window's page
    at file:///D:/dev/orange/apps/desktop/src/main.mjs:746:33
```

`.dev/logs/dev-run*.log`、`studio-direct.log` 无打开工程相关错误（只有 zod/rollup 告警和 `OpenFilm Studio 路 http://127.0.0.1:4747`）。

## 6. 结论与最小修复

1. **当前实例的阻断点**：`page-presentation.mjs:109-117` 的 `capturePage` 等待没有 catch，被遮挡的新 view 截帧失败即 reject，`show()` 回落到 HOME，标签点了不切页。
   最小修复：`page-presentation.mjs:112` 改成
   `contents.capturePage({ x: 0, y: 0, width: 1, height: 1 }, { stayHidden: true }).catch(() => null),`
   （截帧是"顺手等一帧"的优化，超时已经兜底，不该有能力否决一次切页）。
2. **2a 的复发风险**：`desktop-auth.mjs:162-183` 降级 + `:224` 无保护的 `reservation.run` 组合 = 一旦封印再失败，所有 native 接口 500 而 UI 仍显示已登录。
   最小修复：在 `desktop-auth.mjs:224` 之前加 `if(!reservation)throw deny('authentication-required');`，让降级态明确 403，而不是 TypeError → 500；同时 `project-control-guard.mjs:147` 的 BOM 容忍补丁需要提交并补测试（当前是未提交状态）。
3. 与品牌 / product-links / 云管家 UI 改动**无关**（不相关）。
