# Overlay 冲突分诊表：24 个 conflicted 文件逐个裁决

日期：2026-11-13。分支 `feat/seams` @ `c222314`；base `upstream-v0.3.2` @ `e01b37f`；overlay 切点 `7713d38`（v0.3.0）。
本文只读代码 + 只写这一份文档，不 commit / 不 push / 不动 `pnpm-lock.yaml`。

## 0. 结论先给

| 裁决 | 文件数 | 冲突标记数 |
| --- | --- | --- |
| `take-theirs` | **1** | 1（整块消失） |
| `keep-ours` | **2** | 5（整块消失） |
| `merge` | **21** | **40** |
| 合计 | 24 | 46 |

- 46 个冲突标记 = 排练实测（见 §1 复现方法），不是估算。
- 21 个 `merge` 文件里，**16 个是纯并集（20 个 hunk，照 §4 的“合成行”抄即可）**，**只有 5 个文件 / 20 个 hunk 需要人判断**：
  `ProjectView.tsx`(8)、`watch.mjs`(5)、`server.mjs`(4)、`local-agents-ipc.mjs`(2)、`library-search.mjs`(1)。
- 即：真正逐 hunk 的工作量落在 **5 个文件、20 个 hunk**（目标 ≤5 文件 ✔）。
- 域分布与 `overlay.md` 一致：studio 15（`server` 7 + `ui` 8）、desktop 6、openfilm/src 3。
- 3 个锚点缺失文件里，`Launcher.tsx`、`LibraryDrawer.tsx` 在冲突表内，`SettingsModal.tsx` 的 3-way 已自动合干净（不在 24 内）——锚点缺失 ≠ 必然冲突，别混为一谈。

## 1. 复现方法与判定口径

```bash
# 冲突清单（唯一来源）
node scripts/vendor/apply-overlay.mjs --dry-run     # clean 83 · conflicted 24

# 我们的改动 / 上游改动（逐个文件）
git log --oneline 7713d38..HEAD            -- <file>
git diff        7713d38..HEAD              -- <file>
git diff        7713d38..upstream-v0.3.2   -- <file>

# 冲突落点排练（本文所有 L 行号都来自这一步，等价于 apply-overlay 的 --3way 结果）
git show 7713d38:<file>        > base;  git show HEAD:<file> > ours;  git show upstream-v0.3.2:<file> > theirs
git merge-file -L ours -L base -L theirs --diff3 ours base theirs
```

注意两个前置事实，否则会误判：

1. `git merge-base 7713d38 upstream-v0.3.2` = `3eacfd6`，**早于 v0.3.0**，所以 `7713d38` 不是上游 tag 的祖先；`git diff 7713d38..upstream-v0.3.2` 是两棵树的全量差，读它时只取与本文件相关的直觉，不要当成“上游提交序列”。
2. 补丁的 preimage 是 `7713d38`，不是 `e01b37f`。`anchors.json` 记录的漂移 identical 48 / modified 53 / binary 6 就是冲突的根因，clean 83 全靠上下文没被上游动到。

裁决只允许三种：`keep-ours`（我们主导，整文件保我们）、`take-theirs`（上游主导，我们的改动抽成新增文件/单点注册）、`merge`（逐 hunk，写明合哪几处）。

## 2. 分诊表（先易后难：take-theirs → keep-ours → merge 1 hunk → 2 → 4 → 5 → 8）

