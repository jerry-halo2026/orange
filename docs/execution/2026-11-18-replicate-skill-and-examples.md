# 内置「视频复刻」技能 + 随包示例

2026-11-18。两件事：把官方 `replicate`（视频复刻）改成 OrangeFilm 品牌并作为**核心技能**随包分发；把官方示例 `one-prompt` 拉下来**封进发布包**，让示例面板离线可用。

## 1 视频复刻技能（内置）

| 项 | 值 |
| --- | --- |
| 来源 | `github.com/openfilm/skill-replicate`，commit `eef1ee5eda2a2aaeec60a3f133d73b86dd53c053`（v0.1.3，MIT） |
| 落位 | `packages/openfilm/manual/replicate/`（与 edit / media / canvas 并列，`coreSkills()` 第 4 位） |
| 文件 | `SKILL.md`、`openfilm.json`（含 5 语言标题/摘要/详情、`cover.jpg`、`order:4`、来源与 commit）、`cover.jpg`、`scripts/measure.mjs`（67 KB） |
| 改写 | 品牌词 OpenFilm → **OrangeFilm**；`npx openfilm …` → `openfilm …`（技能里只写命令名，这是本仓测试的硬要求） |
| 描述符 | 保留 `repository` 与 `sourceCommit` 作为出处；`builtIn: "orangeflim"` |
| 手册 | `MANUAL.md` 增加 `replicate` 一条，并把产品名统一为 OrangeFilm |

验证：`openfilm skills` / `openfilm skill replicate` 能打印；`node --test src/skills.test.mjs` **24/24**；实机 app 的 `/api/skills` 返回 `openfilm/edit, media, canvas, replicate`（各一条，无重复）。

### 为此修的一个重复问题

app 里曾出现两条 `openfilm/replicate`：一条是核心技能，一条是 Discover 目录里下载过的副本（uid 带 `@commit`）。修法：

- `src/skills.mjs`：`offeredSkills()` 里，核心技能按**名字**遮蔽 Discover 副本（`shadowsCore`）；`skillsNamed()` 的合并也按名字去重。
- `studio/server/server.mjs` 的 `/api/skills`：`had` 里加入核心技能 uid，并再按名字过滤 Discover 条目。
- `packages/openfilm/skill-catalog-seed.json`：删掉已被内置取代的 `replicate` 条目（该 seed 现在为空）。

## 2 示例随包（Examples 面板）

之前示例面板是空的：`EXAMPLES_INDEX` 指向占位地址 `raw.githubusercontent.com/OWNER/orange-film-skill/...`（永远 404）。

现在：

| 项 | 值 |
| --- | --- |
| 随包示例 | `packages/openfilm/examples/one-prompt/`（官方 `openfilm/examples` 的 `one-prompt` 整目录，96 文件，**6.5 MB**） |
| 索引 | `packages/openfilm/examples/index.json`（`folder: one-prompt`，封面 `one-prompt/look.jpg`，时长 1:31） |
| 默认指向 | `studio/server/examples.mjs` 的 `EXAMPLES_INDEX` 改为**包内** `examples/index.json`；`exampleFile()` 对本地索引按其所在目录取海报 |
| 覆盖 | `OPENFILM_EXAMPLES_INDEX` 仍可指向别的地址或本机文件（开发时用它挂 `examples/index.json` 里的口播示例） |
| 打包 | `package.json` 的 `files` 增加 `examples` |

验证：不设任何环境变量时 `listExamples()` 返回 1 条（One Prompt），海报解析到包内文件；实机 app 的 `/api/examples` 返回 1 条。`npm pack` 后 tgz **40.5 MB**，含 `package/examples/one-prompt/` 96 个文件与 `package/examples/index.json`，以及 `package/manual/replicate/` 4 个文件。

**没有封进包的**：官方 `openfilm-intro` 示例整目录 **214.8 MB**——放进安装包不划算。要它的话建议按"首次使用时下载"（像 library 的 published parts 那样）或继续从 GitHub 拉。

## 2.1 点开示例报「Project ownership is not established.」——已修

原因：随包示例的文件夹在**安装目录里**，桌面端只允许打开"属于本人"的工程路径（`projects.mjs:555` 的 `authority.pathAllowed`），于是按路径打开它 → 403 `project-access-denied`。

修法（把示例当成"新建一个我的工程，再把示例拷进去"）：

| 位置 | 改动 |
| --- | --- |
| `studio/server/server.mjs` | 新路由 `POST /api/examples/:id/start`：`exampleFolderHere(id)` → `createProject(名字)` → `cpSync(示例文件夹 → 工程)` → `{ project }`；`node:fs` 导入补 `cpSync` |
| `studio/server/examples.mjs` | 本地索引读出的示例带 `local: true` |
| `studio/ui/src/lib/project-sources.ts` | 新增 `startExample(id)` |
| `studio/ui/src/components/ProjectsLibrary.tsx` | `onStart`：`example.local` 时走 `startExample` 并直接打开；非本地仍走原来的 GitHub 拉取 |

实测（app 内）：`POST /api/examples/one-prompt/start` → **200**，生成 `one-prompt N` 工程并拷好 `film.html`（已删除测试工程）。

## 2.2 开箱即用：两张卡都在，点开就能用

| 示例 | 随包内容 | 点开 Start 时 |
| --- | --- | --- |
| `one-prompt` | 整个工程（96 文件，6.5 MB） | 直接从包内拷成你的工程，**离线可用** |
| `openfilm-intro` | 索引条目 + 封面 `look.jpg` + 它的 `README.md`/`CREDITS.md`（**215 MB 的素材不入 git**） | 首次点开始从 `github.com/openfilm/examples` 把它**拉进本机缓存**（`<home>/cache/examples/openfilm-intro`，一天内复用），再拷成工程；之后同 One Prompt 一样离线 |

`examples.mjs` 的 `exampleFolder()` 改了：随包索引里列出的示例，若包内没有 `film.html`，不再报「没有这个示例」，而是按它的仓库地址取一次（服务端本来就带 `fetchFolder`，写进缓存再拷进工程）。这样面板"开箱即用"，而不用把 215 MB 塞进 git。

> 为什么不是全封：整支 intro 是 304 文件 / 214.8 MB（mp4 127 MB、png 49 MB、字体 17.5 MB），放进 40 MB 的包里会让安装包涨 5 倍多；本机直连 GitHub 拉 215 MB 也屡次被重置（`ERR_RES_CONTENT_LENGTH_MISMATCH` / `ECONNRESET`）。首次点开时按需拉取（带缓存）是唯一稳妥的"开箱即用"。

## 3 overlay 记账（重建 overlay 时必做）

新增文件已登记 `overlay/new-files.txt`（+101：4 技能 + 97 示例）。

以下**上游文件被修改**，重建 overlay 时要收进 `overlay/patches/openfilm.patch`：

- `MANUAL.md`（replicate 条目 + 品牌）
- `studio/server/examples.mjs`（默认索引 + 本地海报解析）
- `studio/server/server.mjs`（`/api/skills` 去重）
- `src/skills.mjs`（核心遮蔽 Discover）
- `src/skills.test.mjs`（核心技能顺序 + replicate 断言）
- `package.json`（`files` 加 `examples`）
- `skill-catalog-seed.json`（删除被内置取代的 replicate）

## 4 还没做

- `openfilm-intro`（215 MB）未随包；需要定"下载即用"还是"封包"。
- 实机 app 的 Skills 面板/Skills 详情页尚未逐个点开看封面与脚本展示（数据面已确认 4 条、`scripts: 1`）。
