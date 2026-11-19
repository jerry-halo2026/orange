-- 010 租户判据严格化 / 租户来源收口 / 客户端契约自洽 / content_key 形状。
--
-- 只追加不改写：004/005/007/008/009 一律不动，本文件把它们的结果收敛到最终形状。
--
-- 六块交付：
--   1. app_tenant_key()（宽松版）重排来源顺序：JWT claim → GUC（只采信受信调用身份）→
--      ops.tenant_member。008 的顺序是 GUC → claim → 成员表，于是任何能执行
--      `set local app.company_key = 't-victim'` 的会话都能换租户。010 起：
--        * token 里的 app_metadata.company_key 永远优先（token 是服务端签的，GUC 不是）；
--        * GUC 只在**调用身份**属于 {postgres, orange_app, service_role, supabase_admin}
--          时被采信；调用身份 = `current_setting('role')`（SET ROLE / PostgREST 的
--          SET LOCAL ROLE），没设过角色时回落到 session_user。这样
--          `set role authenticated; set local app.company_key='t-victim'` 里 session_user
--          虽然是 postgres，身份仍是 authenticated → GUC 被忽略，claim 说了算。
--   2. 所有租户策略改成严格判据：无租户上下文 → 42501 tenant-context-required（读、写都是），
--      有租户但参数不一致仍返回空集（保持 006 原意）。
--      策略表达式调 public.tenant_key_required()（严格版的策略面向名字），而不是
--      public.app_company_key()：008 的收尾断言 8.4 会拦“任何策略表达式里出现
--      app_company_key 字样”，而 008 是已应用文件、每轮重放都会再跑一遍；策略若写成
--      app_company_key，第二轮 008 直接 RAISE，001→010 的两轮幂等就破了。
--      两个名字是同一实现（app_company_key 委托给 tenant_key_required），只是策略必须用
--      后者。008 的自检 8.7 仍然用 app_company_key，行为不变。
--   3. orange_resolve_materials 的返回列改成客户端读的 camelCase
--      （apps/api/src/supabase.ts:66 读 m.versionId / m.contentSha256 / m.durationSec /
--      m.probeRevision；snake_case 会让客户端把每次解析都判成 result-unknown）。
--   4. orange_preflight：prepare-required / duplicate 各返回**恰好 1 个键**（客户端
--      supabase.ts:70-71 要求 Object.keys(value).length === 1）；claim 分支整份返回
--      claimEnvelope，status 取 claim 的真实五态（客户端 supabase.ts:72 校验 status ∈
--      五态；原先 `jsonb_build_object('status','claim') || envelope` 让 status 被信封覆盖，
--      而客户端根本不接受 'claim' 这个值）。
--   5. orange_plan.content_key / orange_claim.content_key 加 `^[0-9a-f]{64}$` CHECK。
--   6. anon 收口：public 下所有函数/表的 EXECUTE/SELECT… 全部收回（008 把
--      app_tenant_key()/app_uid() 授给了 anon，等于把租户解析入口挂到匿名角色上），
--      并断言 anon 在 public 下的**有效权限**为零（--contract 用 has_*_privilege 复核）。
--
-- 幂等：DO 循环 + 目录探测；策略 ALTER 可重复；函数 DROP/CREATE；约束先 NOT VALID 再 VALIDATE。
-- 前置：008、009 必须已应用（否则下面的策略/函数都不存在）。
--
-- 注意：策略改成严格判据后，**没有租户上下文的读也会报 42501**（不再是静默 0 行）。
-- 这是契约 tenant.missing 的读侧要求；维护脚本 / pg_dump 请用超级用户或
-- `row_security = off`，或先 `set app.company_key`（受信身份下）。

DO $$
BEGIN
  IF to_regclass('public.orange_claim') IS NULL THEN
    RAISE EXCEPTION '010: 缺少 orange_claim，请先跑 009（顺序 001→010 不能换）';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    RAISE EXCEPTION '010: 缺少 authenticated 角色，请先跑 008';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 1. 宽松版租户解析：JWT claim → GUC（受信身份）→ 成员表。
