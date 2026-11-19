-- 006 检索与写入 RPC（四个 + 三个兼容别名）。
--
-- 纪律（三条，缺一不可）：
--   1. `security invoker`：函数以**调用者**身份执行，RLS 因此照常生效（superuser 调用时才靠显式 company_key 过滤）。
--   2. 租户只能来自会话：`app.company_key` 已设置且与 `p_company_key` 不一致时——
--      检索返回**空集**（不报错、不泄露"另一个租户存在"），写入抛 `42501`。
--      换句话说：调用方无法用参数把租户"覆盖"成别的值。
--   3. `set search_path = public, pg_temp`：防 search_path 劫持。
--
-- 幂等：CREATE OR REPLACE FUNCTION；加列的 ALTER 用 IF NOT EXISTS。

-- ---------------------------------------------------------------------------
-- 版本列：upsert 的"旧版本不得覆盖新版本"需要每张表都记 analyzer_ver。
-- wiki_source 在 002 已有；这里给另外三张补上（默认 'v0'，任何真实版本都 >= 'v0'）。
-- 约定：analyzer_ver 必须是**可字典序比较**的字符串（如 a1.0 / a1.10 / a2.0，补零对齐）。
-- ---------------------------------------------------------------------------
ALTER TABLE wiki_summary ADD COLUMN IF NOT EXISTS analyzer_ver text NOT NULL DEFAULT 'v0';
ALTER TABLE wiki_entity  ADD COLUMN IF NOT EXISTS analyzer_ver text NOT NULL DEFAULT 'v0';
ALTER TABLE wiki_event   ADD COLUMN IF NOT EXISTS analyzer_ver text;

COMMENT ON COLUMN wiki_summary.analyzer_ver IS '产出该行的分析器版本；upsert 时旧版本不得覆盖新版本。';
COMMENT ON COLUMN wiki_entity.analyzer_ver  IS '产出该行的分析器版本；upsert 时旧版本不得覆盖新版本。';

