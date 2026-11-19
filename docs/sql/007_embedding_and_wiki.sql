-- 007 向量维度收敛到 768 + wiki 源/卡片/时间线/镜头 + 三个读 RPC。
--
-- 契约（只读，按它实现，不改它）：
--   * docs/sql/embedding.json —— dims=768、vectorColumn=wiki_summary.embedding、
--     index=hnsw(vector_cosine_ops, m=16, ef_construction=64)。
--   * docs/sql/contract.json —— tables(wiki_source / wiki_summary / wiki_entity) 与
--     rpc(upsert_wiki_source / wiki_video / wiki_timeline / wiki_shot) 的形状与预算。
--
-- 为什么列必须保持 `vector(768)`（定长），而不是裸 `vector`：
--   pgvector 的 HNSW **要求索引列带 typmod**。列变成裸 vector 后，003 的
--   `create index ... using hnsw (embedding vector_cosine_ops)` 会直接报
--   `column does not have dimensions`。所以列、函数变量、函数参数一律定长，
--   维度正确性靠函数体里的 `vector_dims(v) = 768` 断言兜（不匹配抛 22023）。
--
-- 顺序：先清空旧维度向量（1024 维的值无法直接改写成 768 维）→ 拆 HNSW →
--       改列类型 → 重建 HNSW。整段可重跑（第二轮是 no-op）。
--
-- 幂等：ADD COLUMN IF NOT EXISTS / IF NOT EXISTS / CREATE OR REPLACE FUNCTION；
--       改列类型、拆建索引之前都先探测当前状态。

-- ---------------------------------------------------------------------------
-- 0. 维度常量：只在本文件里出现一次，改维度 = 出 010 迁移，不改这里。
--    768 来自 embedding.json（model=text-embedding-nomic-embed-text-v1.5）。
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.wiki_summary') IS NULL THEN
    RAISE EXCEPTION '007: 缺少 wiki_summary，请先按顺序跑 002';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 1. 租户读取器（宽松版，供 007 的 RPC 与 008/009 的 RLS 策略使用）。
--    007 先给一个“只读 GUC”的最小实现；008 会用三级回落（GUC → JWT claims →
--    ops.tenant_member）替换它，**名字与签名不变**，所以策略与 RPC 不需要再改。
--    约定：解析不到租户返回 NULL（由 RLS 默认拒绝 / RPC 返回空集），不抛错。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_tenant_key() RETURNS text
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, extensions, pg_temp
AS $$ SELECT nullif(btrim(coalesce(current_setting('app.company_key', true), '')), '') $$;

COMMENT ON FUNCTION public.app_tenant_key() IS
  '会话租户（宽松版）：解析不到返回 NULL。007 只读 GUC；008 替换成三级回落（GUC→JWT→成员表）。';

-- ---------------------------------------------------------------------------
-- 2. 向量列改到 768 维。
--    2a 清空：旧向量是别的模型/别的维度，保留只会让改类型失败，也会污染检索。
--       三件套一起清空（002 的 wiki_summary_embedding_complete 要求同进同出）。
-- ---------------------------------------------------------------------------
UPDATE wiki_summary
   SET embedding       = NULL,
       embedding_model = NULL,
       embedding_ver   = NULL
 WHERE embedding IS NOT NULL
    OR embedding_model IS NOT NULL
    OR embedding_ver IS NOT NULL;

-- 2b 拆掉 HNSW：索引列类型变更前先拆，避免索引重建时的隐式转换错误。
DROP INDEX IF EXISTS public.wiki_summary_embedding_hnsw_idx;

-- 2c 改类型（已经 768 就跳过，保证第二轮零 ERROR、零重写）。
DO $$
DECLARE
  v_dims integer;
BEGIN
  SELECT a.atttypmod INTO v_dims
    FROM pg_attribute a
   WHERE a.attrelid = 'public.wiki_summary'::regclass
     AND a.attname  = 'embedding';

  IF v_dims IS DISTINCT FROM 768 THEN
    ALTER TABLE public.wiki_summary ALTER COLUMN embedding TYPE vector(768);
    RAISE NOTICE '007: wiki_summary.embedding 维度 % -> 768', coalesce(v_dims::text, '(无 typmod)');
  END IF;