--    解析不到仍返回 NULL（RLS 不再依赖它返回 NULL，但 006/007 的 RPC 用它判“有没有上下文”）。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_tenant_key() RETURNS text
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = public, extensions, pg_temp
  SET statement_timeout = '30s'
AS $$
DECLARE
  v_key    text;
  v_claims jsonb;
  v_uid    uuid;
  v_role   text;
BEGIN
  -- ① JWT claims（服务端签发，最高优先）：request.jwt.claims.app_metadata.company_key
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

  -- ② GUC：只采信受信调用身份。身份取 `role` GUC（SET ROLE / SET LOCAL ROLE 的值），
  --    没设过角色时是 'none'，回落到 session_user。
  v_role := nullif(current_setting('role', true), 'none');
  IF v_role IS NULL THEN
    SELECT session_user INTO v_role;
  END IF;

  IF v_role IN ('postgres', 'orange_app', 'service_role', 'supabase_admin') THEN
    v_key := nullif(btrim(coalesce(current_setting('app.company_key', true), '')), '');
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

  RETURN NULL;
END
$$;

COMMENT ON FUNCTION public.app_tenant_key() IS
  '租户解析（宽松版，010 起）：JWT claim → GUC（仅受信调用身份）→ ops.tenant_member；解析不到返回 NULL。';

-- ---------------------------------------------------------------------------
-- 2. 严格版：策略面向。三路都无 → 42501 tenant-context-required。
--    app_company_key() 保持名字与行为不变（008 的自检 8.7、契约 tenant.missing 都指它），
--    实现改成委托给 tenant_key_required()，两者永远同一判据。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tenant_key_required() RETURNS text
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = public, extensions, pg_temp
  SET statement_timeout = '30s'
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

COMMENT ON FUNCTION public.tenant_key_required() IS
  '严格租户判据（策略面向）：无租户上下文抛 42501 tenant-context-required。所有 RLS 策略用这个。';

CREATE OR REPLACE FUNCTION public.app_company_key() RETURNS text
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = public, extensions, pg_temp
  SET statement_timeout = '30s'
AS $$
BEGIN
  RETURN public.tenant_key_required();
END
$$;

COMMENT ON FUNCTION public.app_company_key() IS
  '严格租户解析（008 的名字，010 起委托 tenant_key_required）：三路都无抛 42501 tenant-context-required。';

-- ---------------------------------------------------------------------------
-- 3. 所有租户策略 → 严格判据（按 pg_policy 动态取，不写死名单；004/005/007/009 建的
--    15 条 `*_tenant` 全覆盖）。
-- ---------------------------------------------------------------------------
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
      'ALTER POLICY %I ON public.%I USING (company_key = public.tenant_key_required()) WITH CHECK (company_key = public.tenant_key_required())',
      r.polname, r.tbl);
    v_cnt := v_cnt + 1;
  END LOOP;
  IF v_cnt = 0 THEN
    RAISE EXCEPTION '010: 一条租户策略都没找到（004/005/007/009 未应用？）';
  END IF;
  RAISE NOTICE '010: 已把 % 条租户策略改成严格判据（无租户上下文 → 42501）', v_cnt;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. content_key 形状：64 位小写 hex（与 contentSha256/checksum 同一口径）。
