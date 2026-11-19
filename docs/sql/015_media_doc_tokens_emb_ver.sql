-- 015 两件事：① 词法分支会切词（多词查询的**真缺陷**）；② `embedding_ver_4096`（4096 列自己的模型标签）。
--
-- ① 为什么（实测，不是推测）：`media_search('柠檬宝藏茶 外包装', p_embedding => null)` → **0 条**，
--    而 `media_search('柠檬宝藏茶', …)` → 20 条。原因不在语料，在 012:451 那一行：
--    `v_like := '%' || <整个 p_query> || '%'`，于是查询变成 `text ILIKE '%柠檬宝藏茶 外包装%'` ——
--    库里没有任何一行的 text/name 含**这个带空格的整串**。用户最自然的输入恰好是多词，所以词法分支
--    （三路里唯一在 p_embedding 为 NULL 时还能答话的两路）对多词查询等于不存在。
--    同一份快照上的旁证（改前实测）：
--      select count(*) from media_doc where superseded_at is null and text ilike '%茶汤%';  -- 5325
--      select count(*) from media_doc where superseded_at is null and text ilike '%特写%';  -- 7922
--      media_search('茶汤特写', null)                                                       -- 0 条
--    两个词各自都有几千行，连起来 0 条 —— 修法只有切词：`regexp_split_to_array(btrim(p_query), '\s+')`。
--
-- ② 为什么（B）：014 的 4096 列没有自己的版本列，而 `embedding_ver` 是**行属性**、只描述 768 那一列
--    （012:108-109）。run-8b.md §6 第 2 条把这个代价写得很准：全量 4096 想沿用同一行（两列并存、不取代 768）
--    就得写同一个 analyzer_ver，而那样 `embedding_ver` 会被改写成 8B 的串 —— 768 列的模型标签当场变错。
--    所以 4096 列需要自己的标签：`embedding_ver_4096`。upsert 的口径随之与 768 那条对齐
--    「给了向量就必须给它的模型版本，缺了 23514」；`embedding`/`embedding_ver` 的语义一个字没动。
--
-- 本文件只做五件事，**不重建** 012/013/014 里别的东西：
--   1. `alter table … add column if not exists embedding_ver_4096 text`（只加列）+ 回填已有的 4096 行；
--   2. `upsert_media_doc`：4096 那条要求 `embedding_ver_4096`（23514），其余（冲突目标/取代/幂等）逐条不变；
--   3. `media_search`（768 那条）：p_query 切词，**每个 token 都要命中**；
--   4. `media_search_4096`：同一套切词，逐字对齐第 3 条；
--   5. 契约同步：contract.json / docs/contracts/media-doc.schema.json / docs/sql/README.md
--      （RPC 名字与返回列都没变，`packages/openfilm/src/index-client.mjs` 的 RPC_NAMES 因此不动）。
--
-- 分词的口径（三条，都能在下面的 SQL 里逐字对上）：
--   * token 全集 = `regexp_split_to_array(btrim(p_query), '\s+')` 去掉空串；空查询/纯空白 → token 集为空
--     → **不加任何词法条件**（词法两路整体不参与，只回向量路的结果，与改前一致）；
--   * 命中判据分两档，逐 token 各算一次：
--       子串档：`text ILIKE '%token%'` 或 `name ILIKE '%token%'` 或 `batch/product/gname = token`（012 的原谓词，逐字保留）；
--       trigram 档：再或上 `token <% text` / `token <% name`（word-trigram）—— 正是它让"茶汤"能命中
--       "…茶汤特写…"这类长正文里的一个词；
--     ilike 那一路要求**全部 token 走子串档**，trigram 那一路要求**全部 token 至少走一档**；
--   * 词法分数 = 命中 token 数 / token 总数。因为上面要求"全部命中"，这个比值落在 1.0 上 ——
--     公式照写（`sub_hits / v_token_count`），代价是把"为什么恒为 1.0"写在注释里，而不是留一个说不清的常数。
--     单 token 时它逐字等于改前的 1.0 / similarity，见下一条。
--
-- 「单 token 行为与改前等价」是怎么保证的（不是靠运气）：
--   * ilike 路：单 token 时谓词 = 012:490-494 的原谓词，分数 = 1.0 —— 逐字相同；
--   * trigram 路：单 token 时**仍用改前的 `text % p_query` 判据与 similarity 分数**（CASE 分支里写死）。
--     多 token 才换成"每个 token 至少一档 + word-trigram"。这一条不是洁癖：`%`（整串 similarity）与
--     `<%`（word_similarity）在单 token 上不等价，混用会把 trigram 路在 v_k 的截断处悄悄换人。
--
-- 幂等：`ADD COLUMN IF NOT EXISTS` / 回填带 `IS NULL` 守卫 / `CREATE OR REPLACE FUNCTION`；第二轮是 no-op。

