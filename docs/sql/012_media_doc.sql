-- 012 统一检索的派生索引层：素材级文档（gran='asset'）与镜头级文档（gran='shot'）同表共存。
--
-- 为什么是"一张派生表"而不是把 wiki_summary 撑大（见 docs/execution/2026-11-17-retrieval/analysis.md §2.4/§3.1）：
--   * wiki_summary 的 analyzer_ver **不在主键里**（002:76），"当前版本"靠**文本比较**裁决（007:288-300），
--     `'qwen-vl-shots-1' > 'analyze-runner-2'` 是字典序伪序（`'analyze-runner-10' < 'analyze-runner-9'` 同理）：
--     逐镜头结果一旦写进去，卡片的 scenes/risks/status 会被整行覆盖。
--   * 这里把 analyzer_ver 放进主键：换模型/换提示词不覆盖旧答案，"新旧"只由 created_at 裁决。
--   * 粒度是**行属性**，不是表属性：云语料只有卡片（没有字节），工程视频有镜头 —— 二者同表同一条 RPC。
--
-- 契约（同批更新，别只改这里）：
--   * docs/sql/contract.json —— tables.media_doc（主键/租户列/向量列）与 rpc.upsert_media_doc / rpc.media_search；
--   * docs/contracts/media-doc.schema.json —— 写入行与检索返回行的列约定；
--   * packages/orangefilm/src/index-client.mjs —— RPC_NAMES（apps/api/src/index/client.test.ts 双向比对）；
--   * docs/sql/README.md —— 迁移表。
--
-- 三件**不写进库**的事（写进来就是第二份真相）：
--   1. "本地有没有这些字节"：内容库有 2 GB 预算与 LRU 淘汰（material-media-cache.mjs:439-467），
--      Saved 库还有第二套命名（materials-proxy.mjs:357-390）—— 任何 is_local 列两小时内就会变成谎言。
--      可用性由客户端按 `md5Of(videoId)` + `contentStore.has(md5)` 在返回前补。
--   2. 维度：只认 docs/sql/embedding.json（dims=768），本文件不引入第二个常量来源。
--   3. score / rank：只在查询时算，不落库（落库就等于给排序做了一份会过期的缓存）。
--
-- 幂等：CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / DROP POLICY IF EXISTS 后重建 /
--       CREATE OR REPLACE FUNCTION；第二轮执行是 no-op。

-- ---------------------------------------------------------------------------
-- 0. 前置断言：顺序（001→012 不能换）、扩展、角色。
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.material') IS NULL THEN
    RAISE EXCEPTION '012: 缺少 public.material，请先按顺序跑 002';
  END IF;
  IF to_regprocedure('public.tenant_key_required()') IS NULL THEN
    RAISE EXCEPTION '012: 缺少 public.tenant_key_required()，请先跑 010（租户策略只认这个严格判据）';
  END IF;
  -- pg_trgm 是词法分支（`text % query` / ILIKE）与 003 的 gin_trgm_ops 索引的共同前提。
  -- 001 已把它写进硬依赖；这里再断言一次，避免"扩展被人删掉后 012 留一个半残分支"。
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    RAISE EXCEPTION '012: 缺少 pg_trgm 扩展（003 的 gin_trgm_ops 索引也依赖它），请先跑 001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'orange_app') THEN
    RAISE EXCEPTION '012: 缺少 authenticated / service_role / orange_app 角色，请先跑 004/008';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 1. 表 media_doc：一行 = 一个"可检索文档" = (素材|镜头) × analyzer_ver。
--
--    主键 (company_key, media_key, analyzer_ver)：
--      * company_key 在最左（与 002/003/005 同一口径，RLS 与所有过滤都从它开始）；
--      * media_key 是跨同步、跨重分析、跨导入都稳定的身份：云素材=video_id，工程视频=内容摘要（sha256:<hex>）；
--      * analyzer_ver 进主键 = 版本不覆盖（这是 wiki_summary 缺的那一条，见文件头）。
--    粒度相关的形状由 CHECK 兜：素材级没有镜头号，镜头级必须有 —— 让"两种粒度同表"这件事在库里自解释。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.media_doc (
  company_key   text        NOT NULL,
  media_key     text        NOT NULL,
  analyzer_ver  text        NOT NULL,
  gran          text        NOT NULL CHECK (gran IN ('asset', 'shot')),
  video_id      text,
  shot_index    integer,
  name          text,
  batch         text,
  product       text,
  gname         text,
  labels        text[]      NOT NULL DEFAULT '{}',
  duration_ms   integer,
  author        text,
  source_kind   text        NOT NULL CHECK (source_kind IN ('cloud', 'project')),
  text          text        NOT NULL,
  embedding_ver text,
  embedding     vector(768),
  superseded_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_doc_pk PRIMARY KEY (company_key, media_key, analyzer_ver),
  CONSTRAINT media_doc_media_key_nonempty CHECK (length(media_key) > 0),
  CONSTRAINT media_doc_analyzer_ver_nonempty CHECK (length(analyzer_ver) > 0),
  CONSTRAINT media_doc_text_nonempty CHECK (length(btrim(text)) > 0),
  CONSTRAINT media_doc_duration_nonneg CHECK (duration_ms IS NULL OR duration_ms >= 0),
  -- 粒度决定形状：asset 行没有镜头号；shot 行的镜头号非负。
  CONSTRAINT media_doc_gran_shape CHECK (
    (gran = 'asset' AND shot_index IS NULL)
    OR (gran = 'shot' AND shot_index IS NOT NULL AND shot_index >= 0)
  )
);

