-- 014 media_doc 的第二条向量列：4096 维（qwen3-embedding-8b），与 768 维（nomic）并存。
--
-- 为什么另开一列，而不是把 `embedding` 改成 4096（见 docs/execution/2026-11-17-retrieval/run-8b.md）：
--   * 现有 live 78 874 行是 **768 维 nomic**，改列类型 = 先清空再重算：对照组当场消失，
--     "8B vs nomic 的 top-1 对比"就没有 768 那一侧了；
--   * 两条向量属于**两个模型**，而 `embedding_ver` 是行属性（012:108-109）—— 模型不同，列就分开；
--     upsert 的口径是"谁给了写谁"（第 3 节），不是"二选一"；
--   * HNSW 的维度上限写在**索引类型**里，不是列里：混成一列会让 768 那两条部分 HNSW（012:131-137）无处安放。
--
-- 引擎事实（本文件唯一一处偏离题述的地方，证据就是下面这两条实测 ERROR）：
--   pgvector 0.8.7 对 HNSW 的维度上限是 vector ≤ 2000 / halfvec ≤ 4000：
--     create index on t using hnsw (e vector_cosine_ops)   -- e vector(4096)
--       ERROR: column cannot have more than 2000 dimensions for hnsw index
--     create index on t using hnsw (e halfvec_cosine_ops)  -- e halfvec(4096)
--       ERROR: column cannot have more than 4000 dimensions for hnsw index
--   所以"4096 维稠密向量上的部分 HNSW"在这台引擎上**不存在**（换 ivfflat 也一样，上限同源）。
--   三条可行形状，本文件取 (a)，理由写在下面：
--     (a) 前缀 halfvec(4000) 表达式索引 + 完整 4096 维重排      ← 采用
--     (b) sparsevec(4096) 上的 HNSW：维度全留，但稠密向量每条 4096×8 B，
--         66 470 行 ≈ 2 GB 索引，超出本地 2 GB 内容预算，且写入边长一档；
--     (c) 不建索引、纯精确扫描：5 000 行 <50 ms 可接受，66 470 × 4096 浮点 ≈ 1 GB 顺序扫不可接受。
--   (a) 的取舍必须写清楚：**候选**由前 4000 维（halfvec）选，**分数**用完整 4096 维算
--   （media_search_4096 的 vec_* CTE：cand_* 只做 LIMIT，score 在 vec_* 里按 `<=>` 全精度算）。
--   于是 top-k 的分数与"纯精确扫描"逐位相同，只有"谁进候选"受末尾 96 维（2.3%）截断影响 ——
--   MRL 类模型（qwen3-embedding 系列）的信号集中在前段，这个截断是这套引擎上代价最小的近似。
--   若将来 pgvector 放开稠密 4096，把索引换成
--   `using hnsw (embedding_4096 vector_cosine_ops) where embedding_4096 is not null and superseded_at is null`
--   即可，函数不用改（vec_* 的分数本来就按 4096 全精度算）。
--
-- 本文件只做五件事，**不动** 768 那一侧的形状：
--   1. `alter table … add column if not exists embedding_4096 vector(4096)`（只加列，不改列）；
--   2. 一条**部分** HNSW 表达式索引（谓词 `embedding_4096 is not null and superseded_at is null`，同 012 的口径）；
--   3. `upsert_media_doc` 认 `p_row->>'embedding_4096'`（数组或 `[a,b,…]` 文本，4096 断言），与 `embedding` 并存；
--   4. 新检索函数 `media_search_4096`：与 `media_search` 同语义（向量/ilike/trigram 三路、按 media_key 去重 shot 优先），
--      只是向量那一路走 4096 列；
--   5. 契约同步：contract.json（表列 + 两个函数）、docs/contracts/media-doc.schema.json、
--      packages/orangefilm/src/index-client.mjs 的 RPC_NAMES、docs/sql/README.md。
--
-- 幂等：`ADD COLUMN IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` / `CREATE OR REPLACE FUNCTION`；
--       第二轮执行是 no-op（索引已存在即跳过，函数体等价重写）。

