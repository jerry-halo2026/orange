-- 013 media_doc 的主键补 shot_index：同一素材同一版本内多镜头并存。
--
-- 为什么必须改（P4 逐镜头分析的硬前置，见 docs/execution/2026-11-17-retrieval/analysis.md §2.4）：
--   012 的 PK 是 (company_key, media_key, analyzer_ver)，**同一素材同一版本只能存一条行**。
--   Qwen-VL 逐镜头分析写 shot_index=1 时命中 shot_index=0 那行的 ON CONFLICT，把它就地改写：
--   第 2 帧覆盖第 1 帧，N 个镜头永远只剩最后一个。粒度是行属性，那么粒度身份就必须进主键。
--
-- 本文件只改三件事，其余语义一律不动：
--   1. shot_index → integer not null default 0（asset 行恒 0；shot 行 0..N）。
--      * 为什么不留 NULL：NULL 在唯一索引/主键里**互不相等**（PG 默认 NULLS DISTINCT），
--        asset 行可以无限重复写入 —— 主键就不再是主键。0 是一个值，冲突才真的冲突。
--      * "asset 没有镜头"改由 shot_index = 0 + CHECK 表达，不再靠 NULL。
--   2. PK → (company_key, media_key, analyzer_ver, shot_index)。
--   3. media_doc_gran_shape：asset ⇒ shot_index = 0（012 是 asset ⇒ shot_index IS NULL）。
--   upsert_media_doc 的 ON CONFLICT 目标换成新主键四列、asset 行显式写 0；
--   幂等判定 / embedding_ver 校验 / 768 断言 / 按 created_at 取代 / 取代只收窄同一 gran —— 逐条不变。
--   media_search 不重建：它的 DISTINCT ON (media_key) 排序键本来就带 shot_index 兜底（012:517-525），
--   shot 多行时仍按 (shot 优先, score DESC, vector 优先, shot_index) 取一行 —— 见本文件 §4 的说明。
--
-- **一条升格为主键层面的不变量**（写在这里，因为 013 之后它就是约束而不是约定）：
--   同一 media_key 的 asset 文档与 shot 文档必须用**不同的 analyzer_ver**。
--   asset 行 shot_index 恒 0，若第 0 帧 shot 用同一个 ver，二者就是同一个主键。
--   现实里两条管线的 ver 本来就不同（card-meta-1 / analyze-runner-N vs qwen-vl-shots-1）；
--   万一撞上，函数入口用 23505 明确拒绝，**不做**"把 asset 行就地改写成 shot 行"的静默合并
--   （那等于悄悄丢掉整条素材的卡片文档）。
--
-- 可重入（本机已有测试数据已 truncate、线上为空，但脚本不押这个）：
--   整段 DDL 在一个 DO 块里 —— 单条语句 = 单事务，先 DROP PK、再改列、最后 ADD PK；
--   第二轮执行等价于"拆了再装回去"，不会因为"已有主键 / 默认值已存在 / NOT NULL 已生效"失败。
--   列的收敛顺序不能反：旧 CHECK 要在回填 NULL→0 **之前**摘掉，否则现存 asset 行会被自己的约束拦住。
--
-- 契约（同批更新，别只改这里）：
--   * docs/sql/contract.json —— tables.media_doc.pk/note 与 rpc.upsert_media_doc（含 conflict 目标）；
--   * docs/contracts/media-doc.schema.json —— $defs.row.shot_index；
--   * docs/sql/README.md —— 迁移表与 §7 的 media_doc 段。

-- ---------------------------------------------------------------------------
-- 0. 前置断言：顺序（012 必须先跑）、列齐全。
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_cols integer;
BEGIN
  IF to_regclass('public.media_doc') IS NULL THEN
    RAISE EXCEPTION '013: 缺少 public.media_doc，请先按顺序跑 012';
  END IF;
  SELECT count(*) INTO v_cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'media_doc'
     AND column_name IN ('company_key', 'media_key', 'analyzer_ver', 'gran', 'shot_index');
  IF v_cols <> 5 THEN
    RAISE EXCEPTION '013: media_doc 的列不全（company_key/media_key/analyzer_ver/gran/shot_index 只找到 % 个），012 的形状不对', v_cols;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 1. 改列 + 换主键 + 收形状约束（一个 DO 块 = 原子，要么全成要么全不成）。