COMMENT ON TABLE public.media_doc IS
  '统一检索的派生索引层：素材级(asset)与镜头级(shot)同表，版本进主键；向量是可丢弃的导数，正文(text)是重算依据。';
COMMENT ON COLUMN public.media_doc.media_key IS
  '稳定身份：云素材=供应商 video_id；工程视频=内容摘要 sha256:<hex>（无云 id，见 analyze-runner.mjs:93-100）。';
COMMENT ON COLUMN public.media_doc.analyzer_ver IS
  '产出这批文档的管线/模型版本（如 card-meta-1 / analyze-runner-N / qwen-vl-shots-1）。进主键：换版本不覆盖旧答案。';
COMMENT ON COLUMN public.media_doc.gran IS
  '可检索单元粒度：asset=整条素材的卡片文本；shot=某个镜头（shot_index 必填）。跨粒度余弦不可比，故分索引。';
COMMENT ON COLUMN public.media_doc.shot_index IS
  '镜头序号（>=0，按时间顺序）；gran=asset 时必须为 NULL（CHECK media_doc_gran_shape）。';
COMMENT ON COLUMN public.media_doc.gname IS
  '名称解析出的分组（material-index.mjs:159-244 的第三层：批次 → 产品 → 分组）。';
COMMENT ON COLUMN public.media_doc.source_kind IS
  '语料来源：cloud=云管家素材；project=工程视频（本地字节，唯一标识是内容摘要）。';
COMMENT ON COLUMN public.media_doc.text IS
  '被向量化的原文（可重算向量的唯一依据）。正文变了就是要重算向量，不许留着旧向量冒充当前答案。';
COMMENT ON COLUMN public.media_doc.embedding_ver IS
  '嵌入模型+版本（如 nomic-embed-text-v1.5@768）。不再冒充管线版本（analyze-runner.mjs:295 的老问题）。';
COMMENT ON COLUMN public.media_doc.embedding IS
  '768 维向量（docs/sql/embedding.json）。列必须带 typmod，否则 HNSW 拒绝建索引（007:9-13 同理）。';
COMMENT ON COLUMN public.media_doc.superseded_at IS
  '同一 media_key **同一 gran** 内有更新的（created_at 更晚的）analyzer_ver 落地时写下；写的同时把 embedding 置空（正文保留可重算）。';

-- ---------------------------------------------------------------------------
-- 2. 索引。
--
--    向量侧：两条**部分 HNSW**（不是 ivfflat）。
--      * 写入是涓流（一次分析一行）：HNSW 增量插入即可；ivfflat 的 lists 要 ANALYZE + 全量重建才准；
--      * 查询永远带过滤（租户 + 批次 + 时长），过滤到 <1% 时 ivfflat 的候选会挤在少数 list 上、recall 塌方；
--        HNSW 有 hnsw.iterative_scan（pgvector >= 0.8，001:17-19 已写成硬前提，007:169 已在用）；
--      * 跨粒度余弦不可比（镜头文本天然更具体），所以 asset / shot 各一条，只在同类里混排；
--      * 只索引 superseded_at IS NULL 的行：索引体积恒等于"当前答案"的规模，旧版本不进索引。
--      **注意（实现约束，不是风格）**：部分索引只在查询谓词能蕴含索引谓词时才会被选中。
--      所以 media_search 的向量分支按 gran **拆成两条 CTE**，各自写死 `gran = 'asset'` / `'shot'`；
--      把 gran 当普通过滤条件写在同一个 CTE 里 = 两条 HNSW 都用不上。
--
--    过滤侧：B-tree 的 company_key 在最左；labels 用 GIN。全部是普通索引（不加谓词）：
--    过滤之后还要靠 superseded_at 判活，谓词留给规划器自己挑。
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS media_doc_asset_vec_idx ON public.media_doc
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)
  WHERE gran = 'asset' AND superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS media_doc_shot_vec_idx ON public.media_doc
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)
  WHERE gran = 'shot' AND superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS media_doc_batch_idx   ON public.media_doc (company_key, batch);
