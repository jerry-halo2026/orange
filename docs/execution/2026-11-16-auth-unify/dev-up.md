# 「一条命令起全套」缺口清单（只读研究，分支 `chore/vendor-0.3.2`）

范围：只读阅读与只读探测。未改动任何既有文件、未 commit、未起/停任何 docker 容器、未启动应用。
唯一新增文件即本文件。行号取自本次阅读快照（2026-11-16 13:52 前后）。
结论层级：运行时行为 > 已捕获输出 > 源码注释。

**运行时快照（本次实测）**

| 事实 | 证据 |
| --- | --- |
| `orange-w1-db` 已 `Up 2 days (healthy)`，`127.0.0.1:55432->5432` | `docker ps` |
| 账本已到 `011`，`target=local`，12 个文件与盘上 sha256 一致 | `node infra/migrate.mjs --check` → `--check 通过`，exit 0 |
| `ops.tenant_member` = **0 行**；`public.material` = 0 行 → 无种子 | `psql -At -c 'select count(*) …'` |
| 当下已有一个 dev 桌面壳在跑：`electron.exe` pid 32152（utility = Studio），占 `4757/4758`，`%USERPROFILE%\.openfilm-dev\run.json` 内容 `origin=http://127.0.0.1:4757`、`filmOrigin=http://localhost:4758` | `Get-NetTCPConnection`、`Get-CimInstance Win32_Process`、读 run.json 的非密钥字段 |

---

## 1. 从零到「能登录能用」：10 步，5 步有脚本 / 5 步纯手工

| # | 动作 | 脚本? | 证据 | 断了会怎样 |
| --- | --- | --- | --- | --- |
| 1 | `pnpm install`（node ≥ 22.18） | 标准命令，**无包装脚本** | `package.json:8-10`（engines）、`package.json:11-25`（无 install/ bootstrap 条目） | 后续全部 ENOENT |
| 2 | `docker compose -f infra/docker-compose.yml up -d`，再等 `(healthy)` | **无脚本** | 仅文档 `docs/sql/README.md:17-19`；编排 `infra/docker-compose.yml:8-33` | 第 3 步起全部失败（见 §3 的可读性缺陷） |
| 3 | `node infra/migrate.mjs --target local` | **有脚本** | `infra/migrate.mjs:5`、`docs/sql/README.md:66` | 表/角色/RLS/RPC 全缺 |
| 4 | `node infra/verify.mjs`（9 项） | **有脚本** | `infra/verify.mjs:24`、`TOTAL=9`（`:34`） | 库「看起来起来了」但租户/RLS/向量 RPC 未证 |
| 5 | 写 `ORANGE_AUTH_CONFIG_FILE`（绝对路径 JSON，恰好三键 `{environmentId, authOrigin, publishableKey}`，`authOrigin` 必须 **https**） | **纯手工** | 读取点唯一：`apps/desktop/src/desktop-auth.mjs:21-31`（`:24` 绝对路径、`:26` nlink/size、`:28` 键集合）；https 硬校验 `apps/desktop/src/auth-service.mjs:103-113`（`:105`）、测试钉住 `auth-service.test.mjs:21-25` | `service=null` → 永久 `signed-out/configuration-required`（`desktop-auth.mjs:100-104,110`），登录框输入被禁用（`apps/desktop/shell/Login.tsx:27,41`） |
| 6 | 该环境里**有账号**（GoTrue `/auth/v1/token?grant_type=password`） | **纯手工**，本仓无本地 auth 服务 | `auth-service.mjs:389`、`auth-service.mjs:400` | 同上，登录必然 4xx |
| 7 | 种子：`ops.tenant_member`（成员→租户）+ 业务数据 | **无脚本，纯手工 psql** | 表在 `docs/sql/008_unify_surface.sql:48`；全仓无 `insert into ops.tenant_member`；实测 0 行 | 无 JWT claim 时租户回落三级全空 → `42501 tenant-context-required`（`008:185-202`、`010`） |
| 8 | 素材服务凭据 `.dev/zhishang/credentials.local.json` + `.dev/staging` | **纯手工**（文件已存在），路径硬编码 | `apps/desktop/src/main.mjs:121-129`；`apps/api/src/credentials.ts:51-56`（必须在 `.dev` 下、必须叫 `credentials.local.json`）；`material-service.mjs:226-232` | 素材服务 `credentials-missing`/`staging-*` 拒绝启动，窗口降级但可登录（`main.mjs:134-139`） |
| 9 | `pnpm dev`（Studio 4848 + vite watch + 写 `.dev/bin/openfilm{,.cmd}`） | **有脚本** | `package.json:12` → `packages/openfilm/scripts/dev.mjs:19-31`（`:23` home、`:27` 端口 4848）、`:50-59`、`:102-118` | 无 Studio，桌面壳开不了编辑器 |
| 10 | `pnpm dev:desktop`（先 build shell，再拉 Electron） | **有脚本** | `package.json:13` → `apps/desktop/scripts/start.mjs:27-35`（build）、`:71`（spawn） | 无窗口 |