END
$$;

-- 2d 重建 HNSW（参数与 embedding.json 的 index 段一致）。
CREATE INDEX IF NOT EXISTS wiki_summary_embedding_hnsw_idx
  ON public.wiki_summary USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

COMMENT ON COLUMN public.wiki_summary.embedding IS
  '768 维向量（docs/sql/embedding.json）；列必须带 typmod，否则 HNSW 拒绝建索引。';

-- 2e 断言：列有 typmod 且等于 768。这里失败说明有人手工把列改成了裸 vector，
--    后续 003/007 的 HNSW 会以 `column does not have dimensions` 形式晚一步炸。
DO $$
DECLARE
  v_dims integer;
BEGIN
  SELECT a.atttypmod INTO v_dims
    FROM pg_attribute a
   WHERE a.attrelid = 'public.wiki_summary'::regclass
     AND a.attname  = 'embedding';
  IF v_dims IS NULL OR v_dims < 0 THEN
    RAISE EXCEPTION '007: wiki_summary.embedding 没有 typmod（裸 vector），HNSW 无法建索引' USING ERRCODE = '22023';
  END IF;
  IF v_dims <> 768 THEN
    RAISE EXCEPTION '007: wiki_summary.embedding 维度是 %，契约要求 768', v_dims USING ERRCODE = '22023';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. search_materials：006 的语义原样保留，只把 1024 换成 768（006:57/74 的硬编码）。
