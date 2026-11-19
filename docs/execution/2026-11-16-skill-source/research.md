# skill 取源链路与「上游身份」盘点（只读研究）

- 仓库：`D:\dev\orange`，分支 `chore/vendor-0.3.2`，HEAD `cc974e6`（工作树未提交改动：`brand.json`、`brand.generated.ts`、`packages/openfilm/studio/ui/src/lib/product-links.ts`）。
- 方式：只读。未修改任何源码、未 commit。全部结论由 `git grep` / `git ls-files` 与实读文件得出，行号对应当前工作树。
- 影响面提示：本文 A.5 提到的 `packages/openfilm/studio/server/skill-catalog.mjs` 当前 `INDEX_URL` 已带占位 `OWNER`（提交 `57c41e8` 引入），即**现网 Discover 的索引地址是坏的**（fetch 必 404），离线兜底完全依赖"上次读到什么"。这一点决定了 A.4 的改动优先级。

---

## A. skill 取源链路

### A.0 关键文件与职责

| 文件 | 职责 |
|---|---|
| `packages/openfilm/src/skills.mjs` | skill 的领域模型与**本地取源**：发现三层目录、解析 `SKILL.md`/`openfilm.json`、uid 归属、开关、注入给 agent 的文本（`skillText`）、按地址/文件夹加入 |
| `packages/openfilm/src/skills-cli.mjs` | `openfilm skills` / `openfilm skill <uid>` 与"先看再收"的暂存：`previewSkills`(66)、`previewFolder`(98)、`commitSkills`(113)、`discardSkills`(127) |
| `packages/openfilm/studio/server/skill-catalog.mjs` | **远端取源**（Discover）：读索引 `index.json`、按 commit 落盘、安装/更新/卸装、与索引比新旧 |
| `packages/openfilm/studio/server/fetch-github.mjs` | 索引条目的按文件下载（`listFiles`/`downloadFiles`，被 skill-catalog 引用 L23） |
| `packages/openfilm/studio/server/fetch-repo.mjs` | 按 GitHub/GitLab **地址**取仓（`parseRepoUrl` 47、`fetchFilm` 233），供"粘贴地址加 skill"与拉示例片 |
| `packages/openfilm/studio/server/server.mjs` | HTTP 面：`/api/skills`(628)、`/api/skills/catalog`(664)、`/api/skills/<uid>/installed`(682)、`/update`(691)、`/on`(707)；启动预热 `bootstrapStudioResources`(1692) |
| `apps/desktop/src/skills-ipc.mjs` | Electron IPC：`desktop:skills:list/texts/preview/commit/discard/reveal`，只做转发（`lib()`=openfilm/skills，`cli()`=openfilm/skills-cli，L41-42） |
| `apps/desktop/src/agent-skills.mjs` | **第 4 层来源**：各 agent 自己的 skills 目录；以及把 OpenFilm 的 skill 以 `owner-name` 链接成会话目录注入各 agent（`sessionSkills` 308、`linkFolder` 232） |
| `apps/desktop/chat/src/app-bridge.ts` | 渲染进程的类型与通道（`skills.*` 96-109，`starterSkills` 55） |
| `apps/desktop/chat/src/components/AddSkill.tsx` | "加一个 skill"对话框：地址 / 文件夹 / 让 agent 现做；只调用 `preview/commit/discard` |
| `apps/desktop/chat/src/lib/skill-pages.ts` | 与取源**无关**：只决定"这条消息要不要把某个 skill 的 `SKILL.md` 随消息发给 agent"（按会话去重，`pagesToSend`/`givenAfter`） |
| `apps/desktop/scripts/release.mjs` | 打包：**没有任何 skill 逻辑**；`files`(297) + `asarUnpack: ['node_modules/openfilm/**']`(296) 决定 `openfilm` 包里带什么 |

### A.1 来源、顺序与优先级

本地侧（`skills.mjs:54`）：

```
SKILL_SOURCES = ['project', 'mine', 'official']   // 同一 uid，先者胜
```

