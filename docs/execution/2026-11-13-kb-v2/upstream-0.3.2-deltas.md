# 上游 v0.3.2 语义增量清单（与我们的交集）

- 分支：`chore/vendor-0.3.2`（从 `9374a88` 起）
- 上游：`upstream-v0.3.2` @ `e01b37f`（v0.3.0 `7713d38` → v0.3.2 的增量）
- 我们的产品基线：`144be1c`（`9374a88` = 该基线 + 一个 overlay 脚本修复）
- 状态：**未 commit**。工作树已 `git add -A`，`tsc -p packages/openfilm/studio/ui --noEmit` 0 错误，`node --check` 全绿。
- 本文只回答一件事：**上游这半年加了什么、和我们撞在哪、要补哪一步、用哪个测试验收。**

---

## 1. 结论（先看这段）

1. **「只保 24 个标记文件」不足以自洽。** 按任务给的规则执行完，树里有 **23 个 tsc 错误**，不是一个干净状态。
2. 原因是三种耦合，不是一处笔误：
   - 5 组 patch 过 3-way merge 后，**30 个「clean」文件其实是杂交体**——既不是我们的版本，也不是上游的版本，而是"上游新文本 + 我们旧 hunk"的拼接产物（`package.json`、`i18n/*.ts`、`providers.ts`…）。
   - 我们不碰但**上游改了**的 193 个文件里，有一批是我们 UI 的直接邻居（`AudioList`、`VoicesPane`、`LayoutMenu`、`undo.ts` 的 op 类型…），改签名就断我们的调用点。
   - 5 个上游新增模块（`organize-tracks.ts`、`canvas/video.tsx`…）要求**先扩展我们的类型层**才能编译。
3. **保 ours 的范围因此扩到「所有与我们代码发生语义碰撞的上游文本」**，规则与数字见 §2.3。最终 `9374a88 → 本次` 共 **188 个路径变化 = 116 个上游 v0.3.2 修订 + 72 个上游 v0.3.2 新增**，其余 3022 个跟踪路径原样是我们的。
4. 上游增量与我们真正有交集的能力共 **16 项**，逐条列在 §3。其中 **5 项是「采纳上游后必然改我们代码」的硬冲突**（D1/D2/D3/D9/D10），另 **4 项是本次被删文件的前置条件**（D11–D14）。
5. 上游新增的 80 个文件：**删 8 个、留 72 个**，判断规则与逐组依据见 §4。留下的 72 个里有 21 个是上游用例，**现在跑是红的**，它们是 D1–D14 的验收标准。

---

## 2. 实测数字

### 2.1 `apply-overlay.mjs` 实跑

```
note       HEAD moved: 9374a88 (base.json productRef 144be1c) — new files still come from productRef
mode       apply to current worktree
base       upstream-v0.3.2 @ e01b37f -> product 144be1c
restore    upstream whole tree 2808 paths, then 482 new files from productRef
patch      5 patch(es) covering 107 files
result     clean 83 · conflicted 24
```

- 冲突文件 **24**，工作树 `^<<<<<<< ours` 标记 **41** 处（逐文件分布：`ProjectView.tsx` 8、`watch.mjs` 4、`server.mjs` 3、`local-agents-ipc`/`main.mjs`/`studio.mjs`/`render.mjs`/`ProjectsLibrary` 各 2，其余 1）。
- 数字与背景一致，**脚本修复有效**：overlay 自身（`overlay/`、`scripts/vendor/`）没有被 restore 删掉。

### 2.2 保 ours 之后的收敛过程（每一步都实测）

| 步骤 | 动作 | tsc 错误 |
|---|---|---|
| 0 | 基线 `9374a88` 原样 | **0** |
| 1 | `git checkout 9374a88 -- <24 个含标记文件>`（任务给的规则） | **23** |
| 2 | + 30 个 3-way 杂交 patch 文件回退 ours | 21 |
| 3 | + 6 个自有机制文件回退（`overlay/*`、`scripts/vendor/apply-overlay.mjs`、`overlay.md`） | 21 |
| 4 | + 77 个既有 UI 源文件回退 ours（上游 UI 重构的邻居） | 20 |
| 5 | + 删除 8 个无法编译的上游新增文件 | **0** |

> 基线 0 错误的测法：worktree 与 index 分离（`index` 始终持有 drop 树 `ed31afd`），用 `git restore --source=9374a88 --worktree -- .` 把工作树整体切回 9374a88 测一遍，再 `git restore --worktree -- .` 从 index 复原。可逆，未动 index。

### 2.3 本次实际采用的取舍规则（重要）

> **上游文本只有在「不与我们的代码发生语义碰撞」时才保留；一旦碰撞，整片保留 ours，并把上游那份改进登记进本文。**

据此被回退成 ours 的 4 类：

