# P4 执行单：切换到干净提交历史（2026-11-19）

## 执行结果（2026-11-19 20:40）

| 步骤 | 结果 |
| --- | --- |
| 安全网 | `.dev/private-archive/orange-history-pre-orphan-20261119.bundle` — 715 提交、50 refs、79 MB，`bundle verify` 通过 |
| 证据移出 | 8 条路径移入 `.dev/private-archive/evidence-20261119/`（`docs/history`、`overlay`、`scripts/vendor`、上游 CHANGELOG、`skill-catalog-seed.{json,mjs}`、示例 CREDITS、library LICENSE.md）；新建 `packages/openfilm/CHANGELOG.md` 从 `## 0.1.0` 开始 |
| 单提交 | `a0578192 OrangeFilm v0.1.0`，作者只有 `Ethan <ethan@orange.local>`，提交信息零 upstream 字样 |
| 分支 | `dev`、`main` 指向同一提交；`chore/vendor-0.3.2` 与 `archive/*` 已删（内容在 bundle 里） |
| 工具 refs | 删掉 30+ 条 `refs/codex/**`、`refs/archive/**`、`refs/orangeflim/upstream/v0.3.0` |
| 远端 | 只留 `origin/main`；`dev` 与 4 条 `codex/*` 已删；`upstream` 远端与 `upstream-v0.3.2` tag 已移除 |
| 仓库可见性 | 由 public 改为 **private**（原本是公开仓库，与专有许可冲突） |
| 体积 | `.git` 93 MB → 74 MB（剩下的都是单提交里的工作树内容） |
| 归档 | `main` 与 `dev` 均为 `a057819`；随后一次提交 `f0637ef` 去掉钱包充值链接里的上游域名 |
| tag / 流水线 | `v0.1.0` 已推；`desktop`（tag）与 `ci`（main）已触发 |

回归检查：`pnpm typecheck` 0、`pnpm build` 通过、`audit:public` 0 发现（移动证据之后重跑）。

## 原计划步骤（保留备查）

前置（已完成）：

- `.dev/private-archive/orange-history-pre-detach-20261119.bundle`（79 MB、242 refs，`git bundle verify` 通过）
- `.dev/hygiene/inventory.{json,md}`（每条分支的 SHA 与主题）、`.dev/hygiene/patches/*.patch`（7 份未提交工作）

## 步骤

1. **再保一次**（树已变，重新生成）：
   ```
   git bundle create .dev/private-archive/orange-history-pre-orphan-20261119.bundle --all
   git bundle verify .dev/private-archive/orange-history-pre-orphan-20261119.bundle
   ```
2. **证据移出发行树**（不删除，移到 `.dev/private-archive/evidence-20261119/`）：
   ```
   node .dev/hygiene/archive-evidence.mjs --dry-run
   node .dev/hygiene/archive-evidence.mjs
   ```
   涉及：`docs/history/`、`overlay/`、`scripts/vendor/`、`packages/openfilm/skill-catalog-seed.json`、`packages/openfilm/scripts/skill-catalog-seed.mjs`、`packages/openfilm/CHANGELOG.md`（上游 0.3.2 条目）、`examples/openfilm-intro/CREDITS.md`、`library/LICENSE.md`。
3. **建单一根提交**：
   ```
   git checkout --orphan orange-main
   git add -A
   git commit -m "OrangeFilm v0.1.0"
   ```
4. **指过去**：`git branch -f dev orange-main`；`git branch -f main orange-main`（`main` 首次建立）。
5. **清理远端与 tag**（需 operator 明确点头）：
   ```
   git remote remove upstream
   git tag -d upstream-v0.3.2
   git push origin main            # 新分支，无需 force
   git push origin --delete dev codex/archive-consolidated-20261107 codex/docs-realignment codex/native-chain-ci codex/t05-path-policy
   ```
6. **失效引用修正**：`AGENTS.md` 的 `8b8ef162…` 基线句、`docs/execution/pilot-readiness.json` 的 `workingBaselineCommit`、`docs/execution/**` 里的旧提交号 → 改为「新 SHA / 历史 SHA 见本地归档」。

## 验收

| 检查 | 命令 | 期望 |
| --- | --- | --- |
| 单提交 | `git rev-list --count HEAD` | `1` |
| 作者 | `git log --format='%an <%ae>'` | 只有我们 |
| 提交信息 | `git log --format=%B \| grep -i 'openfilm\|upstream'` | 无输出 |
| tag | `git tag` | 无 `upstream*`；`v0.1.0` 之后才有 |
| 树内 | `git grep -il 'openfilm\.dev\|dev\.openfilm\.desktop'` | 只剩 `LICENSE`/`THIRD_PARTY_NOTICES`（已删除）/无 |
| 退路 | `git fetch .dev/private-archive/*.bundle 'refs/*:refs/recovered/*'` | 能取回旧 ref |

## 注意

- 改写后**所有 SHA 变**，`.git` 从 98 MB 缩到单提交大小；旧历史只存在于 bundle 与本地 `archive/*` 分支（后者在 bundle 校验通过后删）。
- 远端 `dev` 与 4 条 `codex/*` 的删除是唯一不可逆动作，执行前把清单贴给 operator 确认。