1. `project` — `<project>/skills/<name>/`（`PROJECT_SKILLS` 52），随片走。
2. `mine` — 人的自有：`OPENFILM_SKILLS` 或"项目库旁边的 `Skills/`"（`mySkillsDir` 100）；旧位置 `~/.openfilm/skills` 会被 `migrateMySkills`(113) 搬过来；来源记在 `mine/.origins.json`（`skillOrigins` 591）。
3. `official` — 已安装的"官方/社区"skill：`OPENFILM_OFFICIAL_SKILLS` 或 `<sharedHome>/skills-installed`（`officialSkillsDir` 61），每个带 `.source.json`（repo/path/commit/version，`skillSource` 68）。

另有两条**不在**上述三层，但同样算"被发现"的来源：

0. `coreSkills` — 包内 `packages/openfilm/manual/`（`coreSkillsDir` 94；三个 skill：`edit`/`media`/`canvas`，`CORE_SKILLS` 382）。永远在场、不可安装/删除，只能被关（`skillsOff` 363）；给 agent 的顺序固定 edit→media→canvas（`coreSkills` 385）。
4. 各 **agent 自己的** skills 目录 — `agent-skills.mjs:114 ownSkills`：claude(`~/.claude/skills`)、codex(`~/.codex/skills`、`~/.agents/skills`、plugins cache)、opencode、qwen、copilot；按人的白名单过滤（`FILTERED_AGENTS` 44）。它不是 OpenFilm 的库，只在输入框 Skills 面板可见/可放行。
5. **Discover 未安装的** — 索引里有、本地没装的，用于"先试再说"：`discoverSkills()`(84) 并入 `skillsNamed`(405)/`offeredSkills`(447) 的 `rest`。

给 agent 的注入顺序（`offeredSkills` 447-458）：`core（未关）` → `usable（project/mine/official 里未关）` → `rest（含未安装的 Discover）`；`given` = 前两段。

同名冲突规则：uid = `owner/name`（`SKILL_UID` 145），owner 由**来源**决定而非 skill 自述（`skillOwner` 162-177：official→其仓库账号、project→`project`、从链接加的→GitHub 账号/`gitlab-<group>`、其余→`local`）。同名不同 owner 并存；agent 侧只认名字，故用 `owner-name`（`agentName` 423，超长再编号 `agentNames` 431）。

### A.2 有没有"远端仓库 / URL"概念

**有，而且是两条互不相干的链路。**

- 链路 1「按地址加」（人主动，一次性）：`desktop:skills:preview` → `previewSkills(url)`（skills-cli 66）→ `fetch-repo.mjs`（GitHub/GitLab，克隆/tarball 到暂存）→ `commitSkills` → 落到 `mine`，并把 `{from:'link', address}` 写进 `.origins.json`。支持 GitHub 与 GitLab（`parseRepoUrl` 47），不支持任意裸 URL。
- 链路 2「Discover 索引」：`skill-catalog.mjs:33 INDEX_URL` 指向一个 **`index.json`**；每条 `{name, repo, path, version, commit}`，按 commit 逐文件下载（`fetch-github.mjs`），落到 `<sharedHome>/skill-catalog/<owner>/<name>@<commit>`，`.source.json` 记录出处；安装=拷到 `skills-installed`（`installSkill` 177），更新=换 commit（旧文件夹进回收站），索引里消失=标记 `retired`（`installedStanding` 156）。
- 索引可被 `OPENFILM_SKILLS_INDEX` 覆盖，取值 `https://…` 或**本机 `index.json` 路径**（`refreshCatalog` 81-90 的 if/else，本机路径直接 `readFile`，无网络）。

也就是说：**没有 registry/service API，只有"一个 index.json + GitHub 上的 commit 固定文件"**。没有签名、没有 hash 校验（`skill-catalog-seed.json` 的生成脚本里才有 sha256 校验，运行时没有）。

`brand.json.links.skills`（`https://github.com/jerry-halo2026/orange-film-skill`，`brand.json:21`）目前**没有任何代码读它**：全仓只有 `brand.json`、`brand.generated.ts` 出现该字符串；`product-links.ts:9` 的 `BrandLinks` 类型只有 `docs/github/issues/discussions/community`，`PRODUCT_LINKS`(12) 也只取前三个。→ 换源必须新增消费方。

### A.3 现在读 `index.json` 还是每次扫文件夹

两层答案，别混：