| 类 | 数量 | 为什么不能采纳上游 |
|---|---|---|
| 24 个含标记文件 | 24 | 任务规定保 ours；内容本身也是我们的行为修复（`localFission`/`desktopAuth`/`isolation`/`home` 注入、`MaterialCenter` 的 `api.savedFiles` 依赖等） |
| 3-way 杂交 patch 文件 | 30 | 结果既非我们亦非上游（例：`package.json` 混了两边的依赖行、`i18n/zh-CN.ts` 混了键集、`ProvidersSection.tsx` 引用了我们 `OwnProvider` 里没有的 `connectionError`）——无意义状态，不能留 |
| 上游重构过的 UI 邻居 | 77 | `packages/openfilm/studio/ui/src/**` 是密耦合网：`LibraryDrawer` 依赖 `AudioList` 的 `libraryArt`/`HereButton(onFetch)`/`MiniPlayer(player,name,group,art)`/`Player<LibraryItem>`；`ProjectView` 依赖 `LayoutMenu` 的 `assets/layers/timeline/inspector` 布尔组、`LayersPanel.onSelectLayers`、模板预览的 3 个 prop、`undo.ts` 的 op 联合类型。上游把这些全改了，**整文件二分在这里就是不可能**（背景里已预警） |
| 自有机制文件 | 6 | drop 从 `productRef=144be1c` 取新文件，会**回退 9374a88 的 overlay 脚本修复**（`new-files.txt` 少 18 行、`desktop.patch` 少 138 行）。这会把"overlay 删掉自己的指令"的老 bug 带回来 |
| 跨边界无守卫签名 | 1 | `apps/desktop/src/chat-ipc.mjs` 的上游版本要求 `filmPutBack`，我们的 `main.mjs:735` 没传且上游在 `:148/:152` 直接 `await filmPutBack(dir)` 无守卫 → 运行期 TypeError。见 D16 |

**净结果：**

```
9374a88 -> chore/vendor-0.3.2（+ 本文档）
  A（上游新增）  72        （+ 本文档本身 = 73）
  M（上游修订） 115
  D              0
  packages/openfilm 119 · apps/desktop 58 · packages/shared 8 · .github 2
  未变动（仍是我们的）3095 个跟踪路径（3210 tracked − 115 modified）
```

---

## 3. 上游语义增量清单（16 项）

字段约定：**上游** = `upstream-v0.3.2` 的行号；**我们** = `9374a88` 的行号；**动作** = 要补的具体改动；**验收** = 该跑的测试。后标 ⛔ 的是硬冲突（采纳上游必须改我们代码），🔒 的是本次因它删了文件。

### D1 ⛔ `host.canvasWriting` 接线

| 项 | 内容 |
|---|---|
| 上游 | `packages/openfilm/studio/ui/src/lib/host.ts:17`（`export type HostWritingModel = { agent: HostAgentId; options: Record<string, string \| number \| boolean> }`）、`:47`（`canvasWriting?: { Picker: React.ComponentType<{ triggerClassName?: string }>; selection: () => HostWritingModel \| null }`）；注入点 `apps/desktop/shell/main.tsx:12,16`（`host.canvasWriting = { Picker: CanvasModelPicker, selection: canvasWritingModel }`）；消费者 `ui/src/components/canvas/CanvasView.tsx:734`、`ui/src/components/canvas/panels.tsx:657` |
| 我们 | `ui/src/lib/host.ts:44`（`ask?:` 之后直接是 `onSelection`，**没有 `canvasWriting`、没有 `HostWritingModel`**）；`apps/desktop/shell/main.tsx:10`（只 import `applyStudioHost`，没有赋值）；`ui/src/components/canvas/CanvasView.tsx:546`（`api.canvasWrite(projectId, ask, inputs)` 只有 3 参） |
| 动作 | ① `host.ts` 加 `HostWritingModel` 类型 + `canvasWriting?` 字段，并在 `applyStudioHost` 里透传；② `shell/main.tsx` 赋值 `{ Picker: CanvasModelPicker, selection: canvasWritingModel }`（`chat/src/components/ModelPopover.tsx:64,68` 这两个导出我们**已经有**，只差接线）；③ `CanvasView` 取 `studioHost?.canvasWriting?.selection()` 作 `api.canvasWrite` 第 4 参；④ `panels.tsx` 用 `Picker` 渲染左下角入口 |
| 验收 | `tsc -p packages/openfilm/studio/ui --noEmit` · `node --test packages/openfilm/studio/server/canvas.test.mjs` · `node --test packages/openfilm/studio/canvas-turn-restore.test.mjs` |

### D2 ⛔ `WorkspaceLibraryPane` 工作区骨架

