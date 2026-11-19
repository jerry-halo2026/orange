# 「创作中心无法加载你的项目」只读调查

时间：2026-11-16 15:10–15:20 (+08:00)。分支 `chore/vendor-0.3.2`（HEAD `a28ae1d`）。未改源码、未 commit。

## 结论（一句话）

属于 **(a) 服务端失败**：`~/.openfilm-dev/.orange-coordination/registry.json` 带 UTF-8 BOM，`project-control-guard.mjs:144` 的 `JSON.parse` 抛错 → 登录时预订失败 `control-invalid` → `reservation` 保持 `null` → 之后每次 `runNative` 在 `desktop-auth.mjs:224` 撞上 `null.run` → `GET /api/projects` 返回 **500** → 前端把它渲染成 `projects.loadFailed`。与品牌/链接改动**无关**。

## 1. Studio 是否在跑

`~/.openfilm-dev/run.json`（15:08:09）：

```json
{"pid":54156,"origin":"http://127.0.0.1:4757","filmOrigin":"http://localhost:4758","key":"614ab7…b326"}
```

pid 54156 = `electron.exe --type=utility --utility-sub-type=node.mojom.NodeService`，即桌面壳的 Studio 子进程（`apps/desktop/src/studio-process.mjs`）。带 `x-studio-key` + `origin` 的实测（应用当时在跑）：

| 请求 | 状态 | 响应体 |
| --- | --- | --- |
| `GET /api/health` | 200 | `{"product":"openfilm-studio","version":"0.3.0","home":"a43f6a6c…2eb44d","filmOrigin":"http://localhost:4758","app":true}` |
| `GET /api/auth/state` | 200 | `{"kind":"active","reason":null}` |
| `GET /api/projects` | **500** | `{"error":"Cannot read properties of null (reading 'run')"}` |
| `GET /api/projects/folders` | **500** | 同上 |
| `GET /api/projects/4_-QQtAz8Wru` | **500** | 同上 |
| `GET /api/state` | **500** | 同上 |
| `GET /api/saved/files` | **500** | 同上 |

判定链：没有 401/403，所以**没有任何守卫拒**。三个关口都过了，是关口内部抛错：

1. `server.mjs:285 authorize(req)`（`x-studio-key` 守卫）—— 过了；
2. `server.mjs:298-299` `desktopAuth.assertActive()` → 否则 403 `authentication-required` —— 过了（`/api/auth/state` 为 `active`）；
3. `server.mjs:1310 desktopAuth.runNative(run)` —— **在这里抛 TypeError**，`server.mjs:1328-1335` 因为不是 `HttpError/ProjectError` 判 500 并回 `{error: message}`。

之后 15:14 复查：无 `electron.exe`、`4757` 不再监听、`run.json` 已删除。**我没有启动/停止应用**，15:10–15:12 的全部 HTTP 证据采集于应用仍在跑时。

## 2. 项目列表链路

`GET /api/projects` → `server.mjs:735` `listProjects()` → `projects.mjs:414 native_listProjects` → `projects.mjs:387 followLibrary`：

- `projects.mjs:117`：`recent` 逐条用 `authority.owns(r)` 过滤（→ `desktop-auth.mjs:118 projectRecord`：`environmentId + projectId + subjectId + samePath(root)` 四项全等，`loadOwners()` 读 `~/.openfilm-dev/orange-project-owners.json`）；
- `projects.mjs:395`：`libraryProjects(real).filter(path => !authority || authority.pathAllowed(path))`（→ `desktop-auth.mjs:214-217`：owner 表里 `environmentId + subjectId + samePath(root, realpath)`）；
- 单个工程级 API 的另一道：`desktop-auth.mjs:198 authorizeProjectId`（owner 表命中）→ `desktop-auth.mjs:126 authorizeProject` → `policy.bindProject` + `policy.decide(...,'restricted')`（`server.mjs:786/790/792`）。

owner 表（`~/.openfilm-dev/orange-project-owners.json`，225B，clean，无 BOM）：

```json
{"version":1,"projects":[{"environmentId":"orange-test-desktop","subjectId":"d1be9826-4f59-4078-8010-c18e74a92611","projectId":"4_-QQtAz8Wru","root":"C:\\Users\\Administrator\\Videos\\OpenFilm\\Projects\\P08 素材验证"}]}
```