- **Discover 侧读 `index.json`**：`readCatalog()`（skill-catalog 67）读 `<sharedHome>/skill-catalog/index.json`（`{read, entries[]}`，`read` 是 ISO 时间）；`readDiscover({fresh})`(128) 在 `FRESH_MS`(35)=10 分钟内不重读，并发只允许一次 `refreshCatalog`。`refreshCatalog`(80) 只对"索引里有、本地缺这个 commit"的条目去下载（92-105），并把索引里已不存在的目录删掉（107-112）。`server.mjs:1439` 让 Studio 启动时预热一次 `readDiscover({fresh:60000})`。
- **本地三层（project/mine/official）+ core 每次都扫文件夹**：`skillsIn(dir, source)`（skills.mjs 314）`readdirSync` 后对每个子目录 `readSkill`（280）——内含读 `SKILL.md` + 读 `openfilm.json`（`openfilmJson` 244）+ 递归 `scriptsIn`（295，最多 5 层/50 项）。**没有缓存、没有本地索引**。`listSkills`(332) 被 `/api/skills`（每次打开库/切项目）、`offeredSkills`（每次 chat 列表、每次会话建档）调用，因此每次请求都做 O(技能数) 次 stat + 文件解析。
- 同一份 Discover 数据被读两遍：`skill-catalog.catalogSkills()`(144) 按 entries 逐个 `readSkill`，`skills.mjs.discoverSkills()`(84) 再读同一个 `index.json` 并再扫同一批文件夹。

结论：**索引只覆盖"发现远端有什么"，本地一律现扫**；而"扫出来的元数据"没有任何一层缓存。

### A.4 换成 `brand.json.links.skills` + 内置快照离线可用：最小改动点

按依赖顺序，共 6 处（都不需要动 IPC/UI 转发层）：

**(1) `packages/openfilm/studio/server/skill-catalog.mjs:26-33` — `INDEX_URL` 从 brand 派生**
- 现状：`'https://raw.githubusercontent.com/OWNER/orange-film-skill/main/index.json'`，注释自称占位；`OWNER` 从未被替换 → 线上必 404。
- 改什么：新增极小的 brand 读取（`packages/openfilm/src/brand.mjs`，照 `apps/desktop/src/brand.mjs:23-41` 的 `brandCandidates`＋`readBrand` 写法向上找 `brand.json`；`packages/openfilm` 不能 import `apps/desktop`），由 `links.skills` 的 `https://github.com/<o>/<r>` 派生 `https://raw.githubusercontent.com/<o>/<r>/<branch>/index.json`（branch 走默认 `main`，或读一次 repos API；实测无网时必须能退化）。`OPENFILM_SKILLS_INDEX` 保持最高优先（已有 81）。
- 为什么：单一真相源，换仓只改 `brand.json`；同时消灭占位导致的"永远 404"。

**(2) 同文件 `indexEntries()`(57-64) — 索引校验过严**
- 现状：要求 `e.path === 'skills/' + e.name`、`version` 匹配 `^\d+\.\d+\.\d+$`、`repo` 必须 `github.com/<o>/<r>`；任一条不符整条丢弃且**不报错**。
- 改什么：`version` 改为可选（缺省时用 `SKILL.md` front matter 的 `version`，`readSkill` 287 已支持）；`path` 放宽为 `skills/<name>` 前缀（兼容后续 `examples/<id>` 不参与）；`paths` 显式排除。理由：`orange-film-skill` 的布局是 `index.json` + `skills/<id>/SKILL.md` + `examples/<id>/`，若 version 写成 `1.0` 或省略，Discover 会"空页面但无错误"，排查成本极高。

**(3) 同文件 `refreshCatalog()`(80-117) — 加超时与离线兜底**
- 现状：无 `timeoutMs`（上游 0.3.2 已加，vendor 合并时正好对齐）；`fetch` 失败直接 `throw` → `server.mjs:664` 返回 502；首次启动无缓存时 Discover 全空。
- 改什么：加 `timeoutMs`（默认 ~15 s）与 `AbortSignal.timeout`；失败路径 `return readCatalog() ?? seedCatalog()`（见 (4)），只在"缓存也没有、快照也没有"时才向上抛。
- 为什么：`OPENFILM_SKILLS_INDEX` 指向本机文件时已经是纯离线（90），补上 https 侧的确定性超时与回落，离线才真的"可用"而不是"卡住/502"。