| 项 | 内容 |
|---|---|
| 上游 | `ui/src/components/WorkspaceLibraryPane.tsx:8`（`export function WorkspaceLibraryPane({ open, dock, rect, children, free = false, onResize })`）、`:5`（`WorkspaceLibraryPane.module.css`）；接线 `ui/src/components/ProjectView.tsx:106`（import）、`:2777`（`const dockGeometry = canvasOpen ? canvasDock : editDock`）、`:5051-5068`（`<WorkspaceLibraryPane open={libraryOpen} dock={…} rect={…}>`）；配套 `components/ProjectLayoutMenu.tsx:11`（`{ className?; value: WorkspaceLayout; onChange; onReset }`）、`components/WorkspaceEditor.tsx`、`components/WorkspacePreview.tsx`、`lib/workspaces.ts`、`lib/use-workspaces.ts`、`lib/workspace-dock.ts`、`lib/workspace-preview.ts`、`components/ProjectTabs.tsx` |
| 我们 | `ui/src/components/ProjectView.tsx:242`（`ProjectView({ projectId, onProject, onLeave, foreground = true, … })`，**无 dock 几何、无 WorkspaceLibraryPane**）；我们的工作区形态在 `components/StandaloneWorkspace.tsx`，两者不是同一套 |
| 动作 | 以 `lib/workspaces.ts` 的 `WorkspaceLayout` / `workspaceGeometry` / `dockFrames` 为骨架，把 `dockGeometry` 与 `WorkspaceLibraryPane` 接进 `ProjectView`；把 `ProjectLayoutMenu` 从「`assets/layers/timeline/inspector` 四个布尔 + 若干回调」改成「`value` + `onChange` + `onReset`」；**必须同时保留我们的 `foregroundRef`**（见 D9）。注意我们其余 12 个调用 `ProjectLayoutMenu` 的地方会一起断，需要一并改 |
| 验收 | `node --test packages/openfilm/studio/workspaces.test.mjs` · `node --test packages/openfilm/studio/ui/src/lib/workspaces.test.ts`（走 UI 的 ts 测试入口）· `workspace-dock.test.ts` · `workspace-preview.test.ts` · `ui/src/components/project-view-host-pane.test.ts` |

### D3 ⛔ `api.savedFiles` 迁移 + `api.ts` 契约对齐

| 项 | 内容 |
|---|---|
| 上游 | `ui/src/api.ts:162`（`duplicateProject`）、`:216`（`canvasWrite(id, prompt, inputs, model?: HostWritingModel, attachments: string[] = [])`）、`:294`（`{ type: 'canvas'; reset?: boolean }`）；op 联合类型新增 `\| { op: 'track-layout'; at: number; from: string[][]; to: string[][] }` 与 `newTrackAttrs?: Track['attrs']`；`Clip` 新增 `disabled?: true`；`film()` 变 `async` 并校验 `rev`/`project`；`projects()`/`files()` **去掉了 `AbortSignal`** |
| 我们 | `ui/src/api.ts:258`：`savedFiles: (signal?: AbortSignal) => call<SavedListing>('saved/files', { signal })`，以及 `SavedFile` / `SavedListing` 两个类型——**上游 v0.3.2 完全没有这两个东西**。消费者 `ui/src/components/MaterialCenter.tsx:76,101`；契约断言 `ui/src/components/material-center-no-raw.test.ts:127`（`assert.match(center, /api\.savedFiles\(\)/, 'the Saved library is read through the native saved/files route')`） |
| 动作 | 以上游 `api.ts` 为底稿，**重新叠加我们这三样**：① `savedFiles()`；② `SavedFile` / `SavedListing` 类型；③ `projects`/`film`/`files` 的 `AbortSignal` 透传（上游删了 signal，我们的 `MaterialCenter` 取消订阅要靠它）。然后再把 `MaterialCenter` 切到新版 api 的其余方法。**顺序很重要**：先叠 `savedFiles` 再切其他，否则 `MaterialCenter` 一编译就断 |
| 验收 | `node --test packages/openfilm/studio/ui/src/components/material-center-no-raw.test.ts` · `ui/src/lib/material-center-library.test.ts` · `ui/src/lib/material-center-*.test.ts` 全体 · `tsc -p packages/openfilm/studio/ui` |

### D4 `server.mjs` 的 duplicate 路由

| 项 | 内容 |
|---|---|
| 上游 | `packages/openfilm/studio/server/server.mjs:40`（import `duplicateProject`）、`:684-686`（`if (parts.length === 3 && parts[2] === 'duplicate' && req.method === 'POST')` → `duplicateProject(parts[1], name)`） |
| 我们 | `packages/openfilm/studio/server/server.mjs` 里**没有 duplicate 路由、没有 import**；projects 段在 `:1060`（`rest === 'files'`）之前 |
| 动作 | ① import `duplicateProject`；② 在 `/p/:id` 段加 `duplicate` 分支；③ `api.ts` 加 `duplicateProject(id, name)`（D3）；④ `Components/ProjectsLibrary.tsx` 加「复制项目」入口——上游 UI 里那个必填的 `onDuplicate` prop 就是这里来的 |
| 验收 | `node --test packages/openfilm/studio/server/projects-control.test.mjs` · `projects-isolation.test.mjs` · `server/http.test.mjs`（上游新增，含 duplicate 用例） |

### D5 `server.mjs` 的 `notifyReferences`

| 项 | 内容 |
|---|---|
| 上游 | `server.mjs:691`（`const notifyReferences = async (work) => {…}` 定义）、调用点 `:934`（`bringIn`）、`:942`（`relink`）、`:971`（`collect`）、`:1006`（`moveFile`）、`:1009`（`trashFile`） |
| 我们 | `server.mjs:1088`（`return json(res, 200, await moveFile(project.path, from, to))`）、`:1091`（`await trashFile(project.path, at)`）**直接返回，没有任何引用变更通知**；files 段起于 `:1060` |
| 动作 | 引入 `notifyReferences` 包装器（把每次引用变化推给 Studio 的 watcher/客户端，让打开的 film 里失效引用及时刷新），把上面 5 个文件操作调用点包起来；与 D6 的 rev 推送联动 |
| 验收 | `node --test packages/openfilm/studio/server/server-request-drain.test.mjs` · `server-watch-drain.test.mjs` · `saved-library-ownership.test.mjs` · `server/http.test.mjs` |