**判定**：第 2/5/6/7/8 步无脚本（5 步）；其中第 5+6 步在**本地**形态下不只是「麻烦」，是**当前无解**——见下条。

**第 5 步的硬缺口（最该先决策的一条）**

- 本地栈的默认环境写死在 `packages/openfilm/src/auth-environment.mjs:23-27`：`authOrigin: 'http://127.0.0.1:54321'`、`publishableKey: 'local-anon-key'`。
- 但 `54321` 在本仓**没有任何服务**：全仓只有 1 处 `54321`（就是那个常量本身）；没有 `supabase/config.toml`、没有 GoTrue/Kong/PostgREST 容器；编排文件只有 `infra/docker-compose.yml` 的单个 `db` 服务（`:9-11`）。
- 且 `http:` 会被 `auth-service.mjs:105,111` 判 `invalid-configuration`，`desktop-auth.mjs:103` 吞成 `service=null`。
- 另：`resolveEnvironment()`（`auth-environment.mjs:88-132`）目前**未被任何生产路径引用**（全仓 grep 只命中它自己的测试），`desktop-auth.mjs:23` 只认 `ORANGE_AUTH_CONFIG_FILE` 文件路径，不认 `ORANGE_AUTH_ENV` 内联 JSON。
- 结论：本机现在能登录，靠的是 `.dev/auth-runtime.json` 指向**托管 Supabase**（键集合与本地常量同形，取值不同）。所以「一条命令起全套并本地登录」缺的不是脚本，**是一个本地 auth 端点（或用 https 终结）**。该链路的细节见同目录 `auth-chain.md:167-205`，此处不重复。

---

## 2. 本地 Supabase/Docker 的确切启动方式与健康检查点

**仓库里有什么**

- 编排：`infra/docker-compose.yml`（唯一一个 compose 文件；无 `docker-compose.override.yml`、无 `supabase/` 目录）。
- 服务：`db`（`infra/docker-compose.yml:9`），镜像 `pgvector/pgvector:pg17`（`:10`），`container_name: orange-w1-db`（`:11`）。
- 认证：`POSTGRES_HOST_AUTH_METHOD: trust`（`:16`）+ 只绑回环 → **无口令**（`:3-5` 注释）。
- 端口：`127.0.0.1:55432 -> 5432`（`:19`）。**不是** Supabase 默认的 54322。
- 数据卷：命名 volume `orange-pgdata` → 实际名 `orange-w1-pgdata`（`:21`、`:32-33`；`down` 保留、`down -v` 清空）。
- 策略：`restart: unless-stopped`（`:28`）。

**健康检查（三层，都要）**

1. 容器级（compose 自带）：`pg_isready -U postgres -d orange`，`interval 3s / timeout 3s / retries 30 / start_period 5s`（`:22-27`）→ `docker compose ps` 的 `(healthy)`。
2. 会话级：`docker compose -f infra/docker-compose.yml exec -T db psql -U postgres -d orange -At -c 'select 1'` 回 `1`。这正是 `infra/verify.mjs:82-89` 的 `waitReady()`（60×1s）。
3. 应用级：`node infra/verify.mjs` 的 9 项断言（`:124-277`），全过才 `exit 0`；环境没起是 `exit 2` + 一行可执行提示（`:119-122`）。