**(4) 内置快照真正接上：`skill-catalog.mjs` 新增 `seedCatalog()` + `packages/openfilm/package.json:43-68` 的 `files`**
- 现状：`packages/openfilm/scripts/skill-catalog-seed.mjs` 能生成 `packages/openfilm/skill-catalog-seed.json`（内含 `replicate` 一个 skill 的 base64 文件与 LICENSE，`THIRD_PARTY_NOTICES.md:22` 有说明），但：
  - 全仓**没有任何运行时读取者**（只有 `scripts/` 与 notices 提到它）；
  - `packages/openfilm/package.json` 的 `files` 白名单里**没有** `skill-catalog-seed.json` → `npm pack` 出来的包不带它 → `release.mjs` 的 `asarUnpack: node_modules/openfilm/**` 也带不出一个不存在的文件。
- 改什么：a) `seedCatalog()` 读包内 `skill-catalog-seed.json`，把每个 entry 的文件 base64 落成 `skill-catalog/<owner>/<name>@<commit>/`（并写 `.source.json`），合成 `{read, entries}` 供 `readCatalog()`/`catalogSkills()` 直接使用；b) `package.json.files` 加 `"skill-catalog-seed.json"`。`release.mjs` **不用改**（skill 由包带出）。
- 为什么：这是"首启即有 Discover 且离线可装"的唯一来源；也避免与 (3) 的回落互相空转。

**(5) `packages/openfilm/src/skills.mjs:84-92 discoverSkills()` 与 `:162-177 skillOwner()`**
- 现状：`discoverSkills()` 只读 `<sharedHome>/skill-catalog/index.json`，文件不存在直接 `return []`——即使快照在包里也看不见；`skillOwner()` 的 official 分支在没有 `.source.json` 时回落硬编码 `'openfilm'` 命名空间（166）。
- 改什么：`discoverSkills()` 在无 `index.json` 时回落到 seed（或让 (4) 的 `seedCatalog()` 顺手写出一份 `index.json`，则此处零改动——**推荐后者**，改动面更小）；`skillOwner()` 的 official 回落改为品牌 owner（脚本 owner），或干脆去掉硬编码 fallback（official 条目必有 repo）。
- 为什么：uid `owner/name` 会进 UI、进 agent 上下文（`agentNames` 431 / `skillText` 473）、进 `.origins.json`，是身份面；`openfilm/xxx` 会直接暴露上游名。

**(6) `packages/openfilm/scripts/skill-catalog-seed.mjs:12` — 快照生成器的来源过滤**
- 现状：`.filter((e) => new URL(e.repo).pathname.startsWith('/openfilm/'))`。换成 `jerry-halo2026/orange-film-skill` 后**重新生成会得到空快照**并抛 `The index has no official skills.`
- 改什么：改为按索引 entries 全取（或按 brand 的 owner 判断，`OWNER`/`USER` 占位）。
- 为什么：快照的重建路径不能与新源互相排斥，否则下次刷新就断。

**不需要改（明确列出，避免误改）**
- `apps/desktop/src/skills-ipc.mjs`、`app-bridge.ts`、`AddSkill.tsx`、`lib/skill-pages.ts`：只转发/文案/按会话去重；`AddSkill.tsx:165` 的 placeholder 与各语言 `skills.addHint` 已经是 `orange-film-skill`。
- `apps/desktop/scripts/release.mjs`：无 skill 逻辑。
- `skills.mjs` 的三层发现与 `skillsIn`：与远端索引无关，保持现扫（若要性能，届时再谈本地索引缓存，别混进这次改动）。

### A.5 改动后的取源时序（预期行为）

