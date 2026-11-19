-- 008 统一表面：ops 账本 / 扩展收口 / 租户三级回落 / 角色与权限收口 / 语句超时。
--
-- 本文件是“形状收敛”的最后一层：003 的 HNSW、004/005 的 RLS、006/007 的 RPC 都保持不动，
-- 这里只做**跨切面**的事，并且全部用 DO 循环 + 系统目录断言，不靠人工数对象个数。
--
-- 五个交付块：
--   1. ops schema：迁移账本 ops.schema_migrations + 成员表 ops.tenant_member。
--      （000_reset.sql 会 DROP SCHEMA public CASCADE，账本若放 public 会被自己清掉。）
--   2. extensions schema：vector / pg_trgm 迁进去；数据库级 search_path 兜住
--      “未加引号、未带 schema 的类型名”（002/003 就是在裸名字上写 vector(1024) 的）。
--   3. 租户解析三级回落：app_company_key()（严格，缺上下文抛 42501
--      tenant-context-required）/ app_tenant_key()（宽松，解析不到返回 NULL，
--      供 RLS 策略用——策略里抛错会让**所有**查询失败，包括维护与 pg_dump）。
--   4. 角色对齐云上形状：anon（零权限）/ authenticated / service_role（BYPASSRLS），
--      权限从 orange_app 同步；public 下**所有函数**收回 PUBLIC 的 EXECUTE。
--   5. statement_timeout 30s（角色级 + 函数级），sync_state 加 account_key 并入主键。
--
-- 幂等：IF NOT EXISTS / CREATE OR REPLACE / 目录探测后再改；第二轮全部 no-op。

-- ---------------------------------------------------------------------------
-- 1. schema：ops（账本与成员）与 extensions（扩展收口）。
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS ops;
CREATE SCHEMA IF NOT EXISTS extensions;

COMMENT ON SCHEMA ops IS '运维面：迁移账本与租户成员表。不放业务数据，000 重置也不会清掉。';
COMMENT ON SCHEMA extensions IS '扩展收口：vector / pg_trgm 等第三方对象统一放这里，public 只留自己的对象。';

-- 迁移账本：一行 = 一个文件在一个 target 上的一次成功应用。
--   version  ：文件名（001_extensions.sql …），保持字典序即执行序
--   target   ：local / cloud —— 本地与云的账本互不干扰，可以各自重放
--   checksum ：文件 sha256（64 位小写 hex），用来抓“应用过的文件被改写”
CREATE TABLE IF NOT EXISTS ops.schema_migrations (
  version    text        NOT NULL,
  target     text        NOT NULL CHECK (target IN ('local', 'cloud')),
  checksum   text        NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT schema_migrations_pk PRIMARY KEY (version, target),
  CONSTRAINT schema_migrations_version_nonempty CHECK (length(version) > 0)
);

COMMENT ON TABLE ops.schema_migrations IS
  '迁移账本（contract.tables.ops.schema_migrations）。infra/migrate.mjs 写入，--check 与文件 sha256 比对。';
COMMENT ON COLUMN ops.schema_migrations.checksum IS
  '文件内容的 sha256；与本文件当前哈希不一致 = 已应用的历史被改写（只追加不改写纪律）。';

-- 成员表：user_id（Supabase auth.users.id）→ company_key。租户解析的第三级回落。
CREATE TABLE IF NOT EXISTS ops.tenant_member (
  user_id     uuid        PRIMARY KEY,
  company_key text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_member_company_key_nonempty CHECK (length(btrim(company_key)) > 0)
);

COMMENT ON TABLE ops.tenant_member IS
  '成员→租户映射（contract.tables.ops.tenant_member）。仅在 app.company_key 与 JWT claim 都缺失时被查。';

CREATE INDEX IF NOT EXISTS tenant_member_company_idx
  ON ops.tenant_member (company_key);

-- 账本与成员表不放业务数据，也不需要给应用写权限：只有 service_role 能读账本（排障用）。
-- 授权放在第 4 节之后（service_role 在那里创建，云上可能已存在）。

-- ---------------------------------------------------------------------------
-- 2. 扩展收口到 extensions schema。
--    已是别的 schema（public）→ alter extension ... set schema；
--    还没装 → 直接 with schema extensions 装上。
--    对象按 OID 引用，迁 schema 不会重建列/索引，表数据不动。
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_ext   text;
  v_schema text;