-- ---------------------------------------------------------------------------
-- 0. 前置断言：顺序（012/013 必须先跑）、768 列仍在、扩展与角色。
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_dims integer;
BEGIN
  IF to_regclass('public.media_doc') IS NULL THEN
    RAISE EXCEPTION '014: 缺少 public.media_doc，请先按顺序跑 012 / 013';
  END IF;
  -- 014 是**并存**，不是替换：768 列不见了说明有人把形状改了，别在半残的表上加第二条向量列。
  SELECT a.atttypmod INTO v_dims
    FROM pg_attribute a
   WHERE a.attrelid = 'public.media_doc'::regclass AND a.attname = 'embedding';
  IF v_dims IS DISTINCT FROM 768 THEN
    RAISE EXCEPTION '014: media_doc.embedding 的 typmod 是 %（014 与 768 并存，768 列必须还在）', coalesce(v_dims::text, 'missing');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RAISE EXCEPTION '014: 缺少 vector 扩展，请先跑 001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    RAISE EXCEPTION '014: 缺少 pg_trgm（词法两路要它），请先跑 001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'orange_app') THEN
    RAISE EXCEPTION '014: 缺少 authenticated / service_role / orange_app 角色，请先跑 004/008';
  END IF;
  IF to_regprocedure('public.media_search(text, text, jsonb, vector, integer)') IS NULL THEN
    RAISE EXCEPTION '014: 缺少 public.media_search(...)，请先跑 012（014 只加第二条通路，不重建 768 那条）';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 1. 加列：只加，不改。nullable，因为 768 的行本来就没有 4096 的答案（反之亦然）。
--    typmod 必须带（`vector` 裸类型会让 HNSW 以 `column does not have dimensions` 晚一步炸，同 012:559-566）。
-- ---------------------------------------------------------------------------
ALTER TABLE public.media_doc ADD COLUMN IF NOT EXISTS embedding_4096 vector(4096);

COMMENT ON COLUMN public.media_doc.embedding_4096 IS
  '4096 维向量（qwen3-embedding-8b）。与 embedding(768) 并存：一行可以有其一或都没有（正文变了就都置空），embedding_ver 说这行是哪一列的答案。';