1. Studio 启动 → `bootstrapStudioResources` → `readDiscover({fresh:60000})`。
2. `readCatalog()` 命中 `<sharedHome>/skill-catalog/index.json` 且 10 分钟内 → 直接用。
3. 否则 `refreshCatalog()`：`OPENFILM_SKILLS_INDEX` > `brand.links.skills` 派生的 raw 地址；超时/失败 → 上次缓存 → 内置快照。
4. 条目逐个校验（放宽后的 `indexEntries`），缺的 commit 才下载；写回 `index.json`（`read` = 现在）。
5. 安装：`installSkill(uid)` 拷到 `skills-installed`（带 `.source.json`），`listSkills` 的 `official` 层即可扫到；uid 的 owner 来自 repo 账号。
6. 关网重启：快照/缓存已在 `skill-catalog/` 下，`catalogSkills()` 照常列出，`installSkill` 纯本地拷贝，功能不降级。

### A.6 验证清单（改动落地时至少跑这些）

- `packages/openfilm/studio/server/skill-catalog.test.mjs`（已有"本机 index.json"用例，`overlay/patches/studio.patch:6015` 引入，正好是离线路径的现成回归）
- `packages/openfilm/src/skills.test.mjs`（uid/owner/discover 相关）
- `apps/desktop/src/skills-ipc.test.mjs`、`apps/desktop/src/agent-skills.test.mjs`
- `apps/desktop/chat/src/lib/skill-pages` 外的 UI 无需新增；`packages/openfilm/studio/ui/src/i18n/keys.test.ts`（新增/删除 i18n key 时）
- 手工：把 `OPENFILM_SKILLS_INDEX` 指向本机 `index.json`、再断开网络各启动一次，比 `/api/skills` 的 `catalog.read` 与列表。

---

## B. 剩余「上游身份」清单

### B.0 口径与计数

`git grep -I -c` 按文件统计命中行数（仅 tracked 文件；`docs/history` 在树内，一并计入"该留"）。

| 检索词 | 文件数 | 行数 |
|---|---|---|
| `OpenFilm`（整词） | 641 | 1851 |
| `openfilm.dev` | 25 | 35 |
| `github.com/openfilm` | 40 | 859 |
| `riverisbuilding` | 5 | 185 |
| `openfilm.json`（格式名，保留） | 14 | 48 |

按桶汇总（同一分类规则，规则见 B.1）：

| 桶 | 文件 | 行 |
|---|---|---|
| **该换 — 产品身份** | 546 | 1322 |
| 该留 — 上游出处/协议/历史（`docs/`、`overlay/`、`.github/`、README/SECURITY/TRADEMARK/CODE_OF_CONDUCT/CONTRIBUTING/LICENSE） | 29 | 219 |
| 该留 — 上游发布记录（`CHANGELOG.md`×2） | 2 | 88 |
| 该留 — 测试夹具（`.test.mjs/.test.ts` 里的样例字符串） | 61 | 217 |
| 该留 — 第三方来源（`examples-index/SOURCE`、`THIRD_PARTY_NOTICES.md`、seed） | 3 | 5 |

`github.com/openfilm` 的 859 行里 **836 行**是 CHANGELOG 里的 PR/commit 链接与 `overlay/patches` 快照——全部"该留"；剩下 23 行才是产品身份（`package.json` 的 repository/bugs、README 正文、`.github` 模板等）。
`riverisbuilding` 184/185 行是 CHANGELOG 的致谢署名（"Thanks [@riverisbuilding]"）——该留；唯一 1 行产品身份是 `product-links.ts:26`。

### B.1 分类规则

- **该留**：① 上游出处与许可（`LICENSE`、`THIRD_PARTY_NOTICES.md`、`TRADEMARK.md`、`examples-index/SOURCE`、`packages/openfilm/TRADEMARK.md`）；② 上游发布记录（`CHANGELOG.md`，含 PR 链接与致谢）；③ 历史证据（`docs/history/**`、`docs/discovery/15…`、`docs/execution/**` 已发生的执行记录）；④ vendor 兼容层快照 `overlay/patches/**`（改了就无法与上游 diff 复现，属证据而非产品面）；⑤ 测试里的样例值（断言用的假数据）。
- **该换**：用户可见文案、产品名/品牌、桌面壳与打包标识、指向上游服务的默认地址与账号入口、发给 agent 或写进 uid 的身份命名空间、命令/`bin` 名（除包名保留，见 B.4）。
- 明确排除（保留）：`openfilm.json`（skill 清单格式名）、npm 包名 `openfilm`、导出子路径 `openfilm/skills`、`bin.openfilm`。

