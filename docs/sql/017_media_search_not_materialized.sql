-- 017 让向量检索真的走索引：把 `base` CTE 改成 NOT MATERIALIZED。
--
-- 实测（本机 26 588 条带 4096 向量的行，同一条查询）：
--   直接对着表写、表达式与索引逐字一致  → Index Scan using media_doc_vec4096_hnsw_idx，8.5 ms，514 页（≈4 MB）
--   经由 media_search_4096() 调用同一逻辑 → Function Scan 3556 ms（冷 8197 ms），171 000 页（≈1.3 GB）
--
-- 差 400 倍的原因不是库大，是 **CTE 被物化**：`base` 在函数体里被引用 4 次
-- （cand_asset / cand_shot / lex_ilike / lex_trigram），PostgreSQL 12+ 只对"单次引用"的 CTE 做内联，
-- 多次引用一律物化 —— 于是排序落在"物化出来的整表副本"上，`media_doc_vec4096_hnsw_idx` 完全用不上，
-- 只能全表扫 + 全量排序。灌得越多越慢，云上 30 s 的 statement_timeout 迟早顶爆。
--
-- 为什么用 `NOT MATERIALIZED` 而不是把候选段重写成"直接读表"：
--   1. 语义零改动 —— 谓词、列、LIMIT 顺序全都原样，只是允许优化器把它们内联到各分支；
--   2. 不需要在迁移里复制 500 行函数体（复制就会有漂移）；
--   3. 内联之后向量分支的谓词正好蕴含索引的 partial 条件
--      (`embedding_4096 IS NOT NULL AND superseded_at IS NULL`)，表达式与索引逐字一致 → 走 Index Scan。
--
-- 幂等：已经改过的函数跳过（`position('AS NOT MATERIALIZED')`）。函数不存在也只 NOTICE，不中断。
DO $$
DECLARE
  r record;
  def text;
  patched int := 0;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('media_search', 'media_search_4096')
     ORDER BY p.proname, p.oid
  LOOP
    def := pg_get_functiondef(r.oid);
    IF position('WITH base AS (' in def) > 0 THEN
      def := replace(def, 'WITH base AS (', 'WITH base AS NOT MATERIALIZED (');
      EXECUTE def;
      patched := patched + 1;
      RAISE NOTICE '017: % 的 base CTE 改为 NOT MATERIALIZED（向量分支从此可用 HNSW 索引）', r.proname;
    ELSIF position('WITH base AS NOT MATERIALIZED (' in def) > 0 THEN
      RAISE NOTICE '017: % 已是 NOT MATERIALIZED，跳过', r.proname;
    ELSE
      RAISE NOTICE '017: % 里没找到 `WITH base AS (` —— 函数体已不是这个形状，跳过（需人工确认）', r.proname;
    END IF;
  END LOOP;
  IF patched = 0 THEN
    RAISE NOTICE '017: 没有需要改的函数';
  END IF;
END
$$;

COMMENT ON FUNCTION public.media_search_4096(text, text, jsonb, vector, integer) IS
  '4096 维检索（014/015 + 017）：base CTE 为 NOT MATERIALIZED，向量分支走 media_doc_vec4096_hnsw_idx；'
  '候选按 halfvec(4000) 前缀取 k，分数用完整 4096 维重排。';
