-- 025 客户端模型定档：`media_search_512` 读 bge-small-zh 的向量列，并给它建部分 HNSW。
--
-- # 为什么是 bge-small-zh-v1.5（而不是 bge-m3）
--
-- 同一批 200 题、同一份语料（精确余弦、都 512 维）：
--
--   bge-small-zh-v1.5  23 MB   查询编码 p50 14 ms   同组 100.0%   recall@20 76.5%（12k 子集）
--   bge-m3            543 MB   查询编码 p50 407 ms  同组 98.0%    recall@20 83.0%（12k 子集）
--
-- 客户端要跑本地推理：23 MB / 14 ms 与 543 MB / 407 ms 是"开箱即用"与"要等"的区别。bge-m3 的 recall@20 高
-- 6.5 pp，但同组命中反而低 2 pp —— 而这批语料里每组有几十条几乎一样的片段，用户感知的是"是不是同一组素材"。
-- bge-m3 那一档保留（列、索引、media_search_1024 都在），供离线/批量用。
--
-- # 做了什么
--
-- 1. `embedding_512_bge_small` 上的部分 HNSW（512 < 2000，直接建在列上）；
-- 2. `media_search_512` 的向量那一路从 `embedding_512_06b`（qwen3-0.6b）改读 `embedding_512_bge_small`；
--    qwen 的列保持不动，回滚就是把这一句反过来。
DO $$
DECLARE
  def text;
BEGIN
  def := pg_get_functiondef('public.media_search_512(text,text,jsonb,vector,integer)'::regprocedure);
  IF position('embedding_512_bge_small' in def) > 0 THEN
    RAISE NOTICE '025: media_search_512 已经读 bge-small-zh 的列，跳过';
    RETURN;
  END IF;
  /* 列名替换：从长到短，避免把新列再替换一次（`embedding_512_06b` 与 `embedding_512` 都含 `embedding_512`） */
  def := replace(def, 'embedding_512_bge_small', 'embedding_512');
  def := replace(def, 'embedding_512_06b', 'embedding_512_bge_small');
  EXECUTE def;
  RAISE NOTICE '025: media_search_512 改读 embedding_512_bge_small（bge-small-zh-v1.5，512 维）';
END
$$;

CREATE INDEX IF NOT EXISTS media_doc_vec512_bge_small_hnsw_idx
  ON public.media_doc USING hnsw (embedding_512_bge_small vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE embedding_512_bge_small IS NOT NULL AND superseded_at IS NULL;

COMMENT ON COLUMN public.media_doc.embedding_512_bge_small IS
  'bge-small-zh-v1.5（BERT WordPiece，512 维）。客户端本地推理用这一档：模型 23 MB、查询编码 p50 14 ms；'
  '分词由 src/wordpiece.mjs 提供，取向量方式是 CLS（不是 e5 的 mean）。';

COMMENT ON FUNCTION public.media_search_512(text, text, jsonb, vector, integer) IS
  '512 维检索（bge-small-zh-v1.5，客户端模型）：向量走 media_doc_vec512_bge_small_hnsw_idx；'
  'p_filters 认 oneLevel/twoLevel；四路结果按分支内名次 RRF 融合，score 是融合分不是余弦。';
