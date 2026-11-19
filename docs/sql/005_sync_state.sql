-- 005 同步状态 + 素材软删除标记。
--
-- 这两块 DDL 原本以常量形式留在 `apps/api`（`src/sync/store.ts` 的 SYNC_SCHEMA_DDL），
-- 现在落地成正式迁移；常量仍保留在代码里作为"本模块需要什么"的说明书，但**迁移以本文件为准**。
--
-- 幂等：IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / DROP POLICY IF EXISTS 后重建。

-- 每个 (租户, 环境, 模式) 一行的同步水位。
--   cursor   ：下一页从哪里继续（供应商游标；默认 createTime/videoId 双键）
--   drift    ：上一轮发现的漂移（数量/时间差），由调用方解释
--   pages/requests：本轮翻页次数与请求数（成本可观测）
--   status   ：ok / failed；失败时 error 为可展示的短消息（不含凭据）
CREATE TABLE IF NOT EXISTS sync_state (
  company_key text        NOT NULL,
  env_id      text        NOT NULL,
  mode        text        NOT NULL CHECK (mode IN ('day', 'watermark', 'full')),
  cursor      jsonb       NOT NULL DEFAULT '{"createTime":null,"videoId":null}'::jsonb,
  last_run    timestamptz NOT NULL DEFAULT now(),
  drift       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  pages       integer     NOT NULL DEFAULT 0,
  requests    integer     NOT NULL DEFAULT 0,
  status      text        NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'failed')),
  error       text,
  CONSTRAINT sync_state_pk PRIMARY KEY (company_key, env_id, mode),
  CONSTRAINT sync_state_company_key_nonempty CHECK (length(company_key) > 0),
  CONSTRAINT sync_state_env_id_nonempty CHECK (length(env_id) > 0),
  CONSTRAINT sync_state_pages_nonneg CHECK (pages >= 0),
  CONSTRAINT sync_state_requests_nonneg CHECK (requests >= 0)
);

COMMENT ON TABLE sync_state IS '供应商同步水位：每 (租户, 环境, 模式) 一行，幂等 upsert。';
COMMENT ON COLUMN sync_state.mode IS 'day=按日增量；watermark=按水位增量；full=全量重扫。';
COMMENT ON COLUMN sync_state.cursor IS '下一页起点；不存任何凭据。';

-- 软删除：供应商侧已下架/删除的素材不物理删除（历史草稿仍可能引用）。
-- NULL = 仍然有效。
ALTER TABLE material ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

COMMENT ON COLUMN material.deleted_at IS '软删除时间；NULL 表示仍在供应商侧有效。查询默认只看 deleted_at IS NULL。';

-- 部分索引：只索引"有效行"，比全表索引小，且天然匹配 `company_key = ? AND deleted_at IS NULL`。
CREATE INDEX IF NOT EXISTS material_company_live_idx
  ON material (company_key, deleted_at)
  WHERE deleted_at IS NULL;

-- 新表同样进租户隔离（与 004 一致：ENABLE + FORCE + app.company_key 策略）。
GRANT SELECT, INSERT, UPDATE, DELETE ON sync_state TO orange_app;

ALTER TABLE sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_state FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sync_state_tenant ON sync_state;
CREATE POLICY sync_state_tenant ON sync_state
  USING (company_key = public.app_company_key())
  WITH CHECK (company_key = public.app_company_key());