**缺什么**：**没有任何脚本在做「起库 + 等健康 + 迁移 + 自查」**。`package.json:11-25` 里没有 `supabase`/`db`/`migrate`/`seed`/`up` 任何条目；`infra/migrate.mjs` 与 `infra/verify.mjs` 只被文档手动调用（`docs/sql/README.md:17-19,66-70,121`）。`pnpm dev`（`dev.mjs`）与 `pnpm dev:desktop`（`start.mjs`）都**不碰** docker。→ 编排完全缺。

---

## 3. 迁移与种子：`migrate.mjs` 的失败可读性、种子位置、是否自动应用

**`--target local` 的判定与执行路径**

- 参数：`--target` 缺省 `local`（`infra/migrate.mjs:59`），只允许 `local|cloud`，否则 `exit 2`（`:84-87`）。
- `local` 后端（`:168-196`）：所有 SQL 都走 `docker compose -f infra/docker-compose.yml exec -T db psql -U postgres -d orange -v ON_ERROR_STOP=1 -At`（`:171-176`）；容器 id 由 `docker compose ps -q db` 取（`:177-182`）；`prepare()` 先把 `docs/sql` 拷进容器（先 `rm -rf /sql` 再 `docker cp`，`:184-191`）。
- `cloud` 后端（`:145-166`）：`docker run --rm postgres:17 psql "$SUPABASE_DB_URL"`；URL 含 `6543`/`pooler` 直接 `exit 2`（`assertCloudUrl:92-102`）。

**账本 `ops.schema_migrations`**

- 建表在 `docs/sql/008_unify_surface.sql:33-43`（放在 `ops` 而不是 `public`，因为 `000_reset.sql` 的 `DROP SCHEMA public CASCADE` 会清掉自己：`008:7`、`migrate.mjs:15`）。
- 读：`readLedger`（`:203-214`）→ `select jsonb_object_agg(version, checksum) … where target='<t>'`；账本不存在时靠正则 `LEDGER_MISSING`（`:201`）返回 `null`（`:209`），其他 psql 失败**抛错**（`:210`）。
- 写：`writeLedger`（`:216-226`）→ `insert … on conflict (version,target) do update`。
- 失败语义：某个文件失败时，**已成功的那些仍然记账**（`:678-685`），并 `return 1`。
- 应用后守卫：扫 `pg_proc` 里是否还有 `vector(1024)` 残留，有则**不记账**并 `return 1`（`:697-708`）；守卫自己跑不动也算失败（`:698-702`）。
- 漂移：已应用文件被改动 → 计划里标 `drift`，**拒绝执行任何 apply**（`:650-654`）。

**`--check`（`:231-265`）**

- 只读：读账本 + 逐文件 sha256，输出 `OK/MISS/DRIFT/EXTRA`，`000_reset.sql` 永远 `SKIP`（`:242-245`），末尾 `--check 通过/失败`，`exit 0/1`。
- 账本不存在 → 一行提示「先跑 `--target …`」并 `return 1`（`:234-237`）。
- 本次实测：`--check` 通过，12 文件一致，exit 0。

**「服务未就绪时报什么」——这里是真缺陷**

- 顺序是：`runApply` → **先** `readLedger`（`:607-609`）→ 后端 `psql`（`:171-176`）→ 容器没起时 `docker compose exec` 非 0，stderr 形如 `service "db" is not running`；`LEDGER_MISSING` 不匹配 → `throw new Error('读取账本失败：…')`（`:210`）。
- `main()` 没有 try/catch（`:720-731`），顶层 `await` → **未捕获异常 + 栈回溯，exit 1**。
- 而那句最可读的提示（`本地 db 容器没起来：docker compose -f infra/docker-compose.yml up -d`，`:186`，返回 **2**）只有在 `prepare()` 阶段才可能打印（`:660-664`），即**晚于**账本读取，且仅 apply 模式、且非 `--dry-run`。
- 判定：**能读出「读取账本失败：…」但语义错**——不是「环境未就绪」，退出码是 1 不是 2，且混着栈。`--check`/`--contract` 同样走 `readLedger`，同样问题。
- 修法（供 Lead 排序）：把 `prepare()` 的探活提到 `readLedger` 之前，或在 `readLedger` 捕获「容器没起/连接被拒/starting up」映射成 `code:2`。

