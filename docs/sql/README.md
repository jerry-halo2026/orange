# 本地数据库（Postgres + pgvector）与表结构

本地开发用的 Postgres 17 + pgvector 0.8.7，跑在 Docker 里。这里只有**表结构与迁移**；
`apps/api` 仍然是零依赖模块、通过 HTTP 访问 Supabase，**不引入数据库驱动**（这些 SQL 由运维/迁移脚本执行，
或由 Supabase 侧执行，客户端不直连）。

- 编排文件：`infra/docker-compose.yml`
- 自查脚本：`infra/verify.mjs`
- 迁移执行器：`infra/migrate.mjs`（账本 / `--check` / `--contract`）
- JWT 签发：`infra/jwt.mjs`（HS256，本地验 authenticated / service_role / anon）
- 迁移目录：`docs/sql/`（本文件所在目录）
- 契约（只读，唯一形状来源）：`docs/sql/contract.json`、`docs/sql/embedding.json`

## 1 起库

```bash
docker compose -f infra/docker-compose.yml up -d
docker compose -f infra/docker-compose.yml ps        # 等到 STATUS 出现 (healthy)
```

- 端口：`127.0.0.1:55432 -> 5432`（**只绑回环**，同机其他用户/网卡不可达）
- 数据：命名 volume `orange-w1-pgdata`，`down` 不丢，`down -v` 才丢
- 认证：`POSTGRES_HOST_AUTH_METHOD=trust` + 回环绑定，**没有任何口令**
  （因此仓库里没有凭据；也因此**绝不能**把这个 compose 用于任何共享环境）

## 2 依次执行迁移（顺序不能换）

```bash
# 把 SQL 送进容器（用 -f 读文件，比管道喂 stdin 可靠，尤其带中文注释时）
docker cp docs/sql orange-w1-db:/sql

# 006 的函数体里写死了 search_path = public, pg_temp（历史文件，不改），而 008 把 vector
# 迁到了 extensions；重放时先关掉函数体校验（与 pg_dump 同款），否则第二轮会在 006 报
# `type "vector" does not exist`。migrate.mjs 自己就带这个设置。
# 009 之前先丢掉 orange_resolve_materials：010 把它的 OUT 列改成了 camelCase，而 PG 不允许
# CREATE OR REPLACE 改返回类型；009 会按历史形状重建、010 再改回 camelCase。全新库上是 no-op。
for f in 001_extensions.sql 002_schema.sql 003_indexes.sql 004_roles_and_rls.sql \
         005_sync_state.sql 006_rpc.sql 007_embedding_and_wiki.sql 008_unify_surface.sql \
         009_orange_claim.sql 010_tenant_strict.sql; do
  docker compose -f infra/docker-compose.yml exec -T db \
    psql -U postgres -d orange -v ON_ERROR_STOP=1 -At \
      -c "set check_function_bodies = off" \
      -c "drop function if exists public.orange_resolve_materials(text, text[])" \
      -f "/sql/$f" || break
done
```

Windows PowerShell 等价写法：

```powershell
docker cp docs/sql orange-w1-db:/sql
foreach ($f in '001_extensions.sql','002_schema.sql','003_indexes.sql','004_roles_and_rls.sql',
               '005_sync_state.sql','006_rpc.sql','007_embedding_and_wiki.sql',
               '008_unify_surface.sql','009_orange_claim.sql','010_tenant_strict.sql') {
  docker compose -f infra/docker-compose.yml exec -T db psql -U postgres -d orange `
    -v ON_ERROR_STOP=1 -At `
    -c "set check_function_bodies = off" `
    -c "drop function if exists public.orange_resolve_materials(text, text[])" `
    -f "/sql/$f"
}
```

或者一条命令全搞定（推荐，顺带写账本）：

```bash
node infra/migrate.mjs --target local     # 只跑“账本里没有 / 校验和不同”的文件
node infra/migrate.mjs --check            # 只比对账本与文件 sha256，不执行任何 DDL
node infra/migrate.mjs --contract          # 从 pg_proc/information_schema 导出并与 contract.json 双向比对
node infra/migrate.mjs --target local --allow-replay   # 账本丢了但库非空时，确认按 001→010 重铺（会清空向量）
```

> 若容器里已存在旧的 `/sql`，`docker cp docs/sql orange-w1-db:/sql` 会变成 `/sql/sql/`。
> 先 `docker exec orange-w1-db rm -rf /sql` 再拷，或拷 `docs/sql/.`。`migrate.mjs` 自己会先清再拷。