--
--    顺序是有理由的，不是风格：
--      (a) 先摘 PK —— ADD PRIMARY KEY 要求表上没有主键；DROP CONSTRAINT IF EXISTS 保证第二轮不报错；
--      (b) 再摘旧的 gran_shape —— 它写着 asset ⇒ shot_index IS NULL，(c) 的回填会被它拦住；
--      (c) 列收敛：default 0 → 回填 ALL NULL 成 0 → SET NOT NULL（顺序不能换：
--          先 NOT NULL 再回填会在现存 asset 行上报 23502）；
--      (d) 装新 gran_shape（asset ⇒ 0；shot ⇒ >= 0）；
--      (e) 最后装四列主键（此时列已经是 NOT NULL，不会出现"主键隐含 NOT NULL 却与 CHECK 打架"）。
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_pk_name text;
  v_filled  integer := 0;
BEGIN
  -- (a) 摘主键。先按 012 的名字摘；再用 catalog 兜底（人工 SQL / 别的分支可能用了别的名字，
  --     而一个表只允许一个主键，留着它就是 ADD PRIMARY KEY 报 42P16）。
  ALTER TABLE public.media_doc DROP CONSTRAINT IF EXISTS media_doc_pk;
  SELECT con.conname INTO v_pk_name
    FROM pg_constraint con
   WHERE con.conrelid = 'public.media_doc'::regclass AND con.contype = 'p';
  IF v_pk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.media_doc DROP CONSTRAINT %I', v_pk_name);
  END IF;

  -- (b) 摘旧形状约束（见文件头"列的收敛顺序不能反"）。
  ALTER TABLE public.media_doc DROP CONSTRAINT IF EXISTS media_doc_gran_shape;

  -- (c) 列收敛：asset 行恒 0，shot 行 0..N。
  ALTER TABLE public.media_doc ALTER COLUMN shot_index SET DEFAULT 0;
  UPDATE public.media_doc SET shot_index = 0 WHERE shot_index IS NULL;
  GET DIAGNOSTICS v_filled = ROW_COUNT;
  ALTER TABLE public.media_doc ALTER COLUMN shot_index SET NOT NULL;

  -- (d) 形状约束（名字沿用 012 的 media_doc_gran_shape，只把 asset 分支从 IS NULL 改成 = 0）。
  --     NOT NULL 之上 shot 分支的 `shot_index >= 0` 就是"全部合法镜头号"。
  ALTER TABLE public.media_doc
    ADD CONSTRAINT media_doc_gran_shape CHECK (
      (gran = 'asset' AND shot_index = 0)
      OR (gran = 'shot' AND shot_index >= 0)
    );

  -- (e) 新主键：粒度身份 = (media_key, analyzer_ver, shot_index)。
  --     company_key 仍在最左（与 002/003/005 同一口径，RLS 与所有过滤都从它开始）。
  ALTER TABLE public.media_doc
    ADD CONSTRAINT media_doc_pk PRIMARY KEY (company_key, media_key, analyzer_ver, shot_index);

  RAISE NOTICE '013: media_doc 主键 → (company_key, media_key, analyzer_ver, shot_index)；shot_index NOT NULL DEFAULT 0（回填 % 行）；gran_shape: asset ⇒ 0', v_filled;
END
$$;

COMMENT ON COLUMN public.media_doc.shot_index IS
  '镜头序号：shot 行 0..N（按时间顺序）；asset 行恒 0（NOT NULL DEFAULT 0，CHECK media_doc_gran_shape）。013 起进主键 —— 同一素材同一版本的每个镜头各占一行。';

COMMENT ON CONSTRAINT media_doc_gran_shape ON public.media_doc IS
  '粒度决定形状：asset ⇒ shot_index = 0；shot ⇒ shot_index >= 0。013 把 asset 分支从 IS NULL 改成 = 0（NULL 在唯一索引里互不相等，主键会失效）。';

COMMENT ON CONSTRAINT media_doc_pk ON public.media_doc IS
  '可检索文档的身份：素材 × 版本 × 镜头号。asset 行 shot_index 恒 0，故 asset 文档与第 0 帧 shot 文档必须用不同的 analyzer_ver。';