**种子**

- **没有 seed 脚本**：全仓无 `seed` 相关脚本（`package.json:11-25` 无条目；`scripts/` 9 个文件无一涉及）；`docs/sql/` 第 11 个文件是 `011_delivery_content_key.sql`（结构，不是数据）。
- 唯一「种子状」需求是 `ops.tenant_member`（`008:48-59`），实测 **0 行**；`docs/sql/*.sql` 里没有任何 `insert into ops.tenant_member`。
- 迁移**不会**自动应用种子；也没有任何地方创建 auth 用户（本地无 GoTrue，`auth.uid()` 只来自 JWT claim `sub`，`008:185-202`）。
- 现状：想让租户回落生效，只能手工 `psql` 插成员行；想登录，必须有第 5/6 步的环境与账号。

---

## 4. Studio 的动态端口：写在哪、桌面壳怎么拿到、有无单例

**端口怎么定**

- `pnpm dev`：`OPENFILM_STUDIO_PORT` 默认 `4848`（`packages/openfilm/scripts/dev.mjs:27`），并 `OPENFILM_STUDIO_WORKER=1`（`:30`）→ 跳过 supervisor（`studio/server/main.mjs:33`）。
- 桌面壳：`OPENFILM_STUDIO_PORT = IDENTITY.studioPort`（`apps/desktop/src/main.mjs:521`），dev flavour = **4757**（`apps/desktop/src/flavor.mjs:30-33`；release 4747 `:25`）。
- Studio 进程：`main.mjs:54-55` 缺省 4747；端口被占或 Windows 保留段（`EACCES`）→ `startStudio({port: 0})` 取任意空闲端口（`:65-78`）；重启态被抢则自己退出（`:72-75`）。film 端口 = 编辑端口 **+1**（`server.mjs:1446-1447`），editor 端口拿不到就整体失败。

**动态端口写到哪：文件，不是 env、不是内存**

- `<OPENFILM_HOME>/run.json`，内容 `{ pid, supervisor?, origin, filmOrigin, key }`，`mode 0o600`（`server.mjs:1450-1456`）；关闭时若 `pid` 匹配才删（`:1420`）。
- home 由谁定：`pnpm dev` → `.dev/home`（`dev.mjs:23`）→ 即 **`.dev/home/run.json`**；桌面壳 → `%USERPROFILE%\.openfilm-dev`（`flavor.mjs:32` + `main.mjs:648`）→ 即 `~/.openfilm-dev/run.json`。**两套 home、两套 run.json，互不可见。**

**桌面壳怎么拿到**

1. 先读自己的 `run.json` 并探活 `/api/health`（`apps/desktop/src/studio.mjs:31-38`，要求 `health.product === 'openfilm-studio'`）；命中就当「机器上已有的 Studio」，`POST /api/quit` 请它退（`:41-66`，`whenIdle`）。
2. 自己 fork 时靠 IPC：utility 子进程回 `{type:'ready', origin, filmOrigin, key}`（`studio.mjs:73-109`，`:85-89`），并把端口以 env 传下去（`:78`）。
3. 健康端点契约：`GET /api/health` → `{ product:'openfilm-studio', version, home:<sha256(home)>, filmOrigin, app? }`（`server.mjs:260`；home 指纹 `:1539-1542`）。
4. CLI 侧：先读 `run.json` + health（`packages/openfilm/studio/client.mjs:36-60`），env 端口**只作 fallback**（`:61-66`）。所以 `.dev/bin/openfilm.cmd` 里导出的 `OPENFILM_STUDIO_PORT=4848`（`dev.mjs:53,58`）在 Studio 换端口时会「过期但无害」。

**单例：一半有一半没有**