-- ---------------------------------------------------------------------------
-- search_materials：素材检索。
--   * 租户与软删除是**硬条件**（见下方 [tenant] / [live] 两行），任何过滤组合都绕不过去。
--   * 关键词用 ILIKE，走 003 的 material_name_trgm_idx。
--   * p_filters['embedding'] 存在时改走向量排序（join wiki_summary），并打开
--     hnsw.iterative_scan=strict_order（事务级）。pgvector < 0.8 会忽略这个设置而不是报错，
--     详见 docs/sql/README.md「向量检索与旧版本回退」。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_materials(
  p_company_key text,
  p_query       text    DEFAULT NULL,
  p_filters     jsonb   DEFAULT '{}'::jsonb,
  p_limit       integer DEFAULT 20
) RETURNS TABLE (
  video_id    text,
  name        text,
  score       real,
  category2_id text,
  labels      text[],
  create_time timestamptz,
  account_key text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session_tenant text := nullif(current_setting('app.company_key', true), '');
  v_query    text  := nullif(btrim(coalesce(p_query, '')), '');
  v_filters  jsonb := CASE WHEN jsonb_typeof(p_filters) = 'object' THEN p_filters ELSE '{}'::jsonb END;
  v_limit    integer := greatest(1, least(coalesce(p_limit, 20), 100));
  v_labels   text[];
  v_vec      vector(1024);
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
    v_vec := (v_filters ->> 'embedding')::vector(1024);
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
  '素材检索：租户 + 软删除硬过滤，关键词 ILIKE（trgm 索引），可选向量排序；limit 上限 100。';

-- ---------------------------------------------------------------------------
-- upsert_wiki_summary：按 (company_key, video_id) 幂等；analyzer_ver 旧版本不覆盖新版本。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.upsert_wiki_summary(p_company_key text, p_row jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session_tenant text := nullif(current_setting('app.company_key', true), '');
  v_video  text := nullif(btrim(coalesce(p_row ->> 'video_id', '')), '');
  v_ver    text := coalesce(nullif(btrim(coalesce(p_row ->> 'analyzer_ver', '')), ''), 'v0');
  v_emb    vector(1024);
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

  IF p_row ? 'embedding' THEN
    -- 向量三件套必须同时给（002 的 wiki_summary_embedding_complete 会兜底，这里给可读的错误）。
    IF nullif(btrim(coalesce(p_row ->> 'embedding_model', '')), '') IS NULL
       OR nullif(btrim(coalesce(p_row ->> 'embedding_ver', '')), '') IS NULL THEN
      RAISE EXCEPTION 'upsert_wiki_summary: embedding needs embedding_model and embedding_ver' USING ERRCODE = '23514';
    END IF;
    v_emb := (p_row ->> 'embedding')::vector(1024);
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
-- upsert_wiki_entity：按 (company_key, entity_id) 幂等；analyzer_ver 参与版本比较。
-- 注意 (company_key, kind, slug) 另有唯一约束：同一 slug 换了 entity_id 会撞唯一键，
-- 这是有意的（slug 是给人读的稳定标识），调用方应先按 (kind, slug) 查再决定 entity_id。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.upsert_wiki_entity(p_company_key text, p_row jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session_tenant text := nullif(current_setting('app.company_key', true), '');
  v_entity text := nullif(btrim(coalesce(p_row ->> 'entity_id', '')), '');
  v_kind   text := nullif(btrim(coalesce(p_row ->> 'kind', '')), '');
  v_slug   text := nullif(btrim(coalesce(p_row ->> 'slug', '')), '');
  v_ver    text := coalesce(nullif(btrim(coalesce(p_row ->> 'analyzer_ver', '')), ''), 'v0');
BEGIN
  IF p_company_key IS NULL OR btrim(p_company_key) = '' THEN
    RAISE EXCEPTION 'upsert_wiki_entity: p_company_key is required' USING ERRCODE = '22023';
  END IF;
  IF v_session_tenant IS NOT NULL AND v_session_tenant <> p_company_key THEN
    RAISE EXCEPTION 'upsert_wiki_entity: tenant mismatch' USING ERRCODE = '42501';
  END IF;
  IF v_entity IS NULL OR v_kind IS NULL OR v_slug IS NULL THEN
    RAISE EXCEPTION 'upsert_wiki_entity: entity_id, kind and slug are required' USING ERRCODE = '22023';
  END IF;

  INSERT INTO wiki_entity AS e (
    company_key, entity_id, kind, slug, title, body_md, tags, sources, confidence, status, analyzer_ver, last_updated
  ) VALUES (
    p_company_key, v_entity, v_kind, v_slug,
    p_row ->> 'title',
    p_row ->> 'body_md',
    CASE WHEN jsonb_typeof(p_row -> 'tags') = 'array'
         THEN array(SELECT jsonb_array_elements_text(p_row -> 'tags')) ELSE '{}'::text[] END,
    CASE WHEN jsonb_typeof(p_row -> 'sources') = 'array'
         THEN array(SELECT jsonb_array_elements_text(p_row -> 'sources')) ELSE '{}'::text[] END,
    nullif(btrim(coalesce(p_row ->> 'confidence', '')), '')::numeric,
    coalesce(nullif(btrim(coalesce(p_row ->> 'status', '')), ''), 'active'),
    v_ver,
    now()
  )
  ON CONFLICT (company_key, entity_id) DO UPDATE SET
    kind         = excluded.kind,
    slug         = excluded.slug,
    title        = coalesce(excluded.title, e.title),
    body_md      = coalesce(excluded.body_md, e.body_md),
    tags         = excluded.tags,
    sources      = excluded.sources,
    confidence   = coalesce(excluded.confidence, e.confidence),
    status       = excluded.status,
    analyzer_ver = excluded.analyzer_ver,
    last_updated = now()
  WHERE excluded.analyzer_ver >= e.analyzer_ver;   -- 旧版本不覆盖新版本
END
$$;

-- ---------------------------------------------------------------------------
-- record_wiki_event：追加型，event_id 是幂等键；重复投递直接忽略（不更新）。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_wiki_event(p_company_key text, p_row jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session_tenant text := nullif(current_setting('app.company_key', true), '');
  v_event text := nullif(btrim(coalesce(p_row ->> 'event_id', '')), '');
  v_kind  text := nullif(btrim(coalesce(p_row ->> 'kind', '')), '');
BEGIN
  IF p_company_key IS NULL OR btrim(p_company_key) = '' THEN
    RAISE EXCEPTION 'record_wiki_event: p_company_key is required' USING ERRCODE = '22023';
  END IF;
  IF v_session_tenant IS NOT NULL AND v_session_tenant <> p_company_key THEN
    RAISE EXCEPTION 'record_wiki_event: tenant mismatch' USING ERRCODE = '42501';
  END IF;
  IF v_event IS NULL OR v_kind IS NULL THEN
    RAISE EXCEPTION 'record_wiki_event: event_id and kind are required' USING ERRCODE = '22023';
  END IF;

  INSERT INTO wiki_event AS ev (company_key, event_id, video_id, kind, at, payload, analyzer_ver)
  VALUES (
    p_company_key, v_event,
    nullif(btrim(coalesce(p_row ->> 'video_id', '')), ''),
    v_kind,
    coalesce(nullif(btrim(coalesce(p_row ->> 'at', '')), '')::timestamptz, now()),
    CASE WHEN jsonb_typeof(p_row -> 'payload') = 'object' THEN p_row -> 'payload' ELSE '{}'::jsonb END,
    nullif(btrim(coalesce(p_row ->> 'analyzer_ver', '')), '')
  )
  ON CONFLICT (company_key, event_id) DO NOTHING;
END
$$;

-- ---------------------------------------------------------------------------
-- 兼容别名：`apps/api` 的 client 调的是 upsert_wiki_summary / upsert_wiki_entity /
-- record_wiki_event（见 src/index/client.ts）；任务书里用的短名也保留，二者同一实现。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.upsert_summary(p_company_key text, p_row jsonb)
RETURNS void LANGUAGE sql SECURITY INVOKER SET search_path = public, pg_temp
AS $$ SELECT public.upsert_wiki_summary(p_company_key, p_row) $$;

CREATE OR REPLACE FUNCTION public.upsert_entity(p_company_key text, p_row jsonb)
RETURNS void LANGUAGE sql SECURITY INVOKER SET search_path = public, pg_temp
AS $$ SELECT public.upsert_wiki_entity(p_company_key, p_row) $$;

CREATE OR REPLACE FUNCTION public.record_event(p_company_key text, p_row jsonb)
RETURNS void LANGUAGE sql SECURITY INVOKER SET search_path = public, pg_temp
AS $$ SELECT public.record_wiki_event(p_company_key, p_row) $$;

-- ---------------------------------------------------------------------------
-- 权限：只给应用角色执行权；函数是 invoker，表权限仍由 004/005 的 GRANT + RLS 决定。
-- ---------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.search_materials(text, text, jsonb, integer) TO orange_app;
GRANT EXECUTE ON FUNCTION public.upsert_wiki_summary(text, jsonb) TO orange_app;
GRANT EXECUTE ON FUNCTION public.upsert_wiki_entity(text, jsonb) TO orange_app;
GRANT EXECUTE ON FUNCTION public.record_wiki_event(text, jsonb) TO orange_app;
GRANT EXECUTE ON FUNCTION public.upsert_summary(text, jsonb) TO orange_app;
GRANT EXECUTE ON FUNCTION public.upsert_entity(text, jsonb) TO orange_app;
GRANT EXECUTE ON FUNCTION public.record_event(text, jsonb) TO orange_app;