-- ---------------------------------------------------------------------------
-- 2. upsert_media_doc：**只**换冲突目标（三列 → 四列）+ asset 行的 shot_index 写 0，其余逐条不变。
--
--    改了什么（对照 012:274-298 / 012:326-328）：
--      * ON CONFLICT (company_key, media_key, analyzer_ver) → (…, shot_index)：
--        不同 shot_index 现在是不同的行，不会再吃掉彼此的镜头；
--      * v_shot 默认 0（asset 行）；显式传非 0 的 asset 行 → 22023（把粒度搞混了，不要静默改数）；
--      * shot_index 不再出现在 DO UPDATE 的 SET 里 —— 它属于冲突目标，赋值恒等于原值；
--      * 回读 created_at 时补 shot_index —— 多镜头后同一 (media_key, ver) 有 N 行，
--        不带镜头号就是"随便挑一行"的 created_at 去裁决新旧（原写法没有 STRICT，不会报错，只会错）。
--      * 新增同 (media_key, ver, shot_index) 的跨粒度检查 → 23505（见文件头那条不变量）。
--    没改什么：必填校验、text+embedding_ver 幂等且不刷 updated_at、embedding 必须带 embedding_ver、
--    768 断言、按 created_at 判新旧（不比版本字符串）、取代只收窄同一 gran、返回信封。
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
    labels, duration_ms, author, source_kind, text, embedding_ver, embedding, created_at, updated_at
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

    -- 新版本落地 → 更旧的行退出检索：清空向量（正文留着，25 ms 可重算）+ 写 superseded_at。
    -- **不比较版本字符串**：`'qwen-vl-shots-1' > 'analyze-runner-2'` 是字典序伪序，
    --  `'analyze-runner-10' < 'analyze-runner-9'` 跨十位就翻车；新旧只由 created_at 裁决。
    -- 取代只在**同一 gran 内**发生：asset 行与 shot 行不是彼此的替代品，而是同一条素材的两种答案
    -- （"哪个素材" vs "哪一段"，analysis.md §2.2/§4.6）。同一个 media_key 的多个镜头行属于同一批答案：
    -- 换版本时整批（所有 shot_index）一起退出检索，不会只退掉某一帧留下半新半旧的镜头表。
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
  '写一个可检索文档（asset|shot）：必填 media_key/gran/text；冲突目标 = 主键四列 (company_key, media_key, analyzer_ver, shot_index)，同版本多镜头各占一行；text+embedding_ver 未变则整行不动；同一 gran 内有新版本落地时把更旧行的向量置空并记 superseded_at（按 created_at 判新旧，不比版本字符串）。';