--    维度断言：先按裸 vector 解析，再断言 vector_dims=768（不匹配抛 22023，
--    而不是让 pgvector 在 `<=>` 处抛晦涩的维度错误）。
--    租户不一致仍返回空集（防探测），不加新错误。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_materials(
  p_company_key text,
  p_query       text    DEFAULT NULL,
  p_filters     jsonb   DEFAULT '{}'::jsonb,
  p_limit       integer DEFAULT 20
) RETURNS TABLE (
  video_id     text,
  name         text,
  score        real,
  category2_id text,
  labels       text[],
  create_time  timestamptz,
  account_key  text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, extensions, pg_temp
SET statement_timeout = '30s'
AS $$
DECLARE
  v_session_tenant text := public.app_tenant_key();
  v_query    text  := nullif(btrim(coalesce(p_query, '')), '');
  v_filters  jsonb := CASE WHEN jsonb_typeof(p_filters) = 'object' THEN p_filters ELSE '{}'::jsonb END;
  v_limit    integer := greatest(1, least(coalesce(p_limit, 20), 100));
  v_labels   text[];
  v_vec      vector;               -- 裸 vector 只用于解析；断言后再参与运算
  v_dims     integer;
  v_has_vec  boolean := v_filters ? 'embedding';
BEGIN
  IF p_company_key IS NULL OR btrim(p_company_key) = '' THEN
    RAISE EXCEPTION 'search_materials: p_company_key is required' USING ERRCODE = '22023';
  END IF;

  -- 会话租户优先：调用方给不出别的租户（返回空集而不是报错，避免探测）。
  IF v_session_tenant IS NOT NULL AND v_session_tenant <> p_company_key THEN
    RETURN;
  END IF;

  IF v_filters ? 'labels' THEN
    v_labels := array(SELECT jsonb_array_elements_text(v_filters -> 'labels'));
  END IF;

  IF v_has_vec THEN
    BEGIN
      v_vec := (v_filters ->> 'embedding')::vector;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'search_materials: embedding 不是合法向量文本' USING ERRCODE = '22023';
    END;
    v_dims := vector_dims(v_vec);
    IF v_dims IS DISTINCT FROM 768 THEN
      RAISE EXCEPTION 'search_materials: embedding 维度是 %，契约要求 768', v_dims USING ERRCODE = '22023';
    END IF;
    -- 事务级：过滤条件与向量混用时，让 HNSW 继续扫到足够多的候选（commit/rollback 后自动失效）。
    PERFORM set_config('hnsw.iterative_scan', 'strict_order', true);

    RETURN QUERY
      SELECT m.video_id, m.name,
             (1 - (s.embedding <=> v_vec))::real AS score,
             m.category2_id, m.labels, m.create_time, m.account_key
        FROM material m
        JOIN wiki_summary s
          ON s.company_key = m.company_key AND s.video_id = m.video_id
       WHERE m.company_key = p_company_key                 -- [tenant]
         AND m.deleted_at IS NULL                          -- [live]
         AND s.embedding IS NOT NULL
         AND (v_query IS NULL OR m.name ILIKE '%' || v_query || '%')
         AND (v_filters ->> 'category1' IS NULL OR m.category1_id = v_filters ->> 'category1')
         AND (v_filters -> 'category2' IS NULL OR m.category2_id = ANY (array(SELECT jsonb_array_elements_text(v_filters -> 'category2'))))
         AND (v_filters -> 'video_types' IS NULL OR m.video_type = ANY ((array(SELECT jsonb_array_elements_text(v_filters -> 'video_types')))::smallint[]))
         AND (v_labels IS NULL OR m.labels && v_labels)
         AND (v_filters ->> 'min_duration_ms' IS NULL OR m.duration_ms >= (v_filters ->> 'min_duration_ms')::bigint)
         AND (v_filters ->> 'max_duration_ms' IS NULL OR m.duration_ms <= (v_filters ->> 'max_duration_ms')::bigint)
         AND (v_filters ->> 'created_from' IS NULL OR m.create_time >= (v_filters ->> 'created_from')::timestamptz)
         AND (v_filters ->> 'created_to' IS NULL OR m.create_time < (v_filters ->> 'created_to')::timestamptz + interval '1 day')
         AND (v_filters ->> 'account_key' IS NULL OR m.account_key = v_filters ->> 'account_key')
       ORDER BY s.embedding <=> v_vec, m.video_id
       LIMIT v_limit;
    RETURN;
  END IF;

  RETURN QUERY
    SELECT m.video_id, m.name,
           (CASE WHEN v_query IS NULL THEN 0::real
                 ELSE coalesce(similarity(m.name, v_query), 0)::real END) AS score,
           m.category2_id, m.labels, m.create_time, m.account_key
      FROM material m
     WHERE m.company_key = p_company_key                   -- [tenant]
       AND m.deleted_at IS NULL                            -- [live]
       AND (v_query IS NULL OR m.name ILIKE '%' || v_query || '%')
       AND (v_filters ->> 'category1' IS NULL OR m.category1_id = v_filters ->> 'category1')
       AND (v_filters -> 'category2' IS NULL OR m.category2_id = ANY (array(SELECT jsonb_array_elements_text(v_filters -> 'category2'))))
       AND (v_filters -> 'video_types' IS NULL OR m.video_type = ANY ((array(SELECT jsonb_array_elements_text(v_filters -> 'video_types')))::smallint[]))
       AND (v_labels IS NULL OR m.labels && v_labels)
       AND (v_filters ->> 'min_duration_ms' IS NULL OR m.duration_ms >= (v_filters ->> 'min_duration_ms')::bigint)
       AND (v_filters ->> 'max_duration_ms' IS NULL OR m.duration_ms <= (v_filters ->> 'max_duration_ms')::bigint)
       AND (v_filters ->> 'created_from' IS NULL OR m.create_time >= (v_filters ->> 'created_from')::timestamptz)
       AND (v_filters ->> 'created_to' IS NULL OR m.create_time < (v_filters ->> 'created_to')::timestamptz + interval '1 day')
       AND (v_filters ->> 'account_key' IS NULL OR m.account_key = v_filters ->> 'account_key')
     ORDER BY score DESC, m.create_time DESC NULLS LAST, m.video_id
     LIMIT v_limit;
END
$$;

COMMENT ON FUNCTION public.search_materials(text, text, jsonb, integer) IS
  '素材检索：租户 + 软删除硬过滤，关键词 ILIKE（trgm 索引），可选向量排序；向量维度定长 768，limit 上限 100。';

-- ---------------------------------------------------------------------------
-- 4. upsert_wiki_summary：保留 006 的语义（版本护栏、三件套同进同出），
--    维度改成 768 并加断言（006:142/160 的硬编码）。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.upsert_wiki_summary(p_company_key text, p_row jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions, pg_temp
SET statement_timeout = '30s'
AS $$
DECLARE
  v_session_tenant text := public.app_tenant_key();
  v_video  text := nullif(btrim(coalesce(p_row ->> 'video_id', '')), '');
  v_ver    text := coalesce(nullif(btrim(coalesce(p_row ->> 'analyzer_ver', '')), ''), 'v0');
  v_emb    vector;
  v_dims   integer;
BEGIN
  IF p_company_key IS NULL OR btrim(p_company_key) = '' THEN
    RAISE EXCEPTION 'upsert_wiki_summary: p_company_key is required' USING ERRCODE = '22023';
  END IF;
  IF v_session_tenant IS NOT NULL AND v_session_tenant <> p_company_key THEN
    RAISE EXCEPTION 'upsert_wiki_summary: tenant mismatch' USING ERRCODE = '42501';
  END IF;
  IF v_video IS NULL THEN
    RAISE EXCEPTION 'upsert_wiki_summary: video_id is required' USING ERRCODE = '22023';
  END IF;

  IF p_row ? 'embedding' AND jsonb_typeof(p_row -> 'embedding') <> 'null' THEN
    -- 向量三件套必须同时给（002 的 wiki_summary_embedding_complete 会兜底，这里给可读的错误）。
    IF nullif(btrim(coalesce(p_row ->> 'embedding_model', '')), '') IS NULL
       OR nullif(btrim(coalesce(p_row ->> 'embedding_ver', '')), '') IS NULL THEN
      RAISE EXCEPTION 'upsert_wiki_summary: embedding needs embedding_model and embedding_ver' USING ERRCODE = '23514';
    END IF;
    BEGIN
      v_emb := (p_row ->> 'embedding')::vector;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'upsert_wiki_summary: embedding 不是合法向量文本' USING ERRCODE = '22023';
    END;
    v_dims := vector_dims(v_emb);
    IF v_dims IS DISTINCT FROM 768 THEN
      RAISE EXCEPTION 'upsert_wiki_summary: embedding 维度是 %，契约要求 768', v_dims USING ERRCODE = '22023';
    END IF;
  END IF;

  INSERT INTO wiki_summary AS w (
    company_key, video_id, one_line, scenes, best_clip, risks, production, confidence, status,
    embedding, embedding_model, embedding_ver, analyzer_ver, updated_at
  ) VALUES (
    p_company_key,
    v_video,
    p_row ->> 'one_line',
    CASE WHEN jsonb_typeof(p_row -> 'scenes') = 'array' THEN p_row -> 'scenes' ELSE '[]'::jsonb END,
    p_row -> 'best_clip',
    CASE WHEN jsonb_typeof(p_row -> 'risks') = 'array'
         THEN array(SELECT jsonb_array_elements_text(p_row -> 'risks')) ELSE '{}'::text[] END,
    nullif(btrim(coalesce(p_row ->> 'production', '')), ''),
    nullif(btrim(coalesce(p_row ->> 'confidence', '')), '')::numeric,
    coalesce(nullif(btrim(coalesce(p_row ->> 'status', '')), ''), 'candidate'),
    v_emb,
    nullif(btrim(coalesce(p_row ->> 'embedding_model', '')), ''),
    nullif(btrim(coalesce(p_row ->> 'embedding_ver', '')), ''),
    v_ver,
    now()
  )
  ON CONFLICT (company_key, video_id) DO UPDATE SET
    one_line        = coalesce(excluded.one_line, w.one_line),
    scenes          = excluded.scenes,
    best_clip       = coalesce(excluded.best_clip, w.best_clip),
    risks           = excluded.risks,
    production      = coalesce(excluded.production, w.production),
    confidence      = coalesce(excluded.confidence, w.confidence),
    status          = excluded.status,
    embedding       = coalesce(excluded.embedding, w.embedding),
    embedding_model = coalesce(excluded.embedding_model, w.embedding_model),
    embedding_ver   = coalesce(excluded.embedding_ver, w.embedding_ver),
    analyzer_ver    = excluded.analyzer_ver,
    updated_at      = now()
  WHERE excluded.analyzer_ver >= w.analyzer_ver;   -- 旧版本不覆盖新版本
END
$$;

-- ---------------------------------------------------------------------------
-- 5. upsert_wiki_source：一轮分析的原始记录（markdown + 证据）。
--    主键 (company_key, video_id, analyzer_ver)：换模型版本不覆盖旧结果。
--    content_hash 由**调用方**给（模型/输入都不在这里计算），必须是 64 位小写 hex；
--    同一 (video_id, analyzer_ver) 内容哈希没变时整行不动（幂等，不刷新时间）。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.upsert_wiki_source(p_company_key text, p_row jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions, pg_temp
SET statement_timeout = '30s'
AS $$
DECLARE
  v_session_tenant text := public.app_tenant_key();
  v_video  text := nullif(btrim(coalesce(p_row ->> 'video_id', '')), '');
  v_ver    text := nullif(btrim(coalesce(p_row ->> 'analyzer_ver', '')), '');
  v_hash   text := lower(nullif(btrim(coalesce(p_row ->> 'content_hash', '')), ''));
BEGIN
  IF p_company_key IS NULL OR btrim(p_company_key) = '' THEN
    RAISE EXCEPTION 'upsert_wiki_source: p_company_key is required' USING ERRCODE = '22023';
  END IF;
  IF v_session_tenant IS NOT NULL AND v_session_tenant <> p_company_key THEN
    RAISE EXCEPTION 'upsert_wiki_source: tenant mismatch' USING ERRCODE = '42501';
  END IF;
  IF v_video IS NULL OR v_ver IS NULL THEN
    RAISE EXCEPTION 'upsert_wiki_source: video_id and analyzer_ver are required' USING ERRCODE = '22023';
  END IF;
  -- 契约：content_hash 必须是 sha256 的小写 hex，不接受前缀/大写/空串。
  IF v_hash IS NULL OR v_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'upsert_wiki_source: content_hash must be 64 lowercase hex' USING ERRCODE = '22023';
  END IF;

  INSERT INTO wiki_source AS ws (company_key, video_id, analyzer_ver, content_hash, video_md, evidence, created_at)
  VALUES (
    p_company_key,
    v_video,
    v_ver,
    v_hash,
    p_row ->> 'video_md',
    CASE WHEN jsonb_typeof(p_row -> 'evidence') = 'object' THEN p_row -> 'evidence' ELSE '{}'::jsonb END,
    now()
  )
  ON CONFLICT (company_key, video_id, analyzer_ver) DO UPDATE SET
    content_hash = excluded.content_hash,
    video_md     = coalesce(excluded.video_md, ws.video_md),
    evidence     = excluded.evidence
  WHERE ws.content_hash IS DISTINCT FROM excluded.content_hash;   -- 内容没变就整行不动
END
$$;

-- ---------------------------------------------------------------------------
-- 6. 三张新表：卡片 / 时间线 / 镜头。
--    预算是物理约束，不是口头约定（contract.json budgets）：
--      wiki_video    —— card only（字段就是卡片，正文类内容不进来）
--      wiki_timeline —— <= 20 rows（seq 0..19 由 CHECK 锁死）
--      wiki_shot     —— <= 200 tokens（caption 字符上限 200，按 CJK 最坏情况 1 字符/token 估）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wiki_video (
  company_key text        NOT NULL,
  video_id    text        NOT NULL,
  title       text,
  hook        text,
  audience    text,
  duration_ms bigint      CHECK (duration_ms IS NULL OR duration_ms >= 0),
  tags        text[]      NOT NULL DEFAULT '{}',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wiki_video_pk PRIMARY KEY (company_key, video_id),
  CONSTRAINT wiki_video_video_id_nonempty CHECK (length(video_id) > 0),
  CONSTRAINT wiki_video_title_len CHECK (title IS NULL OR length(title) <= 120),
  CONSTRAINT wiki_video_hook_len  CHECK (hook  IS NULL OR length(hook)  <= 200)
);

COMMENT ON TABLE wiki_video IS '素材卡片（card only，预算见 contract.budgets.wiki_video）：只放卡片字段，不放正文。';

CREATE TABLE IF NOT EXISTS wiki_timeline (
  company_key text    NOT NULL,
  video_id    text    NOT NULL,
  seq         integer NOT NULL,
  at_sec      numeric(12,3) NOT NULL,
  label       text,
  summary     text,
  CONSTRAINT wiki_timeline_pk PRIMARY KEY (company_key, video_id, seq),
  -- 行数预算：seq 只允许 0..19，等于“每个视频最多 20 行”，无需靠 RPC 自觉。
  CONSTRAINT wiki_timeline_seq_budget CHECK (seq >= 0 AND seq <= 19),
  CONSTRAINT wiki_timeline_at_nonneg CHECK (at_sec >= 0),
  CONSTRAINT wiki_timeline_label_len CHECK (label IS NULL OR length(label) <= 40),
  CONSTRAINT wiki_timeline_summary_len CHECK (summary IS NULL OR length(summary) <= 160)
);

COMMENT ON TABLE wiki_timeline IS '时间线（预算 <=20 行，CHECK seq 0..19）。RPC 再按区间过滤并 limit 20。';

CREATE TABLE IF NOT EXISTS wiki_shot (
  company_key text    NOT NULL,
  video_id    text    NOT NULL,
  shot_index  integer NOT NULL,
  at_sec      numeric(12,3),
  dur_sec     numeric(12,3),
  caption     text,
  ocr_text    text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wiki_shot_pk PRIMARY KEY (company_key, video_id, shot_index),
  CONSTRAINT wiki_shot_index_nonneg CHECK (shot_index >= 0),
  CONSTRAINT wiki_shot_at_nonneg  CHECK (at_sec  IS NULL OR at_sec  >= 0),
  CONSTRAINT wiki_shot_dur_nonneg CHECK (dur_sec IS NULL OR dur_sec >= 0),
  -- 存储预算：单镜头的可展示文本合计不超过 200 字符（RPC 的口径，见下）。
  CONSTRAINT wiki_shot_caption_len CHECK (caption  IS NULL OR length(caption)  <= 200),
  CONSTRAINT wiki_shot_ocr_len     CHECK (ocr_text IS NULL OR length(ocr_text) <= 200)
);

COMMENT ON TABLE wiki_shot IS '单个镜头（预算 <=200 tokens：RPC 输出按 200 字符截断，CJK 最坏情况 1 字符/token）。';

CREATE INDEX IF NOT EXISTS wiki_timeline_at_idx
  ON wiki_timeline (company_key, video_id, at_sec);

-- 新表一律进租户隔离（与 004/005 同一判据；函数体在 008 会被替换成三级回落）。
GRANT SELECT, INSERT, UPDATE, DELETE ON wiki_video, wiki_timeline, wiki_shot TO orange_app;

ALTER TABLE wiki_video    ENABLE ROW LEVEL SECURITY;
ALTER TABLE wiki_video    FORCE  ROW LEVEL SECURITY;
ALTER TABLE wiki_timeline ENABLE ROW LEVEL SECURITY;
ALTER TABLE wiki_timeline FORCE  ROW LEVEL SECURITY;
ALTER TABLE wiki_shot     ENABLE ROW LEVEL SECURITY;
ALTER TABLE wiki_shot     FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wiki_video_tenant ON wiki_video;
CREATE POLICY wiki_video_tenant ON wiki_video
  USING (company_key = public.app_tenant_key())
  WITH CHECK (company_key = public.app_tenant_key());

DROP POLICY IF EXISTS wiki_timeline_tenant ON wiki_timeline;
CREATE POLICY wiki_timeline_tenant ON wiki_timeline
  USING (company_key = public.app_tenant_key())
  WITH CHECK (company_key = public.app_tenant_key());

DROP POLICY IF EXISTS wiki_shot_tenant ON wiki_shot;
CREATE POLICY wiki_shot_tenant ON wiki_shot
  USING (company_key = public.app_tenant_key())
  WITH CHECK (company_key = public.app_tenant_key());

-- ---------------------------------------------------------------------------
-- 7. 三个读 RPC（contract.rpc）。
--    只读函数：租户不一致返回“空集语义”（NULL / [] / NULL），不抛错——与 006
--    检索侧一致，避免用报错差异探测别的租户是否存在。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wiki_video(p_company_key text, p_video_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, extensions, pg_temp
SET statement_timeout = '30s'
AS $$
DECLARE
  v_session_tenant text := public.app_tenant_key();
  v_video text := nullif(btrim(coalesce(p_video_id, '')), '');
  v_card  jsonb;
BEGIN
  IF p_company_key IS NULL OR btrim(p_company_key) = '' THEN
    RAISE EXCEPTION 'wiki_video: p_company_key is required' USING ERRCODE = '22023';
  END IF;
  IF v_video IS NULL THEN
    RAISE EXCEPTION 'wiki_video: p_video_id is required' USING ERRCODE = '22023';
  END IF;
  IF v_session_tenant IS NOT NULL AND v_session_tenant <> p_company_key THEN
    RETURN NULL;
  END IF;

  -- card only：只挑卡片字段，不返回 video_md / body_md 之类的正文。
  SELECT jsonb_build_object(
           'videoId',       m.video_id,
           'name',          m.name,
           'durationMs',    m.duration_ms,
           'labels',        m.labels,
           'category2Id',   m.category2_id,
           'title',         wv.title,
           'hook',          wv.hook,
           'oneLine',       s.one_line,
           'status',        s.status,
           'confidence',    s.confidence,
           'risks',         s.risks,
           'shotCount',     (SELECT count(*) FROM wiki_shot     sh WHERE sh.company_key = m.company_key AND sh.video_id = m.video_id),
           'timelineCount', (SELECT count(*) FROM wiki_timeline tl WHERE tl.company_key = m.company_key AND tl.video_id = m.video_id),
           'updatedAt',     coalesce(wv.updated_at, s.updated_at)
         )
    INTO v_card
    FROM material m
    LEFT JOIN wiki_summary s
      ON s.company_key = m.company_key AND s.video_id = m.video_id
    LEFT JOIN wiki_video wv
      ON wv.company_key = m.company_key AND wv.video_id = m.video_id
   WHERE m.company_key = p_company_key            -- [tenant]
     AND m.video_id    = v_video
     AND m.deleted_at IS NULL;                    -- [live]

  RETURN v_card;   -- NULL = 没有这条素材（调用方按“不存在”处理）
END
$$;

COMMENT ON FUNCTION public.wiki_video(text, text) IS
  '素材卡片（card only）：元数据 + 一句话结论 + 计数；无此素材（或跨租户）返回 NULL。';

CREATE OR REPLACE FUNCTION public.wiki_timeline(
  p_company_key text,
  p_video_id    text,
  p_from        numeric DEFAULT NULL,
  p_to          numeric DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, extensions, pg_temp
SET statement_timeout = '30s'
AS $$
DECLARE
  v_session_tenant text := public.app_tenant_key();
  v_video text := nullif(btrim(coalesce(p_video_id, '')), '');
  v_out   jsonb;
BEGIN
  IF p_company_key IS NULL OR btrim(p_company_key) = '' THEN
    RAISE EXCEPTION 'wiki_timeline: p_company_key is required' USING ERRCODE = '22023';
  END IF;
  IF v_video IS NULL THEN
    RAISE EXCEPTION 'wiki_timeline: p_video_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_from > p_to THEN
    RAISE EXCEPTION 'wiki_timeline: p_from > p_to' USING ERRCODE = '22023';
  END IF;
  IF v_session_tenant IS NOT NULL AND v_session_tenant <> p_company_key THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'seq',     x.seq,
           'atSec',   x.at_sec,
           'label',   x.label,
           'summary', x.summary
         ) ORDER BY x.at_sec, x.seq), '[]'::jsonb)
    INTO v_out
    FROM (
      SELECT tl.seq, tl.at_sec, tl.label, tl.summary
        FROM wiki_timeline tl
       WHERE tl.company_key = p_company_key                      -- [tenant]
         AND tl.video_id    = v_video
         AND (p_from IS NULL OR tl.at_sec >= p_from)
         AND (p_to   IS NULL OR tl.at_sec <= p_to)
       ORDER BY tl.at_sec, tl.seq
       LIMIT 20                                                  -- [budget] <=20 rows
    ) x;

  RETURN coalesce(v_out, '[]'::jsonb);
END
$$;

COMMENT ON FUNCTION public.wiki_timeline(text, text, numeric, numeric) IS
  '时间线区间查询（<=20 行）：按 at_sec 区间过滤，跨租户返回 []。';

CREATE OR REPLACE FUNCTION public.wiki_shot(p_company_key text, p_video_id text, p_index integer)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, extensions, pg_temp
SET statement_timeout = '30s'
AS $$
DECLARE
  v_session_tenant text := public.app_tenant_key();
  v_video text := nullif(btrim(coalesce(p_video_id, '')), '');
  v_out   jsonb;
BEGIN
  IF p_company_key IS NULL OR btrim(p_company_key) = '' THEN
    RAISE EXCEPTION 'wiki_shot: p_company_key is required' USING ERRCODE = '22023';
  END IF;
  IF v_video IS NULL THEN
    RAISE EXCEPTION 'wiki_shot: p_video_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_index IS NULL OR p_index < 0 THEN
    RAISE EXCEPTION 'wiki_shot: p_index must be >= 0' USING ERRCODE = '22023';
  END IF;
  IF v_session_tenant IS NOT NULL AND v_session_tenant <> p_company_key THEN
    RETURN NULL;
  END IF;

  -- 预算 <=200 tokens：caption 140 字符 + ocr 60 字符 = 200 字符（CJK 最坏情况 1 字符/token）。
  SELECT jsonb_build_object(
           'videoId',   sh.video_id,
           'shotIndex', sh.shot_index,
           'atSec',     sh.at_sec,
           'durSec',    sh.dur_sec,
           'caption',   left(coalesce(sh.caption, ''), 140),
           'ocrText',   left(coalesce(sh.ocr_text, ''), 60)
         )
    INTO v_out
    FROM wiki_shot sh
   WHERE sh.company_key = p_company_key                         -- [tenant]
     AND sh.video_id    = v_video
     AND sh.shot_index  = p_index;

  RETURN v_out;
END
$$;

COMMENT ON FUNCTION public.wiki_shot(text, text, integer) IS
  '单镜头（<=200 tokens）：caption/ocr 截断到 140/60 字符；无此镜头（或跨租户）返回 NULL。';

-- ---------------------------------------------------------------------------
-- 8. 权限：只在 007 内新建的对象上补 orange_app；authenticated / service_role
--    的同步在 008 做（008 会遍历 public 下的全部表与函数，见那里的 DO 循环）。
-- ---------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.app_tenant_key() TO orange_app;
GRANT EXECUTE ON FUNCTION public.search_materials(text, text, jsonb, integer) TO orange_app;
GRANT EXECUTE ON FUNCTION public.upsert_wiki_summary(text, jsonb) TO orange_app;
GRANT EXECUTE ON FUNCTION public.upsert_wiki_source(text, jsonb) TO orange_app;
GRANT EXECUTE ON FUNCTION public.wiki_video(text, text) TO orange_app;
GRANT EXECUTE ON FUNCTION public.wiki_timeline(text, text, numeric, numeric) TO orange_app;
GRANT EXECUTE ON FUNCTION public.wiki_shot(text, text, integer) TO orange_app;

-- 断言：向量列已定长 768、HNSW 在、新表在（失败信息直接指向要查的地方）。
DO $$
DECLARE
  v_dims integer;
BEGIN
  SELECT a.atttypmod INTO v_dims
    FROM pg_attribute a
   WHERE a.attrelid = 'public.wiki_summary'::regclass AND a.attname = 'embedding';
  IF v_dims <> 768 THEN
    RAISE EXCEPTION '007: 收尾断言失败，embedding typmod=%', v_dims;
  END IF;
  IF to_regclass('public.wiki_summary_embedding_hnsw_idx') IS NULL THEN
    RAISE EXCEPTION '007: 收尾断言失败，HNSW 索引缺失';
  END IF;
  IF to_regclass('public.wiki_video') IS NULL
     OR to_regclass('public.wiki_timeline') IS NULL
     OR to_regclass('public.wiki_shot') IS NULL THEN
    RAISE EXCEPTION '007: 收尾断言失败，wiki_video/wiki_timeline/wiki_shot 缺表';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('upsert_wiki_source', 'wiki_video', 'wiki_timeline', 'wiki_shot')) <> 4 THEN
    RAISE EXCEPTION '007: 收尾断言失败，四个 RPC 不全';
  END IF;
END
$$;
