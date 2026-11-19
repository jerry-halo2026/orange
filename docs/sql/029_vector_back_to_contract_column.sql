-- 029 把向量收回契约里的那一列：`embedding vector(768)`
--
-- 换模型期间我新开了 `embedding_768_bge_base`，但 `docs/sql/contract.json` 与 012 的约定是「media_doc 有一个
-- 768 维的 `embedding` 列」—— `--contract` 因此在 028 之后报"缺向量列 embedding"。两列同维（768）、同数据
-- （bge-base-zh），没有理由留两列：
--
--   1. 建 `embedding vector(768)`，把 bge-base 的向量拷进去；
--   2. `media_search` 的向量那一路改回读 `embedding`（`b.embedding_768_bge_base` → `b.embedding`，
--      只替换带别名的那几处，绝不裸替换 —— 那会改掉入参名 `p_embedding`）；
--   3. 建 `embedding` 的部分 HNSW，删掉临时的 `embedding_768_bge_base`（索引随列一起走）。
--
-- 另外给旧列数据做一次物理回收：`DROP COLUMN` 只是把列标成已删除，空间要等整表重写才回来
-- （`VACUUM FULL`，开发库上做；生产侧同理，但要在维护窗口）。
ALTER TABLE public.media_doc ADD COLUMN IF NOT EXISTS embedding vector(768);

UPDATE public.media_doc
   SET embedding = embedding_768_bge_base
 WHERE embedding_768_bge_base IS NOT NULL
   AND embedding IS DISTINCT FROM embedding_768_bge_base;

DO $$
DECLARE
  def text;
BEGIN
  def := pg_get_functiondef('public.media_search(text,text,jsonb,vector,integer)'::regprocedure);
  IF position('b.embedding_768_bge_base' in def) > 0 THEN
    def := replace(def, 'b.embedding_768_bge_base', 'b.embedding');
    def := replace(def, 'c.embedding_768_bge_base', 'c.embedding');
    def := replace(def, 'd.embedding_768_bge_base', 'd.embedding');
    def := replace(def, 's.embedding_768_bge_base', 's.embedding');
    EXECUTE def;
    RAISE NOTICE '029: media_search 改回读 embedding（768 维，bge-base-zh 的向量）';
  ELSE
    RAISE NOTICE '029: media_search 已经读 embedding，跳过';
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS media_doc_embedding_hnsw_idx
  ON public.media_doc USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE embedding IS NOT NULL AND superseded_at IS NULL;

ALTER TABLE public.media_doc DROP COLUMN IF EXISTS embedding_768_bge_base;

COMMENT ON COLUMN public.media_doc.embedding IS
  '素材向量，768 维：bge-base-zh-v1.5（ONNX，池化=CLS，分词=src/wordpiece.mjs）。'
  '实测 200 题 recall@20 90.5% / 同组 100.0%，查询编码 p50 44 ms（wasm 单线程）。'
  '换模型时新开一列重算、改 media_search 指过去，不要在同一列上覆写。';

VACUUM (FULL, ANALYZE) public.media_doc;