| 层 | 有无单例 | 机制 | 位置 |
| --- | --- | --- | --- |
| `pnpm dev` | **有，但非原子** | 读-判-写 `.dev/dev.pid` | `dev.mjs:37-47`（`:38` 读、`:39` `kill(pid,0)`、`:40-43` 拒绝并 exit 1、`:44` 写、`:45-47` 退出时删） |
| 桌面壳（Electron） | **有** | `app.requestSingleInstanceLock()` + 每 flavour 独立 `userData` | `apps/desktop/src/main.mjs:75-90`（`:83`）、`:77` |
| Studio 服务本身 | **无锁** | 只有端口 + `run.json` 覆盖 | `studio/server/main.mjs:65-78`、`server.mjs:1450-1456` |
| `dev-guard`（PID/环境比对/优雅停/僵死清理） | **不存在** | — | 全仓无对应脚本 |

**两个 `pnpm dev` 同时跑会发生什么**

- 先后启动：第二个在读锁时看到活着的 pid → 打印一行并以 **exit 1** 结束（`dev.mjs:40-43`）。这条路径是好的。
- 同时启动（真正的竞态）：两者都可能读到 `holder=null` → **都通过**（`:38-43` 是 check-then-write，`writeFileSync` 不是 `wx`，`dev.mjs:44`）→ 后写者覆盖 pid。随之发生：
  1. **端口**：两个 Studio 争 `4848`；先到者占住，后到者 `EADDRINUSE` → 取任意端口（`studio/server/main.mjs:65-78`），并**覆盖写** `run.json` 的 `pid/origin/key`（`server.mjs:1450-1456`）→ 先到者的页面、浏览器、CLI 指向的 origin/key 全失效。
  2. **构建**：两个 `vite build --watch` 同时写 `studio/ui/dist`（`dev.mjs:102`）→ 产物互相覆盖/半写。
  3. **共享状态**：同一个 `.dev/home`（`:23`）→ `prefs.json`、项目状态、`run.json` 互相踩。
  4. **清理**：`process.on('exit')` 只在「文件里的 pid === 自己」时删（`:45-47`）→ 后写者删，先写者进程死时不动 → 会留下**指向已死进程**的 `.dev/dev.pid`。
- 僵死/强杀（`Stop-Process -Force`、断电、IDE 杀进程组）：`.dev/dev.pid` 残留 + Studio/vite 子进程变孤儿仍占 `4848/4849`；下一次 `pnpm dev` 起来后 Studio 只能换端口，`run.json` 与 `.dev/bin/openfilm.cmd` 里的 4848 不一致（CLI 仍能工作，但读到 env 的人/脚本会被误导）。
- PID 复用：`alive()` 只做 `kill(pid, 0)`（`:39`），PID 被无关进程复用时 → **假阳性拒绝启动**，且提示的 `kill <pid>` 会杀错东西。
- `pnpm dev` 与 `pnpm dev:desktop` 同时跑：端口不冲突（4848 vs 4757），但**两套 home**（`.dev/home` vs `~/.openfilm-dev`）→ 登录后写入的 `orange-project-owners.json`、`.openfilm-control.json`、`.film/control.json` 只在其中一套 home 下成立（`desktop-auth.mjs:123,147-153`）；另一套打开同一项目会落到 `project-access-denied`。这是「一条命令起全套」必须先定的**一个 home 归属**问题，不是并发问题。

**竞争点清单（具体路径）**

1. `.dev/dev.pid`（非原子创建、无进程身份校验）
2. `.dev/home/run.json`（`pid/origin/filmOrigin/key`，后写者覆盖）
3. `127.0.0.1:4848` + `127.0.0.1:4849`（Studio 与 film 端口成对）
4. `studio/ui/dist`（两个 vite watch 双写）
5. `.dev/bin/openfilm` / `.dev/bin/openfilm.cmd`（每次启动重写，`dev.mjs:54-59`）
6. `.dev/sample`（`film.html`/`title.html`，`dev.mjs:63-90`）
7. `%USERPROFILE%\.openfilm-dev\run.json` 与 `~/.openfilm`（sharedHome：`flavor.mjs:32`、`desktop-auth.mjs:150-153` 写 marker）
8. `.dev/staging` 与 `.dev/zhishang/credentials.local.json`（素材服务，`main.mjs:121-129`）

---

## 5. `dev-guard` 应放在哪一层

**结论：新脚本外包，不改 `apps/desktop/scripts/start.mjs` 内部。**

