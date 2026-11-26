# 素材中心与示例：可用性核查（2026-11-20）

## 结论

- **示例可用**：`GET /api/examples` 返回 2 个（`one-prompt`、`openfilm-intro`）；
  `POST /api/examples/:id/start` 建出工程，`POST /api/open` 200（Windows / macOS 都实测）。
- **素材中心可用**：公司公开视图 `GET /api/materials/list` 200（供应商 total 232 519）；
  `facets` 200；本地索引构建后，素材中心页显示批次（20261109 / 20261106 / 20261102 …）、
  产品（柠檬宝藏茶200g罐 53 条）与分组（规格 20 / 茶汤汤色 18 / 茶干料子 6 / 包装 4 / 冲泡 3 / 加冰块 2）。
  截图：`apps/desktop/.dev/materials-e2e/materials.png`。

## 找到并修掉的问题

1. **打包后拿不到凭据**：`MATERIAL_CREDENTIALS` 原来只指向检出里的 `.dev/zhishang/credentials.local.json`，
   安装后的应用在只读 resources 里，永远没有 → 素材服务不启动。现在按顺序：
   `OPENFILM_MATERIAL_CREDENTIALS` → `<userData>/zhishang/credentials.local.json` → 检出 `.dev`。
   bindings 在打包时也落到 `<userData>/zhishang/`。
2. **索引从不构建**：素材中心的目录来自本地索引（`/api/materials/index`），但启动器没启动过
   `material-index-bootstrap.mjs`。现在：
   - Studio 的索引路由与构建共用 `OPENFILM_MATERIAL_INDEX_DIR`（默认 `<userData>/material-index`）；
   - **登录成功之后**在后台 `--detach` 构建（登录前构建会 403 `Sign in is required`）。
3. **未绑定账号时云管家页只有一张“去绑定”卡**：供应商的公开视图（`authorization.layer=public,
   reason=company-view`）本来就能列素材。现在未绑定也显示公开目录，并加一行说明：
   “未绑定时仍可浏览供应商的公司公开素材；绑定后只按你本人的账号收窄。”（5 种语言）
4. 删掉 `catalog-query-unavailable.ts` 这个永远抛错的占位（它被当作 `queryCloud` 传入，但 `MaterialCenter`
   根本没用它——真客户端默认就是 `createMaterialsClient`）。

## 索引构建的真实约束

- 供应商 `total` 232 519，实际只能翻到约 20 532 条（其余不可达）；Windows 全量构建约 2 分钟，
  得到 20 532 条视频、5 311 个批次、6 811 个未归档分组。
- **`--throttle-ms 0` 会撞 429**，导致整类（videoType）中止、`batches=0`（macOS 第一次构建即如此，
  3 915 条全 unclassified）。默认节流下重建即可。
- 构建耗时/限流是供应商侧事实，不是索引器缺陷；构建结果与警告都写在 `status.json`。

## 验证

- Windows：`apps/desktop/bench/materials-examples-e2e.test.mjs` **通过**（55 s）
  —— sign-in / examples-api / example-start / materials-api / materials-index / materials-ui 全绿
  （materials-ui：4 张合集卡 + 进入产品分组；无“素材服务未接通”）。
- macOS：同一测试 **通过**（80 s）——示例与素材 API、索引路由、索引落盘、materials-ui 4 张合集卡全绿；
  索引使用 Windows 构建好的同一份供应商索引（索引是供应商数据的落盘，与平台无关）。
- 索引构建的真实限流：`--throttle-ms 0` 在 macOS 上会撞 429，导致整类中止、`batches=0`（3 915 条全
  unclassified）；去掉 0 用默认节流重建即可。macOS 第一次构建拿到的 3 915 条即来自该限流场景。
- 已修一个关窗卡死：E2E 的 `app.close()` 等 8 秒后直接收进程树，测试不再挂住。