| 文件 | 我们改了什么（一句话 + 提交号） | 上游改了什么（一句话） | 裁决 | 依据 |
| --- | --- | --- | --- | --- |
| `apps/desktop/shell/shell.css` | 文件末尾追加登录页 `.orange-login*` / `.orange-account-exit` 共 15 行（`5e6dd2b`）。 | 同样在末尾追加 chat 分栏与 legacy 边线 9 行（`1f57332`、`0511686`）。 | **take-theirs** | 两边都是“append 到文件尾”，纯顺序冲突，无共享语义；我们的 15 行不依赖上游任何上下文，抽成新增文件 `apps/desktop/shell/orange-login.css`，由我们自己的 `main.tsx` import（该文件已 keep-ours）。0 人工 hunk。 |
| `apps/desktop/shell/main.tsx` | 入口整换成 `DesktopGate` 登录门：auth 状态、登录后才挂 chat、按 generation 重挂 `App`，外加材料草稿会话围栏（`5e6dd2b`、`b5a6933`）。 | 只加 3 行 canvas 写作模型选择器接线（`import { host }` + `host.canvasWriting = {Picker, selection}`，`e01b37f`）。 | **keep-ours** | 上游 3 行、我们整文件；唯一冲突在 import 块。上游那 2 行是“单点注册”，按 `1) 保留 import { host } from './bridge'; 2) 在 applyStudioHost() 前插入 host.canvasWriting = {...}` 补进我们的文件即完成，不做整文件比对。 |
| `packages/openfilm/studio/ui/src/components/Launcher.tsx` | 整文件换成原生首页：三入口卡（Fission/Studio/素材）+ 内嵌 `ProjectsPopover embedded` + “我的项目 recent/all”（`9f9eea5`）。 | 把标题栏换成 `AppMenu` + `ProjectTabs`（8+/16-，`1f57332`、`0511686`）。 | **keep-ours** | 上游改的正是我们替换掉的 tabbed launcher 标题栏；`AppMenu.tsx` / `ProjectTabs.tsx` 作为上游树文件照常落地（`ProjectView.tsx` 的 `studioHost?.tabs` 分支仍引用它们，所以不会变成死文件），只是不被我们的首页引用。该文件同时是 3 个锚点缺失之一，4 个冲突标记随整文件保留一起消失。 |
| `packages/openfilm/studio/server/local-models.mjs` | `localModelsRoute` 加 `{readOnly}`：隔离态非 GET 抛 503 `isolation-capability-unavailable`，GET 不跑 `localModelsChanged()`（`2b14aed`）。 | GET 返回 `{ models }`（`a8c0553` 的 reconcile 结果变量）。 | merge（1 hunk @L63） | 合成：`if (!readOnly) await localModelsChanged(); return json(res, 200, { models });`——取上游变量名，留我们的闸门。纯并集。 |
| `packages/openfilm/src/library-search.mjs` | 隔离态下 `libraryVerbs` 去掉 `--take`、`libraryGet` 拒绝 take 并改写提示文案（`2b14aed`）。 | community 项 take 前先 `await refreshCommunity()`（`ac2b960`、`0511686`）。 | merge（1 hunk @L367） | **需判断**：两个分支都挂在 `if (take !== undefined)` 上。顺序必须是“隔离闸门 → 上游 refreshCommunity → takeOne”，隔离态不许联网。 |
| `packages/openfilm/src/media-links.mjs` | 加 `sourceAuthority`（AsyncLocalStorage）+ `assertSourceAccess()`，`linkAllowed()` 前置校验（`74ae413`）。 | 写路径改成 symlink 安全 + 临时文件 + `randomUUID`（+71 行，`e01b37f`）。 | merge（1 hunk @L10） | 冲突只在 import 行，并集即可：`existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync` + `randomUUID` + `AsyncLocalStorage`。 |
| `packages/openfilm/studio/server/exports.mjs` | 隔离 profile 的导出目录断言与剪映草稿禁用、`qualifyFissionRender()` 三处校验、`createExports({ renderLaunch })`（`ee704c8`、`a052e88`）。 | `captions` 增加 `{ timelineOnly }` 选项（129+/38-，`cb7aad1`、`19448fb` 等）。 | merge（1 hunk @L849） | 冲突只在一行 JSDoc：合成 `captions?: (root: string, options?: { timelineOnly?: boolean }) => …`，同时保留我们的 `renderLaunch?:`。 |
| `packages/openfilm/studio/server/projects.mjs` | 项目访问围栏（`b8e7a69`）、隔离 profile 断言（`ee704c8`、`3e16fa0`）、登录会话（`5e6dd2b`），共 +321。 | `folderName` 之后新增 90 行文件夹能力，并补 `isAbsolute` / `relative` 导入（`0511686`）。 | merge（1 hunk @L27） | 冲突只在 path import：`{ basename, dirname, isAbsolute, join, relative, resolve, sep }`。90 行新增已自动并入。 |
| `packages/openfilm/studio/server/providers/index.mjs` | 隔离态 Services 走本地 store（`isolatedState` / `isolatedProvidersRoute`），并给每行加 `configured`（`c9d0f89`、`2b14aed`）。 | key 失效时 `invalid ? null : source` + 追加 `connectionError`（`1f57332`、`0511686`）。 | merge（1 hunk @L242） | 合成一行：`…, configured: Boolean(key), source: invalid ? null : key?.source ?? null, last4: …,` 并保留下方 `...(invalid ? { connectionError: … } : {})`。 |
| `packages/openfilm/studio/server/skill-catalog.mjs` | `INDEX_URL` 换成 orange-film-skill 索引（含 `OPENFILM_SKILLS_INDEX` 覆盖）（`57c41e8`、`1a88128`）。 | `refreshCatalog` 加 `timeoutMs` 与超时/重试（+138，`1f57332`、`0511686`）。 | merge（1 hunk @L144） | 冲突只在 `refreshCatalog` 的 JSDoc：保留我们的索引来源说明，并入上游 `timeoutMs?: number`。 |
| `packages/openfilm/studio/ui/src/App.tsx` | 首页/项目双态呈现：`homePresentation`、项目实例跨 Home 保留挂载、`StandaloneWorkspace`、材料草稿（`9f9eea5`…`a52e3f5`、`b5a6933`、`8e17574`）。 | 加 `afterPaintIdle` + 预取 canvas 代码块（4+/0，`1f57332`）。 | merge（1 hunk @L12） | 冲突只在 import：保留我们的 `homePresentation / homeEntryForProject / HomeEntry`，加 `afterPaintIdle`、`loadCanvas` 两行（上游那个 `useEffect` 已自动并入我们保留的 `sourcesApi.preload()` 旁）。 |
| `packages/openfilm/studio/ui/src/api.ts` | `projects` / `film` / `files` 加 `AbortSignal`，新增 `savedFiles()` 与 `SavedListing` 类型（`3af3dfe`、`7082bee`）。 | `film()` 改成校验 `rev` 与 `project` 存在（`f27b849`）。 | merge（1 hunk @L170） | 合成 `film: async (id, signal?) => { const film = await call(p(id), { signal }); if (typeof film?.rev !== 'string' \|\| !film.project) throw …; return film; }`。 |
| `packages/openfilm/studio/ui/src/components/canvas/CanvasView.tsx` | 隐藏时清弹层，并给 6 个浮层加 `shown &&` 守卫（`9f9eea5`）。 | BoardView 大改（340+/97-，含 `addFile(path, { at })` 新签名，`f27b849` 等）。 | merge（1 hunk @L1454） | 合成 `{shown && modal === 'history' ? (<HistoryModal … onAdd={(path) => addFile(path, { at: middle() })} …`——我们的守卫 + 上游签名。其余 `shown &&` 已自动并入。 |
| `packages/openfilm/studio/ui/src/components/library/LibraryDrawer.tsx` | `mediaScope` 加 `'cloud'` 并加云管家 `SideBox`（`f69bebe`）。 | 大改（216+/115-：`mediaRequest`、模板、预览条、community）。 | merge（1 hunk @L98） | 合成 props：`mediaScope: 'project'\|'saved'\|'cloud'`、`onMediaScope: (next: 'project'\|'saved'\|'cloud') => void` + 上游 `mediaRequest?: number;`。 |
| `packages/openfilm/studio/ui/src/lib/providers.ts` | `limited` 字段、去掉 `openfilm` 站点、失败立刻 `setProblem`、`reload` 也清 problem（`2b14aed`、`f68adfe`）。 | `reload` 改成 `revision++` + `readProviders().then(announce)`（`e01b37f` 等）。 | merge（1 hunk @L286） | 以上游 revision 骨架为准，把我们“立刻 setProblem / 清 problem”的语义落到 `announce` 与失败分支。 |
| `apps/desktop/src/studio-process.mjs` | desktop auth 全套（`desktopAuth` / 父子 preservation RPC / local Fission 服务）（`ee704c8`…`da456d3`、`5e6dd2b`）。 | 新增 `account:read` 消息处理与 `desktopAccount()` 转发（`e01b37f`、`1f57332`）。 | merge（1 hunk @L64） | 两个分支都插在同一个 message 监听块：保留我们的 `auth-parent-retired` 与 `desktopAuth` 初始化，上游 `if (data?.type === 'account:read') { … }` 整段紧随其后。 |
| `apps/desktop/src/local-agents-ipc.mjs` | 退役封印：`sealed/entered/retiring/records`、`closeAll()`/`resume()`、`ask` 记入 entered、`closeAll` 排空后才确认（`5e6dd2b`）。 | `onTurn` 回调（turn done/failed/asking）+ `ask(agent, text, signal, options, images)`（`e01b37f`、`1f57332`）。 | merge（2 hunk @L160、L539） | @L160 参数表取上游（含 `onTurn = (_turn) => {}`），函数体保留我们的封印初始化；@L539 合成 `ask: (agent, text, signal, options = {}, images = []) => { assertAdmission(); return remember((async () => { … })(), entered); }`。**需判断**：上游 3 处 `onTurn(...)` 调用已自动并入，不能把它们漏在 `if(!entry.closing)` 外。 |
| `apps/desktop/src/studio.mjs` | 隔离启动器：`windowEditorDirectory()`、隔离开关跳过 takeover、权威退出确认、auth 三通道转发（`ee704c8`、`3e16fa0`、`5e6dd2b`）。 | 新增 `readAccount(child, {fresh})` 父子 RPC + `randomUUID` 导入（`e01b37f`）。 | merge（2 hunk @L13、L34） | @L13 import 并集（保留 `utilityProcess` 动态导入方案）；@L34 在 `windowEditorDirectory()` 之后插入上游 `readAccount` 整段。 |
| `packages/openfilm/src/render.mjs` | fission 渲染资格校验、fission 音轨、`-shortest`、`launch` 透传（`a052e88`、`cae5860`）。 | 断点续渲（chunk resume）+ `missed` 探测 + concat 用 `basename(p)`（70+/30-，`19448fb`、`e01b37f`）。 | merge（2 hunk @L131、L366） | @L131 两个都要：`{ ...(opts.launch ? { launch } : {}), ...(opts.root ? { root } : {}), swap, missed, ...(pool ? { browser: lent[0] } : {}) }`；@L366 取上游 `basename(p)` / `parts[0]`（parts 元素已变成路径字符串），保留我们的 `...(fissionProfile ? ['-shortest'] : [])`。 |
| `apps/desktop/src/main.mjs` | 13 个提交：隔离 profile、Fission material 服务子进程、登录、Orange IPC 一处注册、开发者工具（`ee704c8`…`da456d3`、`5e6dd2b`、`0208e0a`）。 | 5 个提交：`createOpenFilmAgent`/`AGENTS` 接线、Windows `appUserModelId`、chat 画布与撤销（104+/23-，`f27b849`、`8813704`、`e01b37f`）。 | merge（2 hunk @L30、L85） | @L30 agents import 并集（加 `AGENTS` + `createOpenFilmAgent`，保留我们的 `closeEverySession`/`sealAgentAdmission`/`resumeAgentAdmission`）；@L85 保留 `if (!isolation) app.setPath('userData', …)`，其前插入 `if (windows) app.setAppUserModelId(IDENTITY.bundleId);`。 |
| `packages/openfilm/studio/ui/src/components/ProjectsLibrary.tsx` | `embedded` 首页模式（去掉遮罩/portal/模态）+ 示例下载对话框取代 GitHub 入口（`9f9eea5`、`f68adfe`）。 | `busy` 加 `'duplicating'`、弹窗底色换 `--bg-topbar-popover`（`e01b37f`、`1f57332`）。 | merge（2 hunk @L284、L480） | @L284 `useState<'creating'\|'opening'\|'duplicating'\|null>` + 我们的注释；@L480 `aria-modal={embedded ? undefined : true}`、非 embedded 分支用上游 `bg-[var(--bg-topbar-popover)]`。 |
| `packages/openfilm/studio/server/server.mjs` | 路由 seam（`orange-routes.mjs`，`90da0a4`）、隔离断言、材料代理与缓存、`desktopAuth` 授权、账户 scoped services（12 提交，305+/69-）。 | `duplicate` 路由、`mediaReferences` 变更通知、community 刷新、字节范围修复（8 提交，71+/19-）。 | merge（4 hunk @L58、L135、L803、L813） | **需判断**：① L58 library import 并集加 `refreshCommunity`；② L135 我们的 `startStudio` 签名（isolation/desktopAuth/localFission…）保留，函数体首行插 `void refreshCommunity();`；③ L803 上游 `duplicate` 路由插在 `desktopAuth.authorizeProjectId(parts[1])` 之后；④ L813 我们的 `projectApiOperation(parts)` 与上游 `const rest = parts.slice(2).join('/')` 是同一件事，只留一处，并把上游 `notifyReferences` 包在随后的 rest 调用链上（watch 依赖它发 `files` 事件）。 |
| `packages/openfilm/studio/server/watch.mjs` | 观察器围栏：`track()` / `closing` / IO 记账、`trustedNode` 注入、`watchFolder` 返回“进入的 IO 与真实 close 完成”的 Promise（`b8e7a69`）。 | film 文件 mtime `stamp()` 轮询补漏（32+/9-，`f27b849`、`e01b37f`）。 | merge（5 hunk @L51、L59、L92、L140、L186） | **需判断**：两套改动同一函数交织。① L51 JSDoc 并集（`trustedNode` + `watch?`）；② L59 签名 `watchFolder(root, send, { trustedNode = {}, watch: watchFiles = watchTree } = {})`；③ L92 播种：保留我们的 `track(async () => …)`，把上游 stamp 条件塞进回调体，并保住上游的 `checkedStamp = null` 失败语义；④ L140 保留 `settleFilm` 包装 + 上游 `const before = stamp();`；⑤ L186 我们的 `try/catch` 内加 `if (!missing && stamp() !== checkedStamp) pending.add('film');` 并让 `pending.size` 参与 `schedule()`。 |
| `packages/openfilm/studio/ui/src/components/ProjectView.tsx` | 云管家做素材面板第三 tab、foreground/host 资产抽屉可见开关、`onHome`、9 提交 +79/-28（`9f9eea5`…`f69bebe`、`a52e3f5`）。 | 画布/工作区大改：`WorkspaceLibraryPane`、`canvasAddFiles`、`CanvasLoading`、请求画布文件、布局编辑器，8 提交 +417/-233。 | merge（8 hunk @L2833、L2870、L4613、L4709、L5121、L5179、L5221、L5256） | **需判断**（唯一超过 4 hunk 的文件，见 §4 逐条）。核心三处：L5179 上游把抽屉包进 `WorkspaceLibraryPane`（`libraryOpen`/`freeGeometry`/`dock`），我们的是 `foreground && hostAssets.open` 面板 —— 取上游骨架 + 我们的 `foreground &&`、`mediaScope='cloud'`；L4709 上游写成 `hostAssets ? null`，我们有意做了可见开关（`f4385a8`、`f4805a8`），必须保我们；L4613 取我们的 `Orange 橙子创作中心` 首页按钮，但**上游 L4610/L4611 的 `AppMenu`+`ProjectTabs` 与 L112–114 的 import 必须一起留或一起删**——`studio/ui/tsconfig.json` 开着 `noUnusedLocals`，只删其中一半会直接 tsc 红。 |

