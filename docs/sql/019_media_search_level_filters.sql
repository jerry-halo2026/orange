-- 019 检索认 `oneLevel` / `twoLevel` 两个过滤键。
--
-- 018 把分类落成了列（live 67 035 / 67 156 有值，一级 8+ 类、二级 520 个产品），但
-- `media_search` / `media_search_4096` 的 `p_filters` 只认 batch/product/gname/sourceKind/durationMaxMs ——
-- 于是"在这个产品里找"这件事仍然做不到：用户点了 collections 里的文件夹、或者 agent 想只在某个
-- 一级分类里找镜头，都没有路。
--
-- 做法与 017 同一套路：`pg_get_functiondef` 拿到定义，在 `base` CTE 的过滤段后面插两行，再 EXECUTE。
-- 不复制 500 行函数体（复制必然漂移），插入点靠**已有那一行的原文**定位，找不到就 NOTICE 跳过。
--
-- 语义：`p_filters ->> 'oneLevel'` 为 NULL 时不参与过滤（与其它五个键一致）；
--       给了值就是 `d.one_level = 值`，走 018 建的部分索引 `media_doc_one_level_idx`。
-- 注意：过滤发生在 `base` 里，而 `base` 是 NOT MATERIALIZED，所以向量分支仍然是
--       "先让 HNSW 给候选、再按分类过滤"（pgvector 的 iterative_scan 会继续扫到凑够 k 条）。
DO $$
DECLARE
  r record;
  def text;
  anchor text := 'sourceKind';
  inserted int := 0;
  needle text;
  patch text;
BEGIN
  needle := E'       AND (v_filters ->> ''sourceKind''     IS NULL OR d.source_kind = v_filters ->> ''sourceKind'')';
  patch := needle || E'\n'
    || E'       AND (v_filters ->> ''oneLevel''      IS NULL OR d.one_level = v_filters ->> ''oneLevel'')\n'
    || E'       AND (v_filters ->> ''twoLevel''      IS NULL OR d.two_level = v_filters ->> ''twoLevel'')';

  FOR r IN
    SELECT p.oid, p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('media_search', 'media_search_4096')
     ORDER BY p.proname, p.oid
  LOOP
    def := pg_get_functiondef(r.oid);
    IF position('''oneLevel''' in def) > 0 THEN
      RAISE NOTICE '019: % 已认 oneLevel/twoLevel，跳过', r.proname;
      CONTINUE;
    END IF;
    IF position(needle in def) = 0 THEN
      RAISE NOTICE '019: % 里没找到 sourceKind 那一行（函数体形状变了），跳过 —— 需人工确认', r.proname;
      CONTINUE;
    END IF;
    def := replace(def, needle, patch);
    EXECUTE def;
    inserted := inserted + 1;
    RAISE NOTICE '019: % 的 p_filters 现在认 oneLevel / twoLevel', r.proname;
  END LOOP;
  IF inserted = 0 THEN
    RAISE NOTICE '019: 没有需要改的函数（anchor=%，这个变量只为可读性）', anchor;
  END IF;
END
$$;
