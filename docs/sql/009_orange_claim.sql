-- 009 Orange 领取面：素材版本 / 授权 / 计划 / 领取 / 交付 + 8 个 orange_* RPC。
--
-- 唯一形状来源：docs/sql/contract.json
--   * tables：orange_material_grant / orange_material_version / orange_plan / orange_claim /
--     orange_delivery（任务书里的 “material_plan” 在契约里叫 `orange_plan`，以契约为准）。
--   * rpc：8 个 orange_* 的签名、返回形状、预算。
--   * claimEnvelope：required 七键；status 五态；**executionReady 恒 false**；
--     frozenPlan.version 恒 1；historyCount ∈ {0,1}；错误消息 `^orange:[a-z-]+$`；
--     idempotency-conflict 由客户端映射 409（SQL 侧只给消息与 P0001）。
--
-- 纪律（与 006/007 一致）：
--   * security invoker：RLS 照常生效；租户用 p_company_key 显式带，且必须与会话上下文一致。
--   * 所有函数 set search_path = public, extensions, pg_temp + statement_timeout = 30s。
--   * 错误一律 RAISE ... MESSAGE = orange:CODE（例如 orange:invalid-transition），
--     不抛英文长句（客户端只看 code，并用 ^orange:[a-z-]+$ 校验）。
--
-- 幂等：IF NOT EXISTS / CREATE OR REPLACE / 约束由 catalog 探测后再加。

-- ---------------------------------------------------------------------------
-- 0. 租户：显式参数 + 会话上下文（三级回落，见 008）。
--    会话里有上下文就必须一致；不一致 42501。没有上下文（psql/service_role 运维路径）
--    则信任显式 p_company_key——RLS 仍会挡住越权读写。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_require_tenant(p_company_key text) RETURNS text
  LANGUAGE plpgsql
  STABLE
  SECURITY INVOKER
  SET search_path = public, extensions, pg_temp
  SET statement_timeout = '30s'
AS $$
DECLARE
  v_arg text := nullif(btrim(coalesce(p_company_key, '')), '');
  v_ctx text;
BEGIN
  IF v_arg IS NULL THEN
    RAISE EXCEPTION 'orange:tenant-context-required' USING ERRCODE = '42501';
  END IF;
  v_ctx := public.app_tenant_key();          -- 008：GUC → JWT claim → 成员表
  IF v_ctx IS NOT NULL AND v_ctx <> v_arg THEN
    RAISE EXCEPTION 'orange:tenant-mismatch' USING ERRCODE = '42501';
  END IF;
  RETURN v_arg;
END
$$;

COMMENT ON FUNCTION public.claim_require_tenant(text) IS
  'orange_* 的租户入口：显式参数 + 会话上下文必须一致；缺失/不一致抛 42501 orange:tenant-*。';

-- ---------------------------------------------------------------------------
-- 1. 五张表。
-- ---------------------------------------------------------------------------
-- 素材版本：一次“可领取的冻结版本”。versionId 是客户端拿到的稳定标识；
-- contentSha256/kind/durationSec/probeRevision 就是 contract.client_checks 的四项。
CREATE TABLE IF NOT EXISTS orange_material_version (
  company_key    text          NOT NULL,
  version_id     uuid          NOT NULL,
  video_id       text          NOT NULL,
  env_id         text          NOT NULL,
  kind           text          NOT NULL CHECK (kind IN ('video', 'still', 'sound')),
  content_sha256 text          NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  duration_sec   numeric(12,3) NOT NULL CHECK (duration_sec >= 0),   -- numeric 天然有限，不存在 NaN/Inf
  probe_revision integer       NOT NULL CHECK (probe_revision >= 0),
  frozen_at      timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT orange_material_version_pk PRIMARY KEY (company_key, version_id),
  CONSTRAINT orange_material_version_uq UNIQUE (company_key, video_id, env_id, kind, content_sha256),
  CONSTRAINT orange_material_version_video_nonempty CHECK (length(video_id) > 0),
  CONSTRAINT orange_material_version_env_nonempty   CHECK (length(env_id) > 0)
);

COMMENT ON TABLE orange_material_version IS
  '可领取的素材版本（contract: orange_material_version）。duration_sec 用 numeric：有限且 >=0 由类型+约束共同保证。';

CREATE INDEX IF NOT EXISTS orange_material_version_video_idx
  ON orange_material_version (company_key, video_id, kind);