### D6 `watch.mjs` 的 mtime 轮询

| 项 | 内容 |
|---|---|
| 上游 | `packages/openfilm/studio/server/watch.mjs:61-68`（`const stamp = () => …\`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}\``，`statSync(file, { bigint: true, throwIfNoEntry: false })`）、`:69`（注释「Poll only the timeline file's metadata」）、`:71-77`（`initialStamp` / `checkedStamp` 收敛，`flush` 前先比指纹） |
| 我们 | `watch.mjs:56-57`（`settleProjectFilm` / `settleFiles` 注入点）、`:110-119`（先 `settleFilm(root, { stable: true })` 再推 rev）——**完全没有 stat 指纹，靠 settle 兜底** |
| 动作 | 加 `stamp()` + 轮询定时器：只有 `stamp()` 变化才重读 film，避免每次心跳都读盘解析；`bigint: true` 是有意的（`mtimeNs` 精度）。**必须保留我们的 `trustedNode` 注入点**（`watch.test.mjs` 靠它注入假 settle） |
| 验收 | `node --test packages/openfilm/studio/server/watch.test.mjs` · `server-watch-drain.test.mjs` |

### D7 ⛔ `local-agents-ipc` 的 `onTurn` / `ask(…options, images)` 新签名

| 项 | 内容 |
|---|---|
| 上游 | `apps/desktop/src/local-agents-ipc.mjs:157`（`registerLocalAgentIpc(ipcMain, { …, onTurn = (_turn) => {}, … })`）、`:201`（`onTurn({ kind: 'asking', agent, cwd, meta })`）、`:392`（`onTurn({ kind: outcome, …, error })`）、`:503`（`ask: async (agent, text, signal, options = {}, images = [])`）、`:515-519`（`promptCapabilities.image` 校验 + `imageBlocks()` + 「Could not attach all reference images.」） |
| 我们 | `apps/desktop/src/local-agents-ipc.mjs:513`（`ask: (agent, text, signal) => {`）——**无 `options`、无 `images`、无 `onTurn`**。注意我们的 prompt/steer 路径**已经有** images 支持（`:363`、`:434`），只有 `ask` 这条路没有 |
| 动作 | ① `ask` 扩成 5 参，复用我们已有的 `imageBlocks()`（`:108`）并补 image 能力校验；② 加 `onTurn` 回调，在 asking/done/failed 三处触发；③ `studio.mjs` 侧把 `onTurn` 接到 turn 通知上——`apps/desktop/src/turn-notices.mjs` 与 `i18n/turn-notices.mjs`（本次已保留）就是配套 |
| 验收 | `node --test apps/desktop/src/local-agents-ipc.test.mjs` · `apps/desktop/src/studio.test.mjs` · `apps/desktop/src/turn-undo.test.mjs` |

### D8 `library-search` 的 `refreshCommunity` 顺序

| 项 | 内容 |
|---|---|
| 上游 | `packages/openfilm/src/library-search.mjs:17`（`import { …, refreshCommunity } from '../studio/server/library.mjs'`）、`:268`（`export async function searchLibrary(kind, query, o = {}) { await refreshCommunity(); …`——**第一行就刷**）、`:363`（`if (take.startsWith('community/') \|\| take.startsWith(\`${BUILT_IN}/community/\`)) await refreshCommunity();`） |
| 我们 | `packages/openfilm/src/library-search.mjs:267`（`searchLibrary` 直接开始查词，**没有 refresh 前置**）；`studio/server/library.mjs` 本次已采用上游（`:36` import `community-library.mjs`、`:39` re-export、`:187` `if (isCommunity(id)) await refreshCommunity()`），所以缺的只是 search 这一侧的顺序 |
| 动作 | ① `searchLibrary` 开头补 `await refreshCommunity()`；② `take` 命中 community 前缀时先 refresh；③ 确认我们的 `library-semantic` near 计算发生在 refresh **之后**（顺序错会漏掉刚拉到的社区素材，症状是语义搜索对社区内容"看不见"） |
| 验收 | `node --test packages/openfilm/src/library-search.test.mjs` · `library-semantic-isolation.test.mjs` · `packages/openfilm/studio/server/community-library.test.mjs` |

### D9 ⛔ `ProjectView` 的 foreground / 工作区改动