--    先 NOT VALID 加上（不扫表、不阻塞），清掉不合格式的测试数据后再 VALIDATE。
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_bad bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.orange_plan'::regclass
                    AND conname  = 'orange_plan_content_key_sha256') THEN
    ALTER TABLE public.orange_plan
      ADD CONSTRAINT orange_plan_content_key_sha256
      CHECK (content_key ~ '^[0-9a-f]{64}$') NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.orange_claim'::regclass
                    AND conname  = 'orange_claim_content_key_sha256') THEN
    ALTER TABLE public.orange_claim
      ADD CONSTRAINT orange_claim_content_key_sha256
      CHECK (content_key ~ '^[0-9a-f]{64}$') NOT VALID;
  END IF;

  SELECT count(*) INTO v_bad FROM public.orange_plan WHERE content_key !~ '^[0-9a-f]{64}$';
  IF v_bad > 0 THEN
    RAISE EXCEPTION '010: orange_plan 有 % 行 content_key 不是 64 位小写 hex（测试数据），先清理再重跑', v_bad;
  END IF;

  SELECT count(*) INTO v_bad FROM public.orange_claim WHERE content_key !~ '^[0-9a-f]{64}$';
  IF v_bad > 0 THEN
    RAISE EXCEPTION '010: orange_claim 有 % 行 content_key 不是 64 位小写 hex（测试数据），先清理再重跑', v_bad;
  END IF;

  IF NOT (SELECT convalidated FROM pg_constraint WHERE conrelid = 'public.orange_plan'::regclass
                                                    AND conname = 'orange_plan_content_key_sha256') THEN
    ALTER TABLE public.orange_plan VALIDATE CONSTRAINT orange_plan_content_key_sha256;
  END IF;
  IF NOT (SELECT convalidated FROM pg_constraint WHERE conrelid = 'public.orange_claim'::regclass
                                                    AND conname = 'orange_claim_content_key_sha256') THEN
    ALTER TABLE public.orange_claim VALIDATE CONSTRAINT orange_claim_content_key_sha256;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 5. orange_resolve_materials：返回列用带引号的 camelCase 别名。
--    DROP 而不是 CREATE OR REPLACE：OUT 列名变了，替换会报 “cannot change return type”。
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.orange_resolve_materials(text, text[]);

