-- 021 轻量档：512 维投影列 + 索引 + `media_search_512`（免费额度的 Supabase 用这一档）。
--
-- # 为什么是 512
--
-- 实测（同 200 道题、同语料）纯向量召回：
--   4096 全维  recall@20 60.0%  同组 78.5%   云端占用 2.06 GB
--   1024 投影  recall@20 49.0%  同组 67.0%   云端占用 0.78 GB
--   512  投影  recall@20 52.5%  同组 68.5%   云端占用 0.32 GB
--
-- 512 与 1024 在噪声范围内持平，但占用只有一半 —— 免费额度（500 MB 级）里唯一舒服的一档。
-- 混合路径（RRF 之后再算）靠词法那部分补，见 022 的复测。
--
-- # 为什么另开一列而不是改 embedding_4096 的类型
--
-- 4096 那列在本地是"金副本"，云端只是投影。改类型会把本地也一起改掉，且不可逆；
-- 另开一列可以两档并存、随时对照，删列只是一条 drop。
--
-- # 索引为什么直接建在列上
--
-- 512 < 2000，HNSW 对 `vector` 的维度上限之内，不需要 014 那套 halfvec(4000) 前缀表达式。
-- 实测：72 144 行 168 MB（2 445 B/行），比 1024 的 7 KB/行还省 —— 小元素页装得更满。
ALTER TABLE public.media_doc
  ADD COLUMN IF NOT EXISTS embedding_512 vector(512),
  ADD COLUMN IF NOT EXISTS embedding_ver_512 text;

COMMENT ON COLUMN public.media_doc.embedding_512 IS
  '4096 维向量的 MRL 前 512 维投影（qwen3-embedding-8b）。云端轻量档用这一列，本地仍保留 4096 全维。';

CREATE INDEX IF NOT EXISTS media_doc_vec512_hnsw_idx
  ON public.media_doc USING hnsw (embedding_512 vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE embedding_512 IS NOT NULL AND superseded_at IS NULL;

-- `media_search_512` = `media_search_4096` 的同构副本：改名字、把 halfvec(4000) 前缀表达式换成整列、
-- 维度断言 4096 → 512。用 pg_get_functiondef 复制而不是手抄 300 行（手抄必然漂移）。
DO $$
DECLARE
  def text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'media_search_512'
  ) THEN
    RAISE NOTICE '021: media_search_512 已存在，只重建索引';
    RETURN;
  END IF;

  def := pg_get_functiondef('public.media_search_4096(text,text,jsonb,vector,integer)'::regprocedure);
  def := replace(def, 'media_search_4096', 'media_search_512');
  /* 先换掉两处排序表达式（还在用 embedding_4096 的原名），再统一改列名。 */
  def := replace(def, '(subvector(b.embedding_4096, 1, 4000))::halfvec(4000)', 'b.embedding_512');
  def := replace(def, '(subvector(p_embedding, 1, 4000))::halfvec(4000)', 'p_embedding');
  def := replace(def, 'embedding_4096', 'embedding_512');
  def := replace(def, '4096', '512');
  EXECUTE def;

  EXECUTE 'GRANT EXECUTE ON FUNCTION public.media_search_512(text,text,jsonb,vector,integer) '
       || 'TO authenticated, service_role, orange_app';
  RAISE NOTICE '021: media_search_512 已按 4096 版本生成（512 维、整列 HNSW）';
END
$$;

COMMENT ON FUNCTION public.media_search_512(text, text, jsonb, vector, integer) IS
  '512 维轻量检索（云端免费额度档）：向量走 media_doc_vec512_hnsw_idx，p_filters 认 oneLevel/twoLevel，'
  '四路结果按分支内名次 RRF 融合（020）。score 是融合分，不是余弦相似度。';