| 项 | 内容 |
|---|---|
| 上游 | `ui/src/components/ProjectView.tsx`：**没有 `foreground` 这个概念**；工作区侧 `:102`（import `@/lib/workspaces`）、`:844`（`updateWorkspace`）、`:972`（`freeFrames(layout)`）、`:2721`（`workspaceLayout`）、`:2777`（`dockGeometry`）、`:5051`（`WorkspaceLibraryPane`） |
| 我们 | `ProjectView.tsx:242`（`foreground = true` 形参）、`:244`（类型）、`:261-262`（`foregroundRef` + 每次渲染同步）、以及 **13 处前台判定**：`:506`、`:692`、`:820`、`:2803`、`:3809`、`:3818`、`:3947`、`:3960`、`:3961`、`:3997`、`:4177`（`whenProjectForeground`） |
| 动作 | **两套都要，不能二选一**：`foregroundRef` 是我们自己的后台标签页节流（丢掉 → 后台页狂跑 player/命令队列），上游没有对应物；上游的 `WorkspaceLayout`/`dockGeometry` 是新工作区形态。做法：先把 `foreground` 语义按原样保留，再把 D2 的骨架接进来，逐处确认 13 个前台判定点在新工作区布局下仍然生效 |
| 验收 | `node --test packages/openfilm/studio/ui/src/components/project-view-host-pane.test.ts` · `ui/src/lib/workspaces.test.ts` · `node --test packages/openfilm/studio/workspaces.test.mjs` · `canvas-turn-restore.test.mjs` |

### D10 ⛔ 上游 UI 组件签名迁移（tsc 断链的邻居，整批做）

| 项 | 内容 |
|---|---|
| 上游 | `ui/src/components/library/AudioList.tsx:62`（`usePlayer<T extends Playable>(onFailed, cacheKey = (item) => item.id, analyse = false): Player<T>`）、`:104`（`HereButton({ here, addTip, onAdd, onRetry, className, show = 'grid' })`——**`onFetch` 改名成了 `onRetry`**）、`:322`（`MiniPlayer<T extends Playable>({ target, player, name })`——**我们传的是 `(player, name, group, art)`**）；`libraryArt` **已从 AudioList 删除**；`ui/src/components/library/VoicesPane.tsx:34`（`{ group, query, favorites, onServices, onAll, speak, player, previewBar, picked, onPick, onClosePreview }`——多 5 个 prop） |
| 我们 | `ui/src/components/library/LibraryDrawer.tsx:24`（`import { …, libraryArt, usePlayer } from './AudioList'`）、`:298`、`:440`、`:466`、`:474`、`:492`、`:751`（6 处调用点，全部对应上面的签名变化） |
| 动作 | 一次改完 4 件事：① `usePlayer` 泛型化（`Player<Playable>` vs 我们的 `Player<LibraryItem>`）；② `MiniPlayer` 从 `(player,name,group,art)` 改 `(target,player,name)`；③ `HereButton` 的 `onFetch`→`onRetry`；④ `VoicesPane` 加 `player/previewBar/picked/onPick/onClosePreview` 五件套（联动 `lib/library-player.ts`，本次已保留）。**本次选择维持我们这套**（回退 `AudioList`/`VoicesPane` 到 ours），所以这 6 处一个都没动 |
| 验收 | `node --test packages/openfilm/studio/ui/src/lib/library-player.test.ts`（上游新增，当前未接线）· `ui/src/components/library/*.test.*` · `tsc` |

### D11 🔒 `host.openfilm` / `saveOpenFilmModels`（`OpenFilmAgentDialog.tsx` 被删的前置）

| 项 | 内容 |
|---|---|
| 上游 | `ui/src/components/settings/OpenFilmAgentDialog.tsx:5`（`import type { HostOpenFilmModel } from '@/lib/host'`）、`:23`/`:84`（`HostAgent.openfilm`）、`:34`（`studioHost.agents.saveOpenFilmModels`） |
| 我们 | `ui/src/lib/host.ts`（**没有 `openfilm` 命名空间**）；`apps/desktop/src/openfilm-models.mjs`（本次已保留）、`apps/desktop/chat/src/state/local-agent-store.ts`（静态 import 了它） |
| 动作 | `host.ts` 增 `openfilm: Record<HostAgentId, HostOpenFilmModel>` 与 `saveOpenFilmModels()`；在 `applyStudioHost` 里由 desktop 侧注入；然后从 `upstream-v0.3.2` 取回 `ui/src/components/settings/OpenFilmAgentDialog.tsx` |
| 验收 | `node --test apps/desktop/src/openfilm-models.test.mjs`（已保留）· `apps/desktop/bench/openfilm-models.tsx` |

### D12 🔒 `Board.reportError` / `Board.shown`（`canvas/video.tsx` 被删的前置）

| 项 | 内容 |
|---|---|
| 上游 | `ui/src/components/canvas/video.tsx:139`（`board.reportError(...)`）、`:143`/`:147`/`:152`/`:176`（`board.shown`） |
| 我们 | `ui/src/components/canvas/CanvasView.tsx` 里的 `Board` 类型（**无 `reportError`、无 `shown`**） |
| 动作 | 给 `Board` 加 `shown`（画布是否可见，用于暂停解码）与 `reportError`（错误上报到 canvas 面板），再接回 `video.tsx` / `video.module.css` |
| 验收 | `node --test packages/openfilm/studio/canvas-video.test.mjs`（已保留，当前未接线） |

### D13 🔒 `track-layout` 编辑操作（`undo.ts` / `organize-tracks.ts` 被删的前置）