理由（按证据）：

1. `start.mjs` 的职责边界很窄：解析 flavour、build shell、按平台准备运行时、spawn Electron、转发信号（`start.mjs:18-79`）。它**不**知道 Studio 端口（端口在 `main.mjs:521`）、不知道 docker、不知道迁移——把它变成「全套编排 + 锁」会让一个已有 2 组测试钉住的启动器承担无关职责（`apps/desktop/scripts/start.test.mjs:8,14`）。
2. 现有 `SIGINT` 语义是被测过的：12 秒后补 `SIGTERM`（`start.mjs:74-76`）——guard 若在它内部改信号处理，会动既有契约；在外层包一层则互不干扰。
3. 需要管的东西都是「外层」的：docker 生命周期、`migrate`/`verify`、`.dev/dev.pid` 的原子性、两套 home 的归属、僵尸子进程——这些恰好是 `dev.mjs`：37-47 已经做错一半的地方（`dev.mjs` 本身也可不动，由 guard 持锁、再把 `pnpm dev` 当子进程拉起）。
4. 形态建议：`scripts/dev-up.mjs`（新文件，root package.json 加一条 `dev:all`），持锁 → 环境指纹比对 → docker 就绪 → `migrate --check`（有漂移则拒绝）→ `verify` → 起 `pnpm dev` / `pnpm dev:desktop` → 收信号优雅停 → 清 `.dev/dev.pid` 与孤儿。锁文件走 `wx` 或目录锁，内容写 `{pid, 进程创建时间, gitRev, 端口, home, flavour}`。

**必须覆盖的失败场景（12 条）**

1. **无锁并发启动**：`O_EXCL`/`wx`/`mkdir` 原子创建，写失败即退出；不能沿用 `dev.mjs:38-44` 的 check-then-write。
2. **PID 复用假阳性**：锁里存进程创建时间 + 命令行哈希（Windows `Get-CimInstance Win32_Process`），而不是 `kill(pid,0)`（`dev.mjs:39`）。
3. **僵死清理**：锁主已死 → 扫「占着 4848/4849 且 `/api/health` 回 `openfilm-studio`」的进程，用 health 的 `home` 指纹（`server.mjs:260,1539`）判断是不是本 checkout 的 Studio，是则请它退（`POST /api/quit` + key，`studio.mjs:41-49`）或 `SIGTERM`。
4. **孤儿 vite/Studio**：父进程被强杀后子进程仍在写 `studio/ui/dist`、仍占端口 → 启动前必须按端口反查并处置，否则下轮必 EADDRINUSE。
5. **环境指纹不一致**：`git rev`、`OPENFILM_STUDIO_PORT`、`OPENFILM_HOME`、`ORANGE_AUTH_CONFIG_FILE`（及其 `environmentId`）、`OPENFILM_DESKTOP_FLAVOR` 任一与锁记录不同 → 明确报差异并要求显式 `--force`，不静默接管（否则 environmentId 一变，marker/owners 全失效：`desktop-auth.mjs:38,123`）。
6. **docker 未就绪**：`docker info` 失败 / 容器不存在 / `(healthy)` 超时（`component:22-27` 的 30×3s 上限）→ 一行提示 `up -d` 并退出，不进后续步骤。
7. **`migrate` 未跑或漂移**：先 `--check`（exit 1 即拒），再 apply；apply 失败（含 `vector(1024)` 守卫，`migrate.mjs:697-708`）不启应用。
8. **`verify` 未过**：9 项任一 FAIL 不启应用；`exit 2`（环境未就绪，`verify.mjs:25`）要能被区分成「docker 问题」。
9. **端口被无关进程占用**：连 `EACCES`（Windows 保留段，`studio/server/main.mjs:65-67`）一起报「谁占的」，别让 Studio 静默换端口后 run.json 漂移。
10. **桌面壳已单例在跑**：`requestSingleInstanceLock` 失败时 Electron 是 `app.quit()` + **退出码 0 且无消息**（`main.mjs:83-85`）→ guard 必须自己先探 `~/.openfilm-dev/run.json` + health，给出「已在跑」而不是绿灯假成功。
11. **两套 home 混淆**：guard 必须显式选定一个 `OPENFILM_HOME`（建议 dev 桌面壳的 `~/.openfilm-dev`，或让 `pnpm dev` 复用它），并拒绝「两套 home 同时活动」的组合；否则登录后项目归属判据分裂（`desktop-auth.mjs:147-153`）。
12. **优雅停的顺序**：先 `POST /api/quit`（`whenIdle`，`studio.mjs:41-49`）等它写 history 并删 `run.json`（`server.mjs:1420`）→ 超时 `SIGTERM` → 再超时 `SIGKILL`；最后删 `.dev/dev.pid` 与孤儿进程；任一阶段失败要留一行日志到 `.dev/` 而不是静默。