| 顺序 | 文件 | 做什么 |
| --- | --- | --- |
| 0 | `000_reset.sql` | **破坏性**：`DROP SCHEMA public CASCADE` 后重建。默认永不执行，必须显式 `--allow-destructive` |
| 1 | `001_extensions.sql` | `vector` + `pg_trgm`；并断言 pgvector >= 0.8.7（不满足直接报错） |
| 2 | `002_schema.sql` | 六张表 + 注释 + 约束（主键都含 `company_key`）；`wiki_summary.embedding` 初版 `vector(1024)` |
| 3 | `003_indexes.sql` | 列表/模糊/向量/图/事件索引；`(company_key,kind,slug)` 唯一 |
| 4 | `004_roles_and_rls.sql` | 应用角色 `orange_app`、六表 `ENABLE`+`FORCE` RLS、每表一条租户策略 |
| 5 | `005_sync_state.sql` | `sync_state`（同步水位，同样 on+force RLS）+ `material.deleted_at` 软删除 + 部分索引 |
| 6 | `006_rpc.sql` | 四个 RPC（`search_materials` / `upsert_wiki_summary` / `upsert_wiki_entity` / `record_wiki_event`）+ 三个短名别名；补 `analyzer_ver` 版本列 |
| 7 | `007_embedding_and_wiki.sql` | 按 `embedding.json` 把向量收敛到 `vector(768)`（先清空向量→拆 HNSW→改类型→重建 HNSW）+ `upsert_wiki_source` + `wiki_video` / `wiki_timeline` / `wiki_shot` 三表与三个读 RPC |
| 8 | `008_unify_surface.sql` | `ops` 账本与成员表、`extensions` schema 收口、租户三级回落、角色面（anon/authenticated/service_role）、函数权限收口、`statement_timeout`、`sync_state.account_key` 并入主键 |
| 9 | `009_orange_claim.sql` | `orange_material_version/grant/plan/claim/delivery` 五表 + 8 个 `orange_*` RPC（严格按 `contract.json`） |
| 10 | `010_tenant_strict.sql` | 租户判据严格化（策略 → `tenant_key_required()`，无租户读/写都 42501）；`app_tenant_key()` 顺序改为 JWT claim → GUC（仅受信身份）→ 成员表；`orange_resolve_materials` 返回列 camelCase；`orange_preflight` 单键/信封修正；`content_key` 64hex CHECK；anon 权限清零 |
| 11 | `011_delivery_content_key.sql` | `orange_delivery.content_key` 补 64 位小写 hex CHECK（009 只给了 plan/claim 两张表；列不在时整份文件 no-op） |
| 12 | `012_media_doc.sql` | 统一检索的派生索引层 `media_doc`（`gran=asset\|shot` 同表、`analyzer_ver` 进主键、两条**部分 HNSW** + 5 条过滤索引）+ `upsert_media_doc`（必填校验 22023、同 text+embedding_ver 幂等、同 gran 新版本取代旧版本并清空旧向量）+ `media_search`（向量/ILIKE/trigram 三路混合、每行带 `match_kind`、按 `media_key` 去重 shot 优先、**不返回本地可用性**） |
| 13 | `013_media_doc_shot_key.sql` | `media_doc` 的主键补 `shot_index`（三列 → 四列）：`shot_index` 收敛为 `integer not null default 0`（asset 行恒 0；原先用 NULL，而 NULL 在唯一索引里**互不相等**，主键会退化成非主键）、`media_doc_gran_shape` 改成 asset ⇒ 0 / shot ⇒ >= 0、`upsert_media_doc` 的 `ON CONFLICT` 目标换成四列（**同版本多镜头各占一行，写第二帧不再覆盖第一帧**）、幂等/embedding_ver/768/按 created_at 取代的语义逐条不变；`media_search` 不重建（`DISTINCT ON` 排序键已含 `shot_index` 做稳定 tiebreak，多镜头仍取最高分那帧）。可重入：整段 DDL 在一个 DO 块里（先 DROP PK → 改列 → ADD PK），第二轮重放 exit 0 |
| 14 | `014_media_doc_4096.sql` | `media_doc` 的**第二条向量列** `embedding_4096 vector(4096)`（qwen3-embedding-8b），与 768（nomic）**并存**、谁给了写谁、取代时两列一起清空；一条**部分 HNSW** 谓词 `embedding_4096 is not null and superseded_at is null`；新检索函数 `media_search_4096`（与 `media_search` 同语义：三路命中 / `match_kind` / 按 `media_key` 去重 shot 优先 / 同一份过滤键与返回列）。**引擎事实**：pgvector 0.8.7 对 HNSW 的维度上限是稠密 `vector` ≤ 2000、`halfvec` ≤ 4000，4096 维稠密索引在库里不存在（`ERROR: column cannot have more than 2000 dimensions for hnsw index`），所以索引建在 `(subvector(embedding_4096,1,4000))::halfvec(4000)` 上：候选由前 4000 维选、**分数按完整 4096 维重排**，top-k 分数与纯精确扫描一致 |
| 15 | `015_media_doc_tokens_emb_ver.sql` | ① **词法分支会切词**（修一个实测缺陷：`media_search('柠檬宝藏茶 外包装', p_embedding => null)` 改前 **0 条**、`('柠檬宝藏茶', …)` 20 条 —— 原因是整串 `ILIKE '%柠檬宝藏茶 外包装%'`）：`p_query` 按 `regexp_split_to_array(btrim(p_query), '\s+')` 切词、**每个 token 都要命中**（子串档 `text/name ILIKE` 或 `batch/product/gname = token`；trigram 档再加 `token <% text` 的 word-trigram），词法分数 = 命中 token 数 / 总数（全命中故恒 1.0），**单 token 时谓词与 `similarity` 分数逐字不变**，空/纯空白查询不加词法条件；`media_search` 与 `media_search_4096` 同一套。② **`embedding_ver_4096 text`**：4096 列自己的模型版本（`embedding_ver` 继续只描述 768 列 —— 共用一列会让 coexist 写把 768 的标签改写成 8B 的串），已有 5 000 行回填 `qwen3-embedding-8b`；`upsert_media_doc` 变成"给 `embedding_4096` 就必须给 `embedding_ver_4096`"（缺了 23514，与 768 那条同口径），幂等判据里的版本比较改成"调用方给了才比"（否则 coexist 写每轮都算一次写）。回执多一个 `versions` 键，其余形状不变 |