BEGIN
  FOREACH v_ext IN ARRAY ARRAY['vector', 'pg_trgm'] LOOP
    SELECT n.nspname INTO v_schema
      FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
     WHERE e.extname = v_ext;

    IF v_schema IS NULL THEN
      EXECUTE format('CREATE EXTENSION IF NOT EXISTS %I WITH SCHEMA extensions', v_ext);
      RAISE NOTICE '008: 扩展 % 原本未安装，已装进 extensions', v_ext;
    ELSIF v_schema <> 'extensions' THEN
      EXECUTE format('ALTER EXTENSION %I SET SCHEMA extensions', v_ext);
      RAISE NOTICE '008: 扩展 % 从 % 迁到 extensions', v_ext, v_schema;
    END IF;
  END LOOP;
END
$$;

-- 数据库级 search_path：让“裸类型名/裸操作符类名”仍然能解析。
-- 002 的 `embedding vector(1024)`、003 的 `vector_cosine_ops` / `gin_trgm_ops` 都是裸名字；
-- 扩展搬到 extensions 后，若会话 search_path 里没有它，重跑 002/003 会在类型解析处报错。
-- 保留默认的 "$user", public 形状，只在后面追加 extensions。
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET search_path = "$user", public, extensions', current_database());
  RAISE NOTICE '008: 数据库 % 的 search_path 追加 extensions', current_database();
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE '008: 无权设置数据库级 search_path（云上通常由平台托管），继续——迁移会话请显式 SET search_path';
END
$$;

SET search_path = public, extensions, pg_temp;

-- 权限：应用角色要能解析 extensions 里的类型（函数体里写 ::vector / similarity() 需要）。
-- 授权放在第 4 节之后（authenticated / service_role 在那里创建，云上可能已存在）。

-- ---------------------------------------------------------------------------
-- 3. 租户解析：三级回落 —— app.company_key（GUC）→ JWT claims.app_metadata.company_key
--    → ops.tenant_member（按 auth.uid()）。
--    所有读取都在 SECURITY DEFINER + 固定 search_path 里做，调用者不需要 ops 权限。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_uid() RETURNS uuid
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_text text;
  v_uid  uuid;
BEGIN
  -- 本地/直连：request.jwt.claim.sub（PostgREST 单 claim 形式）
  v_text := nullif(btrim(coalesce(current_setting('request.jwt.claim.sub', true), '')), '');

  -- 云上：auth.uid()（auth schema 不存在时静默跳过，本地就是这条路径）
  IF v_text IS NULL THEN
    BEGIN
      EXECUTE 'SELECT auth.uid()::text' INTO v_text;
    EXCEPTION WHEN others THEN
      v_text := NULL;
    END;
  END IF;

  IF v_text IS NULL THEN
    RETURN NULL;
  END IF;

  BEGIN
    v_uid := v_text::uuid;
  EXCEPTION WHEN others THEN
    v_uid := NULL;
  END;
  RETURN v_uid;
END
$$;

COMMENT ON FUNCTION public.app_uid() IS
  '当前用户 id（uuid）：优先 request.jwt.claim.sub，其次 auth.uid()（云）。解析不到返回 NULL。';

-- 宽松版：解析不到返回 NULL。RLS 策略与 006/007 的 RPC 用它——
-- 策略里抛错会让所有查询失败，默认拒绝的正确表达是“判据为 NULL”。
CREATE OR REPLACE FUNCTION public.app_tenant_key() RETURNS text
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_key    text;
  v_claims jsonb;
  v_uid    uuid;