CREATE INDEX IF NOT EXISTS media_doc_product_idx ON public.media_doc (company_key, product);
CREATE INDEX IF NOT EXISTS media_doc_gname_idx   ON public.media_doc (company_key, gname);
CREATE INDEX IF NOT EXISTS media_doc_labels_gin  ON public.media_doc USING gin (labels);

-- 词法分支的支撑（题述索引清单之外的一条，理由写在这里，删不删只需要看这一句）：
-- `text % query` 与 `text ILIKE '%query%'` 没有这条 GIN 就是 78k 行顺序扫描 + 逐行 trigram
-- （analysis.md §4.5 把 trigram 当成"无嵌入端点时的兜底"，兜底本身慢就没有意义）。
-- 部分索引：只覆盖活行；旧版本被 superseded 后自动从索引里消失。
CREATE INDEX IF NOT EXISTS media_doc_text_trgm_idx ON public.media_doc
  USING gin (text gin_trgm_ops) WHERE superseded_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3. 租户隔离与权限：沿用 010 之后的统一判据（策略用严格版 tenant_key_required()，
--    没有租户上下文 → 42501 fail closed，不是静默 0 行）。
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.media_doc
  TO orange_app, authenticated, service_role;
REVOKE ALL ON public.media_doc FROM anon;

ALTER TABLE public.media_doc ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_doc FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS media_doc_tenant ON public.media_doc;
CREATE POLICY media_doc_tenant ON public.media_doc
  USING      (company_key = public.tenant_key_required())
  WITH CHECK (company_key = public.tenant_key_required());

