-- 001 扩展：向量检索（pgvector）与名称模糊检索（pg_trgm）。
-- 幂等：IF NOT EXISTS。向量列与 hnsw 索引要求 pgvector >= 0.5；
-- `hnsw.iterative_scan`（过滤条件下仍能凑够 k 条）要求 pgvector >= 0.8。
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 版本底线：0.8.0（能力底线，不是镜像版本）。
-- 0.8.0 起才有 hnsw.iterative_scan；halfvec / subvector 是 0.7.0 起（014 的表达式索引要用）。
-- 本机开发库是 0.8.7，Supabase 目前最高只给到 0.8.2 —— 底线卡 0.8.7 会让云上根本起不来，而 0.8.2 已覆盖
-- 上面三项能力，所以底线按能力定 0.8.0，低于 0.8.7 时只 NOTICE 一句，不拦。
-- 若这里报错说明镜像不是 pgvector/pgvector:pg17 或版本过旧。
DO $$
DECLARE
  v text;
BEGIN
  SELECT extversion INTO v FROM pg_extension WHERE extname = 'vector';
  IF v IS NULL THEN
    RAISE EXCEPTION 'vector 扩展未安装';
  END IF;
  IF string_to_array(v, '.')::int[] < string_to_array('0.8.0', '.')::int[] THEN
    RAISE EXCEPTION 'pgvector 版本过低：% < 0.8.0（hnsw.iterative_scan 需要 >= 0.8）', v;
  END IF;
  IF string_to_array(v, '.')::int[] < string_to_array('0.8.7', '.')::int[] THEN
    RAISE NOTICE 'pgvector % < 本机开发库的 0.8.7：能力齐全（iterative_scan/halfvec/subvector），只是版本号不同', v;
  END IF;
  RAISE NOTICE 'pgvector % OK', v;
END
$$;
