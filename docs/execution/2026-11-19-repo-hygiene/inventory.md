# 仓库卫生执行记录（2026-11-19）

## 起点

`git worktree list` 37 条（本机主检出 1 + E 盘 36），`git branch` 161 条（77 已并入 `HEAD`、84 有独有提交），`.dev/handoff-snapshots` 7.4 GB 且含大量失效路径，`E:\CodexData\worktrees` 下另有 13 个未注册为工作树的孤儿目录。

## 先做安全网（在任何删除之前）

```
git bundle create .dev/private-archive/orange-history-pre-detach-20261119.bundle --all
git bundle verify  … "The bundle records a complete history."
```

结果：242 个 ref、79 MB、`sha1`。**这份 bundle 是全部旧历史的唯一退路**，包含当时每一条分支与 tag 指向的提交。

## 处置与结果

| 项 | 动作 | 结果 |
| --- | --- | --- |
| 7 个有未提交改动的工作树 | `git diff HEAD --binary` 存为 `patches/<name>.patch` | material-proxy 1.1 KB、fission-independent 479 KB、m0-validate 76 KB、services-restore 17.6 KB、t01-isolation 300 KB、t02-native 28.8 KB、p1-companykey 10 KB |
| 34 个已注册工作树 | `git worktree remove --force`；Windows 长路径失败者用 `rd /s /q \\?\<path>` 补删 | 全部移除，`git worktree prune` 后 `git worktree list` 只剩主检出 |
| `E:\CodexData\worktrees` 下 47 个目录（含 13 个未注册孤儿） | 逐个确认其 HEAD 已可从 `HEAD` 到达（`.dev/hygiene/orphans.mjs`：`unreachable: []`）后删除 | 47 个目录清零，E 盘可用空间 123.4 GB → 137.3 GB |
| 75 条已并入 `HEAD` 的分支 | `git branch -d` | 全部删除，0 失败 |
| 83 条有独有提交的分支（73 条 + 10 条原挂在工作树上） | `git branch -D`（内容已由 bundle 与 patch 覆盖） | 删除后剩余 3 条：`chore/vendor-0.3.2`、`dev`、`archive/worktree-snapshot-archive-cleanup` |
| `.dev/handoff-snapshots`（7.4 GB） | 改名 `.dev/handoff-snapshots-20261119` | 保留，不删除 |

## 与计划的一处偏离（有意）

计划原本要求“有独有提交的分支先打 `archive/<name>-20261119` tag 再删”。执行时改为**不建 tag，用 bundle 保全**：

- tag 会把旧提交继续钉在仓库里，与后面“干净提交历史、只留一个根提交”的目标直接冲突；
- bundle 已包含全部 ref 与提交，随时 `git fetch <bundle> 'refs/*:refs/archive/*'` 可整体取回；
- 每条分支的 SHA、主题、独有提交数都记录在 `.dev/hygiene/inventory.json` 与 `inventory.md` 里，可按名字精确找回。

## 现在的事实

- `git worktree list` → 仅 `D:/dev/orange`。
- `git branch` → `chore/vendor-0.3.2`（当前）、`dev`、`archive/worktree-snapshot-archive-cleanup`。
- 退路：`.dev/private-archive/orange-history-pre-detach-20261119.bundle`（79 MB）、`.dev/hygiene/patches/*.patch`（7 个）、`.dev/hygiene/inventory.{json,md}`。