-- ---------------------------------------------------------------------------
-- 0. 前置断言：顺序（012/014 必须先跑）、两条向量列都在、扩展与角色。
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_dims   integer;
  v_dims49 integer;
BEGIN
  IF to_regclass('public.media_doc') IS NULL THEN
    RAISE EXCEPTION '015: 缺少 public.media_doc，请先按顺序跑 012 / 013 / 014';
  END IF;
  SELECT a.atttypmod INTO v_dims
    FROM pg_attribute a
   WHERE a.attrelid = 'public.media_doc'::regclass AND a.attname = 'embedding';
  IF v_dims IS DISTINCT FROM 768 THEN
    RAISE EXCEPTION '015: media_doc.embedding 的 typmod 是 %（015 只加 4096 的版本列，768 列必须还在）',
      coalesce(v_dims::text, 'missing');
  END IF;
  SELECT a.atttypmod INTO v_dims49
    FROM pg_attribute a
   WHERE a.attrelid = 'public.media_doc'::regclass AND a.attname = 'embedding_4096';
  IF v_dims49 IS DISTINCT FROM 4096 THEN
    RAISE EXCEPTION '015: media_doc.embedding_4096 的 typmod 是 %（请先跑 014）', coalesce(v_dims49::text, 'missing');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    RAISE EXCEPTION '015: 缺少 pg_trgm（分词后的 trigram 档要它），请先跑 001';
  END IF;
  IF to_regprocedure('public.media_search(text, text, jsonb, vector, integer)') IS NULL
     OR to_regprocedure('public.media_search_4096(text, text, jsonb, vector, integer)') IS NULL THEN
    RAISE EXCEPTION '015: 缺少 media_search / media_search_4096，请先跑 012 / 014（015 只改词法与版本列）';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'orange_app') THEN
    RAISE EXCEPTION '015: 缺少 authenticated / service_role / orange_app 角色，请先跑 004/008';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 1. 加列 + 回填：4096 列自己的模型版本（`embedding_ver` 继续只描述 768 列）。
--    nullable，因为 768 的行本来就没有"4096 的答案"，反之亦然 —— 与两条向量列同一口径。
-- ---------------------------------------------------------------------------
ALTER TABLE public.media_doc ADD COLUMN IF NOT EXISTS embedding_ver_4096 text;

COMMENT ON COLUMN public.media_doc.embedding_ver_4096 IS
  '4096 维那一列的嵌入模型版本（如 qwen3-embedding-8b）。与 embedding_ver(768) 各说各的列：向量可比性的前提是模型版本，两列并存时不能共用一个标签。';

-- 回填：014 那一批已经落地的 5 000 行，它们的模型就是 run-8b.md 记的 qwen3-embedding-8b。
-- 守卫 `IS NULL`：重跑是 no-op；将来别人给 4096 向量却带了别的版本，不会被这条改回去。
UPDATE public.media_doc d
   SET embedding_ver_4096 = 'qwen3-embedding-8b'
 WHERE d.embedding_4096 IS NOT NULL
   AND d.embedding_ver_4096 IS NULL;