-- ---------------------------------------------------------------------------
-- 4. upsert_media_doc(p_row jsonb)：一条写入通道，一行一个事务往返。
--    租户**不走参数**：从会话解（tenant_key_required），因此 p_row 里塞 company_key 毫无作用
--    （客户端也拿不到别的租户的 token，见 index-client.mjs 的租户说明）。
--
--    必填：media_key / gran / text，缺或空 → 22023。
--    幂等：text 与 embedding_ver 都没变 → 整行不动，**不刷新 updated_at**（同 007:351 的口径）。
--    新旧：同一 media_key、**同一 gran** 内有更新的 analyzer_ver 落地时，把更旧的行 superseded_at = now()
--          并**清空向量**；"新旧"只按 created_at 比较，版本字符串只做记录（不参与任何判断）。
--          不做跨 gran 取代：asset 行与 shot 行是同一条素材的两种答案，不是彼此的替代品（见函数体内的注释）。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.upsert_media_doc(p_row jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions, pg_temp
SET statement_timeout = '30s'
AS $$
DECLARE
  v_company    text := public.tenant_key_required();   -- 无租户上下文 → 42501 tenant-context-required
  v_media      text := nullif(btrim(coalesce(p_row ->> 'media_key', '')), '');
  v_gran       text := nullif(btrim(coalesce(p_row ->> 'gran', '')), '');
  v_text       text := nullif(btrim(coalesce(p_row ->> 'text', '')), '');
  v_ver        text := coalesce(nullif(btrim(coalesce(p_row ->> 'analyzer_ver', '')), ''), 'v0');
  v_emb_ver    text := nullif(btrim(coalesce(p_row ->> 'embedding_ver', '')), '');
  v_kind       text := nullif(btrim(coalesce(p_row ->> 'source_kind', '')), '');
  v_video      text := nullif(btrim(coalesce(p_row ->> 'video_id', '')), '');
  v_shot       integer;
  v_dur        integer;
  v_labels     text[];
  v_emb        vector;
  v_dims       integer;
  v_now        timestamptz := clock_timestamp();      -- now() 在一个事务里是常量：同一批写入会并列
  v_created    timestamptz;
  v_written    integer := 0;
  v_superseded integer := 0;
  v_old_vers   text[];
BEGIN
  IF p_row IS NULL OR jsonb_typeof(p_row) <> 'object' THEN
    RAISE EXCEPTION 'upsert_media_doc: p_row must be a jsonb object' USING ERRCODE = '22023';
  END IF;
  IF v_media IS NULL THEN
    RAISE EXCEPTION 'upsert_media_doc: media_key is required' USING ERRCODE = '22023';
  END IF;
  IF v_gran IS NULL OR v_gran NOT IN ('asset', 'shot') THEN
    RAISE EXCEPTION 'upsert_media_doc: gran must be asset or shot (got %)', coalesce(v_gran, 'null')
      USING ERRCODE = '22023';
  END IF;
  IF v_text IS NULL THEN
    RAISE EXCEPTION 'upsert_media_doc: text is required' USING ERRCODE = '22023';
  END IF;

  -- 粒度形状：镜头行必须给 shot_index；素材行不允许带（表上 CHECK 兜底，这里给可读的错误）。
  IF v_gran = 'shot' THEN
    IF jsonb_typeof(p_row -> 'shot_index') IS NULL OR jsonb_typeof(p_row -> 'shot_index') = 'null' THEN
      RAISE EXCEPTION 'upsert_media_doc: shot_index is required when gran = shot' USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_shot := (p_row ->> 'shot_index')::integer;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'upsert_media_doc: shot_index must be an integer' USING ERRCODE = '22023';
    END;
    IF v_shot < 0 THEN
      RAISE EXCEPTION 'upsert_media_doc: shot_index must be >= 0 (got %)', v_shot USING ERRCODE = '22023';
    END IF;
  END IF;

  -- 题述只把 media_key/gran/text 列为必填：source_kind 缺省时按身份推断（有云 id = cloud）。
  IF v_kind IS NULL THEN
    v_kind := CASE WHEN v_video IS NOT NULL THEN 'cloud' ELSE 'project' END;
  ELSIF v_kind NOT IN ('cloud', 'project') THEN
    RAISE EXCEPTION 'upsert_media_doc: source_kind must be cloud or project (got %)', v_kind
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_typeof(p_row -> 'duration_ms') IS NOT NULL AND jsonb_typeof(p_row -> 'duration_ms') <> 'null' THEN
    BEGIN
      v_dur := (p_row ->> 'duration_ms')::integer;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'upsert_media_doc: duration_ms must be an integer' USING ERRCODE = '22023';
    END;
    IF v_dur < 0 THEN
      RAISE EXCEPTION 'upsert_media_doc: duration_ms must be >= 0 (got %)', v_dur USING ERRCODE = '22023';
    END IF;
  END IF;

  IF jsonb_typeof(p_row -> 'labels') = 'array' THEN
    v_labels := array(SELECT jsonb_array_elements_text(p_row -> 'labels'));
  END IF;

  -- 向量：给了就必须带 embedding_ver（模型版本是向量可比性的前提，同 007:250-265 的三件套口径），
  -- 维度先按裸 vector 解析再断言 768 —— 不让 pgvector 在 `<=>` 处才抛晦涩的维度错误。
  IF jsonb_typeof(p_row -> 'embedding') IS NOT NULL AND jsonb_typeof(p_row -> 'embedding') <> 'null' THEN
    IF v_emb_ver IS NULL THEN
      RAISE EXCEPTION 'upsert_media_doc: embedding needs embedding_ver' USING ERRCODE = '23514';
    END IF;
    BEGIN
      v_emb := (p_row ->> 'embedding')::vector;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'upsert_media_doc: embedding 不是合法向量文本' USING ERRCODE = '22023';
    END;
    v_dims := vector_dims(v_emb);
    IF v_dims IS DISTINCT FROM 768 THEN
      RAISE EXCEPTION 'upsert_media_doc: embedding 维度是 %，契约要求 768', v_dims USING ERRCODE = '22023';
    END IF;
  END IF;

  INSERT INTO public.media_doc AS d (
    company_key, media_key, analyzer_ver, gran, video_id, shot_index, name, batch, product, gname,
    labels, duration_ms, author, source_kind, text, embedding_ver, embedding, created_at, updated_at
  ) VALUES (
    v_company,
    v_media,
    v_ver,
    v_gran,
    v_video,
    v_shot,                                   -- gran='asset' 时恒为 NULL
    nullif(btrim(coalesce(p_row ->> 'name', '')), ''),
    nullif(btrim(coalesce(p_row ->> 'batch', '')), ''),
    nullif(btrim(coalesce(p_row ->> 'product', '')), ''),
    nullif(btrim(coalesce(p_row ->> 'gname', '')), ''),
    coalesce(v_labels, '{}'::text[]),
    v_dur,
    nullif(btrim(coalesce(p_row ->> 'author', '')), ''),
    v_kind,
    v_text,
    v_emb_ver,
    v_emb,
    v_now,
    v_now
  )
  ON CONFLICT (company_key, media_key, analyzer_ver) DO UPDATE SET
    gran        = excluded.gran,
    video_id    = coalesce(excluded.video_id, d.video_id),
    shot_index  = excluded.shot_index,
    name        = coalesce(excluded.name, d.name),
    batch       = coalesce(excluded.batch, d.batch),
    product     = coalesce(excluded.product, d.product),
    gname       = coalesce(excluded.gname, d.gname),
    labels      = CASE WHEN excluded.labels = '{}'::text[] THEN d.labels ELSE excluded.labels END,
    duration_ms = coalesce(excluded.duration_ms, d.duration_ms),
    author      = coalesce(excluded.author, d.author),
    source_kind = excluded.source_kind,
    -- 正文变了 ⇒ 旧向量就是"错向量"：要么这次给新向量，要么置空等重算。不许拿旧向量冒充新正文的答案。
    text          = excluded.text,
    embedding_ver = CASE WHEN d.text IS DISTINCT FROM excluded.text
                         THEN excluded.embedding_ver
                         ELSE coalesce(excluded.embedding_ver, d.embedding_ver) END,
    embedding     = CASE WHEN d.text IS DISTINCT FROM excluded.text
                         THEN excluded.embedding
                         ELSE coalesce(excluded.embedding, d.embedding) END,
    updated_at  = now()
  WHERE d.text          IS DISTINCT FROM excluded.text          -- 幂等：正文与向量版本都没变 → 整行不动
     OR d.embedding_ver IS DISTINCT FROM excluded.embedding_ver --   （updated_at 也不刷新，同 007:351）
     OR (excluded.embedding IS NOT NULL AND d.embedding IS NULL);  -- 向量被置空后重算回来的那次要落库

  GET DIAGNOSTICS v_written = ROW_COUNT;

  IF v_written > 0 THEN
    SELECT d.created_at INTO v_created
      FROM public.media_doc d
     WHERE d.company_key = v_company AND d.media_key = v_media AND d.analyzer_ver = v_ver;

    -- 记录"被谁取代"：只做记录，不参与判断（版本字符串没有可靠的序）。
    SELECT array_agg(DISTINCT d.analyzer_ver)
      INTO v_old_vers
      FROM public.media_doc d
     WHERE d.company_key  = v_company
       AND d.media_key    = v_media
       AND d.gran         = v_gran            -- 只在同一粒度内取代（见下）
       AND d.analyzer_ver <> v_ver
       AND d.superseded_at IS NULL
       AND d.created_at   < v_created;

    -- 新版本落地 → 更旧的行退出检索：清空向量（正文留着，25 ms 可重算）+ 写 superseded_at。
    -- **不比较版本字符串**：`'qwen-vl-shots-1' > 'analyze-runner-2'` 是字典序伪序，
    --  `'analyze-runner-10' < 'analyze-runner-9'` 跨十位就翻车；新旧只由 created_at 裁决。
    -- 取代只在**同一 gran 内**发生：asset 行与 shot 行不是彼此的替代品，而是同一条素材的两种答案
    -- （"哪个素材" vs "哪一段"，analysis.md §2.2/§4.6）。跨 gran 取代会把卡片向量打掉，
    -- 那正是 analysis.md §3.1 否掉方案 A 的理由 —— 两档粒度都必须活着。
    UPDATE public.media_doc d
       SET embedding     = NULL,
           superseded_at = v_now
     WHERE d.company_key  = v_company
       AND d.media_key    = v_media
       AND d.gran         = v_gran
       AND d.analyzer_ver <> v_ver
       AND d.superseded_at IS NULL
       AND d.created_at   < v_created;
    GET DIAGNOSTICS v_superseded = ROW_COUNT;

    IF v_superseded > 0 THEN
      RAISE NOTICE 'upsert_media_doc: % 行更旧版本被 % 取代（版本差异仅记录：%）',
        v_superseded, v_ver, coalesce(array_to_string(v_old_vers, ','), '-');
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok',                 true,
    'mediaKey',           v_media,
    'gran',               v_gran,
    'analyzerVer',        v_ver,
    'written',            v_written > 0,     -- false = 幂等命中（text/embedding_ver 未变，updated_at 没动）
    'superseded',         v_superseded,
    'supersededVersions', to_jsonb(coalesce(v_old_vers, '{}'::text[]))
  );