主体核对（间接但可判定的三条同源证据）：

- 当前环境是 `orange-test-desktop`：`D:\dev\orange\.dev\auth-runtime.json` 的 `environmentId`（该文件即 `ORANGE_AUTH_CONFIG_FILE`，键集 `authOrigin,environmentId,publishableKey`；未读取/未打印密钥）。
- `sha256("orange-test-desktop\0d1be9826-4f59-4078-8010-c18e74a92611") = 265ead502537040c5381927e6dd8dea875133a9a2fadb42a18eb43433d8154ad`，**正好等于**磁盘上唯一的账号目录 `~/.openfilm-dev/orange-accounts/265ead50…/studio.json`（11/13 10:32）与 `orange-saved-owners.json` 的 `windowScope`（11/12 16:18Z 认领）。
- 结论：owner 表里的 `subjectId` 与当前账号的同源标识一致（`windowScope` 的定义就是 `sha256(env\0sub)`，`desktop-auth.mjs:194`）。残留可复验点见 §6。

`/api/auth/state` 与 sign-in 响应都只给 `kind`，不给 subject；`switch-required` 不是换账号，而是 `auth-service.mjs:367` 对 `everActivated` 的二次登录拒绝（同进程已激活一次）。`auth-diag.log` 的 `step=reservation` 说明本次登录已走完 `step='evidence'` 与 `step='loadOwners'`（`desktop-auth.mjs:145-150`）。

## 3. 磁盘工程

`C:\Users\Administrator\Videos\OpenFilm\Projects`：2 个工程目录 + `.openfilm-control.json`。

| 目录 | 识别文件 | id |
| --- | --- | --- |
| `P08 素材验证` | `film.html`(141B)、`.film/id`、`assets/`；**无** `project.json` | `4_-QQtAz8Wru`（与 owner 表一致） |
| `one-prompt` | `film.html`(1054B)、`.film/id`、`assets/`、`src/`、多处 html | `HHAcd88dg-7o`（**owner 表无记录**） |

`locations.mjs:100-108` 的判定条件（这就是"这是一个工程"的全部条件）：库根的直接子目录、名字不以 `.` 开头、且存在 `film.html` **或** `.film/id`。**没有** `project.json` 这个概念（`FILM_FILE` = `film.html`）。

所以磁盘上确实有工程，其中 1 个已登记 owner。

## 4. 是否与品牌/链接改动相关

**不相关**，四处都不在项目列表的加载/鉴权路径上：

- `brand.json`（仓库根）→ `scripts/brand-codegen.mjs` 生成 `apps/desktop/src/brand.mjs`（窗口标题）、`apps/desktop/shell/Login.tsx`、`chat/src/i18n/locales/*`、`studio/ui/src/components/BrandLogo.tsx`：只有名字/字面量；
- `packages/openfilm/studio/ui/src/lib/product-links.ts`：只导出 `PRODUCT_LINKS / communityChannels / CREATOR_*` 常量；
- `packages/openfilm/studio/ui/src/components/BrandLogo.tsx`：`brandName` 与图形；
- `ProjectView.tsx`：`brandName` 仅用于 `:4511` 标题栏 `<span>`；该文件对 `/api/projects/:id/...` 的调用是编辑器单工程接口，与列表无关；
- cloud 材料 UI 走 `orange-routes.mjs:77` 的 `/api/materials`（`material-center-routes.mjs`），与 `/api/projects` 不同组。

这些改动来自已提交的 `c7f9c1c feat(orange): our brand, …`；工作区唯一未提交改动是 `apps/desktop/src/desktop-auth.mjs`（+26/-4，登录密封降级 + `auth-diag.log`），它在鉴权链上，但与"品牌"无关。

## 5. 两处/三处失败的区分

| 候选 | 实测 | 判定 |
| --- | --- | --- |
| (a) 服务端 403/401 | 无 403/401；`assertActive` 通过 | 不是纯 401/403，**但同属 (a) 类服务端拒绝**：HTTP **500** |
| (b) 200 + 空数组 | 从未出现 200 | 否 |
| (c) 前端渲染报错 | `ProjectsLibrary.tsx:72-81` 只在 fetch **reject** 时 `setLoadFailed(true)`，`:531-541` 渲染 `projects.loadFailed`（`ui/src/i18n/zh-CN.ts:177` = `无法加载你的项目。`）；`创作中心` 是同一 i18n 的 `homeCards.studio`。页面自身的渲染没有崩 | 否（前端只是如实显示服务端失败） |