-- ---------------------------------------------------------------------------
-- 2. upsert_media_doc：4096 那条要求自己的版本列。
--    与 014 的差异只有四处（其余逐条不变：冲突目标 = 主键四列、取代按 created_at、正文变了就清两条向量）：
--      (a) 解析 `embedding_ver_4096`；给 `embedding_4096` 却没给它 → 23514（与 768 那条同口径）；
--          不再要求 `embedding_ver` —— 4096 的写入不该顺手改写 768 的标签（这正是 run-8b.md §6 第 2 条的代价）；
--      (b) INSERT 列 + ON CONFLICT 的 SET 各多一列（正文变了 ⇒ 两条向量的版本也都是旧正文的答案，一起换）；
--      (c) 幂等 WHERE：版本比较改成"调用方给了这个版本才比"。
--          为什么必须改：coexist 写（只给 embedding_4096 + embedding_ver_4096）在旧判据下每次都会命中
--          `d.embedding_ver IS DISTINCT FROM excluded.embedding_ver`（NULL ⇄ 有值），于是 66k 行每跑一次
--          都把 updated_at 刷一遍 —— 而"逐行幂等"是 012:30-36 写下的不变量。调用方不给的版本因此不再触发写；
--          给了不同版本、正文变了、向量从空变非空，这三类照旧触发。
--      (d) 回执：`vectors` 之外多一个 `versions`（说清这次落的是哪条版本列），不新增别的键。
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
  v_emb_ver49  text := nullif(btrim(coalesce(p_row ->> 'embedding_ver_4096', '')), '');
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
  -- 维度先按裸 vector 解析再断言 768 —— 不让 pgvector 在 `<=>` 处才抛晦涩的维度错误。015 起语义不变。
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

  -- 向量（4096，014/015）：数组与文本两种写法都吃（调用方给数组更自然，`psql` 手工抄一份文本也照样能用）。
  -- 数组走 jsonb_array_elements_text → `[a,b,…]` 文本再解析：多的是一次往返内的字符串拼装，
  -- 换来的是"数组不用调用方自己拼 JSON 字符串"这条最常被踩的坑。
  IF jsonb_typeof(p_row -> 'embedding_4096') IS NOT NULL
     AND jsonb_typeof(p_row -> 'embedding_4096') <> 'null' THEN
    -- 015：4096 要的是**它自己的**版本列。缺了就是 23514 —— 与 768 那条同口径，不再借 embedding_ver。
    IF v_emb_ver49 IS NULL THEN
      RAISE EXCEPTION 'upsert_media_doc: embedding_4096 needs embedding_ver_4096' USING ERRCODE = '23514';
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
    embedding_ver_4096, created_at, updated_at
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
    v_emb_ver49,
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
    -- 015：版本列跟着各自的向量列走，同样的两条 CASE。
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
    embedding_ver_4096 = CASE WHEN d.text IS DISTINCT FROM excluded.text
                              THEN excluded.embedding_ver_4096
                              ELSE coalesce(excluded.embedding_ver_4096, d.embedding_ver_4096) END,
    updated_at  = now()
  -- 幂等：正文没变、调用方也没给新版本、两条向量都没"从空变非空" → 整行不动（updated_at 也不刷新，同 007:351）。
  -- 015 起版本比较带上"调用方给了才比"的前缀（理由见本文件第 2 节 (c)）：coexist 写只带 4096 的版本，
  -- 不该因为"没带 768 的版本"每轮都算一次写。
  WHERE d.text          IS DISTINCT FROM excluded.text
     OR (excluded.embedding_ver IS NOT NULL AND d.embedding_ver IS DISTINCT FROM excluded.embedding_ver)
     OR (excluded.embedding_ver_4096 IS NOT NULL AND d.embedding_ver_4096 IS DISTINCT FROM excluded.embedding_ver_4096)
     OR (excluded.embedding IS NOT NULL AND d.embedding IS NULL)
     OR (excluded.embedding_4096 IS NOT NULL AND d.embedding_4096 IS NULL);

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
    -- 015：版本列**不清** —— 它记录"这行曾经是哪条模型的答案"，与向量本身的可再算性是两件事。
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
    'written',            v_written > 0,     -- false = 幂等命中（text/版本/向量都没带来变化，updated_at 没动）
    'superseded',         v_superseded,
    'supersededVersions', to_jsonb(coalesce(v_old_vers, '{}'::text[])),
    -- 014：回执里说清"这次落的是哪一列"，客户端不用再猜（也不新增键以外的东西）。
    'vectors',            to_jsonb(array_remove(ARRAY[
                            CASE WHEN v_emb      IS NOT NULL THEN 'embedding' END,
                            CASE WHEN v_emb4096  IS NOT NULL THEN 'embedding_4096' END
                          ], NULL)),
    -- 015：版本列同理，谁给了写谁（两条向量各自一个模型标签）。
    'versions',           to_jsonb(array_remove(ARRAY[
                            CASE WHEN v_emb_ver   IS NOT NULL THEN 'embedding_ver' END,
                            CASE WHEN v_emb_ver49 IS NOT NULL THEN 'embedding_ver_4096' END
                          ], NULL))
  );
