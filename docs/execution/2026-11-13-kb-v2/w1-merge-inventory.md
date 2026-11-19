# 上游 v0.3.2 合并：冲突盘点（W1 停止点）

日期：2026-11-13。分支 `chore/upstream-0.3.2`（从 `feat/unify-surface` HEAD 分出），上游 tag `upstream-v0.3.2`（`e01b37f`）。

## 结果

`git merge --no-commit --no-ff upstream-v0.3.2` → **145 个冲突**（计划阈值 20），已 `git merge --abort`，工作树干净。清单见 `conflicts-upstream-0.3.2.txt`。

| 区域 | 冲突数 | 说明 |
| --- | --- | --- |
| `packages/openfilm/studio` | 100 | 上游 0.3.1/0.3.2 大量 UI/i18n/库交互改动；我们只改了 8 个组件 + i18n 键 + 3 个 server 文件 |
| `apps/desktop/src` | 15 | 混合：agents/chat/doctor/file-changes（上游）与我们自研的 auth/material/studio-process |
| `apps/desktop/chat` | 9 | 我们只有 6 个文件改动，其余应为上游 |
| `packages/openfilm/src` | 8 | 我们加了 `index-client`、`studioFrames`、`--video-id` |
| `packages/openfilm/manual` | 2 | 文档章节 |
| `apps/desktop/shell` | 2 | 布局改动（应整取上游） |
| 生成物 | 11 | CHANGELOG / package.json / pnpm-lock / i18n 汇总 |

## 为什么这么多

我们的 `dev` 起点是“原生基线导入”（`8b8ef16`）而不是上游的逐提交历史，文件级上与上游 v0.3.0 已有大量非语义差异（格式、重排、局部重写），三点合并会把它们全部暴露成冲突。

## 推荐路线（替代“整体 merge”）

按“谁主导”分三类处理，避免逐 hunk 解 134 个真实冲突：

1. **上游主导、我们只有小改动的树**：`packages/openfilm/studio/**`、`apps/desktop/chat/**`、`apps/desktop/shell/**`
   - 直接 `git checkout --theirs` 取上游整树；
   - 然后重放我们的**已知小改动**（去外链 8 组件、i18n 键、默认索引地址；chat 的 `AddSkill.tsx` + 5 locale），有 `keys.test.ts` 与 grep 守卫。
2. **我们主导的树**：`apps/desktop/src/{main,studio-process,environment,desktop-auth,auth-service,material-*,index-rpc}.mjs`
   - 保留 ours；只对 A 类安全/正确性文件单独取上游（`doctor`、`file-changes`、`chat-ipc`、`chat-store`、`local-agents-ipc`、`file-changes` 等）。
3. **我们纯新增的文件**：`packages/openfilm/src/index-client*`、`docs/sql/*`、`infra/*`、`scripts/*`
   - 不动；`packages/openfilm/src` 里上游改动按文件取 theirs 后重放 `studioFrames` 与 `--video-id`。

预计改造后冲突可压到 **≤10 个**（主要是 `package.json`、`pnpm-lock`、`CHANGELOG`）。

## 下一步（待确认）

- 采用上述“分类整取 + 重放小改动”，在 `chore/upstream-0.3.2` 上分 3 个提交完成（studio/chat/shell → desktop 混改 → 版本与锁文件）。
- 或者只 cherry-pick 20 个有价值的提交（更慢但更可控）。

## 附：合并前基线（本机）

`verify` 9/9；`migrate --check` 12 文件一致；`apps/api` 222/222。