这些文件都是**幂等**的（`IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` / `DROP POLICY IF EXISTS` 后重建 /
`CREATE OR REPLACE FUNCTION` / 改列类型与改主键前先用系统目录探测），可以反复执行；
已验证「001→010 连续两轮全部 exit 0、零 ERROR」（含 010 之后重放 008 的收尾断言）。

### 2.1 账本与“只追加不改写”纪律

- 账本 `ops.schema_migrations(version, target, checksum, applied_at)`：一行 = 一个文件在一个 target
  （`local` / `cloud`）上的一次成功应用，`checksum` 是文件内容的 sha256。
- 账本放 `ops` 而不是 `public`：`000_reset.sql` 的 `DROP SCHEMA public CASCADE` 会把自己清掉。
- **只追加不改写**：文件一旦进入某个 target 的账本（本地或云），就不要再改它的内容。
  改表结构 = 出新的 `01x` 迁移，不改旧的。
  - 在文件上做哪怕一个字节的改动：`node infra/migrate.mjs --check` 会报 `DRIFT` 并 exit 1，
    `migrate.mjs` 执行模式会**拒绝**继续应用（避免“库里的列”和“文件里的列”各自漂移）。
  - 本轮把 `006` **原样还原**（字节与 `1a88128:docs/sql/006_rpc.sql` 一致）：之前那 7 处
    `SET search_path` 的就地修改撤回，等价改动以“迁移会话 `set check_function_bodies = off`”
    的形式放进执行器（`migrate.mjs` 对 local/cloud 都先发这条 SET）。原因：
    006 的函数体里写死 `search_path = public, pg_temp`，而 plpgsql 的 body 校验按**函数自己的**
    search_path 解析类型；008 把 vector 迁进 extensions 后，第二轮重放 006 会报
    `type "vector" does not exist`。改 008（给 006 的函数补 extensions）不成立——
    006 在 008 之前执行，何况 008 是已应用文件。关掉 body 校验后 006 照常创建，
    008 紧接着统一 `ALTER FUNCTION ... SET search_path = public, extensions, pg_temp`。
  - **账本缺失 ≠ 全新库**：账本不存在但库里已有 `public.material` 时，`migrate.mjs` **默认拒绝**
    并打印后果（007 会 `UPDATE wiki_summary SET embedding = NULL` 清空全部向量、`DROP INDEX`
    再重建 HNSW）；确认要重铺才加 `--allow-replay`。全新库（无 `public.material`）不受影响。
- `000_reset.sql` 不参与默认比对与执行；要重来请显式 `--allow-destructive`，或者整卷重建（见 §6）。
- 云上只能走**直连 5432**：URL 里出现 `6543` 或 `pooler` 时 `migrate.mjs` 直接 exit 2
  （事务池会把多语句迁移拆到不同后端连接上，等于把迁移切成一堆半截事务）。


## 3 自查

```bash
node infra/verify.mjs
```

八项，全过才打印「全部通过（8/8）」并 exit 0，否则 exit 1（环境没起 exit 2）：

| # | 断言 |
| --- | --- |
| ① | `vector` 扩展 `extversion >= 0.8.7` |
| ② | `SET hnsw.iterative_scan = strict_order` 成功且 `show` 回来是 `strict_order` |
| ③ | 六张表齐全 |
| ④ | 六张表都 `relrowsecurity`（本实现同时 `force`） |
| ⑤ | 两租户互不可见：`set role orange_app` + 切 `app.company_key` 后各只看到自己那条；跨租户 INSERT 被 RLS 拒绝；**无租户上下文读/写都是 `42501 tenant-context-required`**（010 起策略是严格判据，断言 `no-tenant-read-42501` / `no-tenant-write-42501`，输出里打印实际 SQLSTATE） |
| ⑥ | `sync_state` 存在（并打印其主键） |
| ⑦ | `material.deleted_at` 列存在（`timestamp with time zone`） |
| ⑧ | `search_materials` 可调用：自己租户只看得到有效行（软删除那条不出现）、**用别人的 `company_key` 参数查返回 0 行**；**不设租户直接调是 `42501 tenant-context-required`**（断言 `no-tenant-search-42501`），不再是 0 行 |

另有一行**不计入 8 项**的提示：RPC 内部的事务级 `set_config('hnsw.iterative_scan', ...)` 是否被接受
（`INFO` 或 `WARN`，见 §5）。托管 PG 版本低时它会变成 `WARN`，但**不会判失败**。
输出里同时明写「**向量分支未纳入门禁（已知缺口）**」：这条只证明能调用 + GUC 被接受，
不证明 recall / 索引命中，8 项门禁里没有向量语义。

脚本不引入任何 npm 依赖，通过 `docker compose exec -T db psql` 在容器里执行 SQL。
测试行以 `verify-` 前缀写入并在结束时删除，不残留。

另有一条**不计入 8 项**、但 008 之后必须为 0 的硬指标（所有 `public` 函数都钉住了 search_path）：