---

## 6. 缺口清单（按依赖序，供 Lead 出计划）

| # | 缺口 | 影响 | 证据 |
| --- | --- | --- | --- |
| G1 | **本地没有 auth 端点**（`54321` 无服务；`http` 又被 `auth-service` 拒） | 「本地一键登录」不成立，只能借托管 Supabase | `auth-environment.mjs:23-27`；`auth-service.mjs:105,111`；compose 只有 `db`（`infra/docker-compose.yml:9-11`） |
| G2 | `resolveEnvironment()` 未接线（`desktop-auth.mjs:23` 只认文件路径） | 三处环境来源无人比对，仍会「各信一套环境」 | `auth-environment.mjs:88-132`（grep 仅自身测试引用） |
| G3 | **无编排脚本**（起库/等健康/迁移/自查/起应用） | 5 步手工，且顺序易错 | `package.json:11-25`；`docs/sql/README.md:17-19,66-70` |
| G4 | **无 seed 脚本**（`ops.tenant_member` 0 行，无账号创建） | 登录后无租户上下文 → `42501` | `008:48-59`、实测 0 行 |
| G5 | `migrate.mjs` 环境未就绪时报 exit 1 + 栈（应为 2 + 一行） | 编排脚本难以区分「没起」与「真错」 | `migrate.mjs:609`→`:210`→`:720-731`；`:186` vs `:660-664` |
| G6 | **无 dev-guard**（原子锁/指纹比对/优雅停/僵死清理） | 并发两套 Studio、run.json 漂移、孤儿进程 | `dev.mjs:37-47`；`studio/server/main.mjs:65-78`；`main.mjs:83-85` |
| G7 | 两套 home（`.dev/home` vs `~/.openfilm-dev`）未定归属 | 登录后项目归属判据分裂 | `dev.mjs:23`；`flavor.mjs:32`；`main.mjs:648`；`desktop-auth.mjs:147-153` |
| G8 | `verify.mjs` 缺第 10 项：**auth 端点 + 种子**可达性 | 自查全绿但与「能登录」无关 | `verify.mjs:2`（「九项」）、`:34`（`TOTAL=9`）、`:259-277`（第 ⑨ 项）、`:279-281`（`results.length === TOTAL`） |

**第 10 项的插入位置（精确）**：`infra/verify.mjs:277` 之后、`:279`（`let failed = 0;`）之前插入 `record(...)` 块；同时把 `:34` 的 `TOTAL = 9` 改为 `10`、`:2` 的头注释「九项」改「十项」。建议断言形态：读 `ORANGE_AUTH_CONFIG_FILE`（或 `run.json` 的 Studio health）+ `GET <authOrigin>/auth/v1/health` 200 + `select count(*) from ops.tenant_member` > 0；环境未配置时**只 WARN 不 FAIL**（否则 CI 无账号必红），与既有「提示行不计入总数」的写法一致（`verify.mjs:15-18`）。

---

## 附：本次未做的动作（如实记录）

- 未运行 `node infra/verify.mjs`：它会 `insert into material` 再 `delete`（`verify.mjs:161-165,222-248`），属数据写入，未获授权。
- 未起/停任何容器、未 `docker compose up/down`、未跑 `migrate` 的 apply 模式（只跑了只读的 `--check`）。
- 未启动 `pnpm dev` / `pnpm dev:desktop`（本机已有一个 dev 桌面壳在跑，见运行时快照）。
- 未修改任何既有文件；本文件是唯一新增。