| 项 | 内容 |
|---|---|
| 上游 | `ui/src/api.ts` op 联合类型 `\| { op: 'track-layout'; at: number; from: string[][]; to: string[][] }`；`ui/src/editor/undo.ts:96-97`（`'track-layout'` 分支 + `{ to, from }` 展开）、`:201`（`newTrackAttrs`）；`ui/src/lib/organize-tracks.ts:63`（发出 `{ op: 'track-layout', at, from, to }`） |
| 我们 | `ui/src/api.ts` 的 op 联合（**无 `track-layout`、无 `newTrackAttrs`**）、`ui/src/editor/undo.ts`（我们版没有对应分支） |
| 动作 | ① 扩 op 联合类型；② `undo.ts` 加 track-layout 的 undo/redo 分支（记录 track→tracks 的重排前后）；③ 才能恢复 `lib/organize-tracks.ts`（整理轨道），进而恢复 `studio/timeline-organize-tracks.test.mjs`。**注意这三步必须一起做**——只加 op 类型会得到 `undo.ts:96` 那种「no overlap」的半吊子状态 |
| 验收 | `node --test packages/openfilm/studio/timeline-organize-tracks.test.mjs`（本次已删，接线时取回）· `timeline-range-clear.test.mjs` |

### D14 🔒 `voicePalette`（`VoiceOrbCanvas.tsx` 被删的前置）

| 项 | 内容 |
|---|---|
| 上游 | `ui/src/components/library/VoiceOrbCanvas.tsx:3`（`import { voicePalette } from '@/lib/library-voices'`）、`:138-139`（`{ color }`、`{ x, y, radius }` 解构） |
| 我们 | `ui/src/lib/library-voices.ts`（**没有 `voicePalette`**） |
| 动作 | 在 `library-voices.ts` 导出上游的 `voicePalette` 色板，再接回 `VoiceOrbCanvas.tsx` |
| 验收 | `tsc -p packages/openfilm/studio/ui` · 音色相关 UI 用例 |

### D15 上游 `pnpm-lock.yaml` 的依赖变更（本次按约定未采纳）

| 项 | 内容 |
|---|---|
| 上游 | `overrides` 新增 `minimatch@>=7 <11.0.1: ^11.0.1`；新增包 `@isaacs/nonrecursive-glob-match@1.1.0`；`minimatch@10.2.6` → `minimatch@11.0.5`；**删掉了 `apps/api: {}` 这个 importer** |
| 我们 | `pnpm-lock.yaml` 与 `9374a88` **哈希完全一致**（`14ae96e`），本次未动 |
| 动作 | 若要采纳：**只取 `overrides` + minimatch 那几行**，不要整体覆盖——上游的 lock 没有 `apps/api` importer（那是我们独有的 app），整取会把 `apps/api` 的依赖树弄丢。改完必须 `pnpm install` 验证 |
| 验收 | `pnpm install --frozen-lockfile` · `pnpm -r typecheck` |

### D16 跨边界无守卫签名：`chat-ipc` 的 `filmPutBack`（本次回退的点）

| 项 | 内容 |
|---|---|
| 上游 | `apps/desktop/src/chat-ipc.mjs:75`（`registerChatIpc(ipcMain, { trusted, projects, dataDir, reveal, trash, tell, log, filmPutBack })`）、`:148`（`await filmPutBack(dir).catch(…)`）、`:152`（`await filmPutBack(dir, true).catch(…)`）——**两处都是直接调用，没有 `?.`、没有默认值** |
| 我们 | `apps/desktop/src/main.mjs:735`（`registerChatIpc(ipcMain, {…})` 的 options 里**没有 `filmPutBack`**） |
| 动作 | 在 `main.mjs` 实现 `filmPutBack(dir, done?)`（告诉 Studio 把 film / canvas 回退），再采纳上游 `chat-ipc.mjs`。否则 turn-undo 路径抛 `TypeError: filmPutBack is not a function` |
| 验收 | `node --test apps/desktop/src/turn-undo.test.mjs` |
| 备注 | 本次因这条回退了 `chat-ipc.mjs`（其余 3 处签名变化都安全：`page-presentation.mjs:52` 有 `!resume` 守卫、`captions.mjs:485` 是 `{ timelineOnly = false } = {}`、`canvas.mjs:320` 是 `root = ''`）。`turn-undo.test.mjs` 只是把 `filmPutBack` 当默认 no-op 形参传入，不断言其被调用，所以回退对它安全 |

---

## 4. 上游新增文件：保留 / 删除

实跑 `apply-overlay` 后工作树多出 **80 个未跟踪文件**，全部来自 `upstream-v0.3.2`（`9374a88` 没有）。

### 4.1 判断规则

1. **能在我们当前类型层上编译通过 → 保留**；编译不过且需要先改我们代码 → **删除**（否则 `tsc` 直接红，且它是死代码）。
2. **被保留下来的文件引用 → 保留**（不管能不能编译，删了就断链）。
3. **纯数据 / 生成脚本、无引用、无冲突 → 保留**（成本为零，接线时省一次取回）。
4. **上游用例 → 保留**，它们是 D1–D14 的验收标准；但**现在跑是红的**（见 §4.4）。

### 4.2 已删除 8 个（全部实测编译失败 + 零引用）

