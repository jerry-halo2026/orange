-- 016 让"迁移执行者"能自检 RLS：`set role orange_app` 需要成员资格。
--
-- 为什么需要这一条：`infra/verify.mjs` 的 ⑤/⑧ 要证明"跨租户看不见、无租户 42501"，
-- 做法是 `set role orange_app` 切到一个 **NOBYPASSRLS** 的角色上再查。本机 docker 里的
-- `postgres` 是超级用户，切谁都行；Supabase 上的 `postgres` 是 `rolsuper=false`（只是
-- `bypassrls=true`），没有成员资格时 `set role orange_app` 直接 permission denied，
-- 于是那两项断言只能空跑——看着是"失败"，其实是断言没法执行。
--
-- 这个授权不扩大任何权限：被授权者本来就 bypassrls，能读写全部表。它只是让"以应用角色跑一次查询"
-- 这件事在非超级用户平台上也可行。
--
-- 幂等：角色存在才授予；没有 ADMIN OPTION 时只 NOTICE，不中断迁移（那种环境要 DBA 手工授权）。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'orange_app') THEN
    BEGIN
      EXECUTE format('GRANT orange_app TO %I', current_user);
      RAISE NOTICE '016: orange_app 已授予 %（RLS 自检需要）', current_user;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE '016: 无法把 orange_app 授予 %（缺 ADMIN OPTION）——RLS 自检需要 DBA 手工授权', current_user;
    END;
  ELSE
    RAISE NOTICE '016: 没有 orange_app 角色（004 未跑？），跳过';
  END IF;
END
$$;
