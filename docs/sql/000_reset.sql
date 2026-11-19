-- 000 重置（破坏性）：清空本库 public schema 后重建。
--
-- 只用于本地开发库。会删除 public 下的**全部**对象（表/函数/扩展索引），
-- 随后重跑 001→004。不要对任何共享或生产库执行。
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO public;

-- 角色是集群级对象，不随 schema 删除；要彻底重来请手工：
--   DROP ROLE IF EXISTS orange_app;
--   或整卷重建：docker compose -f .dev/infra/docker-compose.yml down -v