| 文件 | 为什么留不住 | 对应增量 |
|---|---|---|
| `ui/src/components/AppMenu.tsx` | 给我们的 `Menu` 传了不存在的 `block` prop，且 `onEscapeKeyDown` 的 `event` 隐式 any | 组件契约（D10 同类） |
| `ui/src/components/AppMenu.module.css` | 只服务上一行 | — |
| `ui/src/components/canvas/video.tsx` | `Board.reportError` / `Board.shown` 不存在（5 处错误） | **D12** |
| `ui/src/components/canvas/video.module.css` | 只服务上一行 | — |
| `ui/src/components/library/VoiceOrbCanvas.tsx` | `voicePalette` 不存在（4 处错误） | **D14** |
| `ui/src/components/settings/OpenFilmAgentDialog.tsx` | `HostOpenFilmModel` / `HostAgent.openfilm` / `saveOpenFilmModels` 都不存在（6 处错误） | **D11** |
| `ui/src/lib/organize-tracks.ts` | `track-layout` op 不存在于我们的联合类型（3 处错误） | **D13** |
| `packages/openfilm/studio/timeline-organize-tracks.test.mjs` | 上一条的验收用例，随它一起去 | **D13** |

> 校验过：这 8 个在整棵树里**零 import**（`AppMenu`、`canvas/video`、`VoiceOrbCanvas`、`OpenFilmAgentDialog`、`organize-tracks` 五个名字全树 grep 无引用方）。删除对现有代码零影响。
> 取回命令（接线 D11–D14 时用）：
> `git checkout upstream-v0.3.2 -- <上面每个路径>`

### 4.3 保留 72 个，五组

| 组 | 数量 | 代表 | 保留依据 |
|---|---|---|---|
| 服务端新模块 | 6 | `studio/server/community-library.mjs`、`account.mjs`、`hevc-alpha.mjs`、`jianying-captions.mjs`、`src/canvas-attachments.mjs`、`src/render-resume.mjs` | 已被采纳的上游模块静态引用：`library.mjs:36`→`community-library`、`canvas.mjs`→`canvas-attachments`、`jianying.mjs`→`jianying-captions`、`render.test.mjs`→`render-resume`。删一个立刻断链 |
| desktop 新模块 | 4 | `src/openfilm-agent.mjs`、`src/openfilm-models.mjs`、`src/turn-notices.mjs`、`src/i18n/turn-notices.mjs` | `agent-roster.mjs`（动态 import）、`pi-agent.test.mjs`、`chat/src/state/local-agent-store.ts` 已经在引用；且是 **D7 / D11** 的依赖 |
| 工作区骨架 | 17 | `WorkspaceLibraryPane.tsx/.module.css`、`WorkspaceEditor.tsx/.module.css`、`WorkspacePreview.tsx`、`lib/workspaces.ts`、`use-workspaces.ts`、`workspace-dock.ts`、`workspace-preview.ts`、`ProjectTabs.tsx/.module.css`、`ProjectLayoutMenu.module.css`、`ToolbarSurface.module.css`、`SocialLogo.tsx`、`settings/DialogIdentity.tsx`、`settings/LibraryCategoriesGroup.tsx`、`settings/ReorderList.tsx` | 全部通过 tsc；是 **D2 / D9** 的骨架正文。删了等于把上游这块重写一遍 |
| 画布/库小件 | 8 | `canvas/CanvasLoading.tsx`、`canvas/connections.tsx`、`canvas/load.ts`、`library/AudioArtwork.module.css`、`lib/after-paint-idle.ts`、`lib/click-open.ts`、`lib/product-links.ts`、`lib/library-player.ts` | 通过 tsc，被保留的工作区/库文件引用（`library-player.ts` 是 **D10** 的配套） |
| 数据 + 用例 | 37 | `skill-catalog-seed.json` + `scripts/skill-catalog-seed.mjs`；用例 `canvas-{hidden,turn-restore,video,warm}.test.mjs`、`clip-disable`、`export-original-media`、`library-trial`、`server/http.test.mjs`、`nle-{editable,source,windows-path}.test.mjs`、`exports-master-grain`、`timeline-range-clear`、`community-library.test.mjs`、`account.test.mjs`、`clip-export-regressions`、`render-resume.test.mjs`、`desktop/src/*.test.mjs`(6)、`bench/*`(5)、`ui/src/lib/*.test.ts`(4)、`shared/src/markdown-blocks.test.ts`、`studio/workspaces.test.mjs` | 数据文件零冲突；用例是每一条增量的验收标准 |

### 4.4 保留用例的已知代价

这 21 个上游用例**现在跑会红**——它们断言的是我们还没接线的上游行为（`http.test.mjs` 要 `duplicate`、`canvas-video.test.mjs` 要 `video.tsx`、`workspaces.test.mjs` 要新布局…）。

两种处理，取决于你要这条分支"有用"还是"绿"：

```bash
# A（本次采用）保留，把验收标准随分支落库；D1–D14 落地时它们逐条转绿
# B 要一条绿的分支：现在把它们一起删掉，接线时统一取回
git diff --cached --name-only HEAD -- '*test.mjs' '*test.ts' | xargs git rm --cached
git checkout upstream-v0.3.2 -- <需要的那几个>   # 接线时逐批取回
```

---

## 5. 静态一致性核查记录（全部实跑）

