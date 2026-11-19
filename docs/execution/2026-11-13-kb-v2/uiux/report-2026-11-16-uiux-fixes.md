# 2026-11-16 UI/UX 三条实测抱怨：改动 + 证据

分支 `chore/vendor-0.3.2`，未 commit / 未 push。未改 `pnpm-lock.yaml`、`apps/api/**`、`docs/sql/**`、`apps/desktop/bench/**`、
`brand.json`、`brand.generated.ts`、两处 `BrandLogo.tsx`。

改动的文件（9）：

| 文件 | 改动 |
| --- | --- |
| `apps/desktop/shell/AccountExit.tsx`（新） | 退出登录的紧凑触发器 + 120px 面板，`onBlur` + document 捕获阶段点击 + Escape 收起 |
| `apps/desktop/shell/main.tsx` | 原来的整块按钮换成 `<AccountExit onSignOut=…>`，sign-out 的请求原样保留 |
| `apps/desktop/shell/shell.css` | `.orange-account`(right:6/top:6) `.orange-account-trigger`(20×20) `.orange-account-panel`(120px) `.orange-account-exit`(面板里的按钮) |
| `material-center/MaterialCard.tsx` | 新增 `dense` 小卡片变体：封面 `aspect-video rounded-md` + 单行 `truncate text-[12px]` 名称 + 一个状态点；下载/纪要收成 hover 出现的 20px 图标按钮；`data-badge`/`data-field`/`data-count` 仍在（小卡片里为 `sr-only`，不画出来） |
| `material-center/MaterialCenterPage.tsx` | `dense` 时网格 `grid-template-columns: repeat(auto-fill, minmax(104px,1fr))`、`gap:8px 8px`，云条目走小卡片 |
| `MaterialCenter.tsx` | 把 `cloudTab` 作为 `dense` 交给页面（`showFilters` 那行没动） |
| `material-center/CloudMaterialsTab.tsx` | 药丸墙 → 两级清单：完整一级分类行（24px、右侧合集数、默认折叠、展开项高亮）→ 展开后缩进的合集行（12px 缩进、名称 truncate、右侧条数）；顶部保留「全部素材」行；选中合集后素材区顶部出现 `全部素材 / 一级 / 合集` + 「清除」；`max-h-44` → `max-h-56` |
| `lib/material-center/groups.ts` / `group-copy.ts` | `GroupCopy` 加 `allMaterials` / `clear`（中英双语） |

`data-*` 契约全部保留：`data-state`、`data-note`、`data-group-section`、`data-group-card`、`data-group-all`、
`data-group-count`、`data-group-count-value`、`data-material-card`、`data-action`、`data-view-pane`、`data-badge`、
`data-field`、`data-count`、`data-collections`、`data-flat`、`data-cloud-library`、`data-collections-crumb`(新) 等。
没有 `@ts-ignore` / `any`，没有改测试断言。

## 验收数字

| 验收项 | 结果 |
| --- | --- |
| `node packages/openfilm/node_modules/typescript/bin/tsc -p packages/openfilm/studio/ui --noEmit` | **0** |
| `node apps/desktop/node_modules/typescript/bin/tsc -p apps/desktop/shell` | **0** |
| `node --test …/material-center-no-raw.test.ts …/lib/material-center-*.test.ts` | **139 / 139 通过** |
| `node --test packages/openfilm/studio/workspaces.test.mjs` | **9 / 9 通过**（首次运行进程尾上有一个无关的 `ECONNRESET` socket 噪音，重跑 exit 0） |
| `pnpm --filter openfilm build:ui` | **exit 0**（5.0s） |
| `pnpm --filter @openfilm/desktop build:shell` | **exit 0**（16.9s） |
| 全量 studio UI 测试（905 项） | 899 通过，6 失败；6 项全部读 `ProjectView.tsx`（`project-view-host-pane.test.ts` ×5、`projects-page.test.ts` 的 hidden-editor 一项），**本分支 HEAD 上同样失败**（`shown={canvasOpen && foreground}` 在 HEAD 与工作树都不存在），与本次改动无关，且 `ProjectView.tsx` 是别人未提交的改动 |

## 截图与可见证据

三张图由 `capture-fixes.mjs` 生成（真组件 + 真 `shell.css`；供应商路由 mock；顶栏是 iframe 里的真 Studio 工作区）。
数字来自 `capture-fixes.log` 的 `MEASURES`。

### 1 `cloud-grid-compact.png`（云管家小卡片网格，736×374）