## 3. 三个锚点缺失文件的处置

| 文件 | 锚点缺失原因 | 处置 |
| --- | --- | --- |
| `Launcher.tsx` | 补丁上下文是 v0.3.0 的 tabbed 标题栏，上游 v0.3.2 已换成 `AppMenu`/`ProjectTabs`。 | 已在上表 `keep-ours`：整文件保我们，冲突标记随整文件作废。 |
| `LibraryDrawer.tsx` | 补丁首 hunk 上下文 `export function LibraryDrawer({...})` 的参数表上游已扩张（+`showSkills`/`onServices` 等）。 | 已在上表 `merge`（1 hunk）：只并 props 类型，其余 20 个上游 hunk 自动并入。 |
| `SettingsModal.tsx` | 补丁上下文里的 settings 分组表被上游改过。 | **不在 24 内**：3-way 自动合干净，锚点预检失败不影响本文件落地。 |

## 4. merge 文件逐 hunk 合成行（照抄即可的 16 个文件）

以下 16 个文件共 20 个 hunk，全部是“两边各占一行/一段，合成后都要”，不需要设计判断；行号为 §1 排练结果（`git merge-file --diff3` 的 `=======` 位置），锚点行给出以便在真跑后的文件里定位。

| 文件 | hunk | 锚点 | 合成 |
| --- | --- | --- | --- |
| `studio/server/local-models.mjs` | L63 | `return json(res, 200, { models` | `if (!readOnly) await localModelsChanged();` + `return json(res, 200, { models });` |
| `openfilm/src/media-links.mjs` | L10 | `from 'node:fs'` | `/^import/` 并集：`existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync`；补 `randomUUID`、`AsyncLocalStorage` |
| `studio/server/exports.mjs` | L849 | `* @param {{ onChange?:` | `captions?: (root: string, options?: { timelineOnly?: boolean }) => Promise<…>` + 保留 `renderLaunch?:` |
| `studio/server/projects.mjs` | L27 | `from 'node:path'` | `{ basename, dirname, isAbsolute, join, relative, resolve, sep }` |
| `studio/server/providers/index.mjs` | L242 | `...(p.keyless ? { keyless: true } : {})` | `configured: Boolean(key), source: invalid ? null : key?.source ?? null, last4: …` + 保留 `...(invalid ? { connectionError: … } : {})` |
| `studio/server/skill-catalog.mjs` | L144 | `* let go.` | 保留我们的索引来源说明 + 加 `timeoutMs?: number` |
| `studio/ui/src/App.tsx` | L12 | `import { … } from './lib/projects-page'` | 保留 `homePresentation, homeEntryForProject, HomeEntry, HomeEntryRequest`，加 `afterPaintIdle`、`loadCanvas` |
| `studio/ui/src/api.ts` | L170 | `film: (` | 上游 async 校验体 + 我们的 `signal?: AbortSignal` |
| `studio/ui/src/components/canvas/CanvasView.tsx` | L1454 | `modal === 'history'` | `{shown && modal === 'history' ? (` … `onAdd={(path) => addFile(path, { at: middle() })}` |
| `studio/ui/src/components/library/LibraryDrawer.tsx` | L98 | `mediaScope: 'project' \| 'saved'` | `'project' \| 'saved' \| 'cloud'`（两端都加 cloud）+ 上游 `mediaRequest?: number;` |
| `studio/ui/src/lib/providers.ts` | L286 | `reload: async () =>` | 上游 `revision++; await readProviders().then(announce, () => {})`，失败分支保留我们的 `setProblem` |
| `desktop/src/studio-process.mjs` | L64 | `if (data?.type ===` | 保留 `auth-parent-retired` 块 + 插上游 `account:read` 块 |
| `desktop/src/studio.mjs` | L13 | `import { utilityProcess }` | 保留动态 import 方案 + 上游 `randomUUID` |
| 同上 | L34 | `windowEditorDirectory({` | 保留我们的函数，其后插入上游 `readAccount(child, { fresh })` |
| `openfilm/src/render.mjs` | L131 | `probe = await open(target, {` | `...(opts.launch ? { launch: opts.launch } : {})` + 上游 `missed` |
| 同上 | L366 | `writeFileSync(join(work, 'list.txt')` | 上游 `basename(p)` / `parts[0]` + 我们的 `...(fissionProfile ? ['-shortest'] : [])` |
| `desktop/src/main.mjs` | L30 | `from './agents.mjs'` | 并集（加 `AGENTS`、`createOpenFilmAgent`，留 `closeEverySession`/`sealAgentAdmission`/`resumeAgentAdmission`） |
| 同上 | L85 | `app.setPath('userData'` | 前插 `if (windows) app.setAppUserModelId(IDENTITY.bundleId);`，保留我们的 `if (!isolation) …` |
| `studio/ui/src/components/ProjectsLibrary.tsx` | L284 | `useState<'creating' \| 'opening'` | 加 `'duplicating'` |
| 同上 | L480 | `aria-modal` | `aria-modal={embedded ? undefined : true}` + 非 embedded 用 `bg-[var(--bg-topbar-popover)]` |