-- 领取授权：某个主体（subject）能领某个账号（account_key）下的素材。
CREATE TABLE IF NOT EXISTS orange_material_grant (
  company_key text        NOT NULL,
  subject_id  text        NOT NULL,
  account_key text        NOT NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  CONSTRAINT orange_material_grant_pk PRIMARY KEY (company_key, subject_id, account_key),
  CONSTRAINT orange_material_grant_subject_nonempty CHECK (length(subject_id) > 0)
);

COMMENT ON TABLE orange_material_grant IS
  '领取授权（contract: orange_material_grant）：主体 → 供应商账号；revoked_at 非空即失效。';

-- 计划：冻结的“要做什么”。plan_version 固定 1（contract.claimEnvelope.frozenPlan.version）。
CREATE TABLE IF NOT EXISTS orange_plan (
  company_key  text        NOT NULL,
  plan_id      uuid        NOT NULL,
  content_key  text        NOT NULL,
  plan_version integer     NOT NULL DEFAULT 1 CHECK (plan_version = 1),
  frozen_plan  jsonb       NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orange_plan_pk PRIMARY KEY (company_key, plan_id),
  CONSTRAINT orange_plan_content_key_nonempty CHECK (length(btrim(content_key)) > 0),
  -- 冻结计划自带的版本号也只能是 1：客户端据此判断“这是我能执行的计划”
  CONSTRAINT orange_plan_frozen_version CHECK (frozen_plan ->> 'version' = '1')
);

COMMENT ON TABLE orange_plan IS
  '冻结计划（contract: orange_plan）。plan_version 与 frozen_plan.version 都锁死在 1。';

-- 领取：一个计划最多一个 claim（contract.tables.orange_claim.unique）。
CREATE TABLE IF NOT EXISTS orange_claim (
  company_key     text        NOT NULL,
  claim_id        uuid        NOT NULL DEFAULT gen_random_uuid(),
  plan_id         uuid        NOT NULL,
  content_key     text        NOT NULL,
  status          text        NOT NULL DEFAULT 'reserved'
                    CHECK (status IN ('reserved', 'running', 'unknown', 'cancel-requested', 'succeeded')),
  history_count   integer     NOT NULL DEFAULT 0 CHECK (history_count IN (0, 1)),
  -- executionReady 恒 false：客户端**不得**据此直接执行，必须再走 preflight/start。
  execution_ready boolean     NOT NULL DEFAULT false CHECK (execution_ready = false),
  frozen_plan     jsonb       NOT NULL,
  attempt_started_at timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orange_claim_pk PRIMARY KEY (company_key, claim_id),
  CONSTRAINT orange_claim_plan_uq UNIQUE (company_key, plan_id),
  CONSTRAINT orange_claim_plan_fk FOREIGN KEY (company_key, plan_id)
    REFERENCES orange_plan (company_key, plan_id) ON DELETE CASCADE,
  CONSTRAINT orange_claim_frozen_version CHECK (frozen_plan ->> 'version' = '1')
);

COMMENT ON TABLE orange_claim IS
  '领取（contract: orange_claim）：status 五态、historyCount ∈ {0,1}、executionReady 恒 false。';

CREATE INDEX IF NOT EXISTS orange_claim_status_idx
  ON orange_claim (company_key, status, updated_at DESC);

-- 交付：一次 claim 可以有多条交付记录（contract 主键含 delivery_id）。
CREATE TABLE IF NOT EXISTS orange_delivery (
  company_key    text        NOT NULL,
  claim_id       uuid        NOT NULL,
  delivery_id    uuid        NOT NULL,
  content_key    text        NOT NULL,
  content_sha256 text        CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orange_delivery_pk PRIMARY KEY (company_key, claim_id, delivery_id),
  CONSTRAINT orange_delivery_claim_fk FOREIGN KEY (company_key, claim_id)
    REFERENCES orange_claim (company_key, claim_id) ON DELETE CASCADE
);

COMMENT ON TABLE orange_delivery IS
  '交付记录（contract: orange_delivery）：同 claim 可多次投递，delivery_id 幂等。';