END
$$;

COMMENT ON FUNCTION public.upsert_media_doc(jsonb) IS
  '写一个可检索文档（asset|shot）：必填 media_key/gran/text；冲突目标 = 主键四列；text/版本/向量都没变则整行不动；同一 gran 内有新版本落地时把更旧行的两条向量（768/4096）都置空并记 superseded_at（按 created_at 判新旧，不比版本字符串）。015 起 embedding 与 embedding_4096 各带自己的版本列（embedding_ver / embedding_ver_4096），给向量就必须给对应版本（23514）。';

-- ---------------------------------------------------------------------------
-- 3. media_search（768 那条）：p_query 切词，每个 token 都要命中。
--
--    谓词与分数逐字对照改前的 012:450-508 —— 单 token 时两者等价，多 token 时是"全部命中"：
--      tok           token 全集（去掉空串），以及每个 token 自己那份转义好的 LIKE 串；
--      scored        每行两个计数：sub_hits（走子串档的 token 数）/ any_hits（子串档或 word-trigram 档）；
--      lex_ilike     要求 sub_hits = token 数，分数 = sub_hits / token 数（= 1.0，与改前同一个数）；
--      lex_trigram   要求 any_hits = token 数；分数单 token 时仍是 similarity（改前口径），
--                    多 token 时按"命中数 / 总数"（恒 1.0，因为上面要求全命中）。
--    空查询/纯空白：token 集为空 → `v_query` 置 NULL → 两路都不产出（不加词法条件，只回向量路）。
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
  v_session     text := public.app_tenant_key();
  v_query       text := nullif(btrim(coalesce(p_query, '')), '');
  v_filters     jsonb := CASE WHEN jsonb_typeof(p_filters) = 'object' THEN p_filters ELSE '{}'::jsonb END;
  v_limit       integer := greatest(1, least(coalesce(p_limit, 20), 100));
  v_k           integer;
  v_tokens      text[] := '{}'::text[];
  v_like_tokens text[] := '{}'::text[];
  v_token_count integer := 0;
  v_dims        integer;
  v_has_trgm    boolean := EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm');
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

  -- 切词（015）：词法两路都按 token 走。空/纯空白查询 → 不加词法条件（只回向量路）。
  IF v_query IS NOT NULL THEN
    -- 注意 `regexp_split_to_array` 本身返回 text[]（是**标量**）：直接 `FROM regexp_split_to_array(...) AS t`
    -- 会把整条数组当成一行的值，`t <> ''` 就变成"把 '' 转成 text[]"（实测报 malformed array literal）。
    -- 所以要 unnest 一次才是"每个 token 一行"。
    v_tokens := ARRAY(
      SELECT t FROM unnest(regexp_split_to_array(btrim(p_query), '\s+')) AS t WHERE t <> '');
    IF coalesce(array_length(v_tokens, 1), 0) = 0 THEN
      v_query := NULL;                       -- 只有分隔符的查询与空查询同义
    ELSE
      v_token_count := array_length(v_tokens, 1);
      -- 每个 token 各自转义 LIKE 的元字符，否则用户输入的 % / _ 会变成通配符（把"%"查成全表）：
      -- 与 012:450-451 同一口径，只是从"整串一次"变成"逐 token 一次"。
      v_like_tokens := ARRAY(
        SELECT '%' || replace(replace(replace(t, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%'
          FROM unnest(v_tokens) AS t);
    END IF;
  END IF;

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
  -- token 全集（含每个 token 的 LIKE 串）。两个数组同序等长，所以一次 unnest 就是一张表。
  tok AS (
    SELECT u.token, u.like_pattern
      FROM unnest(v_tokens, v_like_tokens) AS u(token, like_pattern)
  ),
  -- 每行对 token 集的两种命中计数。CASE 短路：没有查询时不算（78k 行不该为一条不存在的词付钱）。
  scored AS (
    SELECT b.*,
           CASE WHEN v_query IS NULL THEN 0::bigint ELSE
             (SELECT count(*) FROM tok t
               WHERE b.text    ILIKE t.like_pattern
                  OR b.name    ILIKE t.like_pattern
                  OR b.batch   = t.token
                  OR b.product = t.token
                  OR b.gname   = t.token)
           END AS sub_hits,
           CASE WHEN v_query IS NULL THEN 0::bigint ELSE
             (SELECT count(*) FROM tok t
               WHERE b.text    ILIKE t.like_pattern
                  OR b.name    ILIKE t.like_pattern
                  OR b.batch   = t.token
                  OR b.product = t.token
                  OR b.gname   = t.token
                  OR t.token <% b.text
                  OR t.token <% coalesce(b.name, ''))
           END AS any_hits
      FROM base b
  ),
  -- 向量分支按 gran 拆两条：部分 HNSW 只有在这个 CTE 里写死 `gran = ...` 时才会被选中
  -- （规划器要求查询谓词蕴含索引谓词），同时保证"同类才比 cosine"。
  vec_asset AS (
    SELECT b.media_key, b.gran, b.video_id, b.shot_index, b.name, b.batch, b.product, b.gname,
           b.duration_ms, b.text, b.embedding,
           greatest(0::real, (1 - (b.embedding <=> p_embedding))::real) AS score,
           'vector'::text AS match_kind
      FROM base b
     WHERE p_embedding IS NOT NULL AND b.gran = 'asset' AND b.embedding IS NOT NULL
     ORDER BY b.embedding <=> p_embedding, b.media_key
     LIMIT v_k
  ),
  vec_shot AS (
    SELECT b.media_key, b.gran, b.video_id, b.shot_index, b.name, b.batch, b.product, b.gname,
           b.duration_ms, b.text, b.embedding,
           greatest(0::real, (1 - (b.embedding <=> p_embedding))::real) AS score,
           'vector'::text AS match_kind
      FROM base b
     WHERE p_embedding IS NOT NULL AND b.gran = 'shot' AND b.embedding IS NOT NULL
     ORDER BY b.embedding <=> p_embedding, b.media_key, b.shot_index
     LIMIT v_k
  ),
  -- 词法二路之一：**每个** token 都子串命中（以及批次/产品/分组等于该 token 的"结构化等值"命中）。
  -- 单 token 时 sub_hits = 1 = token 数 ⇔ 012:490-494 的原谓词，分数同为 1.0。
  lex_ilike AS (
    SELECT s.media_key, s.gran, s.video_id, s.shot_index, s.name, s.batch, s.product, s.gname,
           s.duration_ms, s.text, s.embedding,
           (s.sub_hits::real / v_token_count::real) AS score,   -- 命中 token 数 / token 总数（要求全命中，故恒 1.0）
           'ilike'::text AS match_kind
      FROM scored s
     WHERE v_query IS NOT NULL
       AND s.sub_hits = v_token_count
     ORDER BY s.media_key, s.shot_index
     LIMIT v_k
  ),
  -- 词法二路之二：**每个** token 至少命中一档（子串档，或 token <% text 的 word-trigram 档）。
  -- 单 token 时判据与分数**退回改前的写法**（`text % p_query` + similarity）：`%` 与 `<%` 在单 token 上
  -- 不等价，混用会让 trigram 路在 v_k 的截断处换人 —— 那不是修 bug，是换个地方出 bug。
  lex_trigram AS (
    SELECT s.media_key, s.gran, s.video_id, s.shot_index, s.name, s.batch, s.product, s.gname,
           s.duration_ms, s.text, s.embedding,
           CASE WHEN v_token_count = 1
                THEN coalesce(greatest(similarity(s.text, v_query),
                                       similarity(coalesce(s.name, ''), v_query)), 0)::real
                ELSE (s.any_hits::real / v_token_count::real) END AS score,
           'trigram'::text AS match_kind
      FROM scored s
     WHERE v_has_trgm AND v_query IS NOT NULL
       AND (CASE WHEN v_token_count = 1
                 THEN (s.text % v_query OR s.name % v_query)
                 ELSE s.any_hits = v_token_count END)
     ORDER BY score DESC, s.media_key, s.shot_index
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
              (m.match_kind = 'ilike') DESC,   -- 015：同分时确定性子串优先于相似度估计（多 token 两路都是 1.0）
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
  '统一检索（素材级+镜头级同表）：向量/词法两路（ILIKE、trigram）混合，每行带 match_kind，按 media_key 去重（shot 优先）；p_query 按空白切词，词法要求每个 token 都命中（015）；p_embedding 为 NULL 时只走词法；返回列不含本地可用性。';

-- ---------------------------------------------------------------------------
-- 4. media_search_4096：与 media_search **同语义**，只是向量那一路换成 4096 列。
--    词法部分与第 3 节逐字同形（同一套 tok / scored / lex_ilike / lex_trigram），
--    向量部分保持 014 的 cand_* → vec_* 两段（索引表达式必须逐字一致才会被选中，见 014:397-403）。
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
  v_session     text := public.app_tenant_key();
  v_query       text := nullif(btrim(coalesce(p_query, '')), '');
  v_filters     jsonb := CASE WHEN jsonb_typeof(p_filters) = 'object' THEN p_filters ELSE '{}'::jsonb END;
  v_limit       integer := greatest(1, least(coalesce(p_limit, 20), 100));
  v_k           integer;
  v_tokens      text[] := '{}'::text[];
  v_like_tokens text[] := '{}'::text[];
  v_token_count integer := 0;
  v_dims        integer;
  v_has_trgm    boolean := EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm');
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

  -- 切词（015）：口径与 media_search 逐字相同（空/纯空白 → 不加词法条件）。
  IF v_query IS NOT NULL THEN
    v_tokens := ARRAY(
      SELECT t FROM unnest(regexp_split_to_array(btrim(p_query), '\s+')) AS t WHERE t <> '');
    IF coalesce(array_length(v_tokens, 1), 0) = 0 THEN
      v_query := NULL;
    ELSE
      v_token_count := array_length(v_tokens, 1);
      v_like_tokens := ARRAY(
        SELECT '%' || replace(replace(replace(t, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%'
          FROM unnest(v_tokens) AS t);
    END IF;
  END IF;

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
  tok AS (
    SELECT u.token, u.like_pattern
      FROM unnest(v_tokens, v_like_tokens) AS u(token, like_pattern)
  ),
  scored AS (
    SELECT b.*,
           CASE WHEN v_query IS NULL THEN 0::bigint ELSE
             (SELECT count(*) FROM tok t
               WHERE b.text    ILIKE t.like_pattern
                  OR b.name    ILIKE t.like_pattern
                  OR b.batch   = t.token
                  OR b.product = t.token
                  OR b.gname   = t.token)
           END AS sub_hits,
           CASE WHEN v_query IS NULL THEN 0::bigint ELSE
             (SELECT count(*) FROM tok t
               WHERE b.text    ILIKE t.like_pattern
                  OR b.name    ILIKE t.like_pattern
                  OR b.batch   = t.token
                  OR b.product = t.token
                  OR b.gname   = t.token
                  OR t.token <% b.text
                  OR t.token <% coalesce(b.name, ''))
           END AS any_hits
      FROM base b
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
  -- 词法二路之一：每个 token 都子串命中（判据与分数同第 3 节）。
  lex_ilike AS (
    SELECT s.media_key, s.gran, s.video_id, s.shot_index, s.name, s.batch, s.product, s.gname,
           s.duration_ms,
           (s.sub_hits::real / v_token_count::real) AS score,
           'ilike'::text AS match_kind
      FROM scored s
     WHERE v_query IS NOT NULL
       AND s.sub_hits = v_token_count
     ORDER BY s.media_key, s.shot_index
     LIMIT v_k
  ),
  -- 词法二路之二：每个 token 至少命中一档（单 token 时退回改前的 `%` + similarity）。
  lex_trigram AS (
    SELECT s.media_key, s.gran, s.video_id, s.shot_index, s.name, s.batch, s.product, s.gname,
           s.duration_ms,
           CASE WHEN v_token_count = 1
                THEN coalesce(greatest(similarity(s.text, v_query),
                                       similarity(coalesce(s.name, ''), v_query)), 0)::real
                ELSE (s.any_hits::real / v_token_count::real) END AS score,
           'trigram'::text AS match_kind
      FROM scored s
     WHERE v_has_trgm AND v_query IS NOT NULL
       AND (CASE WHEN v_token_count = 1
                 THEN (s.text % v_query OR s.name % v_query)
                 ELSE s.any_hits = v_token_count END)
     ORDER BY score DESC, s.media_key, s.shot_index
     LIMIT v_k
  ),
  merged AS (
    SELECT * FROM vec_asset
    UNION ALL SELECT * FROM vec_shot
    UNION ALL SELECT * FROM lex_ilike
    UNION ALL SELECT * FROM lex_trigram
  ),
  ranked AS (
    SELECT DISTINCT ON (m.media_key) m.*
      FROM merged m
     ORDER BY m.media_key,
              (m.gran = 'shot') DESC,
              m.score DESC,
              (m.match_kind = 'vector') DESC,
              (m.match_kind = 'ilike') DESC,   -- 015：同分时确定性子串优先于相似度估计（多 token 两路都是 1.0）
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
  '统一检索（4096 维那一侧）：向量/词法两路（ILIKE、trigram）混合，每行带 match_kind，按 media_key 去重（shot 优先）；p_query 按空白切词，词法要求每个 token 都命中（015）；向量候选走 media_doc_vec4096_hnsw_idx（前 4000 维 halfvec），分数按完整 4096 维重排；p_embedding 为 NULL 时只走词法；返回列不含本地可用性。';

-- ---------------------------------------------------------------------------
-- 5. 权限：只复核，不改口径（012:537-548 / 014:563-573 的口径逐条保留）。
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.upsert_media_doc(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_media_doc(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.media_search(text, text, jsonb, vector, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.media_search(text, text, jsonb, vector, integer) FROM anon;
REVOKE ALL ON FUNCTION public.media_search_4096(text, text, jsonb, vector, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.media_search_4096(text, text, jsonb, vector, integer) FROM anon;

GRANT EXECUTE ON FUNCTION public.upsert_media_doc(jsonb) TO authenticated, service_role, orange_app;
GRANT EXECUTE ON FUNCTION public.media_search(text, text, jsonb, vector, integer)
  TO authenticated, service_role, orange_app;
GRANT EXECUTE ON FUNCTION public.media_search_4096(text, text, jsonb, vector, integer)
  TO authenticated, service_role, orange_app;

-- ---------------------------------------------------------------------------
-- 6. 收尾断言：读系统目录 + 读函数体（不靠手数）。失败信息直接指向要查的地方。
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_bad    integer;
  v_type   text;
  v_src    text;
  v_left   integer;
BEGIN
  -- 6.1 新列在，而且是 text（不是 vector —— 它存的是模型版本，不是向量）。
  SELECT format_type(a.atttypid, a.atttypmod) INTO v_type
    FROM pg_attribute a
   WHERE a.attrelid = 'public.media_doc'::regclass AND a.attname = 'embedding_ver_4096';
  IF v_type IS DISTINCT FROM 'text' THEN
    RAISE EXCEPTION '015: media_doc.embedding_ver_4096 的类型是 %（契约要求 text）', coalesce(v_type, 'missing');
  END IF;

  -- 6.2 回填完整：没有"有 4096 向量却没有 4096 版本"的行。
  SELECT count(*) INTO v_bad FROM public.media_doc d
   WHERE d.embedding_4096 IS NOT NULL AND d.embedding_ver_4096 IS NULL;
  IF v_bad > 0 THEN
    RAISE EXCEPTION '015: 还有 % 行有 embedding_4096 而 embedding_ver_4096 为空（回填没走完）', v_bad;
  END IF;

  -- 6.3 两个检索函数各只有一个签名，返回列仍是契约形状（014:638-655 的口径）。
  SELECT count(*) INTO v_left
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'media_search';
  IF v_left <> 1 THEN
    RAISE EXCEPTION '015: media_search 有 % 个签名（应当恰好 1 个）', v_left;
  END IF;
  SELECT count(*) INTO v_left
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'media_search_4096';
  IF v_left <> 1 THEN
    RAISE EXCEPTION '015: media_search_4096 有 % 个签名（应当恰好 1 个）', v_left;
  END IF;

  -- 6.4 分词确实落进了函数体（读 pg_get_functiondef，不读磁盘上的文件）：
  --     两个检索函数都要有 regexp_split_to_array 与 word-trigram 的 `<%`；upsert 要认 embedding_ver_4096。
  SELECT count(*) INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('media_search', 'media_search_4096')
     AND pg_get_functiondef(p.oid) LIKE '%regexp_split_to_array%'
     AND pg_get_functiondef(p.oid) LIKE '%<% b.text%';
  IF v_bad <> 2 THEN
    RAISE EXCEPTION '015: 只有 % 个检索函数带上了分词（要求 2 个：media_search / media_search_4096）', v_bad;
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'upsert_media_doc';
  IF v_src NOT LIKE '%embedding_ver_4096%' OR v_src NOT LIKE '%23514%' THEN
    RAISE EXCEPTION '015: upsert_media_doc 的函数体里没有 embedding_ver_4096 的 23514 断言';
  END IF;

  -- 6.5 anon 零权限（010 的默认收回 + 本文件显式 REVOKE 之后仍然成立）。
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    SELECT count(*) INTO v_bad
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('upsert_media_doc', 'media_search', 'media_search_4096')
       AND has_function_privilege('anon', p.oid, 'EXECUTE');
    IF v_bad > 0 THEN
      RAISE EXCEPTION '015: anon 仍能 EXECUTE % 个函数（契约要求 0）', v_bad;
    END IF;
  END IF;

  RAISE NOTICE '015: embedding_ver_4096（text，已回填）、upsert_media_doc（4096 带自己的版本，23514）、media_search / media_search_4096（逐 token 全命中）OK';
END
$$;