**需人判断的 5 个文件**：`library-search.mjs`(L367)、`local-agents-ipc.mjs`(L160/L539)、`server.mjs`(L58/L135/L803/L813)、`watch.mjs`(L51/L59/L92/L140/L186)、`ProjectView.tsx`(8 处)——合成要求见 §2 对应行的“依据”列，核心判定点已在那列点明。

## 5. 执行顺序清单（每步后跑最小门禁）

前置：HEAD 必须还是 `c222314`（变了就重跑 `sync-base → gen-patches → gen-anchors`）；工作树除 `overlay/`、`scripts/vendor/`、本文之外必须干净。

| # | 动作 | 最小门禁 |
| --- | --- | --- |
| 1 | `node scripts/vendor/check-anchors.mjs`（预期 exit 1，3 条锚点缺失 = 已知，记录不修） | 输出里缺失文件恰为 `Launcher.tsx`/`LibraryDrawer.tsx`/`SettingsModal.tsx` |
| 2 | `node scripts/vendor/apply-overlay.mjs`（真跑：上游 2808 路径 + 481 新增 + 5 补丁） | `git status --porcelain \| Select-String '^UU'` 的文件数 = 24 |
| 3 | 处理 `take-theirs`：`git checkout --theirs -- apps/desktop/shell/shell.css`；新建 `apps/desktop/shell/orange-login.css`（原 15 行）；`apps/desktop/shell/main.tsx` 加一行 import | `pnpm --filter @openfilm/desktop exec tsc -p shell`（import 与 CSS 引用能过） |
| 4 | 处理 2 个 `keep-ours`：`git checkout --ours -- packages/openfilm/studio/ui/src/components/Launcher.tsx apps/desktop/shell/main.tsx`，再补 `host` import + `host.canvasWriting` 2 行 | `pnpm --filter openfilm exec tsc -p studio/ui` + `pnpm --filter @openfilm/desktop exec tsc -p shell` |
| 5 | 13 个 1-hunk 文件按 §4 表逐条并集（`local-models` / `media-links` / `exports` / `projects` / `providers-index` / `skill-catalog` / `App.tsx` / `api.ts` / `CanvasView` / `LibraryDrawer` / `providers.ts` / `studio-process` / `library-search`） | `node scripts/vendor/gate-smoke.mjs --skip-live`（tsc studio/ui + 3 个 server 测试） |
| 6 | 5 个 2-hunk 文件（`local-agents-ipc` / `studio.mjs` / `render` / `main.mjs` / `ProjectsLibrary`） | `node --test apps/desktop/src/local-agents-ipc.test.mjs apps/desktop/src/turn-log.test.mjs` + 两个包的 typecheck |
| 7 | `server.mjs`（4 hunk，含 `duplicate` 路由与 `notifyReferences`） | `node scripts/vendor/gate-smoke.mjs`（含 live：`/api/health` 200、`/api/materials/list` 非 404） |
| 8 | `watch.mjs`（5 hunk，围栏 × stamp） | `node --test packages/openfilm/studio/server/watch.test.mjs packages/openfilm/studio/server/auto-versions.test.mjs` |
| 9 | `ProjectView.tsx`（8 hunk，最硬的一步，放最后） | `pnpm --filter openfilm exec tsc -p studio/ui` + `node --test packages/openfilm/studio/ui/src/lib/projects-page.test.ts` |
| 10 | 全量收口 | `pnpm typecheck`；`pnpm test`（含 `gate-test-coverage`）；`node scripts/vendor/gate-smoke.mjs`；手测：首页三入口 → 打开项目 → 素材抽屉云管家 tab → 画布导入 → 导出一次 |
| 11 | `pnpm install --lockfile-only` 单独处理 lock（overlay 从不写 `pnpm-lock.yaml`） | `git diff --stat pnpm-lock.yaml` 只含依赖解析差异，无手改 |