### B.2 该换（代表条目；同一模式在各语言 i18n 里重复，按组计数）

**用户可见文案 / UI**
| 文件:行 | 当前文本 | 说明 |
|---|---|---|
| `packages/openfilm/studio/ui/src/i18n/en.ts`（及 `es/ja/ko/zh-CN` 同 key） | 56/56/55/55/55 行：如 `discoverNote: 'Films made with OpenFilm, to start from or to learn from.'`、`title: 'OpenFilm for desktop'`、`skillsOfficial: 'OpenFilm'`、`hint: 'What OpenFilm finds on this computer…'`、`providers… openfilm: 'OpenFilm\'s own service…'` | 最大单块（277 行）；`skillsOfficial` 直接是库里的分区标题 |
| `packages/openfilm/studio/ui/src/components/BrandLogo.tsx:22-23` | `const FALLBACK_NAME = 'OpenFilm';` / `FALLBACK_LABEL = '橙子创作中心'` | fallback 名（`brand.productName` 已存在，L28） |
| `apps/desktop/chat/src/i18n/locales/{es,ja,ko}.ts` | 各 7 行，如 `ffmpegMissing: '…再開 OpenFilm してください：'`、`skillsOpenfilm: 'OpenFilm のスキル'` | 这三语未走 `brand.*` 键，硬编码 |
| `apps/desktop/chat/src/lib/local-agent-run.ts:803,1062` | `'This needs the OpenFilm Mac app.'`、`'OpenFilm closed while the agent was working on this.'` | 运行时错误文案 |
| `apps/desktop/chat/src/i18n/locales/{en-US,zh-CN}.ts:15` | `product: company || product || 'OpenFilm'` | fallback（保留语义，值需换） |

**桌面壳 / 运行时标识**
| 文件:行 | 当前文本 |
|---|---|
| `apps/desktop/src/flavor.mjs:25,27,31,38` | `productName: 'OpenFilm'` / `'OpenFilm Preview'` / `'OpenFilm Dev'` / `'OpenFilm Bench'`，`bundleId: 'dev.openfilm.desktop*'` |
| `apps/desktop/shell/bridge.ts:291` | `name: 'OpenFilm'`（Studio host 自报名） |
| `apps/desktop/src/studio.mjs:77` | `serviceName: 'OpenFilm Studio'` |
| `apps/desktop/src/agent-definitions.mjs:7` | `openfilm: { name: 'OpenFilm', install: null }`（内置 agent 显示名） |
| `apps/desktop/src/agents.mjs:940`、`agent-usage.mjs:88` | `{ name: 'openfilm-desktop', title: 'OpenFilm', … }`（ACP clientInfo，对外可见） |
| `apps/desktop/src/app-report.mjs:46` | `'OpenFilm desktop app'`（诊断报告首行） |
| `apps/desktop/src/analyze.mjs:34` | `const product = (env.OPENFILM_PRODUCT_NAME ?? 'OpenFilm')…` |
| `apps/desktop/src/update-menu.mjs:14` | `productName = 'OpenFilm'`（手动更新弹窗默认值） |
| `apps/desktop/src/main.mjs:52` | `DISPLAY_NAME = brandWindowTitle()` — **已 brand 化**（列此说明壳层已通，无需重复改） |

**打包配置**
| 文件:行 | 当前文本 |
|---|---|
| `apps/desktop/scripts/release.mjs:81` | `const NAME = preview ? 'OpenFilm Preview' : 'OpenFilm'` |
| 同上 `:289` | `appId: preview ? 'dev.openfilm.desktop.preview' : 'dev.openfilm.desktop'`（`brand.json` 已有 `appId: com.orange.studio`，此处未读） |
| 同上 `:291` | `copyright: 'Copyright © 2026 OpenFilm'`（`brand.json.about.copyright` 未读） |
| 同上 `:328` | `NSMicrophoneUsageDescription: 'OpenFilm records sound from the microphone when you press Record.'` |
| `apps/desktop/package.json:2,6` | `"name": "@openfilm/desktop"`、`"productName": "OpenFilm"` |
| `packages/openfilm/package.json:4,6` | `description: "The open source AI video agent: …"`、`homepage: "https://openfilm.dev"` |
| `packages/shared/package.json:7,8` | `description: "What OpenFilm's clients share: …"`、`homepage: "https://openfilm.dev"` |