END
$$;

COMMENT ON FUNCTION public.upsert_media_doc(jsonb) IS
  '写一个可检索文档（asset|shot）：必填 media_key/gran/text；text+embedding_ver 未变则整行不动；同一 gran 内有新版本落地时把更旧行的向量置空并记 superseded_at（按 created_at 判新旧，不比版本字符串）。';

-- ---------------------------------------------------------------------------
-- 5. media_search：一条 RPC 覆盖两类语料、三路命中。
--    向量（p_embedding 非空才走）/ ILIKE / trigram（pg_trgm），每行带 match_kind 说清"这条是怎么命中的"，
--    按 media_key 去重（shot 优先：能直接下刀的排前面；同 gran 取最高分）。
--
--    score 的口径按 kind 分开，且**不可跨 kind 解释**（这正是 match_kind 必须外露的原因）：
--      * vector  = 1 - cosine 距离（同一 gran 内可比）；
--      * ilike   = 1.0（确定性子串命中，不是相似度估计）；
--      * trigram = similarity(text|name, query)。
--    降级：没有嵌入端点时 p_embedding = NULL → 只跑词法分支，**不许**伪装成语义（match_kind 会说话）。
--
--    过滤 p_filters 支持的键：batch / product / gname / durationMaxMs / sourceKind
--    （其余键一律忽略：过滤条件只有这里列的是契约，别在调用方发明）。
--
--    返回列不含"本地可用性"：字节在哪台机器上，库不知道（见文件头第 1 条）。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.media_search(
  p_company_key text,
  p_query       text         DEFAULT NULL,
  p_filters     jsonb        DEFAULT '{}'::jsonb,
  p_embedding   vector(768)  DEFAULT NULL,
  p_limit       integer      DEFAULT 20
) RETURNS TABLE (
  media_key   text,
  gran        text,
  video_id    text,
  shot_index  integer,
  name        text,
  batch       text,
  product     text,
  gname       text,
  duration_ms integer,
  score       real,
  match_kind  text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, extensions, pg_temp
SET statement_timeout = '30s'
AS $$
DECLARE
  v_session    text := public.app_tenant_key();
  v_query      text := nullif(btrim(coalesce(p_query, '')), '');
  v_filters    jsonb := CASE WHEN jsonb_typeof(p_filters) = 'object' THEN p_filters ELSE '{}'::jsonb END;
  v_limit      integer := greatest(1, least(coalesce(p_limit, 20), 100));
  v_k          integer;
  v_like       text;
  v_dims       integer;
  v_has_trgm   boolean := EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm');
BEGIN
  IF p_company_key IS NULL OR btrim(p_company_key) = '' THEN
    RAISE EXCEPTION 'media_search: p_company_key is required' USING ERRCODE = '22023';
  END IF;

  -- 租户：读侧沿用 007 的空集语义（不报错，避免用报错差异探测别的租户有没有数据）。
  IF v_session IS NOT NULL AND v_session <> p_company_key THEN
    RETURN;
  END IF;

  IF p_embedding IS NOT NULL THEN
    v_dims := vector_dims(p_embedding);
    IF v_dims IS DISTINCT FROM 768 THEN
      RAISE EXCEPTION 'media_search: p_embedding 维度是 %，契约要求 768', v_dims USING ERRCODE = '22023';
    END IF;
    -- 事务级：带过滤条件的向量检索要能继续扫到足够候选（pgvector >= 0.8，同 007:169）。
    PERFORM set_config('hnsw.iterative_scan', 'strict_order', true);
  END IF;

  v_k := least(v_limit * 4, 200);   -- 每路取 k 倍再合并：给"去重后还能凑够 limit"留余量

  -- 词法查询串：转义 LIKE 的元字符，否则用户输入的 % / _ 会变成通配符（把"%"查成全表）。
  v_like := '%' || replace(replace(replace(v_query, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%';

  RETURN QUERY
  WITH base AS (
    SELECT d.media_key, d.gran, d.video_id, d.shot_index, d.name, d.batch, d.product, d.gname,
           d.duration_ms, d.text, d.embedding
      FROM public.media_doc d
     WHERE d.company_key = p_company_key                        -- [tenant]
       AND d.superseded_at IS NULL                              -- [live] 旧版本不参与检索
       AND (v_filters ->> 'batch'          IS NULL OR d.batch    = v_filters ->> 'batch')
       AND (v_filters ->> 'product'        IS NULL OR d.product  = v_filters ->> 'product')
       AND (v_filters ->> 'gname'          IS NULL OR d.gname    = v_filters ->> 'gname')
       AND (v_filters ->> 'sourceKind'     IS NULL OR d.source_kind = v_filters ->> 'sourceKind')
       AND (v_filters ->> 'durationMaxMs'  IS NULL
            OR (d.duration_ms IS NOT NULL AND d.duration_ms <= (v_filters ->> 'durationMaxMs')::integer))
  ),
  -- 向量分支按 gran 拆两条：部分 HNSW 只有在这个 CTE 里写死 `gran = ...` 时才会被选中
  -- （规划器要求查询谓词蕴含索引谓词），同时保证"同类才比 cosine"。
  vec_asset AS (
    SELECT b.*, greatest(0::real, (1 - (b.embedding <=> p_embedding))::real) AS score,
           'vector'::text AS match_kind
      FROM base b
     WHERE p_embedding IS NOT NULL AND b.gran = 'asset' AND b.embedding IS NOT NULL
     ORDER BY b.embedding <=> p_embedding, b.media_key
     LIMIT v_k
  ),
  vec_shot AS (
    SELECT b.*, greatest(0::real, (1 - (b.embedding <=> p_embedding))::real) AS score,
           'vector'::text AS match_kind
      FROM base b
     WHERE p_embedding IS NOT NULL AND b.gran = 'shot' AND b.embedding IS NOT NULL
     ORDER BY b.embedding <=> p_embedding, b.media_key, b.shot_index
     LIMIT v_k
  ),
  -- 词法二路之一：子串命中（以及批次/产品/分组等于查询串的"结构化前缀"命中）。
  lex_ilike AS (
    SELECT b.*, 1.0::real AS score, 'ilike'::text AS match_kind
      FROM base b
     WHERE v_query IS NOT NULL
       AND (b.text   ILIKE v_like
         OR b.name   ILIKE v_like
         OR b.batch  = v_query
         OR b.product = v_query
         OR b.gname  = v_query)
     ORDER BY b.media_key, b.shot_index
     LIMIT v_k
  ),
  -- 词法二路之二：trigram 相似（pg_trgm 由 001 硬依赖，顶部断言已保证；扩展不在时不静默半残）。
  lex_trigram AS (
    SELECT b.*,
           coalesce(greatest(similarity(b.text, v_query), similarity(coalesce(b.name, ''), v_query)), 0)::real AS score,
           'trigram'::text AS match_kind
      FROM base b
     WHERE v_has_trgm AND v_query IS NOT NULL
       AND (b.text % v_query OR b.name % v_query)
     ORDER BY score DESC, b.media_key, b.shot_index
     LIMIT v_k
  ),
  merged AS (
    SELECT * FROM vec_asset
    UNION ALL SELECT * FROM vec_shot
    UNION ALL SELECT * FROM lex_ilike
    UNION ALL SELECT * FROM lex_trigram
  ),
  -- 按 media_key 去重：镜头优先（能直接下刀的排前面），同 gran 取最高分；
  -- 分数相同则语义优先于词法（match_kind 是"怎么命中的"，不是排序权重）。
  ranked AS (
    SELECT DISTINCT ON (m.media_key) m.*
      FROM merged m
     ORDER BY m.media_key,
              (m.gran = 'shot') DESC,
              m.score DESC,
              (m.match_kind = 'vector') DESC,
              m.shot_index NULLS LAST
  )
  SELECT r.media_key, r.gran, r.video_id, r.shot_index, r.name, r.batch, r.product, r.gname,
         r.duration_ms, r.score, r.match_kind
    FROM ranked r
   ORDER BY (r.gran = 'shot') DESC, r.score DESC, r.media_key, r.shot_index NULLS LAST
   LIMIT v_limit;
END
$$;

COMMENT ON FUNCTION public.media_search(text, text, jsonb, vector, integer) IS
  '统一检索（素材级+镜头级同表）：向量/ILIKE/trigram 三路混合，每行带 match_kind，按 media_key 去重（shot 优先）；p_embedding 为 NULL 时只走词法；返回列不含本地可用性。';

-- ---------------------------------------------------------------------------
-- 6. 权限：新函数一律显式收口（010 已把 public 下的默认 EXECUTE 从 PUBLIC 收回，
--    这里再显式 REVOKE 一次，保证"重放/新建"两条路径上 anon 都是零权限）。
--    表权限在第 3 节；函数执行只给 authenticated / service_role / orange_app。
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.upsert_media_doc(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_media_doc(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.media_search(text, text, jsonb, vector, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.media_search(text, text, jsonb, vector, integer) FROM anon;

GRANT EXECUTE ON FUNCTION public.upsert_media_doc(jsonb) TO authenticated, service_role, orange_app;
GRANT EXECUTE ON FUNCTION public.media_search(text, text, jsonb, vector, integer) TO authenticated, service_role, orange_app;

-- ---------------------------------------------------------------------------
-- 7. 收尾断言：全部用系统目录（不靠手数），失败信息直接指向要查的地方（同 007:621-646 的风格）。
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_dims integer;
  v_bad  integer;
  v_list text;
BEGIN
  -- 7.1 向量列定长 768（裸 vector 会让 HNSW 以 `column does not have dimensions` 晚一步炸）
  SELECT a.atttypmod INTO v_dims
    FROM pg_attribute a
   WHERE a.attrelid = 'public.media_doc'::regclass AND a.attname = 'embedding';
  IF v_dims IS DISTINCT FROM 768 THEN
    RAISE EXCEPTION '012: media_doc.embedding typmod=%（契约要求 768，见 docs/sql/embedding.json）', v_dims
      USING ERRCODE = '22023';
  END IF;

  -- 7.2 两条部分 HNSW 在，且真的是"部分"（缺 superseded_at 谓词 = 旧版本会污染索引）
  SELECT count(*), string_agg(c.relname || ':' || coalesce(pg_get_expr(i.indpred, i.indrelid), '(no pred)'), ',')
    INTO v_bad, v_list
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
   WHERE i.indexrelid IN ('public.media_doc_asset_vec_idx'::regclass,
                          'public.media_doc_shot_vec_idx'::regclass)
     AND i.indpred IS NOT NULL
     AND pg_get_expr(i.indpred, i.indrelid) LIKE '%superseded_at IS NULL%';
  IF v_bad <> 2 THEN
    RAISE EXCEPTION '012: 两条 HNSW 部分索引不全或不是部分索引（%）', coalesce(v_list, 'missing');
  END IF;
  SELECT count(*) INTO v_bad
    FROM pg_index i
    JOIN pg_class c  ON c.oid = i.indexrelid
    JOIN pg_am   am  ON am.oid = c.relam
   WHERE i.indexrelid IN ('public.media_doc_asset_vec_idx'::regclass,
                          'public.media_doc_shot_vec_idx'::regclass)
     AND am.amname = 'hnsw';
  IF v_bad <> 2 THEN
    RAISE EXCEPTION '012: 向量索引不是 hnsw（% / 2）', v_bad;
  END IF;

  -- 7.3 过滤索引齐（4 条普通 + 1 条 text trigram）
  SELECT count(*) INTO v_bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname IN ('media_doc_batch_idx', 'media_doc_product_idx', 'media_doc_gname_idx',
                       'media_doc_labels_gin', 'media_doc_text_trgm_idx');
  IF v_bad <> 5 THEN
    RAISE EXCEPTION '012: 过滤索引不全（% / 5）', v_bad;
  END IF;

  -- 7.4 RLS enable+force 且策略指向严格判据
  IF NOT EXISTS (SELECT 1 FROM pg_class c
                  WHERE c.oid = 'public.media_doc'::regclass AND c.relrowsecurity AND c.relforcerowsecurity) THEN
    RAISE EXCEPTION '012: media_doc 未 ENABLE+FORCE RLS';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
     WHERE p.polrelid = 'public.media_doc'::regclass
       AND p.polname  = 'media_doc_tenant'
       AND coalesce(pg_get_expr(p.polqual, p.polrelid), '') LIKE '%tenant_key_required%'
       AND coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') LIKE '%tenant_key_required%'
  ) THEN
    RAISE EXCEPTION '012: media_doc_tenant 策略缺失或没指向 tenant_key_required()';
  END IF;

  -- 7.5 两个 RPC 各只有一个重载，且返回列与 contract.json 对得上（--contract 是权威，这里更直白）
  SELECT count(*) INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('upsert_media_doc', 'media_search');
  IF v_bad <> 2 THEN
    RAISE EXCEPTION '012: upsert_media_doc / media_search 不全或有重载（% / 2）', v_bad;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'media_search'
       AND pg_get_function_result(p.oid) LIKE '%match_kind text%'
       AND pg_get_function_result(p.oid) LIKE '%score real%'
       AND pg_get_function_result(p.oid) LIKE '%duration_ms integer%'
  ) THEN
    RAISE EXCEPTION '012: media_search 的返回列不是契约形状（需要 score real / duration_ms integer / match_kind text）';
  END IF;

  -- 7.6 anon 不能执行这两个函数（010 的口径：漏 token 必须 42501）
  SELECT count(*) INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('upsert_media_doc', 'media_search')
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_bad > 0 THEN
    RAISE EXCEPTION '012: anon 仍可执行 % 个 media_* 函数', v_bad;
  END IF;

  RAISE NOTICE '012: media_doc（asset/shot 同表 + 两条部分 HNSW + 5 条过滤索引）、upsert_media_doc、media_search OK';
END
$$;