| 核查项 | 方法 | 结果 |
|---|---|---|
| 基线 tsc | worktree 切回 `9374a88`（index 保留 drop 树 `ed31afd`），测完复原 | **0 错误** → 后面的错误确实是本次引入 |
| 最终 tsc | `tsc -p packages/openfilm/studio/ui --noEmit` | **exit 0，0 错误** |
| 语法 | `node --check` 扫全部 118 个改动的 `.mjs/.cjs/.js` | **0 失败** |
| 关键文件 | 15 个（`server.mjs`、`watch.mjs`、`local-agents-ipc.mjs`、`studio.mjs`、`studio-process.mjs`、`main.mjs`、`library-search.mjs`、`media-links.mjs`、`render.mjs`、`exports.mjs`、`projects.mjs`、`local-models.mjs`、`skill-catalog.mjs`、`providers/index.mjs`、`apply-overlay.mjs`） | **15/15 ok** |
| 相对导入 | 解析 375 条相对 import 的目标是否存在 | **0 缺失**（唯一告警 `timeline.test.mjs:1474` 的 `./needed.mjs` 是写进临时目录的字符串夹具，非真导入） |
| 具名导入 | 我们的未改动模块对 4454 条具名 import 做导出比对 | **0 真实缺失**（首轮报 6 条，全部是我的解析器漏了 `export type { … }` / `export interface` / `@typedef {{…}}`，逐一人工核对后确认存在） |
| 跨边界签名 | 我们未改动模块所 import 的上游模块，逐个比函数形参 | 4 处变化 → **3 处安全**（默认值/守卫）、**1 处无守卫**（D16，已回退 `chat-ipc.mjs`） |
| 外部依赖 | 72 个新增文件用到的裸包名 vs 各 `package.json` | **全部已声明**（只用到 `@xyflow/react`、`lucide-react`、`openfilm`、`playwright-core`、`react`、`react-dom`、`vite`；`@/` 是 tsconfig alias） |
| `pnpm-lock.yaml` | `git hash-object` vs `9374a88` | **完全一致**（`14ae96e`） |
| index 状态 | `git diff --cached --name-status HEAD` | A=73（含本文）、M=115、D=0；`git status` 无未暂存项 |

---

## 6. 未验证 / 残余风险（交接要点）

1. **服务端 `.mjs` 的行为兼容性未验证。** `files.mjs`、`saved.mjs`、`library.mjs`、`canvas.mjs`、`jianying.mjs`、`captions.mjs` 等已被采纳为上游版本，而我们的 `server.mjs` 是原样保留。已静态确认**导出面完全匹配**、**签名只有 3 处良性扩展**，但函数**语义**（返回结构、路径规范化、错误码）没有跑过任何测试。第一件事应该是跑 `server/*.test.mjs`。
2. **本轮没有跑任何测试。** 只做了静态校验（tsc / `node --check` / 导入与导出对账）。`pnpm test` 未执行，上游那 21 个用例大概率红（§4.4）。
3. **115 个文件的上游改进被整体推迟。** 尤其是 `packages/openfilm/studio/ui/src/**` 那 77 个——不是"我们不需要"，而是"要一次改完"（D2/D9/D10）。逐文件挑着采纳会反复断链。
4. **`package.json` 仍是我们的**，上游新增的依赖声明没有进来（已核对：保留的 72 个文件不需要新依赖，所以当前不缺东西；但 D15 的 minimatch override 若要采纳得单独做）。
5. **镜像方向未做穷尽核查。** 我查的是"我们的代码 → 上游模块"（参数、导出）。反方向"上游代码 → 我们的模块"只做了导出比对；上游调用我们模块时若依赖我们某个形参**被解构**，理论上仍可能断。这类只有跑测试能发现。
6. **分支未 commit。** 按约定只 `git add -A`。

---

## 7. 建议的接线顺序（按"每步都能独立验收"排）

1. **D13 / D14 / D11 / D12** —— 四条小而独立，各自只恢复 1 个被删文件 + 1 个类型扩展。做完 tsc 稳定，且这 4 个文件回来了。
2. **D8**（library-search 的 refresh 顺序）—— 一行前置 + 一个分支，语义风险最低，能立刻验证社区素材是否漏。
3. **D6**（watch 的 mtime 轮询）—— 纯内部优化，不碰契约。
4. **D5 → D4**（`notifyReferences` → `duplicate` 路由）—— 两个独立路由改动，一起跑 `server/*.test.mjs`。
5. **D3**（`api.ts` 契约 + `savedFiles` 重新叠加）—— UI 与服务端的接缝，必须在 D2 之前做完。
6. **D7**（`onTurn` / `ask(…images)`）—— desktop 侧独立，可与上面并行。
7. **D1 → D2 + D9 + D10**（canvasWriting → 工作区骨架 → ProjectView → 库组件签名）—— 最后一起做，因为 D2/D9/D10 是同一次 UI 重构的三个面，分开做会反复断链。
8. **D15 / D16** 收尾。

> 每一步做完的验收口径统一为：`tsc -p packages/openfilm/studio/ui --noEmit` 0 错误 + 该条列出的测试转绿 + `node --check` 不回归。