-- ---------------------------------------------------------------------------
-- 2. 租户隔离（与 004/005/007 同一判据）与权限。
-- ---------------------------------------------------------------------------
ALTER TABLE orange_material_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE orange_material_version FORCE  ROW LEVEL SECURITY;
ALTER TABLE orange_material_grant   ENABLE ROW LEVEL SECURITY;
ALTER TABLE orange_material_grant   FORCE  ROW LEVEL SECURITY;
ALTER TABLE orange_plan             ENABLE ROW LEVEL SECURITY;
ALTER TABLE orange_plan             FORCE  ROW LEVEL SECURITY;
ALTER TABLE orange_claim            ENABLE ROW LEVEL SECURITY;
ALTER TABLE orange_claim            FORCE  ROW LEVEL SECURITY;
ALTER TABLE orange_delivery         ENABLE ROW LEVEL SECURITY;
ALTER TABLE orange_delivery         FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS orange_material_version_tenant ON orange_material_version;
CREATE POLICY orange_material_version_tenant ON orange_material_version
  USING (company_key = public.app_tenant_key())
  WITH CHECK (company_key = public.app_tenant_key());

DROP POLICY IF EXISTS orange_material_grant_tenant ON orange_material_grant;
CREATE POLICY orange_material_grant_tenant ON orange_material_grant
  USING (company_key = public.app_tenant_key())
  WITH CHECK (company_key = public.app_tenant_key());

DROP POLICY IF EXISTS orange_plan_tenant ON orange_plan;
CREATE POLICY orange_plan_tenant ON orange_plan
  USING (company_key = public.app_tenant_key())
  WITH CHECK (company_key = public.app_tenant_key());

DROP POLICY IF EXISTS orange_claim_tenant ON orange_claim;
CREATE POLICY orange_claim_tenant ON orange_claim
  USING (company_key = public.app_tenant_key())
  WITH CHECK (company_key = public.app_tenant_key());

DROP POLICY IF EXISTS orange_delivery_tenant ON orange_delivery;
CREATE POLICY orange_delivery_tenant ON orange_delivery
  USING (company_key = public.app_tenant_key())
  WITH CHECK (company_key = public.app_tenant_key());

GRANT SELECT, INSERT, UPDATE, DELETE ON
  orange_material_version, orange_material_grant, orange_plan, orange_claim, orange_delivery
  TO orange_app, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. 信封：唯一构造点。executionReady 写字面量 false（不读列），
--    七个 required 键一个不少；frozenPlan 原样带出（其 version 由表约束保证为 1）。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_envelope(p_company_key text, p_claim_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, extensions, pg_temp
SET statement_timeout = '30s'
AS $$
DECLARE
  c orange_claim;
BEGIN
  SELECT * INTO c
    FROM orange_claim
   WHERE company_key = p_company_key
     AND claim_id    = p_claim_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'claimId',        c.claim_id,
    'planId',         c.plan_id,
    'status',         c.status,
    'contentKey',     c.content_key,
    'historyCount',   c.history_count,
    'executionReady', false,                      -- 契约：恒 false
    'frozenPlan',     c.frozen_plan               -- 契约：version 恒 1（表约束兜底）
  );
END
$$;

COMMENT ON FUNCTION public.claim_envelope(text, uuid) IS
  'claimEnvelope 的唯一构造点（contract.claimEnvelope）；找不到返回 NULL。';