-- ---------------------------------------------------------------------------
-- 2. 部分 HNSW（表达式索引，理由见文件头"引擎事实"）：
--      * 谓词 `embedding_4096 is not null and superseded_at is null` —— 索引体积恒等于"当前 4096 答案"的规模；
--      * 建在 `(subvector(embedding_4096, 1, 4000))::halfvec(4000)` 上：halfvec 的上限正好是 4000，
--        而这 4000 维是 4096 维的前缀（MRL 截断），halfvec 每条比 dense vector 省一半字节；
--      * **搜索函数必须写一模一样的表达式**才会被选中（规划器按表达式树匹配，谓词靠蕴含推断），
--        media_search_4096 的 cand_asset / cand_shot 就是为此写的（注释在函数体里）。
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS media_doc_vec4096_hnsw_idx ON public.media_doc
  USING hnsw (((subvector(embedding_4096, 1, 4000))::halfvec(4000)) halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE embedding_4096 IS NOT NULL AND superseded_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3. upsert_media_doc：认第二条向量列。冲突目标 / 幂等 / 取代语义**逐条不变**，
--    只加三处（对照 013:132-362）：
--      (a) 解析 `embedding_4096`（数组或 `[a,b,…]` 文本），维度断言 4096（不赌 pgvector 在 `<=>` 处才报错）；
--      (b) INSERT 列 + ON CONFLICT 的 SET（正文变了 ⇒ 旧向量是错向量，与 `embedding` 同一口径）；
--      (c) 幂等 WHERE 多一条"向量被置空后重算回来的那次要落库"，并且取代时**两条向量一起清**
--          （superseded 行的向量留在库里 = 第二份会过期的真相，同 012:112-113 的口径）。
--    谁给了写谁：只给 embedding → 768 那条落库、4096 不动；只给 embedding_4096 → 反之；两个都给 → 两个都写。
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
  v_shot       integer := 0;                           -- 013：asset 行恒 0（012 是 NULL）
  v_dur        integer;
  v_labels     text[];
  v_emb        vector;
  v_dims       integer;
  v_emb4096    vector;
  v_dims4096   integer;
  v_vec_text   text;
  v_now        timestamptz := clock_timestamp();       -- now() 在一个事务里是常量：同一批写入会并列
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

  -- 粒度形状：镜头行必须给 shot_index；素材行的镜头号恒 0（表上 CHECK 兜底，这里给可读的错误）。
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
  ELSIF jsonb_typeof(p_row -> 'shot_index') IS NOT NULL
        AND jsonb_typeof(p_row -> 'shot_index') <> 'null' THEN
    -- asset 行只允许 0（缺省/显式 null 都按 0 处理）；非 0 说明调用方把两种粒度搞混了。
    BEGIN
      v_shot := (p_row ->> 'shot_index')::integer;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'upsert_media_doc: shot_index must be an integer' USING ERRCODE = '22023';
    END;
    IF v_shot <> 0 THEN
      RAISE EXCEPTION 'upsert_media_doc: shot_index must be 0 when gran = asset (got %)', v_shot
        USING ERRCODE = '22023';
    END IF;
    v_shot := 0;
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

  -- 向量（768）：给了就必须带 embedding_ver（模型版本是向量可比性的前提，同 007:250-265 的三件套口径），
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

  -- 向量（4096，014）：数组与文本两种写法都吃（调用方给数组更自然，`psql` 手工抄一份文本也照样能用）。
  -- 数组走 jsonb_array_elements_text → `[a,b,…]` 文本再解析：多的是一次往返内的字符串拼装，
  -- 换来的是"数组不用调用方自己拼 JSON 字符串"这条最常被踩的坑。
  IF jsonb_typeof(p_row -> 'embedding_4096') IS NOT NULL
     AND jsonb_typeof(p_row -> 'embedding_4096') <> 'null' THEN
    IF v_emb_ver IS NULL THEN
      RAISE EXCEPTION 'upsert_media_doc: embedding_4096 needs embedding_ver' USING ERRCODE = '23514';
    END IF;
    BEGIN
      IF jsonb_typeof(p_row -> 'embedding_4096') = 'array' THEN
        SELECT '[' || string_agg(e.value, ',' ORDER BY e.ord) || ']'
          INTO v_vec_text
          FROM jsonb_array_elements_text(p_row -> 'embedding_4096') WITH ORDINALITY AS e(value, ord);
        IF v_vec_text IS NULL THEN
          RAISE EXCEPTION 'upsert_media_doc: embedding_4096 是空数组' USING ERRCODE = '22023';
        END IF;
        v_emb4096 := v_vec_text::vector;
      ELSE
        v_emb4096 := (p_row ->> 'embedding_4096')::vector;
      END IF;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'upsert_media_doc: embedding_4096 不是合法向量（数组或 ''[a,b,…]'' 文本）' USING ERRCODE = '22023';
    END;
    v_dims4096 := vector_dims(v_emb4096);
    IF v_dims4096 IS DISTINCT FROM 4096 THEN
      RAISE EXCEPTION 'upsert_media_doc: embedding_4096 维度是 %，契约要求 4096', v_dims4096 USING ERRCODE = '22023';
    END IF;
  END IF;

  -- 013：主键层面的一条不变量。asset 行 shot_index 恒 0，所以 asset 文档与第 0 帧 shot 文档
  -- 不能共用同一个 analyzer_ver（否则它们就是同一行）。明确拒绝，不让 ON CONFLICT 把卡片行改写成镜头行。
  IF EXISTS (
    SELECT 1 FROM public.media_doc d
     WHERE d.company_key = v_company
       AND d.media_key   = v_media
       AND d.analyzer_ver = v_ver
       AND d.shot_index  = v_shot
       AND d.gran        <> v_gran
  ) THEN
    RAISE EXCEPTION 'upsert_media_doc: % 在 analyzer_ver=% / shot_index=% 上已经是 % 行；asset 与 shot 文档必须用不同的 analyzer_ver',
      v_media, v_ver, v_shot, v_gran
      USING ERRCODE = '23505';
  END IF;

  -- 冲突目标 = 新主键四列（013）：同一素材同一版本里，不同 shot_index 是**不同的行**，不再互相覆盖。
  -- shot_index 本身不进 DO UPDATE 的 SET：它属于冲突目标，赋值恒等于原值。
  INSERT INTO public.media_doc AS d (
    company_key, media_key, analyzer_ver, gran, video_id, shot_index, name, batch, product, gname,
    labels, duration_ms, author, source_kind, text, embedding_ver, embedding, embedding_4096,
    created_at, updated_at
  ) VALUES (
    v_company,
    v_media,
    v_ver,
    v_gran,
    v_video,
    v_shot,                                   -- asset 行恒 0；shot 行 = 镜头号
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
    v_emb4096,
    v_now,
    v_now
  )
  ON CONFLICT (company_key, media_key, analyzer_ver, shot_index) DO UPDATE SET
    gran        = excluded.gran,
    video_id    = coalesce(excluded.video_id, d.video_id),
    name        = coalesce(excluded.name, d.name),
    batch       = coalesce(excluded.batch, d.batch),
    product     = coalesce(excluded.product, d.product),
    gname       = coalesce(excluded.gname, d.gname),
    labels      = CASE WHEN excluded.labels = '{}'::text[] THEN d.labels ELSE excluded.labels END,
    duration_ms = coalesce(excluded.duration_ms, d.duration_ms),
    author      = coalesce(excluded.author, d.author),
    source_kind = excluded.source_kind,
    -- 正文变了 ⇒ 旧向量就是"错向量"：要么这次给新向量，要么置空等重算。不许拿旧向量冒充新正文的答案。
    -- 014：两条向量列同一口径 —— 正文变了就把"这次没给"的那一列也清掉（它算的是旧正文）。
    text          = excluded.text,
    embedding_ver = CASE WHEN d.text IS DISTINCT FROM excluded.text
                         THEN excluded.embedding_ver
                         ELSE coalesce(excluded.embedding_ver, d.embedding_ver) END,
    embedding     = CASE WHEN d.text IS DISTINCT FROM excluded.text
                         THEN excluded.embedding
                         ELSE coalesce(excluded.embedding, d.embedding) END,
    embedding_4096 = CASE WHEN d.text IS DISTINCT FROM excluded.text
                          THEN excluded.embedding_4096
                          ELSE coalesce(excluded.embedding_4096, d.embedding_4096) END,
    updated_at  = now()
  WHERE d.text          IS DISTINCT FROM excluded.text          -- 幂等：正文与向量版本都没变 → 整行不动
     OR d.embedding_ver IS DISTINCT FROM excluded.embedding_ver --   （updated_at 也不刷新，同 007:351）
     OR (excluded.embedding IS NOT NULL AND d.embedding IS NULL)  -- 向量被置空后重算回来的那次要落库
     OR (excluded.embedding_4096 IS NOT NULL AND d.embedding_4096 IS NULL);  -- 014：4096 列同理

  GET DIAGNOSTICS v_written = ROW_COUNT;

  IF v_written > 0 THEN
    -- 013：多镜头后同一 (media_key, analyzer_ver) 有 N 行 —— 判新旧必须锁到**本行**的 created_at，
    -- 不带 shot_index 等于随便挑一行（SELECT INTO 非 STRICT 不报错，只会静默用错基准）。
    SELECT d.created_at INTO v_created
      FROM public.media_doc d
     WHERE d.company_key   = v_company
       AND d.media_key     = v_media
       AND d.analyzer_ver  = v_ver
       AND d.shot_index    = v_shot;

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

    -- 新版本落地 → 更旧的行退出检索：两条向量一起清空（正文留着，可重算）+ 写 superseded_at。
    -- 014 追加 `embedding_4096 = NULL` 的理由：superseded 行的向量留在库里就是第二份会过期的真相，
    -- 与 012:112-113 对 `embedding` 的口径一致；索引谓词本来就只收 `superseded_at is null`，清空不影响检索面。
    -- **不比较版本字符串**：新旧只由 created_at 裁决（012:341-346 的理由逐条仍成立）。
    UPDATE public.media_doc d
       SET embedding      = NULL,
           embedding_4096 = NULL,
           superseded_at  = v_now
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
    'supersededVersions', to_jsonb(coalesce(v_old_vers, '{}'::text[])),
    -- 014：回执里说清"这次落的是哪一列"，客户端不用再猜（也不新增键以外的东西）。
    'vectors',            to_jsonb(array_remove(ARRAY[
                            CASE WHEN v_emb      IS NOT NULL THEN 'embedding' END,
                            CASE WHEN v_emb4096  IS NOT NULL THEN 'embedding_4096' END
                          ], NULL))
  );