```bash
docker compose -f infra/docker-compose.yml exec -T db psql -U postgres -d orange -At -c \
  "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proconfig is null"
# -> 0
```

手工验同样的事：

```bash
docker compose -f infra/docker-compose.yml exec -T db psql -U postgres -d orange -c \
  "select extversion from pg_extension where extname='vector'"

docker compose -f infra/docker-compose.yml exec -T db psql -U postgres -d orange -c \
  "set hnsw.iterative_scan = strict_order" -c "show hnsw.iterative_scan"

# 租户隔离（同一个会话里 SET ROLE 才有效）
docker compose -f infra/docker-compose.yml exec -T db psql -U postgres -d orange -c \
  "set role orange_app" -c "set app.company_key='tenant-a'" -c "select count(*) from material"
```

## 4 如何验证 RPC

四个函数（外加三个短名别名）都在 `006_rpc.sql`，`007` 给了 `upsert_wiki_source` + `wiki_video` /
`wiki_timeline` / `wiki_shot`，`009` 给了 8 个 `orange_*`。全部 `security invoker`：
以**调用者**身份执行，所以 RLS 照常生效；再用显式的 `m.company_key = p_company_key` 二次兜底。

租户不可被参数覆盖，规则是：

- 会话租户（`app_tenant_key()`：claim → GUC（受信身份）→ 成员表）已解析且与 `p_company_key` **不一致** → 读返回**空集**（不报错，避免探测），写抛 `42501`；`orange_*` 则抛 `orange:tenant-mismatch`。
- 会话租户解析不到 → RLS 策略的严格判据在**读和写**上都抛 `42501 tenant-context-required`（010 起 fail closed）。
  例外是 `BYPASSRLS` 的 `service_role` 运维路径：它显式带 `p_company_key`，不受策略约束（语句里仍要自己过滤）。


手工验一遍（同一个 psql 会话里 `SET ROLE` + `SET app.company_key` 才有效）：

```bash
# 1) 造两行（postgres 是超级用户，绕过 RLS）
docker compose -f infra/docker-compose.yml exec -T db psql -U postgres -d orange -c "
  insert into material (company_key, env_id, video_id, name) values
    ('t-a','local','va','A 的素材'), ('t-b','local','vb','B 的素材')
  on conflict do nothing"

# 2) 以应用角色、租户 t-a 检索：只应看到 va
docker compose -f infra/docker-compose.yml exec -T db psql -U postgres -d orange \
  -c "set role orange_app" -c "set app.company_key='t-a'" \
  -c "select video_id, score from search_materials('t-a', null, '{}'::jsonb, 10)"

# 3) 同一会话里用别人的租户参数查：必须 0 行
docker compose -f infra/docker-compose.yml exec -T db psql -U postgres -d orange \
  -c "set role orange_app" -c "set app.company_key='t-a'" \
  -c "select count(*) from search_materials('t-b', null, '{}'::jsonb, 10)"

# 4) 软删除行不出现
docker compose -f infra/docker-compose.yml exec -T db psql -U postgres -d orange -c "
  update material set deleted_at = now() where company_key='t-a' and video_id='va'"
#   再跑第 2 步 → 0 行；恢复：update material set deleted_at = null where video_id='va'

# 5) 写入 RPC（幂等 + 版本护栏）
docker compose -f infra/docker-compose.yml exec -T db psql -U postgres -d orange \
  -c "set role orange_app" -c "set app.company_key='t-a'" -c "
  select upsert_wiki_summary('t-a', jsonb_build_object(
    'video_id','va','one_line','一句话','analyzer_ver','a1.0'))"
```

`infra/verify.mjs` 的第 ⑧ 项就是第 2/3 步的自动化版本（含软删除那条）。

**版本护栏**：`upsert_wiki_summary` / `upsert_wiki_entity` 里带
`WHERE excluded.analyzer_ver >= <表>.analyzer_ver`，旧版本写不进去（不会覆盖新结果）。
因此 `analyzer_ver` 必须是**字典序可比**的字符串（`a1.0 < a1.10 < a2.0`，位数补零对齐），
不要用 `v10` 与 `v9` 这种。

## 4.1 租户从哪来（010 起：claim 优先，GUC 只对受信身份生效）

004 原先只认连接级 GUC `app.company_key`。008 加了三级回落但**GUC 最先**，
于是任何能执行 `set local app.company_key = 't-victim'` 的会话都能换租户（token 反而被顶掉）。
010 起顺序是：

| 级别 | 来源 | 谁设置 | 用在哪 |
| --- | --- | --- | --- |
| ① | `request.jwt.claims -> app_metadata ->> 'company_key'` | PostgREST / Supabase 从 JWT 解出 | `authenticated` 客户端（token 服务端签，**任何 GUC 都顶不掉**） |
| ② | `app.company_key`（GUC） | 受信任服务端，事务级 `set_config(..., true)` | 自建服务端 / 同步任务 / psql 排障 |
| ③ | `ops.tenant_member`（按 `auth.uid()` 或 `request.jwt.claim.sub`） | 运维写入 | 客户端 JWT 里没带公司时兜底 |

② 只在**调用身份**受信时才采信。身份 = `current_setting('role')`（`SET ROLE` / PostgREST 的
`SET LOCAL ROLE` 的值），没设过角色时回落 `session_user`；受信集合是
`{postgres, orange_app, service_role, supabase_admin}`。所以
`set role authenticated; set local app.company_key = 't-victim'` 里即使 `session_user` 是 postgres，
身份仍是 `authenticated` → GUC 被忽略，token 说了算；漏 token 时直接 42501。