顺序约束：3 → 4 必须在 5 之前（`main.tsx`/`Launcher.tsx` 定稿后，`App.tsx`、`api.ts` 的并集才有正确引用面）；9 必须最后（它依赖 5–8 定下来的 `api.ts` / `LibraryDrawer` / `CanvasView` / `server.mjs` 形态）。

## 6. 结论

- 24 个冲突文件：**take-theirs 1 · keep-ours 2 · merge 21**。
- 冲突标记 46 个：take-theirs 消掉 1 个、keep-ours 消掉 5 个，**实际要合 40 个 hunk / 21 个文件**。
- 其中 **20 个 hunk（16 个文件）是纯并集**，按 §4 表照抄，可以脚本化、无需判断。
- **真正需要逐 hunk 判断的只有 5 个文件、20 个 hunk**：`ProjectView.tsx`(8)、`watch.mjs`(5)、`server.mjs`(4)、`local-agents-ipc.mjs`(2)、`library-search.mjs`(1)。达标（目标 ≤5）。
- 风险点集中在三处：`ProjectView.tsx` 的“上游 `WorkspaceLibraryPane` 工作区骨架 vs 我们的 `foreground` + 云管家 tab”，`watch.mjs` 的“我们的 IO 围栏 × 上游 mtime stamp 轮询”，以及“删了上游新接线、忘了删对应 import”——`studio/ui/tsconfig.json` 的 `noUnusedLocals: true` 会把这类遗漏变成 tsc 红，所以每一步的最小门禁不能省。
- `git merge-file` 排练只看文本，不看 tsconfig / 测试覆盖；本文的 L 行号用于定位，最终判定以真跑后的冲突标记 + 门禁结果为准。