BEGIN
  -- ① 连接/事务级 GUC：只允许受信任服务端设置（事务级 set_config(..., true)）
  v_key := nullif(btrim(coalesce(current_setting('app.company_key', true), '')), '');
  IF v_key IS NOT NULL THEN
    RETURN v_key;
  END IF;

  -- ② JWT claims（PostgREST / Supabase）：request.jwt.claims.app_metadata.company_key
  BEGIN
    v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  EXCEPTION WHEN others THEN
    v_claims := NULL;
  END;

  IF v_claims IS NOT NULL THEN
    v_key := nullif(btrim(coalesce(v_claims -> 'app_metadata' ->> 'company_key', '')), '');
    IF v_key IS NOT NULL THEN
      RETURN v_key;
    END IF;
  END IF;

  -- ③ 成员表：按当前用户 id 查 ops.tenant_member
  v_uid := public.app_uid();
  IF v_uid IS NOT NULL THEN
    SELECT nullif(btrim(m.company_key), '')
      INTO v_key
      FROM ops.tenant_member m
     WHERE m.user_id = v_uid;
    IF v_key IS NOT NULL THEN
      RETURN v_key;
    END IF;
  END IF;

  RETURN NULL;   -- 三路都无 → 由上层决定（RLS 默认拒绝 / 严格版抛 42501）
END
$$;

COMMENT ON FUNCTION public.app_tenant_key() IS
  '租户三级回落（GUC→JWT app_metadata.company_key→ops.tenant_member by auth.uid()）；解析不到返回 NULL。RLS 策略用这个。';

-- 严格版：三路都无 → 42501 tenant-context-required（contract.tenant.missing）。
-- 用于“必须知道租户才能继续”的入口；**不要**放进 RLS 策略。
CREATE OR REPLACE FUNCTION public.app_company_key() RETURNS text
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_key text := public.app_tenant_key();
BEGIN
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'tenant-context-required' USING ERRCODE = '42501';
  END IF;
  RETURN v_key;
END
$$;

COMMENT ON FUNCTION public.app_company_key() IS
  '严格租户解析：GUC → JWT claim → 成员表；三路都无抛 42501 tenant-context-required。不用于 RLS 策略（策略用 app_tenant_key）。';

-- 3a. 把 public 下所有 `*_tenant` 策略的判据重指到宽松版（004/005/007 的策略形状一致）。
--     004 原来用 app_company_key()（宽松语义）；008 把 app_company_key() 升级成严格版，
--     所以策略必须改指 app_tenant_key()，否则“没有租户上下文”会变成报错而不是 0 行。
DO $$
DECLARE
  r     record;
  v_cnt integer := 0;
BEGIN
  FOR r IN
    SELECT c.relname AS tbl, p.polname
      FROM pg_policy p
      JOIN pg_class c     ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND p.polname LIKE '%\_tenant'
  LOOP
    EXECUTE format(
      'ALTER POLICY %I ON public.%I USING (company_key = public.app_tenant_key()) WITH CHECK (company_key = public.app_tenant_key())',
      r.polname, r.tbl);
    v_cnt := v_cnt + 1;
  END LOOP;
  RAISE NOTICE '008: 已把 % 条租户策略重指到 app_tenant_key()', v_cnt;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. 角色：anon（零权限）/ authenticated（读完写）/ service_role（BYPASSRLS）。
--    云上这三个角色由 Supabase 预建，本地自己建；属性只在“我们建的”上面断言。
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r        text;
  v_exists boolean;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) INTO v_exists;
    IF NOT v_exists THEN
      IF r = 'service_role' THEN
        EXECUTE 'CREATE ROLE service_role NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE';
      ELSE
        EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE', r);
      END IF;
      RAISE NOTICE '008: 已创建角色 %', r;
    END IF;

    -- service_role 必须 BYPASSRLS（同步/分析写回）；云上已满足时这里是 no-op。
    BEGIN
      IF r = 'service_role' THEN
        EXECUTE 'ALTER ROLE service_role BYPASSRLS';
      END IF;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE '008: 无权修改 % 的属性（云上由平台托管，需人工核对 BYPASSRLS）', r;
    END;
  END LOOP;
END
$$;

-- 4a. 表权限：与 orange_app 的形状保持一致（004/005/007 已给 orange_app 的同一组）。
DO $$
DECLARE
  t record;
  v_cnt integer := 0;
BEGIN
  FOR t IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
     ORDER BY c.relname
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t.relname);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role', t.relname);
    v_cnt := v_cnt + 1;
  END LOOP;
  RAISE NOTICE '008: 已把 % 张表的表级权限同步给 authenticated / service_role', v_cnt;
END
$$;

-- anon 故意不给任何表权限：漏 token 时必须是 42501（permission denied），不是“静默 0 行”。
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE USAGE ON SCHEMA extensions FROM anon;

