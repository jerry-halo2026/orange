# Vendor drop overlay：整棵上游树 + 我们的新增 + 补丁

日期：2026-11-13。分支 `feat/seams`。本文只描述**基建**；vendor drop 尚未执行。

## 为什么不 merge

`git merge-base HEAD upstream-v0.3.2` = `3eacfd6`（早于 v0.3.0 `7713d38`）。历史合不上，所以不 merge，改为重建树：

```
upstream-v0.3.2 整棵树（2808 个路径）
  + overlay/new-files.txt（481 个我们新增的文件，取自 productRef）
  + overlay/patches/*.patch（107 个我们改过的上游文件，3-way 打补丁）
```

旁证：同目录 `w1-merge-inventory.md` 记录的 `git merge` 尝试得到 145 个冲突（阈值 20）后 abort；补丁级 3-way 只落在 107 个文件上。

## 资产

| 文件 | 内容 |
| --- | --- |
| `overlay/base.json` | `upstreamTag` / `upstreamCommit` `e01b37f` / `productRef` / `generatedAt` |
| `overlay/new-files.txt` | 相对 v0.3.0 新增的文件，一行一个，已排除 node_modules / .dev / dist / .pnpm-store；其中 16 个是本 overlay 自身的脚手架（`overlay/**`、`scripts/vendor/*`、本文），会随 drop 一起保留 |
| `overlay/patches/*.patch` | 按域分组 5 个：`studio` 51、`desktop` 39、`openfilm` 13、`package` 2、`readme` 2（共 107 文件）；用 `git diff --binary 7713d38..productRef -- <paths>` 生成，`git apply --3way` 可复现 |
| `overlay/anchors.json` | 每个补丁记录其 hunk 首行上下文（文件 + 锚点字符串）211 条，供预检；并标注上游漂移：identical 48 / modified 53 / binary 6 |

**例外：`pnpm-lock.yaml`**。它是我们改过的上游文件，但共享工作区不允许改写，故不入补丁、不还原；vendor drop 时由 pnpm 自己重算，谁改动谁在独立分支里补。

## 流程

```bash
node scripts/vendor/sync-base.mjs            # 写 base.json（校验 tag 存在，记录 tag 对象与 productRef）
node scripts/vendor/gen-patches.mjs          # 重新生成 new-files.txt / patches（域映射唯一来源）
node scripts/vendor/gen-anchors.mjs          # 重新生成 anchors.json
node scripts/vendor/check-anchors.mjs        # 预检：锚点必须存在于上游 tag，缺失 exit 1 并列文件
node scripts/vendor/apply-overlay.mjs --dry-run   # 演练：临时 worktree 真跑一遍，不碰当前工作树
node scripts/vendor/apply-overlay.mjs        # 真跑：还原上游树 → 还原新增文件 → 3-way 打补丁
node scripts/vendor/version-follow.mjs [--write]  # openfilm 跟随 tag 版本，desktop 用 0.4.0-orange.N
node scripts/vendor/gate-smoke.mjs           # tsc(studio/ui) + studio/server 测试子集 + 起 Studio 探 /api/health、/api/materials
```

顺序约束：`sync-base` 先于 `gen-patches`/`gen-anchors`；`check-anchors` 与 `apply-overlay --dry-run` 通过后才允许真跑；真跑后必须跑 `gate-smoke`，再提交。

实现要点：

- `apply-overlay` 用**临时索引**（`GIT_INDEX_FILE` + `read-tree` + `add -A`）满足 `--3way` 对“索引与工作树一致”的要求；真实索引留在 `productRef`，所以 drop 结果在 `git status` 里表现为普通未暂存改动，不会被偷偷 staged。
- 真跑前有脏工作树闸门：本 overlay 之外有未提交改动就拒绝执行（`--force` 才放行），避免踩掉同工作区其他人的改动。
- `--dry-run` 在 `git worktree` 临时目录里完整执行一遍，报告“将要还原/打补丁的文件数”和真实冲突清单，然后删掉临时 worktree。

## 回退

```bash
node scripts/vendor/apply-overlay.mjs --rollback --dry-run   # 演练：只打印将还原/删除什么
node scripts/vendor/apply-overlay.mjs --rollback             # 真回退
```

实现：`git restore --source=<productRef> --worktree -- .`，再删除只存在于上游 tag 的路径（`git diff --diff-filter=A productRef..upstreamCommit`，本次 80 个）；新增文件因在 `productRef` 中会被还原回来。`pnpm-lock.yaml` 全程未动。

手工兜底：`git restore --source=<productRef> --staged --worktree -- .` + 按上面的 diff 删上游独有路径 + 复核 `git status --porcelain`。

## 当前实测（2026-11-13，productRef `c222314`）

- `check-anchors.mjs` → **exit 1**：211 条锚点中 3 条在上游缺失（`Launcher.tsx`、`LibraryDrawer.tsx`、`SettingsModal.tsx`），即漂移落点。想拿到 0 只能把锚点限制成“首个 hunk 的固定上下文”，那样闸门就只是装饰，故保留真实结果。
- `apply-overlay.mjs --dry-run` → 上游 2808 路径 + 481 新增 + 5 补丁 107 文件；**clean 83 / conflicted 24**（冲突集中在 `studio/server`、`studio/ui`、`desktop/src`）。
- `gate-smoke.mjs` → 3/3 通过（tsc 无诊断、26 测试全过、`/api/health` 200、`/api/materials/list` 501 非 404）。

**结论：基建可用，但这棵树上还不能盲跑 drop**。24 个冲突文件就是人工合并清单，按域分布：`studio` 15/51、`desktop` 6/39、`openfilm/src` 3/13、`package`+`readme` 0/4。建议 drop 时先落 package/readme 与 openfilm/src 的干净部分，studio 与 desktop 的冲突按文件拆给对应负责人。

## 规则

- 共享工作区：只写工作区文件，不 commit / push，不动 `pnpm-lock.yaml`。
- `productRef` 必须显式钉住：共享工作区 HEAD 一直在动（本次 7c0adb2 → da456d3 → c222314），产物一律按 `base.json` 的 sha 生成；HEAD 变了就重跑 `sync-base → gen-patches → gen-anchors` 再验。
- 上游树是唯一事实源：`new-files.txt` 只收相对 v0.3.0 的新增文件，`patches/` 只收改过的上游文件，两者并集必须等于 `git diff --name-status 7713d38..productRef`（`gen-patches.mjs` 有覆盖闸门）。