**默认指向上游服务 / 账号入口（不只是文案，是外发地址）**
| 文件:行 | 当前文本 | 影响 |
|---|---|---|
| `packages/openfilm/studio/server/library.mjs:59` | `'https://openfilm.dev/library'` | 素材库默认远端根 |
| `packages/openfilm/studio/server/community-library.mjs:18` | 同上 | 社区库 |
| `packages/openfilm/src/library-semantic.mjs:81` | `POST ${serviceUrl('API','https://openfilm.dev')}/v1/library/search` | **把检索词外发到上游** |
| `packages/openfilm/studio/server/account.mjs:42` | `${serviceUrl('API','https://openfilm.dev')}/v1/agent` | 账号/额度 |
| `packages/openfilm/studio/server/providers/openfilm.mjs:90` | `service = () => serviceUrl('API','https://openfilm.dev')` | 内置"OpenFilm"服务商 |
| `apps/desktop/src/pi-config.mjs:247` | `{ host: /(^|\.)openfilm\.dev$/, name: 'OpenFilm', url: 'https://openfilm.dev/account' }` | 登录窗口归属识别 |
| `packages/openfilm/product.official.json:3` | `"updates": "https://openfilm.dev/download/desktop"` | 官方构型的更新通道 |
| `.github/workflows/desktop.yml:5` | `… (openfilm.dev/download/… redirects there)` | CI 注释（发布链） |

**身份命名空间 / 来源标记**
| 文件:行 | 当前文本 |
|---|---|
| `packages/openfilm/src/skills.mjs:166` | official 无来源时回落 `'openfilm'`（决定 uid `openfilm/xxx`） |
| `apps/desktop/src/agent-skills.mjs:264` | `if (owner === 'openfilm') return 'OpenFilm'`（插到 SKILL.md 抬头的 "by …"） |
| `packages/openfilm/scripts/skill-catalog-seed.mjs:12` | `filter(e => new URL(e.repo).pathname.startsWith('/openfilm/'))` |
| `packages/openfilm/studio/ui/src/lib/product-links.ts:26-34` | `CREATOR_HANDLE = 'riverisbuilding'` + 5 个社交账号直链（当前**已无消费者**，是死导出） |
| `apps/desktop/src/openfilm-mcp.mjs:31,33` | 写闸门与审计文件在 `~/.openfilm-dev/`（产品身份，但改动需兼容旧路径） |

### B.3 该留（代表条目）

| 文件:行 | 当前文本 | 归类 |
|---|---|---|
| `LICENSE`（MIT）、`packages/openfilm/LICENSE` | 上游许可 | 协议 |
| `THIRD_PARTY_NOTICES.md:22-23` | `…includes OpenFilm's Replicate skill at its pinned commit from openfilm/skill-replicate (MIT License, © 2026 OpenFilm contributors)` | 许可归属 |
| `TRADEMARK.md`（9 行，如 `:25` 的"Write to support@openfilm.dev"）、`packages/openfilm/TRADEMARK.md:25` | 上游商标政策 | 许可/协议（正文该留；`support@openfilm.dev` 联系方式属上游，可另列一条"该换"） |
| `packages/openfilm/examples-index/SOURCE:1-2` | `https://github.com/openfilm/examples/commit/2e8f478…` | 出处 |
| `apps/desktop/CHANGELOG.md`（35 行 `OpenFilm` + 240 行 PR 链接 + 25 行致谢）、`packages/openfilm/CHANGELOG.md`（53 + 501 + 151） | 上游发布记录 | 出处 |
| `overlay/patches/{desktop,meta,studio,extra,package}.patch`（124 行） | vendor 差异快照 | 证据（改则失去可复现 diff） |
| `docs/discovery/15_OpenFilm资源来源与分发边界.md:21,48`、`docs/history/**`、`docs/execution/**` | 已发生的调研/执行记录 | 历史证据 |
| `README.md:3`、`README.zh-CN.md:3` | "Based on the original OpenFilm v0.3.0 … The upstream README below is retained for provenance" | 出处声明（**正文保留**，但见 B.5 第 5 条） |
| `packages/openfilm/manual/{edit,media,canvas}/SKILL.md`（15 行） | 契约正文里自称 OpenFilm | 见 B.4 灰区 |
| 各 `*.test.mjs/*.test.ts` 里的 `'OpenFilm'` 样例 | 断言夹具 | 该留 |

