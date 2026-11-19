-- 004 租户隔离：应用角色 + 六张表全部启用 RLS。
--
-- 模型：连接级 GUC `app.company_key` 是唯一租户上下文。
--   * 未设置 / 设为空串  -> app_company_key() 为 NULL -> 策略不成立 -> 一行都看不到（默认拒绝）。
--   * 设置了            -> 只看得到、也只能写自己 company_key 的行。
-- 因此**谁设置这个 GUC 就是安全问题**：只允许受信任的服务端代码在每次事务里设置，
-- 绝不允许把请求体/查询参数里的值直接 set 进来。
--
-- 注意两点（写进 README，上云必须复验）：
--   1. 超级用户与 `BYPASSRLS` 角色**绕过** RLS；生产上的应用角色必须是普通角色。
--   2. 连接池复用连接时，GUC 会跟着连接活到下次设置为止；用事务级 `set_config(..., true)`
--      或每次取连接后立刻重设，避免上一个租户的上下文泄漏给下一个请求。

-- 租户上下文读取器：空串按“未设置”处理，避免 `SET app.company_key = ''` 意外匹配空租户。
CREATE OR REPLACE FUNCTION public.app_company_key() RETURNS text
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
AS $$ SELECT nullif(current_setting('app.company_key', true), '') $$;

COMMENT ON FUNCTION public.app_company_key() IS
  '当前连接的租户键（GUC app.company_key）；NULL 表示未设置，策略据此默认拒绝。';

-- 应用角色：非超级用户、非 BYPASSRLS，RLS 对它生效。
-- 本地 trust 认证下用它验隔离；上云请换成带口令/证书的独立登录角色。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'orange_app') THEN
    CREATE ROLE orange_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO orange_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON material, wiki_source, wiki_summary, wiki_entity, wiki_edge, wiki_event TO orange_app;
GRANT EXECUTE ON FUNCTION public.app_company_key() TO orange_app;

-- 六张表：启用（并强制）RLS。
-- FORCE 让“表的所有者”也受策略约束；只有超级用户/BYPASSRLS 例外。
ALTER TABLE material     ENABLE ROW LEVEL SECURITY;
ALTER TABLE material     FORCE  ROW LEVEL SECURITY;
ALTER TABLE wiki_source  ENABLE ROW LEVEL SECURITY;
ALTER TABLE wiki_source  FORCE  ROW LEVEL SECURITY;
ALTER TABLE wiki_summary ENABLE ROW LEVEL SECURITY;
ALTER TABLE wiki_summary FORCE  ROW LEVEL SECURITY;
ALTER TABLE wiki_entity  ENABLE ROW LEVEL SECURITY;
ALTER TABLE wiki_entity  FORCE  ROW LEVEL SECURITY;
ALTER TABLE wiki_edge    ENABLE ROW LEVEL SECURITY;
ALTER TABLE wiki_edge    FORCE  ROW LEVEL SECURITY;
ALTER TABLE wiki_event   ENABLE ROW LEVEL SECURITY;
ALTER TABLE wiki_event   FORCE  ROW LEVEL SECURITY;

-- 每张表一条策略：读与写都用同一判据（WITH CHECK 防跨租户写入/改归属）。
-- DROP + CREATE 保证可重复执行（策略没有 CREATE OR REPLACE）。

DROP POLICY IF EXISTS material_tenant ON material;
CREATE POLICY material_tenant ON material
  USING (company_key = public.app_company_key())
  WITH CHECK (company_key = public.app_company_key());

DROP POLICY IF EXISTS wiki_source_tenant ON wiki_source;
CREATE POLICY wiki_source_tenant ON wiki_source
  USING (company_key = public.app_company_key())
  WITH CHECK (company_key = public.app_company_key());

DROP POLICY IF EXISTS wiki_summary_tenant ON wiki_summary;
CREATE POLICY wiki_summary_tenant ON wiki_summary
  USING (company_key = public.app_company_key())
  WITH CHECK (company_key = public.app_company_key());

DROP POLICY IF EXISTS wiki_entity_tenant ON wiki_entity;
CREATE POLICY wiki_entity_tenant ON wiki_entity
  USING (company_key = public.app_company_key())
  WITH CHECK (company_key = public.app_company_key());

DROP POLICY IF EXISTS wiki_edge_tenant ON wiki_edge;
CREATE POLICY wiki_edge_tenant ON wiki_edge
  USING (company_key = public.app_company_key())
  WITH CHECK (company_key = public.app_company_key());

DROP POLICY IF EXISTS wiki_event_tenant ON wiki_event;
CREATE POLICY wiki_event_tenant ON wiki_event
  USING (company_key = public.app_company_key())
  WITH CHECK (company_key = public.app_company_key());
