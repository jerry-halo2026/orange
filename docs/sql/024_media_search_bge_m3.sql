-- 024 检索切到 bge-m3：1024 维列 + 部分 HNSW + `media_search_1024`。
--
-- # 为什么是 bge-m3
--
-- 同一批 200 题、同一份语料（67 156 条，精确余弦）：
--   bge-m3（1024）          recall@20 83.0%  同组 98.0%   634 MB  50 条/秒
--   qwen3-embedding-0.6b    recall@20 74.0%  同组 96.5%   639 MB  22 条/秒
--   qwen3-embedding-8b      recall@20 72.5%  同组 92.0%   4.68 GB
--
-- 体积一样、更快、还高 9 个百分点。另一个决定性因素是分词：bge-m3 是 XLM-RoBERTa 的 SentencePiece unigram，
-- 与仓库现有 `sentence-model.mjs`（为 e5 写的 unigram 实现）同族；qwen3 是 BPE，客户端要另写一套。
--
-- # 做了什么
--
-- 1. `embedding_1024_bge` 上的部分 HNSW（1024 < 2000，直接建在列上；m=16, ef_construction=64）；
-- 2. `media_search_1024` = `media_search_512` 的同构副本：改名字、改向量列、维度断言 512 → 1024；
-- 3. 收回默认的 PUBLIC 执行权，再按 014 的口径授予（010 只覆盖它之前存在的函数）。
--
-- 旧的东西一律保留：`media_search_512`、`embedding_512_06b`、`embedding_512`（8B）。换模型要能回滚，
-- 删列/删函数是另一件事。
DO $$
DECLARE
  def text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'media_search_1024'
  ) THEN
    RAISE NOTICE '024: media_search_1024 已存在，只补索引';
    RETURN;
  END IF;

  def := pg_get_functiondef('public.media_search_512(text,text,jsonb,vector,integer)'::regprocedure);
  /* 先换列名（它含 512，必须在改数字之前），再换函数名，最后才动裸的 512（断言与提示文字） */
  def := replace(def, 'embedding_512_06b', 'embedding_1024_bge');
  def := replace(def, 'media_search_512', 'media_search_1024');
  def := replace(def, '512', '1024');
  EXECUTE def;

  EXECUTE 'REVOKE ALL ON FUNCTION public.media_search_1024(text,text,jsonb,vector,integer) FROM public';
  EXECUTE 'REVOKE ALL ON FUNCTION public.media_search_1024(text,text,jsonb,vector,integer) FROM anon';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.media_search_1024(text,text,jsonb,vector,integer) '
       || 'TO authenticated, service_role, orange_app';
  RAISE NOTICE '024: media_search_1024 已按 512 版生成（1024 维、读 embedding_1024_bge）';
END
$$;

CREATE INDEX IF NOT EXISTS media_doc_vec1024_bge_hnsw_idx
  ON public.media_doc USING hnsw (embedding_1024_bge vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE embedding_1024_bge IS NOT NULL AND superseded_at IS NULL;

COMMENT ON COLUMN public.media_doc.embedding_1024_bge IS
  'bge-m3（XLM-RoBERTa，1024 维原生维度，非 MRL 不可截断）。实测 200 题：recall@20 83.0% / 同组 98.0%。';

COMMENT ON FUNCTION public.media_search_1024(text, text, jsonb, vector, integer) IS
  '1024 维检索（bge-m3）：向量走 media_doc_vec1024_bge_hnsw_idx，p_filters 认 oneLevel/twoLevel，'
  '四路结果按分支内名次 RRF 融合。score 是融合分，不是余弦相似度。';