### B.4 灰区与保留名单（明确不要动）

- **保留**：`openfilm.json`（skill 清单文件名，`skills.mjs:246`、`manual/*/openfilm.json`、各语言注释）、npm 包名 `openfilm`（`packages/openfilm/package.json:2`、`require.resolve('openfilm/skills')`）与 `bin.openfilm`、根 `openfilm-monorepo`、环境变量前缀 `OPENFILM_*`（~40 处，改名需兼容别名，且 `preview`/`dev` 脚本与外部 CI 依赖）、`~/.openfilm*` 目录（迁移代价高，建议只做显示层）。
- **灰区（建议本轮不动）**：`manual/*/SKILL.md` 与 `packages/openfilm/MANUAL.md` 正文里自称 OpenFilm——它是"契约正文"，改动会影响与上游 skill 文本的 diff 与既有会话缓存；`agent id = 'openfilm'`（`agent-skills.mjs:44,357`、配置持久化键）同理。
- **注意**：`README.md:111` 写 "OpenFilm's and the community's under Discover, from openfilm/skills"，换源后该句**事实错误**，属"该换"（B.5 第 5 条已列）。

### B.5 最该先改的 5 条（按"对外可见 × 改成真话 × 成本低"排序）

1. **`packages/openfilm/studio/ui/src/i18n/{en,zh-CN,es,ja,ko}.ts` 共 277 行产品名**（`OpenFilm` → `{brand}` / 直接写"橙子创作中心"）：唯一大面积直面用户的身份，且 `skillsOfficial: 'OpenFilm'` 会让库里整块分区叫上游名。成本：机械替换 + `keys.test.ts`。
2. **5 个默认外发地址**：`library.mjs:59`、`community-library.mjs:18`、`library-semantic.mjs:81`、`account.mjs:42`、`providers/openfilm.mjs:90`（全部 `https://openfilm.dev`）。这是**数据真的发到上游**的地方，不只是名字；须先定"自有服务 / 关闭默认 / 保留并显式告知"。
3. **打包标识**：`release.mjs:81,289,291,328` + `apps/desktop/package.json:6` + `flavor.mjs:25-38`——`brand.json` 里已有 `productName`/`appId`/`about.copyright`，但 release 与 flavor 完全没读，安装包名/AppId/版权仍是上游的。
4. **uid 命名空间与"by …"落款**：`skills.mjs:166`、`agent-skills.mjs:264`、`skill-catalog-seed.mjs:12`——决定 `openfilm/xxx` 是否出现在 agent 上下文与 UI 里，和本次换源强耦合（见 A.4(5)(6)）。
5. **`product-links.ts:26-34` 的 `riverisbuilding` 与 5 个社交账号直链**：全仓唯一残留的上游作者个人身份（其余 184 行都是 CHANGELOG 致谢，该留）；且现在是死导出，删除/替换零风险。附带把 `README.md:111` 的 "from openfilm/skills" 改成新索引仓（换源后即为错句）。

---

## C. 待 operator 决策（研究结论里无法单方面定的）

1. 索引仓 `<owner>`（`jerry-halo2026` 还是最终发布账号）与默认分支：`brand.json.links.skills` 现有值可直接派生，但发布前是否换账号需确认。
2. 5 个 `openfilm.dev` 默认地址的处置：自有服务替换 / 关闭默认（Discover、语义检索、账号、内置服务商、素材库根），属对外行为与数据外发，需明确取舍。
3. `OPENFILM_*` 环境变量前缀与 `~/.openfilm*` 目录是否做改名+兼容别名（影响 `scripts/dev`、CI、已安装用户）。
4. 快照是否只保留 `replicate`（现有 seed 只有 1 条），还是换源时把 `orange-film-skill` 的官方 skill 全量冻结进包（体积：现有 seed 为 230,123 B ≈ 225 KB / 1 条，需实测全量）。