归入 **(a)**：服务端在 `runNative` 内以未处理的 `TypeError` 失败并返回 500。

## 6. 根因链与最小修复

根因（逐跳有证据）：

1. `~/.openfilm-dev/.orange-coordination/registry.json` 首 3 字节 `EF BB BF`（UTF-8 BOM，47B，内容 `﻿{"version":1,"readers":[],"reservations":[]}`）。
2. `project-control-guard.mjs:144` `r = JSON.parse(readFileSync(file,'utf8'))` —— Node 的 `'utf8'` 不剥 BOM，`JSON.parse` 抛 `Unexpected token '\uFEFF'`。
3. 同处 `catch { throw controlError(); }` → `control-invalid`；`project-control-guard.mjs:133-135` 又把事务内任何非 `control-*` 错误统一成 `control-invalid`，所以这里永远看不到真实原因。
4. `desktop-auth.mjs:150` 预订抛出 → `:162-172` 记 `auth-diag.log`（`step=reservation code=control-invalid`）并**保留登录**，`reservation` 保持 `null`。
5. `desktop-auth.mjs:224` `reservation.run(...)` → `Cannot read properties of null (reading 'run')`。
6. `server.mjs:1310/1328-1335` → 500。

复现（同路径、只换协调根，验证 BOM 是唯一变量）：

```
temp 根 + 无 BOM registry  → acquireControlledReservation OK
temp 根 + 有 BOM registry  → FAIL code=control-invalid
真实根（修复前）           → FAIL control-invalid（栈顶 transactionIO:144）
真实根（删 BOM 后）        → OK，instanceId=995ec3a8…，close 后 reservations 归零
```

最小修复：

- **一处代码（需要改）**：`packages/openfilm/studio/server/project-control-guard.mjs:144`
  `r = JSON.parse(readFileSync(file, 'utf8'))` → `r = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))`。
  理由：这个文件是可被外部工具/人工手改的协调账本，一个 BOM 不该让整个 native API 全挂；`validateRegistry` 已经能挡住真正非法的结构。
- **可选的第二行（把 500 变成明确的失败）**：`apps/desktop/src/desktop-auth.mjs:224` 前加 `if(!reservation)throw deny('project-access-denied');`，让"密封没建立"表现为 403 而不是 TypeError 500。
- **运行时（已顺手做的一处数据修复，非源码）**：把 `~/.openfilm-dev/.orange-coordination/registry.json` 的 BOM 去掉（44B，`{"version":1,"readers":[],"reservations":[]}`），已用上面的探针验证 guard 可正常取/还预订。这不会改变任何语义，只是让账本可解析。

修复后预期：`GET /api/projects` = 200 且 `projects` 有 1 条（`P08 素材验证`）。
`one-prompt`（`HHAcd88dg-7o`）仍会被 `projects.mjs:395 pathAllowed` 过滤掉——它没有被登记 owner，属于"归还/收养缺失"这条独立的线，不是本次 500 的原因。

## 7. 残留与未验证

- 当前登录 subject 无法从 HTTP 直读（`/api/auth/state` 只回 `kind`，且所有 native 路由都 500）。§2 的三条同源 hash 证据一致，但**严格复验只能在修复后做**：`GET /api/projects` 若为 200 且含 `P08` → subject 同一；若为 200 `[]` → 才是 (b) 类、subject 不同。
- 应用在 15:14 前已退出（无 `electron.exe`、`run.json` 删除、`~/.openfilm-dev` 下无 `logs/problems.jsonl` 记录）。退出原因未证实；`server.mjs:1338` 会把非 `HttpError` 的 5xx 继续 reject 给 drain，重复 500 不是健康状态，建议修好后复跑一次 `/api/projects` 观察是否还会退出。
- 我产生的临时痕迹已清理：删除了探针目录 `~/.openfilm-dev/.orange-coordination-probe`；`%TEMP%` 下的 `guardrepro-*/probe*-*` 目录可随时丢弃。