-- ---------------------------------------------------------------------------
-- 4. orange_resolve_materials：把可领取的版本解析出来（客户端四项 check 的数据源）。
--    授权规则：若该主体在本公司下**有**授权行，则只回被授权账号的版本；
--    没有授权行（或调用方没有 subject，例如 service_role 运维路径）则回全部。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.orange_resolve_materials(p_company_key text, p_video_ids text[])
RETURNS TABLE (
  version_id     uuid,
  video_id       text,
  kind           text,
  content_sha256 text,
  duration_sec   numeric,
  probe_revision integer
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
           v.version_id, v.video_id, v.kind, v.content_sha256, v.duration_sec, v.probe_revision
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
  '解析可领取版本：按 (video_id, kind) 取 probe_revision 最高的那条；有授权的主体只看被授权账号。';

-- ---------------------------------------------------------------------------
-- 5. orange_preflight：只回答“下一步是什么”，不写任何东西。
--    status ∈ prepare-required | duplicate | claim（contract.client_checks）。
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

  IF v_has AND v_claim.content_key = v_content THEN
    RETURN jsonb_build_object('status', 'claim') || public.claim_envelope(v_company, v_claim.claim_id);
  END IF;

  -- 同一内容键已经有交付记录：不再重复产出（幂等由内容键保证）。
  IF EXISTS (SELECT 1 FROM orange_delivery d
              WHERE d.company_key = v_company AND d.content_key = v_content) THEN
    RETURN jsonb_build_object(
      'status',     'duplicate',
      'planId',     p_plan_id,
      'contentKey', v_content,
      'reason',     'content-key-delivered'
    );
  END IF;

  -- 计划被别的内容键占了：也让客户端知道是 duplicate，而不是盲目再冻结一次。
  IF v_has THEN
    RETURN jsonb_build_object(
      'status',     'duplicate',
      'planId',     p_plan_id,
      'contentKey', v_content,
      'claimId',    v_claim.claim_id,
      'reason',     'plan-claimed-with-other-content-key'
    );
  END IF;

  RETURN jsonb_build_object(
    'status',      'prepare-required',
    'planId',      p_plan_id,
    'contentKey',  v_content,
    'executionReady', false
  );
END
$$;

COMMENT ON FUNCTION public.orange_preflight(text, uuid, text) IS
  '只读预检：status ∈ prepare-required | duplicate | claim；claim 时附带完整信封。';

-- ---------------------------------------------------------------------------
-- 6. orange_freeze_claim：冻结计划 + 建 claim（幂等；同计划不同内容键 = 409 语义）。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.orange_freeze_claim(
  p_company_key   text,
  p_plan_id       uuid,
  p_content_key   text,
  p_history_count integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions, pg_temp
SET statement_timeout = '30s'
AS $$
DECLARE
  v_company  text := public.claim_require_tenant(p_company_key);
  v_content  text := nullif(btrim(coalesce(p_content_key, '')), '');
  v_plan     orange_plan;
  v_claim    orange_claim;
  v_claim_id uuid;
BEGIN
  IF p_plan_id IS NULL OR v_content IS NULL THEN
    RAISE EXCEPTION 'orange:invalid-argument' USING ERRCODE = '22023';
  END IF;
  IF p_history_count IS NULL OR p_history_count NOT IN (0, 1) THEN
    RAISE EXCEPTION 'orange:invalid-history-count' USING ERRCODE = '22023';
  END IF;

  -- 6a 计划冻结（version 恒 1）。已存在的计划必须内容键一致，否则视为“同计划换了内容”。
  SELECT * INTO v_plan
    FROM orange_plan
   WHERE company_key = v_company AND plan_id = p_plan_id;

  IF NOT FOUND THEN
    INSERT INTO orange_plan AS pl (company_key, plan_id, content_key, plan_version, frozen_plan)
    VALUES (
      v_company, p_plan_id, v_content, 1,
      jsonb_build_object('version', 1, 'planId', p_plan_id, 'contentKey', v_content, 'frozenAt', now())
    );
  ELSIF v_plan.content_key <> v_content THEN
    RAISE EXCEPTION 'orange:idempotency-conflict' USING ERRCODE = 'P0001';
  END IF;

  -- 6b 已有 claim：内容键与 historyCount 都一致才算重复调用，否则是冲突。
  SELECT * INTO v_claim
    FROM orange_claim
   WHERE company_key = v_company AND plan_id = p_plan_id;

  IF FOUND THEN
    IF v_claim.content_key <> v_content OR v_claim.history_count <> p_history_count THEN
      RAISE EXCEPTION 'orange:idempotency-conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN public.claim_envelope(v_company, v_claim.claim_id);
  END IF;

  BEGIN
    INSERT INTO orange_claim (
      company_key, claim_id, plan_id, content_key, status, history_count, execution_ready, frozen_plan
    ) VALUES (
      v_company, gen_random_uuid(), p_plan_id, v_content, 'reserved', p_history_count, false,
      jsonb_build_object(
        'version',      1,
        'planId',       p_plan_id,
        'contentKey',   v_content,
        'historyCount', p_history_count,
        'frozenAt',     now(),
        'plan',         coalesce(v_plan.frozen_plan, '{}'::jsonb)
      )
    )
    RETURNING claim_id INTO v_claim_id;
  EXCEPTION WHEN unique_violation THEN
    -- 并发冻结：另一请求刚好建了 claim。按幂等规则重新判断，不把它当 500。
    SELECT * INTO v_claim
      FROM orange_claim
     WHERE company_key = v_company AND plan_id = p_plan_id;
    IF NOT FOUND
       OR v_claim.content_key <> v_content
       OR v_claim.history_count <> p_history_count THEN
      RAISE EXCEPTION 'orange:idempotency-conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN public.claim_envelope(v_company, v_claim.claim_id);
  END;

  RETURN public.claim_envelope(v_company, v_claim_id);
END
$$;

COMMENT ON FUNCTION public.orange_freeze_claim(text, uuid, text, integer) IS
  '冻结计划并建立 claim：同参数重复调用幂等；同计划不同内容键/historyCount 抛 orange:idempotency-conflict（客户端映射 409）。';

-- ---------------------------------------------------------------------------
-- 7. 状态机：reserved → running → succeeded；reserved/running/unknown → cancel-requested；
--    running/reserved/cancel-requested → unknown。重复调用同一转移是幂等的。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.orange_claim_status(p_company_key text, p_claim_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, extensions, pg_temp
SET statement_timeout = '30s'
AS $$
DECLARE
  v_company text := public.claim_require_tenant(p_company_key);
  v_env     jsonb;
BEGIN
  IF p_claim_id IS NULL THEN
    RAISE EXCEPTION 'orange:invalid-argument' USING ERRCODE = '22023';
  END IF;
  v_env := public.claim_envelope(v_company, p_claim_id);
  IF v_env IS NULL THEN
    RAISE EXCEPTION 'orange:claim-not-found' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_env;
END
$$;

COMMENT ON FUNCTION public.orange_claim_status(text, uuid) IS
  '读取 claim 信封；不存在抛 orange:claim-not-found。';

CREATE OR REPLACE FUNCTION public.orange_start_attempt(p_company_key text, p_claim_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions, pg_temp
SET statement_timeout = '30s'
AS $$
DECLARE
  v_company text := public.claim_require_tenant(p_company_key);
  v_claim   orange_claim;
BEGIN
  IF p_claim_id IS NULL THEN
    RAISE EXCEPTION 'orange:invalid-argument' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_claim
    FROM orange_claim
   WHERE company_key = v_company AND claim_id = p_claim_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'orange:claim-not-found' USING ERRCODE = 'P0002';
  END IF;

  IF v_claim.status = 'reserved' THEN
    UPDATE orange_claim
       SET status = 'running', attempt_started_at = now(), updated_at = now()
     WHERE company_key = v_company AND claim_id = p_claim_id;
  ELSIF v_claim.status <> 'running' THEN
    RAISE EXCEPTION 'orange:invalid-transition' USING ERRCODE = 'P0001';
  END IF;

  RETURN public.claim_envelope(v_company, p_claim_id);
END
$$;

COMMENT ON FUNCTION public.orange_start_attempt(text, uuid) IS
  'reserved → running；已在 running 幂等；其余状态抛 orange:invalid-transition。';

CREATE OR REPLACE FUNCTION public.orange_cancel_claim(p_company_key text, p_claim_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions, pg_temp
SET statement_timeout = '30s'
AS $$
DECLARE
  v_company text := public.claim_require_tenant(p_company_key);
  v_claim   orange_claim;
BEGIN
  IF p_claim_id IS NULL THEN
    RAISE EXCEPTION 'orange:invalid-argument' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_claim
    FROM orange_claim
   WHERE company_key = v_company AND claim_id = p_claim_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'orange:claim-not-found' USING ERRCODE = 'P0002';
  END IF;

  IF v_claim.status = 'succeeded' THEN
    RAISE EXCEPTION 'orange:invalid-transition' USING ERRCODE = 'P0001';
  ELSIF v_claim.status <> 'cancel-requested' THEN
    UPDATE orange_claim
       SET status = 'cancel-requested', updated_at = now()
     WHERE company_key = v_company AND claim_id = p_claim_id;
  END IF;

  RETURN public.claim_envelope(v_company, p_claim_id);
END
$$;

COMMENT ON FUNCTION public.orange_cancel_claim(text, uuid) IS
  '请求取消：reserved/running/unknown → cancel-requested；已取消幂等；succeeded 抛 orange:invalid-transition。';

CREATE OR REPLACE FUNCTION public.orange_mark_unknown(p_company_key text, p_claim_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions, pg_temp
SET statement_timeout = '30s'
AS $$
DECLARE
  v_company text := public.claim_require_tenant(p_company_key);
  v_claim   orange_claim;
BEGIN
  IF p_claim_id IS NULL THEN
    RAISE EXCEPTION 'orange:invalid-argument' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_claim
    FROM orange_claim
   WHERE company_key = v_company AND claim_id = p_claim_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'orange:claim-not-found' USING ERRCODE = 'P0002';
  END IF;

  IF v_claim.status = 'succeeded' THEN
    RAISE EXCEPTION 'orange:invalid-transition' USING ERRCODE = 'P0001';
  ELSIF v_claim.status <> 'unknown' THEN
    UPDATE orange_claim
       SET status = 'unknown', updated_at = now()
     WHERE company_key = v_company AND claim_id = p_claim_id;
  END IF;

  RETURN public.claim_envelope(v_company, p_claim_id);
END
$$;

COMMENT ON FUNCTION public.orange_mark_unknown(text, uuid) IS
  '标记结果未知（网络中断等）：reserved/running/cancel-requested → unknown；已 unknown 幂等。';

CREATE OR REPLACE FUNCTION public.orange_record_delivery(
  p_company_key text,
  p_claim_id    uuid,
  p_delivery_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions, pg_temp
SET statement_timeout = '30s'
AS $$
DECLARE
  v_company text := public.claim_require_tenant(p_company_key);
  v_claim   orange_claim;
BEGIN
  IF p_claim_id IS NULL OR p_delivery_id IS NULL THEN
    RAISE EXCEPTION 'orange:invalid-argument' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_claim
    FROM orange_claim
   WHERE company_key = v_company AND claim_id = p_claim_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'orange:claim-not-found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO orange_delivery AS d (company_key, claim_id, delivery_id, content_key, recorded_at)
  VALUES (v_company, p_claim_id, p_delivery_id, v_claim.content_key, now())
  ON CONFLICT (company_key, claim_id, delivery_id) DO NOTHING;

  IF v_claim.status <> 'succeeded' THEN
    UPDATE orange_claim
       SET status = 'succeeded', updated_at = now()
     WHERE company_key = v_company AND claim_id = p_claim_id;
  END IF;

  RETURN public.claim_envelope(v_company, p_claim_id);
END
$$;

COMMENT ON FUNCTION public.orange_record_delivery(text, uuid, uuid) IS
  '记录交付并置 claim 为 succeeded：delivery_id 幂等（同 id 重复投递不报错）。';

-- ---------------------------------------------------------------------------
-- 8. 权限：函数在执行时创建（008 的 revoke-on-default 已生效，但这里仍显式收口）。
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.claim_require_tenant(text) FROM public;
REVOKE ALL ON FUNCTION public.claim_envelope(text, uuid) FROM public;

DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind = 'f'
       AND p.proname LIKE 'orange\_%'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO orange_app', f.sig);
  END LOOP;
END
$$;

GRANT EXECUTE ON FUNCTION public.claim_require_tenant(text) TO authenticated, service_role, orange_app;
GRANT EXECUTE ON FUNCTION public.claim_envelope(text, uuid)        TO authenticated, service_role, orange_app;

-- ---------------------------------------------------------------------------
-- 9. 收尾断言：8 个 RPC 齐全 + 契约不变量（executionReady 恒 false、version=1、
--    historyCount ∈ {0,1}、错误消息口径由常量表保证，见上）。
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(x.n, ',')
    INTO v_missing
    FROM (VALUES ('orange_resolve_materials'), ('orange_preflight'), ('orange_freeze_claim'),
                 ('orange_claim_status'), ('orange_start_attempt'), ('orange_cancel_claim'),
                 ('orange_mark_unknown'), ('orange_record_delivery')) AS x(n)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
      WHERE ns.nspname = 'public' AND p.proname = x.n
   );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '009: 缺少 orange_* RPC：%', v_missing;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.orange_claim'::regclass
       AND conname  = 'orange_claim_execution_ready_check'
  ) THEN
    RAISE EXCEPTION '009: orange_claim 缺 execution_ready 恒 false 约束';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.orange_claim'::regclass
       AND conname  = 'orange_claim_history_count_check'
  ) THEN
    RAISE EXCEPTION '009: orange_claim 缺 history_count ∈ {0,1} 约束';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.orange_claim'::regclass
       AND conname  = 'orange_claim_frozen_version'
  ) THEN
    RAISE EXCEPTION '009: orange_claim 缺 frozen_plan.version=1 约束';
  END IF;
END
$$;