- 20 张卡片，**列宽 116px × 6 列**，`grid-template-columns` = `116px 116px 116px 116px 116px 116px`，`gap: 8px`（横向 8px、纵向 8px）。
- 单卡 **116×87**；每卡**可见 badge 只有 1 个**（`data-badge="state"` 状态点，绿点带 `title`）；作者/日期/时长/大小那行**不绘制**（`metaRowDrawn=false`，内容在 `sr-only` 里，契约不丢）。
- hover 的卡片上只有三个 20px 图标：`data-action="select"`（左上，20px）、`data-action="open-wiki"`（20px）、`data-action="use"`（20px）；下载/纪要都收进 hover。
- 对比 `MediaPool.tsx` 现有网格：`gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))'`，同一套 `aspect-video rounded-md`、`truncate text-[12px]`。

### 2 `cloud-collections-tree.png`（两级清单 + 面包屑，788×239）

- 移除药丸墙：`[data-collections] .rounded-full` 计数 = **0**。
- 一级分类行**高 24px**（`data-group-toggle` 实测 height=24），右侧是**合集数**（「城市」=3，「人文」=2，「自然」=1，「商业」=1）；默认全折叠（`▸`），展开项 `▾` 且高亮。
- 展开「城市」后其下三行合集，**缩进 12px**（`cardsIndent=12`），名称 truncate，右侧是该合集的条数（「夜景 7 条」）。
- 列表总高 **202px ≤ `max-h-56`(224px)**，滚动区仍是 `[data-collections]`；顶部保留「全部素材」行（`data-group-all`）。
- 底部面包屑：`全部素材 / 城市 / 夜景`，右端「清除」（`data-action="clear-group"`）；清单 8 行（全部素材 1 + 一级 4 + 展开的合集 3）。

### 3 `shell-exit-compact.png`（顶栏右上角裁切 420×120；另有 `shell-exit-window.png` 整窗）

- 触发器 **20×20**，位置 `x=1574,y=6`（窗口 1600 宽 → `right:6px`、`top:6px`），`aria-label="退出登录"`、`title`、`aria-expanded`。
- 面板 **120×34.8**（`x=1474,y=30`），里面是唯一的「退出登录」按钮（114×28.8）。
- **不再压住模式切换**：`[data-work-mode]`（剪辑）盒 `x=1387.2, w=64.8, y=3, h=26`，与触发器**不相交**（`overlapWithModeSwitch=false`），两者水平净空 **122px**；而旧按钮（`right:150`、宽约 62）按同一几何**会与它相交**（`oldButtonWouldOverlap=true`）——就是用户看到的那次遮盖。
- `--titlebar-right-x`（Windows 窗口控件预留的 138px，`bridge.ts INSET_RIGHT`）在 harness 里按 `applyStudioHost` 的方式写进 iframe，所以模式切换位于**真实位置**。
- 面板点外面即收起：外部点击后面板节点数 = **0**。

## 还缺什么 / 需要决定

1. **Windows 窗口态下 `right:6px` 与 OS 窗口控件重叠**：`titleBarOverlay` 在右上角画最小化/最大化/关闭，Studio 顶栏为它预留 138px（`INSET_RIGHT=138`）。按指令把触发器放在 `right:6px;top:6px`，它正好落在这 138px 里——截图（浏览器）里可见，真机窗口态可能被系统按钮盖住。要不要改成 `right: calc(var(--titlebar-right-x, 0px) + 6px)`（会贴着剪辑/画布右侧，间距仅 ~10px）或让 Studio 顶栏给一格位置，需要产品拍一下。
2. 桌面端真实 Electron 窗口没有跑（需要登录/原生桥），第 3 条证据来自「真 `AccountExit` + 真 `shell.css` + iframe 里真 Studio 顶栏」的 harness；窗口控件区的观感需要一次真机确认。
3. 分支上 6 项既有失败（`ProjectView.tsx` 是两个已存在断言，与本次无关）；`ProjectView.tsx`、bench、品牌文件仍是别人未提交的改动，我没碰。

## 复现

```bash
node packages/openfilm/node_modules/typescript/bin/tsc -p packages/openfilm/studio/ui --noEmit
node --test packages/openfilm/studio/ui/src/components/material-center-no-raw.test.ts packages/openfilm/studio/ui/src/lib/material-center-*.test.ts
node --test packages/openfilm/studio/workspaces.test.mjs
pnpm --filter openfilm build:ui
ORANGE_CHANNEL=msedge node docs/execution/2026-11-13-kb-v2/uiux/capture-fixes.mjs   # 写三张图 + capture-fixes.log
```