三个函数，**别混用**：

- `public.app_tenant_key()` —— **宽松版**，解析不到返回 `NULL`。006/007 的 RPC 用它判断“有没有会话租户”。
- `public.tenant_key_required()` —— **严格版、策略面向**，三路都没有 → `42501` / `tenant-context-required`。
  **所有 RLS 策略用它**：010 起读也会 fail closed（`USING` 与 `WITH CHECK` 同一判据）。
- `public.app_company_key()` —— 严格版的老名字（008 的自检与契约 `tenant.missing` 仍指它），
  010 起实现就是 `RETURN public.tenant_key_required()`，两者行为永远一致。

为什么策略不直接写 `app_company_key()`：008 的收尾断言 8.4 会拦“任何策略表达式里出现
`app_company_key` 字样”，而 008 是已应用文件、每轮重放都会再跑一遍；策略写成它，
第二轮 008 直接 RAISE，001→010 的两轮幂等就破了。策略只能用 010 的新名字。

三者都是 `SECURITY DEFINER` + 固定 `search_path = public, extensions, pg_temp`，
调用者不需要 `ops` 权限就能解析租户。

平台/角色面（008）：

| 角色 | 权限 | 用途 |
| --- | --- | --- |
| `anon` | 零表权限、零函数执行权 | 漏 token 时必须 `42501`，不许静默 0 行 |
| `authenticated` | 表 SELECT/INSERT/UPDATE/DELETE + RPC EXECUTE，**RLS 生效** | PostgREST 客户端 |
| `service_role` | `BYPASSRLS` + 表全权 | 同步/分析写回；语句里仍要显式过滤 `company_key` |
| `orange_app` | 与 `authenticated` 同形（004/005/006/007 原样保留） | 本地 `SET ROLE` 验隔离 |

另外两条硬收口：

```sql
revoke all on all functions in schema public from public;
alter default privileges in schema public revoke execute on functions from public;
```

（PG 默认把 `EXECUTE` 授给 `PUBLIC`，等于把所有 RPC 挂到匿名角色上。）
外加 `alter role orange_app|authenticated|service_role set statement_timeout = '30s'`
与每个 public 函数的函数级 `statement_timeout`。

本地签发 JWT 验身份（**不会打印 secret**）：

```bash
node infra/jwt.mjs --init-secret                                   # 生成 .dev/rest.jwt（只写盘）
node infra/jwt.mjs --role authenticated --company-key t-a           # 打印 token
node infra/jwt.mjs --claims --role authenticated --company-key t-a  # 打印 payload，便于粘进 set_config
node infra/jwt.mjs --verify <token>                                 # 校验签名与 exp
```

secret 来源：`$PGRST_JWT_SECRET` 优先，其次 `.dev/rest.jwt` 首行（< 32 字节直接拒绝，和 Supabase 一致）。

## 4.2 orange_* 与客户端（`apps/api/src/supabase.ts`）的对齐口径

SQL 与客户端是**同一份契约的两端**，010 把三处不自洽拉平（`--contract` 会逐项复核）：

| RPC | 客户端校验（`supabase.ts`） | SQL 侧口径（010 起） |
| --- | --- | --- |
| `orange_resolve_materials` | `m.versionId` uuid / `m.contentSha256` 64hex / `m.kind ∈ video,still,sound` / `m.durationSec` 有限且 ≥0 / `m.probeRevision` 整数（:66） | `RETURNS TABLE ("versionId", "contentSha256", "kind", "durationSec", "probeRevision")` —— 带引号的 camelCase 别名；`contract.rpc.columns` 也登记了这五列，`--contract` 用 `pg_get_function_result` 比对 |
| `orange_preflight`：`prepare-required` / `duplicate` | `Object.keys(value).length === 1`（:70-71） | 各返回**恰好 1 个键**：`{"status":"prepare-required"}` / `{"status":"duplicate"}` |
| `orange_preflight`：`claim` | 不是单键时按**完整 claimEnvelope** 校验，`status` 必须 ∈ 五态（:72），不认识 `'claim'` 这个值 | 直接返回 `claim_envelope(...)`（status = claim 的真实五态）；不再拼一个会被信封覆盖的 `'status':'claim'` |
| 其余 6 个 `orange_*` | 七键信封：`claimId/planId/status/contentKey/historyCount/executionReady:false/frozenPlan.version:1` | `claim_envelope()` 是唯一构造点（009），010 不动 |

`orange_plan.content_key` / `orange_claim.content_key` 另有 `CHECK (content_key ~ '^[0-9a-f]{64}$')`
（010 先 `NOT VALID` 再加、清掉不合格式的历史测试数据后 `VALIDATE`）：
内容键就是 `contentSha256` 的 64 位小写 hex，格式不对的键会让幂等判断失效。

## 5 向量检索与旧版本回退

`search_materials` 在 `p_filters ? 'embedding'` 时改走向量排序：

```sql
join wiki_summary s on s.company_key = m.company_key and s.video_id = m.video_id
order by s.embedding <=> $vec        -- 余弦距离，走 003 的 HNSW 索引
```