-- ---------------------------------------------------------------------------
-- 3. 权限：CREATE OR REPLACE 保留既有 ACL，这里再显式收口一次 ——
--    保证"重放 013"/"新建库只跑到 013"两条路径上的授权形状相同（同 012 §6 的口径）。
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.upsert_media_doc(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_media_doc(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.upsert_media_doc(jsonb) TO authenticated, service_role, orange_app;

-- ---------------------------------------------------------------------------
-- 4. media_search：**不重建**，但把"多镜头之后它为什么仍然正确"记在这里（这是 013 的验收点之一）。
--
--    012 的去重段（012:509-530）：
--      ranked AS (SELECT DISTINCT ON (m.media_key) m.* FROM merged m
--                  ORDER BY m.media_key, (m.gran = 'shot') DESC, m.score DESC,
--                           (m.match_kind = 'vector') DESC, m.shot_index NULLS LAST)
--    * 同一个 media_key 现在可能有 shot 0..N 多行 + 一条 asset 行，全部进 merged；
--      DISTINCT ON (media_key) 对每个 media_key 只留排序后的第一行 ——
--    * shot 优先（`(gran='shot') DESC`）⇒ 只要这条素材有镜头文档，返回的就是镜头行；
--    * `score DESC` 在**同类内**比较（向量用 1-cosine、ilike 恒 1.0、trigram=similarity），
--      所以多镜头里胜出的是分数最高的那一帧 —— 正是本文件要保住的语义；
--    * `shot_index NULLS LAST` 是稳定 tiebreak：同分同 kind 时取镜头号最小的那帧，
--      否则 DISTINCT ON 的行是不确定的（同分多帧 → 每次查询可能换一帧，客户端看到抖动）。
--      013 之后 shot_index 恒非 NULL，这一项对 asset 行不再起作用，对 shot 行仍是唯一确定的决胜键。
--    * 外层再按 `(gran='shot') DESC, score DESC, media_key, shot_index` 排序（012:529），同理会稳定。
--    结论：排序键已经包含 shot_index，**不需要**为了多镜头再改函数（改动面越小，漂移面越小）。
--    仍在此断言它存在：013 只该改 upsert 的冲突目标，不该顺手弄丢检索面。
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'media_search'
  ) THEN
    RAISE EXCEPTION '013: media_search 不见了（它属于 012，本文件不重建它）';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 5. 收尾断言：全部读系统目录（不靠手数），失败信息直接指向要查的地方（同 012 §7 的风格）。
--    这里故意用 pg_get_functiondef 检查 ON CONFLICT 的字面目标 —— "改了主键却漏了函数"是本批
--    最容易犯的错，而它的症状是运行时 42P10（there is no unique or exclusion constraint matching
--    the ON CONFLICT specification），写入第二帧时才炸。
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_pk_count integer;
  v_cols     text;
  v_notnull  boolean;
  v_default  text;
  v_shape    text;
  v_fndef    text;
BEGIN
  -- 5.1 恰好一个主键，且是四列（顺序也要对：company_key 必须在最左）
  SELECT count(*) INTO v_pk_count
    FROM pg_constraint con
   WHERE con.conrelid = 'public.media_doc'::regclass AND con.contype = 'p';
  IF v_pk_count <> 1 THEN
    RAISE EXCEPTION '013: media_doc 的主键数量是 %（应当恰好 1 个）', v_pk_count;
  END IF;

  SELECT string_agg(a.attname, ',' ORDER BY k.ord) INTO v_cols
    FROM pg_constraint con
    JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
   WHERE con.conrelid = 'public.media_doc'::regclass AND con.contype = 'p';
  IF v_cols IS DISTINCT FROM 'company_key,media_key,analyzer_ver,shot_index' THEN
    RAISE EXCEPTION '013: 主键是 (%)，契约要求 (company_key,media_key,analyzer_ver,shot_index)', coalesce(v_cols, '空');
  END IF;

  -- 5.2 shot_index 是 NOT NULL DEFAULT 0
  SELECT a.attnotnull, pg_get_expr(ad.adbin, ad.adrelid)
    INTO v_notnull, v_default
    FROM pg_attribute a
    LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
   WHERE a.attrelid = 'public.media_doc'::regclass AND a.attname = 'shot_index' AND NOT a.attisdropped;
  IF v_notnull IS NOT TRUE THEN
    RAISE EXCEPTION '013: media_doc.shot_index 仍可为 NULL（主键里的 NULL 互不相等，会退化成非主键）';
  END IF;
  IF v_default IS DISTINCT FROM '0' THEN
    RAISE EXCEPTION '013: media_doc.shot_index 的默认值是 %（应为 0，asset 行靠它落 0）', coalesce(v_default, '(无)');
  END IF;

  -- 5.3 gran_shape 是 013 的形状：asset ⇒ 0 / shot ⇒ >= 0，且旧的 IS NULL 分支已经消失
  SELECT pg_get_constraintdef(con.oid) INTO v_shape
    FROM pg_constraint con
   WHERE con.conrelid = 'public.media_doc'::regclass AND con.conname = 'media_doc_gran_shape';
  IF v_shape IS NULL THEN
    RAISE EXCEPTION '013: 缺 media_doc_gran_shape 约束';
  END IF;
  IF v_shape LIKE '%IS NULL%' THEN
    RAISE EXCEPTION '013: media_doc_gran_shape 里还有 IS NULL 分支（旧版没摘掉）：%', v_shape;
  END IF;
  IF v_shape NOT LIKE '%shot_index = 0%' OR v_shape NOT LIKE '%shot_index >= 0%' THEN
    RAISE EXCEPTION '013: media_doc_gran_shape 不是 013 的形状：%', v_shape;
  END IF;

  -- 5.4 upsert 的 ON CONFLICT 字面目标 = 新主键四列
  SELECT pg_get_functiondef(p.oid) INTO v_fndef
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'upsert_media_doc';
  IF v_fndef IS NULL THEN
    RAISE EXCEPTION '013: upsert_media_doc 不存在';
  END IF;
  IF v_fndef NOT LIKE '%ON CONFLICT (company_key, media_key, analyzer_ver, shot_index)%' THEN
    RAISE EXCEPTION '013: upsert_media_doc 的 ON CONFLICT 目标不是新主键四列（改主键漏改函数 = 写第二帧就 42P10）';
  END IF;

  -- 5.5 现存数据没有违反形状的行（CHECK 已保证，这里把"回填是否真的发生"变成一条可读结论）
  IF EXISTS (SELECT 1 FROM public.media_doc WHERE gran = 'asset' AND shot_index <> 0) THEN
    RAISE EXCEPTION '013: 仍有 asset 行的 shot_index <> 0（列收敛没跑完）';
  END IF;

  RAISE NOTICE '013: media_doc PK=(company_key,media_key,analyzer_ver,shot_index)、shot_index NOT NULL DEFAULT 0、gran_shape(asset⇒0/shot⇒>=0)、upsert_media_doc 冲突目标四列 OK';
END
$$;
