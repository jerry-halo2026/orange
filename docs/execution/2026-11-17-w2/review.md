# W2 UI/UX 走查阻塞项证据（2026-11-17）

基线：`D:/dev/orange` HEAD `9b77d3a`，本目录未提交任何代码改动。
全部截图取自真实组件 + 真实 `globals.css` + 真实浏览器（Edge/chromium），只有接口应答是 fixture。
跑法：`node packages/openfilm/.dev/w2-shots/shots.mjs`（脚本在 `.dev/`，已 gitignore），数据落在 `measurements.json`。

## 一、Fission 向导：单页长滚动 → 一次一屏真三步

| 证据 | 证明什么 |
| --- | --- |
| `01-fission-step1-materials-no-selection.png` | 未选素材时：步骤指示 ① 待补全、②③ 灰显「先完成上一步」（`data-step-state="locked"`）；底部「下一步：规则」disabled，且旁边一行写明原因「先选择至少 1 个素材」。旧行为（②③ 已完成、下一步无故 disabled）不再出现。 |
| `02-fission-step2-rules.png` | 选中素材后跳第 ② 步：屏上**只有规则**一块（第 ① 步的目录行与场景组卡已不在版面上，而非挤在下方）；指示条 ①②③ 均为「已完成」；顶栏摘要 sticky 在顶、步骤标题 `② 规则` 完整露出。 |
| `03-fission-step3-export.png` | 第 ③ 步同理：只有导出参数与预计产出，底部「上一步：规则」；摘要条不遮挡标题与首行字段。 |
| `05-wizard-1100px-folded-summary.png` | ≤1200px：摘要条折叠成一行（步骤 / 素材 / 数量 + 右侧预计产出），长说明与其余条目隐藏；实测 `data-summary="full"` → `display:none`、`data-summary="folded"` → `display:flex`。 |

`measurements.json` 关键数字（视口 1280×900）：

- 第 1 步未选素材：`rail = [materials:todo, rules:locked, export:locked]`，`nextDisabled = true`，`reason = "先选择至少 1 个素材"`，`stepOnScreen = materials`。
- 选中「产品素材 2026」后：`rail = [ok, ok, ok]`，`nextDisabled = false`，`[data-note="next-blocked"]` 出现 0 次。
- 跳步后汇总条不遮挡：第 ② 步 `summaryBottom=103 / headingTop=182 / covered=false`；第 ③ 步同样是 `103 / 182 / covered=false`。
- 1100px 折叠：`{full: "none", folded: "flex"}`。

## 二、抽屉窄屏 268px：搜索框≈0、标签折行叠字

| 证据 | 证明什么 |
| --- | --- |
| `04-drawer-268px-filter-bar.png` | 抽屉盒子 292px、页面自带 `p-3` 各 12px ⇒ **内容区正好 268px**。搜索框宽 **192px**（旧实现被作者固定 `w-[200px]` 挤到 ≈0），并已输入「风景」——可输入；「应用」按钮同行；「作者」独占下一整行，两个标签都单行不叠字。 |

`measurements.json`：`contentWidth=292`（含两侧 12px padding），`bar=242`（过滤条自身 `px-3` 后），`search={width:192, right:233}`，
`author={width:242, top:222}`，`authorOnOwnLine=true`，`typed="风景"`。

自动化复现（不靠人眼）：`packages/openfilm/studio/ui/src/components/material-center-filter-narrow.test.ts` 在 268px 与 900px 两档实测：
搜索框宽 > 100、右边界不越出 268、可 `fill` 后回读到值；作者控件在搜索下一行；两个标签的文本行高 < 24px（单行）且不与自己的控件重叠；900px 下搜索框更宽。

## 三、验收数字

| 门 | 结果 |
| --- | --- |
| `tsc -p packages/openfilm/studio/ui --noEmit` | 0 |
| 向导/素材相关源测试（`fission-wizard`、`fission-workbench-steps`、`material-center-no-raw`）+ 新增 `material-center-filter-narrow` | 全绿（含新增：未选素材时 ① 未完成且 ②③ 锁定；268px 搜索可输入且宽 > 0） |
| `node --test studio/fission-workbench-render.test.mjs`（真浏览器端到端） | 2/2 |
| `node --test packages/openfilm/studio/workspaces.test.mjs` | 9/9 |
| `pnpm --filter openfilm run build:ui` | 0（产物 CSS 内含 `.max-[1200px]` 媒体查询与 `.flex-[1_1_100%]`） |
| `studio/ui/src/{components,lib,i18n}/*.test.ts` 全量 | 947 项：941 通过 / 6 失败——这 6 项在 HEAD `9b77d3a` 上同样失败（`git stash` 基线复测：`project-view-host-pane` 5 项 + `projects-page` 1 项，断言找的是 `shown={canvasOpen && foreground}`，HEAD 的 `ProjectView.tsx` 里本就没有），与本次改动无关 |

## 四、改动清单（仅写集）

- `components/fission/wizard.ts:214,223` — `StepState` + `stepStates()`：完成态与开锁由 (options, groups, 已选素材数) 推出。
- `components/fission/StepNav.tsx:6,22-23` — 指示条带 `data-step` / `data-step-state` / `aria-disabled`，锁住的步骤是可点、会解释的按钮。
- `components/fission/SummaryBar.tsx:30,40` — 全文读数与 ≤1200px 折叠读数两份，同一记录。
- `components/FissionWorkbench.tsx:127,269,271,274-275,278,290,301,313,317,350,355` — 一次一屏（其余步 `absolute inset-0 opacity-0`、锁住时再加 `inert`）、摘要测高 + 每步 `scroll-margin-top`、上一步/下一步与可见原因。
- `components/material-center/MaterialCenterPage.tsx:216-228` — 过滤条 `flex-wrap` + 搜索 `flex-[1_1_100%] min-w-0`、作者整行、标签 `whitespace-nowrap`。
- 测试：`components/fission-wizard.test.ts`（+2）、`components/fission-workbench-steps.test.ts`（+3）、新增 `components/material-center-filter-narrow.test.ts`。
- 契约保留：`data-step`、`data-step-state`、`data-action`（新增 `step-back` / `step-next`）、`data-material-card`、`data-filter="search|author"`；测试断言一条未删——两个既有测试文件的 diff 里唯一的删除行是 `fission-wizard.test.ts` 的 import 续行（加入 `stepStates`），其余全是新增。