同时在**事务内**执行 `set_config('hnsw.iterative_scan', 'strict_order', true)`
（`006_rpc.sql` 的 `PERFORM set_config(...)`）。它的作用：HNSW 默认只取 `ef_search` 个候选，
一旦同时带 `WHERE` 过滤，可能凑不够 `limit` 条；`iterative_scan` 让索引继续扫到够为止。

**托管 PG 若 pgvector < 0.8.0：这个设置会被忽略，而且不会报错。**
原因是 `hnsw.iterative_scan` 在旧版本里不存在，Postgres 会把它当成一个普通的
"自定义 GUC 占位符"接受下来——`show` 甚至能读回 `strict_order`，但执行计划里毫无作用。
（这就是为什么 `infra/verify.mjs` 只把它作**提示行**、绝不判失败：本地 0.8.7 是 `INFO`，
低版本环境是 `WARN`。）

真遇到低版本时的**两段式回退**（先过滤、再向量），语义等价、代价是两趟：

```sql
-- 第一段：把候选收窄到有向量的行 + 过滤条件（走 B-tree / GIN）
with candidates as (
  select m.video_id, m.name, m.category2_id, m.labels, m.create_time, m.account_key, s.embedding
    from material m
    join wiki_summary s on s.company_key = m.company_key and s.video_id = m.video_id
   where m.company_key = $1
     and m.deleted_at is null
     and s.embedding is not null
     -- … 其它过滤条件同上 …
)
select video_id, name, (1 - (embedding <=> $2))::real as score, category2_id, labels, create_time, account_key
  from candidates
 order by embedding <=> $2
 limit $3;
```

两段式在候选集不大时更快；候选集很大时要自己调 `hnsw.ef_search`（`set local hnsw.ef_search = 200`），
否则仍可能截断。**判断依据只有一条：先 `show server_version` 与 `select extversion from pg_extension where extname='vector'`，
再决定用哪条路径**——不要假定云上和本地一样。

## 6 重置

```bash
# 只清数据、保留镜像与 volume 定义（快，schema 全没）
docker compose -f infra/docker-compose.yml exec -T db psql -U postgres -d orange -v ON_ERROR_STOP=1 -f /sql/000_reset.sql
docker cp docs/sql orange-w1-db:/sql    # 若 000 之前没 cp 过

# 连数据卷一起重建（最干净：新库、新 initdb）
docker compose -f infra/docker-compose.yml down -v
docker compose -f infra/docker-compose.yml up -d
```

`000_reset.sql` 是**破坏性**的：`DROP SCHEMA public CASCADE`，只对本地库用。

## 7 表与字段（要点）

- **`material`**：供应商素材的本地投影，PK `(company_key, env_id, video_id)`。
  `sha256` 是字节哈希、`content_hash` 是归一化内容哈希（两者都强校验 64 位小写 hex）；
  `provider_state` 存供应商原样返回的 `videoState` 对象（jsonb）；
  `deleted_at`（005 加）是软删除时间，**NULL 才算有效**，检索默认只看有效行。
- **`sync_state`**（005/008）：同步水位，PK `(company_key, env_id, mode, account_key)`（008 起含账号维度）；
  `mode ∈ {day, watermark, full}`、`status ∈ {ok, failed}`；`cursor`/`drift` 是 jsonb，**不存任何凭据**。
  `apps/api/src/sync/store.ts` 里那份 `SYNC_SCHEMA_DDL` 副本已删除（只留注释指向 005/008）。
- **`wiki_source`**：一轮分析（`analyzer_ver` + `content_hash`）的产物，PK `(company_key, video_id, analyzer_ver)`，
  换模型版本不会覆盖旧结果。写入走 `upsert_wiki_source`：`content_hash` 由调用方给，必须是 64 位小写 hex，
  同一 (video_id, analyzer_ver) 内容哈希没变时整行不动。
- **`wiki_summary`**：结论 + 向量，PK `(company_key, video_id)`；`embedding` 自 007 起为 `vector(768)`
  （维度唯一来源是 `docs/sql/embedding.json`；列必须带 typmod，否则 HNSW 拒绝建索引），
  且 `embedding/embedding_model/embedding_ver` 三件套**要么都有要么都没有**；
  `analyzer_ver`（006 加）用于 upsert 的版本护栏。
- **`wiki_video` / `wiki_timeline` / `wiki_shot`**（007）：卡片（card only）/ 时间线（`CHECK seq 0..19`
  = 每视频最多 20 行）/ 单镜头（caption 140 + ocr 60 字符 = ≤200 tokens 口径），
  分别由 `wiki_video()` / `wiki_timeline()` / `wiki_shot()` 读出；跨租户一律返回 `NULL` / `[]`。
- **`orange_*` 五张表**（009）：`orange_material_version`（版本，`duration_sec` 用 numeric 天然有限非负）、
  `orange_material_grant`（主体→账号授权）、`orange_plan`（冻结计划，`version` 与 `frozen_plan.version` 都锁 1）、
  `orange_claim`（`status` 五态、`history_count ∈ {0,1}`、`execution_ready` 恒 `false`）、
  `orange_delivery`（交付，`delivery_id` 幂等）。8 个 `orange_*` RPC 只吐 `orange:<code>` 形式的错误消息。

- **`wiki_entity`**：八类实体（`product/person/scene/style/brand/collection/hook/selling_point`），
  `(company_key, kind, slug)` 唯一，`slug` 限小写连字符；`analyzer_ver` 同上。
