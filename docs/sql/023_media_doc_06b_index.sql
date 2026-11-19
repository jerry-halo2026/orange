-- 023 轻量档换模型：`media_search_512` 读 0.6B 的向量列，并给它建部分 HNSW。
--
-- # 为什么换
--
-- 同一批 200 题、同一份语料（67 156 条，精确余弦、都截 512 维）：
--   qwen3-embedding-8b → 512   recall@20 72.5%  同组 92.0%   4.68 GB
--   qwen3-embedding-0.6b → 512 recall@20 73.0%  同组 96.5%   639 MB
--
-- 0.6B 不输 8B，体积 1/7、编码快 4 倍。客户端要跑本地推理，这是唯一合理的一档；云端 8B 已经全部下线。
--
-- # 做了什么
--
-- 1. `embedding_512_06b` 上的部分 HNSW（m=16, ef_construction=64；512 < 2000，直接建在列上）；
-- 2. `media_search_512` 的向量那一路改读 `embedding_512_06b`（文本替换，不复制 300 行函数体）。
--
-- 旧列 `embedding_512`（8B 算的）先留着：换模型这种事要能回滚，删列不是这一条迁移该做的。
DO $$
DECLARE
  def text;
BEGIN
  def := pg_get_functiondef('public.media_search_512(text,text,jsonb,vector,integer)'::regprocedure);
  IF position('embedding_512_06b' in def) > 0 THEN
    RAISE NOTICE '023: media_search_512 已经读 0.6B 的列，跳过';
    RETURN;
  END IF;
  /* 只换列名：`embedding_512` 是 `embedding_512_06b` 的前缀，从长到短替换，避免把新列再替换一次 */
  def := replace(def, 'embedding_512_06b', 'embedding_512');
  def := replace(def, 'embedding_512', 'embedding_512_06b');
  EXECUTE def;
  RAISE NOTICE '023: media_search_512 改读 embedding_512_06b（qwen3-embedding-0.6b，512 维）';
END
$$;

CREATE INDEX IF NOT EXISTS media_doc_vec512_06b_hnsw_idx
  ON public.media_doc USING hnsw (embedding_512_06b vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE embedding_512_06b IS NOT NULL AND superseded_at IS NULL;

COMMENT ON COLUMN public.media_doc.embedding_512_06b IS
  'qwen3-embedding-0.6b 的 1024 维输出截前 512 维（MRL）。客户端本地推理与云端同族同空间；'
  '实测与 8B 的 512 维投影在 200 题上持平（recall@20 73.0% vs 72.5%，同组 96.5% vs 92.0%）。';