CREATE FUNCTION public.orange_resolve_materials(p_company_key text, p_video_ids text[])
RETURNS TABLE (
  "versionId"     uuid,
  "contentSha256" text,
  "kind"          text,
  "durationSec"   numeric,
  "probeRevision" integer
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, extensions, pg_temp
SET statement_timeout = '30s'
AS $$
DECLARE
  v_company text := public.claim_require_tenant(p_company_key);
  v_subject text := coalesce(
                      public.app_uid()::text,
                      nullif(btrim(coalesce(current_setting('app.subject_id', true), '')), '')
                    );
  v_scoped  boolean;
BEGIN
  v_scoped := v_subject IS NOT NULL AND EXISTS (
    SELECT 1 FROM orange_material_grant g
     WHERE g.company_key = v_company
       AND g.subject_id  = v_subject
       AND g.revoked_at IS NULL
  );

  RETURN QUERY
    SELECT DISTINCT ON (v.video_id, v.kind)
           v.version_id, v.content_sha256, v.kind, v.duration_sec, v.probe_revision
      FROM orange_material_version v
     WHERE v.company_key = v_company                                   -- [tenant]
       AND (p_video_ids IS NULL OR v.video_id = ANY (p_video_ids))
       AND (
         NOT v_scoped
         OR EXISTS (
              SELECT 1
                FROM orange_material_grant g
                JOIN material m
                  ON m.company_key = g.company_key
                 AND m.env_id      = v.env_id
                 AND m.video_id    = v.video_id
                 AND m.account_key = g.account_key
                WHERE g.company_key = v.company_key
                  AND g.subject_id  = v_subject
                  AND g.revoked_at IS NULL
            )
       )
     ORDER BY v.video_id, v.kind, v.probe_revision DESC, v.frozen_at DESC;
END
$$;

COMMENT ON FUNCTION public.orange_resolve_materials(text, text[]) IS
  '解析可领取版本（010 起列名 camelCase，对齐 apps/api/src/supabase.ts:66）：按 (video_id, kind) 取 probe_revision 最高的一条；有授权的主体只看被授权账号。';

-- ---------------------------------------------------------------------------
-- 6. orange_preflight：prepare-required / duplicate → 恰好 1 个键；
--    claim → 完整 claimEnvelope（status = claim 的真实五态，客户端只认五态）。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.orange_preflight(p_company_key text, p_plan_id uuid, p_content_key text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, extensions, pg_temp
SET statement_timeout = '30s'
AS $$
DECLARE
  v_company text := public.claim_require_tenant(p_company_key);
  v_content text := nullif(btrim(coalesce(p_content_key, '')), '');
  v_claim   orange_claim;
  v_has     boolean;
BEGIN
  IF p_plan_id IS NULL OR v_content IS NULL THEN
    RAISE EXCEPTION 'orange:invalid-argument' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_claim
    FROM orange_claim
   WHERE company_key = v_company AND plan_id = p_plan_id;
  v_has := FOUND;   -- 显式存下来：后面的 EXISTS 子查询不保证 FOUND 不变

  -- 已有同内容键的 claim：整份信封（客户端按 claimId/status∈五态 校验）。
  IF v_has AND v_claim.content_key = v_content THEN
    RETURN public.claim_envelope(v_company, v_claim.claim_id);
  END IF;

  -- 同一内容键已经有交付记录：不再重复产出（幂等由内容键保证）。
  IF EXISTS (SELECT 1 FROM orange_delivery d
              WHERE d.company_key = v_company AND d.content_key = v_content) THEN
    RETURN jsonb_build_object('status', 'duplicate');   -- 恰好 1 个键（supabase.ts:71）
  END IF;

  -- 计划被别的内容键占了：同样是 duplicate，只是没有可执行的信封。
  IF v_has THEN
    RETURN jsonb_build_object('status', 'duplicate');   -- 恰好 1 个键
  END IF;

  RETURN jsonb_build_object('status', 'prepare-required');   -- 恰好 1 个键（supabase.ts:70）
END
$$;

COMMENT ON FUNCTION public.orange_preflight(text, uuid, text) IS
  '只读预检（010 起）：prepare-required / duplicate 各返回单键 {"status":…}；claim 返回完整 claimEnvelope。';

-- ---------------------------------------------------------------------------
-- 7. anon 收口：public 下的函数与表一律收回（008 曾把 app_tenant_key()/app_uid() 授给 anon）。
--    注意 PUBLIC 也要收：函数的默认 ACL 就是 `=X`（PUBLIC 可执行），anon 通过 PUBLIC 继承，
--    只 REVOKE ... FROM anon 是收不干净的（010 新建/重建的函数就会带着 `=X`）。
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  f record;
  t record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', f.sig);
  END LOOP;

  FOR t IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', t.relname);
  END LOOP;

  -- 让后续新建的函数默认就没有 PUBLIC 执行权（008 也做过一次；这里补齐并明确口径）。
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC';
  RAISE NOTICE '010: 已收回 anon/PUBLIC 在 public 下的全部函数/表权限';
END
$$;

-- 新函数/重建函数的显式授权（008 的 revoke-on-default 已生效，这里仍显式收口）。
REVOKE ALL ON FUNCTION public.tenant_key_required() FROM public;
REVOKE ALL ON FUNCTION public.app_company_key()    FROM public;
REVOKE ALL ON FUNCTION public.app_tenant_key()     FROM public;

GRANT EXECUTE ON FUNCTION public.tenant_key_required() TO authenticated, service_role, orange_app;
GRANT EXECUTE ON FUNCTION public.app_company_key()     TO authenticated, service_role, orange_app;
GRANT EXECUTE ON FUNCTION public.app_tenant_key()      TO authenticated, service_role, orange_app;
GRANT EXECUTE ON FUNCTION public.orange_resolve_materials(text, text[]) TO authenticated, service_role, orange_app;

-- ---------------------------------------------------------------------------
-- 8. 收尾断言（全部用系统目录，不靠手数）。
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_bad  integer;
  v_list text;
BEGIN
  -- 8.1 没有策略还在用宽松版 / 严格版的老名字（策略必须用 tenant_key_required）
  SELECT count(*), string_agg(c.relname || '.' || p.polname, ',')
    INTO v_bad, v_list
    FROM pg_policy p
    JOIN pg_class c     ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND (coalesce(pg_get_expr(p.polqual, p.polrelid), '')
       || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''))
         ~ '(app_tenant_key|app_company_key)';
  IF v_bad > 0 THEN
    RAISE EXCEPTION '010: % 条策略还在用旧判据：%', v_bad, v_list;
  END IF;

  -- 8.2 每条 `*_tenant` 策略都指向 tenant_key_required()
  SELECT count(*), string_agg(c.relname || '.' || p.polname, ',')
    INTO v_bad, v_list
    FROM pg_policy p
    JOIN pg_class c     ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND p.polname LIKE '%\_tenant'
     AND pg_get_expr(p.polqual, p.polrelid) NOT LIKE '%tenant_key_required%';
  IF v_bad > 0 THEN
    RAISE EXCEPTION '010: % 条租户策略没指着 tenant_key_required()：%', v_bad, v_list;
  END IF;

  -- 8.3 content_key 两条约束存在且已验证
  SELECT count(*) INTO v_bad
    FROM pg_constraint
   WHERE conrelid IN ('public.orange_plan'::regclass, 'public.orange_claim'::regclass)
     AND conname IN ('orange_plan_content_key_sha256', 'orange_claim_content_key_sha256')
     AND convalidated;
  IF v_bad <> 2 THEN
    RAISE EXCEPTION '010: content_key 的 64 位 hex 约束未全部生效（% / 2）', v_bad;
  END IF;

  -- 8.4 8 个 orange_* RPC 各只有一个重载；resolve_materials 的返回列是 camelCase
  SELECT count(*), string_agg(p.proname, ',')
    INTO v_bad, v_list
    FROM (SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND proname LIKE 'orange\_%'
           GROUP BY proname HAVING count(*) > 1) s
    JOIN pg_proc p ON p.proname = s.proname;
  IF v_bad > 0 THEN
    RAISE EXCEPTION '010: 存在重复重载的 orange_* 函数：%', v_list;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'orange_resolve_materials'
       AND pg_get_function_result(p.oid) LIKE '%"versionId"%'
       AND pg_get_function_result(p.oid) LIKE '%"contentSha256"%'
       AND pg_get_function_result(p.oid) LIKE '%"durationSec"%'
       AND pg_get_function_result(p.oid) LIKE '%"probeRevision"%'
  ) THEN
    RAISE EXCEPTION '010: orange_resolve_materials 的返回列不是 camelCase（客户端 supabase.ts:66 会判 result-unknown）';
  END IF;

  -- 8.5 anon 在 public 下的有效权限为零
  SELECT count(*) INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f'
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_bad > 0 THEN
    RAISE EXCEPTION '010: anon 仍可执行 % 个 public 函数', v_bad;
  END IF;

  -- 8.6 所有 public 函数都有 search_path（含 extensions）与 statement_timeout
  SELECT count(*), string_agg(p.proname, ',')
    INTO v_bad, v_list
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f'
     AND (p.proconfig IS NULL
          OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg
                          WHERE cfg = 'search_path=public, extensions, pg_temp')
          OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg
                          WHERE cfg LIKE 'statement_timeout=%'));
  IF v_bad > 0 THEN
    RAISE EXCEPTION '010: % 个 public 函数缺 search_path(command)/statement_timeout：%', v_bad, v_list;
  END IF;

  RAISE NOTICE '010: 租户判据严格化 OK（策略 % 条），content_key/camelCase/anon 收口 OK',
    (SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND p.polname LIKE '%\_tenant');
END
$$;