- **`media_doc`**（012 建表 / 013 收主键）：统一检索的派生索引层，一行 = 一个可检索文档
  = `(素材|镜头) × analyzer_ver × 镜头号`。
  PK `(company_key, media_key, analyzer_ver, shot_index)` —— **版本与镜头号都进主键**：换版本不覆盖旧答案，
  同一素材同一版本的每个镜头各占一行（012 只有三列，写第二帧就会命中 `ON CONFLICT` 把第一帧改掉；
  013 修的就是这条，P4 逐镜头分析的前置）。
  `media_key` 是稳定身份（云素材=`video_id`；工程视频=`sha256:<hex>`），`gran ∈ {asset, shot}` 是**行属性**，
  `shot_index` 是 `integer not null default 0`（asset 行恒 0、shot 行 0..N），由 `media_doc_gran_shape`
  约束成"asset ⇒ 0 / shot ⇒ >= 0"。**不用 NULL 表示"asset 没有镜头号"**：NULL 在唯一索引里互不相等，
  asset 行可以无限重复写入，主键就不再是主键。
  **由此得到一条主键层面的不变量**：asset 文档与第 0 帧 shot 文档必须用不同的 `analyzer_ver`
  （现实里两条管线本来就不同：`card-meta-1` / `analyze-runner-N` vs `qwen-vl-shots-1`）；
  万一同 `(media_key, analyzer_ver, shot_index)` 撞上，`upsert_media_doc` 用 23505 明确拒绝，
  **不做**"把卡片行就地改写成镜头行"的静默合并。
  向量列 `embedding vector(768)` 走两条**部分 HNSW**（`where gran=… and superseded_at is null`，
  不是 ivfflat：写入是涓流、查询永远带过滤）；`text` 是向量化的原文（可重算的唯一依据），
  `superseded_at` 非空 = 同 gran 有更新版本落地、该行向量已置空（同一 media_key 的整批镜头一起退出检索，
  不会只退掉某一帧留下半新半旧）。`media_search` 按 `media_key` 去重（shot 优先、同 gran 取最高分、
  同分时 `vector` > `ilike` > `trigram`（015：确定性子串命中排在相似度估计前面，
  多 token 时两路词法都是 1.0，不加这条就会把子串命中标成 `trigram`）、
  末位键 `shot_index` 做稳定 tiebreak），所以一条素材有 N 个镜头行时仍只回一行。
  **本地可用性不在库里**（内容库有 LRU 淘汰，`is_local` 会变成谎言），由客户端在返回前补。
- **`media_doc` 的第二条向量列**（014 / 015 给它配版本列）：`embedding_4096 vector(4096)`（qwen3-embedding-8b）与
  `embedding` **并存**，不是替换 —— 现有 78 874 行 live 是 768 维 nomic，改列类型等于把对照组删掉。
  `upsert_media_doc` 的规则是**谁给了写谁**：只给 `embedding` 就只落 768，只给 `embedding_4096` 就只落 4096，
  两个都给就两列都写；**每条向量带自己的模型版本**（015）：768 要 `embedding_ver`、4096 要
  `embedding_ver_4096`，缺了对应那个都是 23514（一个标签说不清两个模型的向量；共用一列会让 coexist 写
  把 768 的标签改写成 8B 的串）。维度分别断言 768 / 4096（22023）；
  正文变了就把"这次没给"的那一列一起清空，取代旧版本时两列一起清空（版本列不清：它记的是"这行曾经是哪条模型的答案"）。
  **4096 维稠密向量上建不出 HNSW**：pgvector 0.8.7 的上限是稠密 `vector` ≤ 2000 维、`halfvec` ≤ 4000 维
  （`ERROR: column cannot have more than 2000 dimensions for hnsw index` / `… more than 4000 …`），
  所以索引建在 `(subvector(embedding_4096, 1, 4000))::halfvec(4000)` 上、谓词仍是
  `embedding_4096 is not null and superseded_at is null`；`media_search_4096` 的候选由这段前缀选
  （表达式与索引定义逐字一致，规划器才认），**分数按完整 4096 维重排** —— 于是 top-k 的分数与纯精确扫描
  逐位相同，近似只发生在"谁进候选"，且被限在末尾 96 维（2.3%）。`sparsevec(4096)` 上能建 HNSW（维度全留），
  但稠密向量每条 4096×8 B、66k 行 ≈ 2 GB 索引，超出本地预算，所以没选它。
  **写入模式**（`scripts/material-doc-index.mjs`）：`--dims 4096` 默认 **coexist** —— 沿用 768 行的
  `analyzer_ver`，`ON CONFLICT` 命中同一行、只把第二列写上，768 向量与它的 live 状态都不动（打印 `mode=coexist`）；
  要回到 014 那一批的行为（新 `analyzer_ver` = 新行 → 同一 media_key 的 768 行被取代）必须显式 `--supersede`
  （`mode=supersede`）。coexist 写只带 `embedding_ver_4096`，所以"补 4096 列"要走 `--all`：
  changed-only 只比对 text，看不见"这一列还是空的"。
