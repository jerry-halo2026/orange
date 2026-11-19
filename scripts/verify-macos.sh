#!/usr/bin/env bash
# © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
# No modification or redistribution without the owner’s written permission.

# macOS（Apple Silicon）一次性验证：依赖 → 迁移 → 单测 → .NET 构建 → Studio 侧测试 → UI 构建。
#
#   bash scripts/verify-macos.sh             # 全跑
#   bash scripts/verify-macos.sh --skip-ui   # 跳过 UI 构建（慢）
#
# 设计原则：**任一失败立刻停**，并把"该看哪个文件"打印出来。Windows 上绿了不代表这里绿：
# 路径大小写、realpath 的 /private/var、ffmpeg 二进制后缀、NFD 文件名都会在这里第一次暴露。
set -euo pipefail

cd "$(dirname "$0")/.."
root="$(pwd)"
skip_ui=0
for arg in "$@"; do [[ "$arg" == "--skip-ui" ]] && skip_ui=1; done

step() { printf '\n=== %s ===\n' "$1"; }
fail() { printf '\n✗ %s\n  先看：%s\n' "$1" "$2"; exit 1; }

step "0. 平台与工具链"
uname -s; uname -m
[[ "$(uname -s)" == "Darwin" ]] || fail "这不是 macOS" "本脚本只针对 Darwin；Windows 用 pnpm test"
[[ "$(uname -m)" == "arm64" ]] || printf '注意：%s（预期 arm64）\n' "$(uname -m)"
node -v || fail "没有 Node.js（需要 ≥22）" "brew install node"
pnpm -v || fail "没有 pnpm" "corepack enable && corepack prepare pnpm@latest --activate"
dotnet --version || fail "没有 .NET SDK（需要 10.0.3xx）" "https://dot.net"

step "1. 依赖安装"
pnpm install --frozen-lockfile || fail "依赖安装失败" "package.json / pnpm-lock.yaml"

step "2. 迁移账本（31 个文件）"
# 本地迁移走 docker compose 的 db 容器；这台 Mac 没装 docker 时它必然失败，
# 而那不是"渲染器坏了"——是"这台机器没数据库"。所以说清楚并跳过。
if command -v docker > /dev/null 2>&1; then
  node infra/migrate.mjs --target local --check || fail "迁移与账本不一致" "docs/sql + infra/migrate.mjs"
else
  printf '跳过：本机没有 docker，迁移账本需要 infra/docker-compose.yml 的 db 容器\n'
  printf '      涉及数据库的验证（media_search / 向量包）需要它；本脚本的其余步骤不依赖数据库\n'
fi

step "3. 纯逻辑单测（不需要网络与数据库）"
node --test \
  packages/openfilm/src/plan-schema.test.mjs \
  packages/openfilm/src/plan-store.test.mjs \
  packages/openfilm/src/plan-tools.test.mjs \
  packages/openfilm/src/voice-timing.test.mjs \
  packages/openfilm/src/planset.test.mjs \
  packages/openfilm/src/dedupe-check.test.mjs \
  packages/openfilm/src/copy-rewrite.test.mjs \
  packages/openfilm/src/visual-tags.test.mjs \
  packages/openfilm/src/claim-check.test.mjs \
  packages/openfilm/src/shot-plan.test.mjs \
  || fail "纯逻辑单测失败" "上面列出的具体用例"

step "4. Studio 侧 fission（路径/计划/批次/路由）"
node --test \
  packages/openfilm/studio/server/fission-engine-paths.test.mjs \
  packages/openfilm/studio/server/fission-plan.test.mjs \
  packages/openfilm/studio/server/fission-batch.test.mjs \
  packages/openfilm/studio/server/fission-batch-jobs.test.mjs \
  packages/openfilm/studio/server/fission-render-routes.test.mjs \
  packages/openfilm/studio/ui/src/components/batch/batch-model.test.ts \
  || fail "Studio 侧测试失败" "fission-*.mjs 与 batch-model.ts"

step "5. .NET 渲染器构建"
dotnet build workers/fission/src/Fission.Cli -v quiet --nologo || fail "Fission 构建失败" "workers/fission/src/Fission.Cli"
printf 'dll：%s\n' "$(ls workers/fission/src/Fission.Cli/bin/Debug/net10.0/Fission.Cli.dll 2>/dev/null || echo 缺失)"

if [[ "$skip_ui" == "0" ]]; then
  step "6. UI 构建（vite）"
  (cd packages/openfilm && node ../../node_modules/.pnpm/vite@*/node_modules/vite/bin/vite.js build --config studio/ui/vite.config.ts) \
    || fail "UI 构建失败" "studio/ui（看 vite 输出里的第一个错误）"
fi

step "完成"
cat <<'NOTE'
接下来做一次真出片（比单测有说服力）：

  node scripts/fission-smoke.mjs --engine-from-app

记录三样东西回会话：
  1) 本脚本的完整输出；
  2) 第一次真出片的耗时与产物大小；
  3) 任何与 Windows 不一致的行为（尤其路径大小写、含中文/空格的文件名）。
NOTE