END
$$;

COMMENT ON FUNCTION public.upsert_media_doc(jsonb) IS
  '写一个可检索文档（asset|shot）：必填 media_key/gran/text；冲突目标 = 主键四列；text+embedding_ver 未变则整行不动；同一 gran 内有新版本落地时把更旧行的两条向量（768/4096）都置空并记 superseded_at（按 created_at 判新旧，不比版本字符串）。014 起 embedding 与 embedding_4096 并存，谁给了写谁（各自的维度断言 768 / 4096）。';

-- ---------------------------------------------------------------------------
-- 4. media_search_4096：与 media_search **同语义**，只是向量那一路换成 4096 列。
--
--    语义逐条对齐 012:379-535：
--      * 三路命中：向量（p_embedding 非空才走）/ ILIKE / trigram，每行带 match_kind；
--      * score 口径按 kind 分开且不可跨 kind 解释（vector = 1-cosine，ilike = 1.0，trigram = similarity）；
--      * 按 media_key 去重、shot 优先、同 gran 取最高分、末位键 shot_index 做稳定 tiebreak；
--      * 过滤键同一份：batch / product / gname / durationMaxMs / sourceKind（其余键忽略）；
--      * 返回列同一份（11 列，不含本地可用性）；
--      * 租户不匹配 → 空集（防探测），不报错；
--      * p_embedding 为 NULL → 只走词法，match_kind 如实标 ilike/trigram。
--
--    唯一的实现差异（第 2 节那条索引的直接后果）：向量分支拆成 cand_* + vec_* 两步。
--      cand_asset / cand_shot：按**前缀 4000 维 halfvec** 的余弦距离取 v_k 条 —— 这段表达式必须与索引
--        定义逐字一致，规划器才会选中 media_doc_vec4096_hnsw_idx（表达式索引按表达式树匹配）；
--        同时 gran 写死在各自 CTE 里，保证"同类才比 cosine"（012:467-476 的老问题）。
--      vec_asset / vec_shot：对候选按**完整 4096 维**重算 score —— 于是分数与纯精确扫描一致，
--        近似只发生在"谁进候选"，且已被限在 2.3% 的末尾维度上（见文件头）。
--      代价：多一次 CTE 物化。收益：66k 行时不至于 GB 级顺序扫描。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.media_search_4096(
  p_company_key text,
  p_query       text         DEFAULT NULL,
  p_filters     jsonb        DEFAULT '{}'::jsonb,
  p_embedding   vector(4096) DEFAULT NULL,
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
    RAISE EXCEPTION 'media_search_4096: p_company_key is required' USING ERRCODE = '22023';
  END IF;

  -- 租户：读侧沿用 007/012 的空集语义（不报错，避免用报错差异探测别的租户有没有数据）。
  IF v_session IS NOT NULL AND v_session <> p_company_key THEN
    RETURN;
  END IF;

  IF p_embedding IS NOT NULL THEN
    v_dims := vector_dims(p_embedding);
    IF v_dims IS DISTINCT FROM 4096 THEN
      RAISE EXCEPTION 'media_search_4096: p_embedding 维度是 %，契约要求 4096', v_dims USING ERRCODE = '22023';
    END IF;
    -- 事务级：带过滤条件的向量检索要能继续扫到足够候选（pgvector >= 0.8，同 012:445）。
    PERFORM set_config('hnsw.iterative_scan', 'strict_order', true);
  END IF;

  v_k := least(v_limit * 4, 200);   -- 每路取 k 倍再合并：给"去重后还能凑够 limit"留余量

  -- 词法查询串：转义 LIKE 的元字符，否则用户输入的 % / _ 会变成通配符（把"%"查成全表）。
  v_like := '%' || replace(replace(replace(v_query, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%';

  RETURN QUERY
  WITH base AS (
    SELECT d.media_key, d.gran, d.video_id, d.shot_index, d.name, d.batch, d.product, d.gname,
           d.duration_ms, d.text, d.embedding_4096
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
  -- 候选（索引段）：表达式与 media_doc_vec4096_hnsw_idx 逐字一致，谓词也蕴含索引谓词。
  cand_asset AS (
    SELECT b.*
      FROM base b
     WHERE p_embedding IS NOT NULL AND b.gran = 'asset' AND b.embedding_4096 IS NOT NULL
     ORDER BY (subvector(b.embedding_4096, 1, 4000))::halfvec(4000)
              <=> (subvector(p_embedding, 1, 4000))::halfvec(4000)
     LIMIT v_k
  ),
  cand_shot AS (
    SELECT b.*
      FROM base b
     WHERE p_embedding IS NOT NULL AND b.gran = 'shot' AND b.embedding_4096 IS NOT NULL
     ORDER BY (subvector(b.embedding_4096, 1, 4000))::halfvec(4000)
              <=> (subvector(p_embedding, 1, 4000))::halfvec(4000)
     LIMIT v_k
  ),
  -- 重排（精度段）：分数用完整 4096 维算 —— 与纯精确扫描同一个数。
  vec_asset AS (
    SELECT c.media_key, c.gran, c.video_id, c.shot_index, c.name, c.batch, c.product, c.gname,
           c.duration_ms,
           greatest(0::real, (1 - (c.embedding_4096 <=> p_embedding))::real) AS score,
           'vector'::text AS match_kind
      FROM cand_asset c
  ),
  vec_shot AS (
    SELECT c.media_key, c.gran, c.video_id, c.shot_index, c.name, c.batch, c.product, c.gname,
           c.duration_ms,
           greatest(0::real, (1 - (c.embedding_4096 <=> p_embedding))::real) AS score,
           'vector'::text AS match_kind
      FROM cand_shot c
  ),
  -- 词法二路之一：子串命中（以及批次/产品/分组等于查询串的"结构化前缀"命中）。
  lex_ilike AS (
    SELECT b.media_key, b.gran, b.video_id, b.shot_index, b.name, b.batch, b.product, b.gname,
           b.duration_ms, 1.0::real AS score, 'ilike'::text AS match_kind
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
  -- 词法二路之二：trigram 相似（pg_trgm 由 001 硬依赖，顶部断言已保证）。
  lex_trigram AS (
    SELECT b.media_key, b.gran, b.video_id, b.shot_index, b.name, b.batch, b.product, b.gname,
           b.duration_ms,
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

COMMENT ON FUNCTION public.media_search_4096(text, text, jsonb, vector, integer) IS
  '统一检索（4096 维那一侧）：向量/ILIKE/trigram 三路混合，每行带 match_kind，按 media_key 去重（shot 优先）；向量候选走 media_doc_vec4096_hnsw_idx（前 4000 维 halfvec），分数按完整 4096 维重排；p_embedding 为 NULL 时只走词法；返回列不含本地可用性。';

-- ---------------------------------------------------------------------------
-- 5. 权限：新函数显式收口（012:537-548 的口径），upsert 的 ACL 在 CREATE OR REPLACE 之后仍然要复核。
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.upsert_media_doc(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_media_doc(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.media_search_4096(text, text, jsonb, vector, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.media_search_4096(text, text, jsonb, vector, integer) FROM anon;

GRANT EXECUTE ON FUNCTION public.upsert_media_doc(jsonb) TO authenticated, service_role, orange_app;
GRANT EXECUTE ON FUNCTION public.media_search_4096(text, text, jsonb, vector, integer)
  TO authenticated, service_role, orange_app;

-- ---------------------------------------------------------------------------
-- 6. 收尾断言：全部读系统目录（不靠手数），失败信息直接指向要查的地方（同 012 §7 / 013 §5 的风格）。
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_dims      integer;
  v_have      integer;
  v_pred      text;
  v_am        text;
  v_fndef     text;
  v_args      text;
  v_result    text;
  v_bad       integer;
BEGIN
  -- 6.1 列在，且 typmod 是 4096（裸 vector = 索引会在建索引时或查询时晚一步炸）
  SELECT a.atttypmod INTO v_dims
    FROM pg_attribute a
   WHERE a.attrelid = 'public.media_doc'::regclass AND a.attname = 'embedding_4096' AND NOT a.attisdropped;
  IF v_dims IS DISTINCT FROM 4096 THEN
    RAISE EXCEPTION '014: media_doc.embedding_4096 typmod=%（契约要求 4096）', coalesce(v_dims::text, 'missing')
      USING ERRCODE = '22023';
  END IF;
  -- 768 列仍在（并存的前提）
  SELECT a.atttypmod INTO v_dims
    FROM pg_attribute a
   WHERE a.attrelid = 'public.media_doc'::regclass AND a.attname = 'embedding' AND NOT a.attisdropped;
  IF v_dims IS DISTINCT FROM 768 THEN
    RAISE EXCEPTION '014: media_doc.embedding typmod=%（768 那条列必须原样保留）', coalesce(v_dims::text, 'missing');
  END IF;

  -- 6.2 索引存在、是 hnsw、是部分索引、谓词就是题述那一条
  SELECT count(*), max(pg_get_expr(i.indpred, i.indrelid))
    INTO v_have, v_pred
    FROM pg_index i
   WHERE i.indexrelid = to_regclass('public.media_doc_vec4096_hnsw_idx')
     AND i.indpred IS NOT NULL;
  IF v_have <> 1 THEN
    RAISE EXCEPTION '014: media_doc_vec4096_hnsw_idx 不存在或不是部分索引';
  END IF;
  IF v_pred NOT LIKE '%embedding_4096 IS NOT NULL%' OR v_pred NOT LIKE '%superseded_at IS NULL%' THEN
    RAISE EXCEPTION '014: 索引谓词不是 (embedding_4096 is not null and superseded_at is null)：%', v_pred;
  END IF;
  SELECT am.amname INTO v_am
    FROM pg_class c JOIN pg_am am ON am.oid = c.relam
   WHERE c.oid = to_regclass('public.media_doc_vec4096_hnsw_idx');
  IF v_am IS DISTINCT FROM 'hnsw' THEN
    RAISE EXCEPTION '014: media_doc_vec4096_hnsw_idx 的访问方法是 %（应为 hnsw）', coalesce(v_am, 'missing');
  END IF;

  -- 6.3 upsert 认得 embedding_4096，且冲突目标仍是主键四列（漏掉任何一条都会在运行时才炸）
  SELECT pg_get_functiondef(p.oid) INTO v_fndef
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'upsert_media_doc';
  IF v_fndef IS NULL THEN
    RAISE EXCEPTION '014: upsert_media_doc 不存在';
  END IF;
  IF v_fndef NOT LIKE '%embedding_4096%' THEN
    RAISE EXCEPTION '014: upsert_media_doc 不认 embedding_4096';
  END IF;
  IF v_fndef NOT LIKE '%ON CONFLICT (company_key, media_key, analyzer_ver, shot_index)%' THEN
    RAISE EXCEPTION '014: upsert_media_doc 的 ON CONFLICT 目标不是主键四列';
  END IF;

  -- 6.4 media_search_4096 只有一个签名，参数与返回列都是契约形状
  SELECT count(*) INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'media_search_4096';
  IF v_bad <> 1 THEN
    RAISE EXCEPTION '014: media_search_4096 有 % 个签名（应当恰好 1 个）', v_bad;
  END IF;
  SELECT pg_get_function_identity_arguments(p.oid), pg_get_function_result(p.oid)
    INTO v_args, v_result
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'media_search_4096';
  IF v_args IS DISTINCT FROM 'p_company_key text, p_query text, p_filters jsonb, p_embedding vector, p_limit integer' THEN
    RAISE EXCEPTION '014: media_search_4096 的参数是 (%)，契约要求 (p_company_key text, p_query text, p_filters jsonb, p_embedding vector, p_limit integer)', v_args;
  END IF;
  IF v_result NOT LIKE '%match_kind text%' OR v_result NOT LIKE '%score real%'
     OR v_result NOT LIKE '%duration_ms integer%' THEN
    RAISE EXCEPTION '014: media_search_4096 的返回列不是契约形状（需要 score real / duration_ms integer / match_kind text）';
  END IF;
  -- 768 那条通路没被这次改动弄丢（014 只加第二条）
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'media_search'
  ) THEN
    RAISE EXCEPTION '014: media_search 不见了（014 不改 768 那条通路）';
  END IF;

  -- 6.5 anon 不能执行新函数（010 的口径：漏 token 必须 42501）
  SELECT count(*) INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('upsert_media_doc', 'media_search_4096')
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_bad > 0 THEN
    RAISE EXCEPTION '014: anon 仍可执行 % 个 media_* 函数', v_bad;
  END IF;

  RAISE NOTICE '014: media_doc.embedding_4096 vector(4096) + 部分 HNSW（前 4000 维 halfvec 表达式索引，谓词 embedding_4096 is not null and superseded_at is null）+ upsert_media_doc（两条向量列并存）+ media_search_4096 OK';
END
$$;