- **词法分支怎么匹配多词查询**（015）：`p_query` 先按空白切词，**每个 token 都要命中** ——
  ilike 那一路要求每个 token 都子串命中（`text`/`name` ILIKE，或 `batch`/`product`/`gname` 等于该 token），
  trigram 那一路要求每个 token 至少命中一档（子串，或 `token <% text` 的 word-trigram）；
  词法分数 = 命中 token 数 / 总数（因为要求全命中，所以恒 1.0；排序靠向量路与 `match_kind` 的优先级）。
  单 token 时谓词与分数**逐字等于 012 的写法**（`%` 与 `<%` 在单 token 上不等价，换掉会悄悄改掉 trigram 路的
  候选集），空/纯空白查询不加词法条件。实测：`('柠檬宝藏茶 外包装', null)` 改前 0 条 → 改后 21 条；
  `('茶汤特写', null)` 仍是 0 条，因为它是**一个** token（CJK 不空格），而库里没有任何一行含这个连续串
  （`text ilike '%茶汤%'` 5 325 行、`'%特写%'` 7 922 行，含两者但不相邻 1 172 行）—— 换成带空格的
  `('茶汤 特写', null)` 就回 100 条，词法机制本身是对的。
- **`wiki_edge`**：两端外键都带 `company_key`，跨租户引用在物理上不可能；禁自环。
- **`wiki_event`**：追加型事件流，`event_id` 是幂等键（重复投递 `on conflict do nothing`）。

## 8 RLS 怎么生效（写代码的人必须知道）

策略判据统一是（010 起指向**严格版** `tenant_key_required()`，它内部是
claim → GUC（受信身份）→ 成员表，见 §4.1）：

```sql
company_key = public.tenant_key_required()
```

- 三路都解析不到（claim / GUC / 成员表）→ `42501 tenant-context-required`：
  **读和写都 fail closed**（010 起不再是静默 0 行；契约 `tenant.missing.reads`）。
- 设了 → 只能读到、也只能写入自己 `company_key` 的行（`USING` + `WITH CHECK` 都用同一判据）。
- 会话租户已解析、但 RPC 参数 `p_company_key` **不一致** → 读返回**空集**（不报错，防探测，保持 006 原意）。
- **谁设置这个 GUC 就是安全边界**：010 起 GUC 只在受信调用身份下被采信，
  token 里的 claim 永远优先；仍然不要把请求参数直接 `set` 进去。
- 连接池复用连接时 GUC 会残留：用事务级 `set_config('app.company_key', $1, true)`，
  或每次取连接后先重设。
- 超级用户与 `BYPASSRLS` 角色**绕过** RLS；本地用 `postgres` 建表/灌数据没问题，
  但应用必须用普通角色（本地 `orange_app` / 云上 `authenticated`，`NOLOGIN`，靠 `SET ROLE` 验证）。
- 所有租户表都设了 `FORCE ROW LEVEL SECURITY`：表所有者（非超级用户）同样受约束；
  这也意味着**没有租户上下文的维护脚本 / `pg_dump` 会拿到 42501**，请用超级用户
  （或 `SET row_security = off`，或先以受信身份 `set app.company_key`）。
- 008 的断言 8.4 拦的是“策略表达式里出现 `app_company_key` 字样”，010 的策略因此用
  `tenant_key_required()`（同一实现）；`app_company_key()` 仍存在，只给自检与入口用。

## 9 上云时必须复验的四件事

本地这套是**形状验证**，不是生产配置。搬到 Supabase / 自建云 PG 时，下面四件必须重新证明，缺一不可：

1. **身份与凭据边界**：应用不是超级用户、不带 `BYPASSRLS`，连接走 TLS，凭据只来自受管密钥（不是仓库、不是命令行参数）；`pg_hba`/网络策略不允许公网直连数据库端口。云上 `anon/authenticated/service_role` 由平台预建，008 只在缺失时创建并尝试 `ALTER ROLE service_role BYPASSRLS`（无权限时降级为 NOTICE，需人工核对）。
2. **租户来源受信**：GUC 由服务端按已认证会话推导并事务级设置（`set_config(..., true)`）；JWT 的 `app_metadata.company_key` 只能来自服务端签发的 token；`ops.tenant_member` 的写入权不在应用角色手里。可被并发/连接池复用测试证明不会串租户。
3. **扩展与索引能力一致**：云上 `vector` 版本仍 `>= 0.8.7` 且 `hnsw.iterative_scan` 可用（托管 PG 的扩展版本可能落后）；`hnsw` 索引真实建立、`(company_key, kind, slug)` 唯一约束与 `pg_trgm` GIN 都存在，并且在**带租户过滤**的向量查询上实测 recall/延迟（`iterative_scan` 就是为过滤后仍然凑够 k 条准备的）。扩展必须在 `extensions` schema（008 会迁），且会话 `search_path` 含它（008 会尝试 `ALTER DATABASE ... SET search_path`；云上无权限时降级为 NOTICE，此时迁移会话需显式 `SET search_path`）。
4. **迁移走直连**：`node infra/migrate.mjs --target cloud` 用 `docker run --rm postgres:17 psql "$SUPABASE_DB_URL"`，URL 含 `6543`/`pooler` 直接 exit 2；应用完立刻 `--check`（账本 `target='cloud'` 与本地互不干扰）。


另外两条经验（不是"必须"，但上云前值得各跑一次）：数据卷/备份与恢复演练；`material` 大表上的
`(company_key, create_time DESC)` 翻页在真实行数下的执行计划。