-- ops 面：只给 service_role 读账本与成员（排障/对账用），authenticated 一律不给。
GRANT USAGE ON SCHEMA ops TO service_role;
GRANT SELECT ON ops.schema_migrations TO service_role;
GRANT SELECT ON ops.tenant_member TO service_role;
GRANT USAGE ON SCHEMA extensions TO orange_app, authenticated, service_role;

-- 4b. 函数权限收口：public 下所有函数先收回 PUBLIC 的 EXECUTE（PG 默认给 PUBLIC 执行权，
--     等于把所有 RPC 挂到公网匿名角色上），再按需显式授权。
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM public;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM public;

DO $$
DECLARE
  f record;
  v_cnt integer := 0;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind = 'f'
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
    v_cnt := v_cnt + 1;
  END LOOP;
  RAISE NOTICE '008: 已把 % 个 public 函数的 EXECUTE 授给 authenticated / service_role', v_cnt;
END
$$;

-- RLS 策略调用 app_tenant_key() / app_uid()：判据函数本身必须可执行，
-- 否则策略求值处会以 insufficient_privilege 失败（而不是给出 0 行）。
-- anon 也要 EXECUTE：策略先于表权限求值，没有它时 anon 的报错会指向函数名而不是表；
-- 这两个函数在无 claim 时返回 NULL（anon 的 JWT 不带 app_metadata），不会泄露租户。
GRANT EXECUTE ON FUNCTION public.app_tenant_key() TO anon, orange_app, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.app_uid()        TO anon, orange_app, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. 超时：角色级 30s + 函数级 30s。
--    角色级防“客户端跑一条没有函数的慢查询”；函数级防 SECURITY DEFINER 里越权放大。
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['orange_app', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      BEGIN
        EXECUTE format('ALTER ROLE %I SET statement_timeout = ''30s''', r);
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE '008: 无权设置角色 % 的 statement_timeout', r;
      END;
    END IF;
  END LOOP;
END
$$;

DO $$
DECLARE
  f record;
  v_cnt integer := 0;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind = 'f'
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET statement_timeout = ''30s''', f.sig);
    v_cnt := v_cnt + 1;
  END LOOP;
  RAISE NOTICE '008: 已给 % 个 public 函数设置 statement_timeout=30s', v_cnt;
END
$$;

-- ---------------------------------------------------------------------------
-- 6. 整个 public 的函数统一 search_path = public, extensions, pg_temp。
--    （004 的 app_company_key() 原本没有 search_path，是最典型的缺口；这里用循环统一，
--     不靠人工数“还有几个函数没设”。）
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  f record;
  v_cnt integer := 0;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind = 'f'
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, extensions, pg_temp', f.sig);
    v_cnt := v_cnt + 1;
  END LOOP;
  RAISE NOTICE '008: 已给 % 个 public 函数设置 search_path', v_cnt;
END
$$;

-- ---------------------------------------------------------------------------
-- 7. sync_state：加 account_key 并重建主键 (company_key, env_id, mode, account_key)。
--    同一公司同一环境同一模式，不同账号各有各的水位（供应商按账号返回素材）。
-- ---------------------------------------------------------------------------
ALTER TABLE public.sync_state ADD COLUMN IF NOT EXISTS account_key text NOT NULL DEFAULT '';

COMMENT ON COLUMN public.sync_state.account_key IS
  '账号维度（供应商账号）；空串表示“与账号无关的聚合水位”。主键自 008 起含它。';

DO $$
DECLARE
  v_cols text;
BEGIN
  SELECT string_agg(a.attname, ',' ORDER BY a.attnum)
    INTO v_cols
    FROM pg_constraint c
    JOIN LATERAL unnest(c.conkey) k(attnum) ON true
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
   WHERE c.conrelid = 'public.sync_state'::regclass
     AND c.contype  = 'p';

  IF v_cols IS DISTINCT FROM 'company_key,env_id,mode,account_key' THEN
    IF EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = 'public.sync_state'::regclass AND conname = 'sync_state_pk') THEN
      ALTER TABLE public.sync_state DROP CONSTRAINT sync_state_pk;
    END IF;
    ALTER TABLE public.sync_state
      ADD CONSTRAINT sync_state_pk PRIMARY KEY (company_key, env_id, mode, account_key);
    RAISE NOTICE '008: sync_state 主键重建：(%) -> (company_key,env_id,mode,account_key)', coalesce(v_cols, '无');
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 8. 收尾断言（失败信息直接指向要查的对象；全部用系统目录，不靠手数）。
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_bad  integer;
  v_list text;
BEGIN
  -- 8.1 所有 public 函数都有 search_path=public, extensions, pg_temp
  SELECT count(*), string_agg(p.proname, ',')
    INTO v_bad, v_list
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prokind = 'f'
     AND (
       p.proconfig IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM unnest(p.proconfig) cfg
          WHERE cfg = 'search_path=public, extensions, pg_temp'
       )
     );
  IF v_bad > 0 THEN
    RAISE EXCEPTION '008: % 个 public 函数缺 search_path=public, extensions, pg_temp：%', v_bad, v_list;
  END IF;

  -- 8.2 所有 public 函数都有 statement_timeout
  SELECT count(*), string_agg(p.proname, ',')
    INTO v_bad, v_list
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prokind = 'f'
     AND (p.proconfig IS NULL OR NOT EXISTS (
           SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'statement_timeout=%'));
  IF v_bad > 0 THEN
    RAISE EXCEPTION '008: % 个 public 函数缺 statement_timeout：%', v_bad, v_list;
  END IF;

  -- 8.3 vector / pg_trgm 都在 extensions
  SELECT count(*), string_agg(e.extname, ',')
    INTO v_bad, v_list
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
   WHERE n.nspname <> 'extensions'
     AND e.extname IN ('vector', 'pg_trgm');
  IF v_bad > 0 THEN
    RAISE EXCEPTION '008: 扩展没迁到 extensions：%', v_list;
  END IF;

  -- 8.4 没有策略还引用严格版 app_company_key()
  SELECT count(*)
    INTO v_bad
    FROM pg_policy p
    JOIN pg_class c     ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND coalesce(pg_get_expr(p.polqual, p.polrelid), '') || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
         LIKE '%app_company_key%';
  IF v_bad > 0 THEN
    RAISE EXCEPTION '008: % 条策略仍在用严格版 app_company_key()（应改用 app_tenant_key()）', v_bad;
  END IF;

  -- 8.5 sync_state 主键含 account_key
  SELECT string_agg(a.attname, ',' ORDER BY a.attnum)
    INTO v_list
    FROM pg_constraint c
    JOIN LATERAL unnest(c.conkey) k(attnum) ON true
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
   WHERE c.conrelid = 'public.sync_state'::regclass AND c.contype = 'p';
  IF v_list IS DISTINCT FROM 'company_key,env_id,mode,account_key' THEN
    RAISE EXCEPTION '008: sync_state 主键是 (%)，应为 (company_key,env_id,mode,account_key)', v_list;
  END IF;

  -- 8.6 public 下没有任何函数把 EXECUTE 留给 PUBLIC
  --     proacl 为 NULL = 走默认 ACL（函数默认给 PUBLIC 执行权），同样算“留给 PUBLIC”。
  SELECT count(*)
    INTO v_bad
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prokind = 'f'
     AND (
       p.proacl IS NULL
       OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
     );
  IF v_bad > 0 THEN
    RAISE EXCEPTION '008: % 个 public 函数仍对 PUBLIC 可执行', v_bad;
  END IF;
END
$$;

-- 8.7 严格租户解析在“三路都无”时确实抛 42501 tenant-context-required。
--     （在子事务里试，失败被吞掉；成功反而报错。）
DO $$
DECLARE
  v_ok    boolean := false;
  v_msg   text;
  v_state text;
BEGIN
  BEGIN
    PERFORM set_config('app.company_key', '', true);
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM public.app_company_key();
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
    IF v_state <> '42501' OR v_msg <> 'tenant-context-required' THEN
      RAISE EXCEPTION '008: app_company_key() 抛的是 % / %，应为 42501 / tenant-context-required', v_state, v_msg;
    END IF;
    v_ok := true;
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION '008: app_company_key() 在无租户上下文时没有抛错';
  END IF;
  RAISE NOTICE '008: 严格租户解析 OK（42501 / tenant-context-required）';
END
$$;
