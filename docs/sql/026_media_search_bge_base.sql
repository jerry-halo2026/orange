-- 026 客户端档：`media_search`（768 维那条主函数）读 bge-base-zh 的向量列，并给它建部分 HNSW。
--
-- # 为什么是 bge-base-zh-v1.5
--
-- 同一 12 000 条子集、同一批 200 题、精确余弦（ONNX wasm 单线程）：
--
--   bge-base-zh-v1.5   98 MB   查询 p50 78 ms   recall@20 90.5%  同组 100.0%
--   bge-m3            543 MB   查询 p50 407 ms  recall@20 83.0%  同组 98.0%
--   bge-small-zh       23 MB   查询 p50 11 ms   recall@20 76.5%  同组 100.0%
--
-- 768 维与表里 `vector(768)` 的宽度一致，不做截断（bge-base-zh 不是 MRL 模型）。客户端在本地用同一个模型编码查询，
-- 文档向量也由同一条 ONNX 管线算出 —— 不混 "GGUF 算文档 + ONNX 算查询" 的偏差。
--
-- # 做了什么
--
-- 1. `embedding_768_bge_base` 上的部分 HNSW（768 < 2000，直接建在列上；m=16, ef_construction=64）；
-- 2. `media_search`（012 那条 768 维主函数）的向量那一路改读新列。
--
-- 旧列（`embedding` 768 的老向量、`embedding_1024_bge`、`embedding_512_bge_small`、`embedding_512_06b`、
-- `embedding_512`）全部保留：换模型要能回滚，删列是另一件事。
DO $$
DECLARE
  def text;
BEGIN
  def := pg_get_functiondef('public.media_search(text,text,jsonb,vector,integer)'::regprocedure);
  /* 幂等判据：还有没有**裸的列引用**（`b.` / `c.` / `d.` / `s.` 后面直接跟 embedding）。
     `\M` 是词尾锚点 —— `embedding_768_bge_base` 里的 `embedding` 后面是下划线，不算词尾，所以不会误判。 */
  IF def !~ '(b|c|d|s)\.embedding\M' THEN
    RAISE NOTICE '026: media_search 的向量列已经换过，跳过';
    RETURN;
  END IF;
  /* 只换**列引用**，绝不裸替换 `embedding` —— 那会把入参名 `p_embedding` 也改掉，
     PostgreSQL 直接拒：cannot change name of input parameter。 */
  def := replace(def, 'b.embedding', 'b.embedding_768_bge_base');
  def := replace(def, 'c.embedding', 'c.embedding_768_bge_base');
  def := replace(def, 'd.embedding', 'd.embedding_768_bge_base');
  def := replace(def, 's.embedding', 's.embedding_768_bge_base');
  EXECUTE def;
  RAISE NOTICE '026: media_search 改读 embedding_768_bge_base（bge-base-zh-v1.5，768 维）';
END
$$;

CREATE INDEX IF NOT EXISTS media_doc_vec768_bge_base_hnsw_idx
  ON public.media_doc USING hnsw (embedding_768_bge_base vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE embedding_768_bge_base IS NOT NULL AND superseded_at IS NULL;

COMMENT ON COLUMN public.media_doc.embedding_768_bge_base IS
  'bge-base-zh-v1.5（BERT WordPiece，768 维原生宽度）。客户端与文档向量同一条 ONNX 管线：'
  'pooling=cls、src/wordpiece.mjs 分词。实测 200 题：recall@20 90.5% / 同组 100.0%，查询编码 p50 78 ms。';

COMMENT ON FUNCTION public.media_search(text, text, jsonb, vector, integer) IS
  '768 维检索（bge-base-zh-v1.5，客户端模型）：向量走 media_doc_vec768_bge_base_hnsw_idx；'
  'p_filters 认 oneLevel/twoLevel；四路结果按分支内名次 RRF 融合，score 是融合分不是余弦。';
