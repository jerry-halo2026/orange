-- 020 按名次融合（RRF）：不再在原始分数上合并四路结果。
--
-- # 为什么必须改
--
-- 019 之后的产品路径是"向量 + ILIKE + trigram + 分词"四路各自打分、合并后按分数排序。四路的分数
-- **不在同一个尺度上**：
--   · `lex_ilike` 命中就给 1.000（二值）；
--   · 向量余弦 0.5–0.6；
--   · trigram `similarity()` 0.1 量级。
-- 于是 1.000 那一路必然占满前 20。实测（同 200 道题、同语料）：
--
--   只开向量(4096)   recall@20 60.0%  同组命中 78.5%  p50 241 ms
--   混合(4096)       recall@20 36.0%  同组命中 49.0%  p50 925 ms
--   混合(768)        recall@20 36.0%  同组命中 49.0%  p50 982 ms
--
-- 两档不同模型混合后结果完全相同 —— 说明合并之后向量分支根本没参与排序。200 道题里 78 道是
-- "向量排 1–4、混合后掉出前 20"。具体例子（`宴山藏大红袍 包装`）混合前 8 条全是 `ilike | 1.000`，
-- 而且其中多条属于**别的产品**（two_level = LCM-厦门-一炮而红大红袍128g）。
--
-- # 改法
--
-- 每路先在自己的分支内排名（`row_number() over (partition by match_kind ...)`），
-- 再按 RRF 求和：`score = Σ 1/(60 + rank)`。名次是无量纲的，所以 1.0 与 0.55 不再打架；
-- 同一行被多路同时命中会自然加分（这才是"多路共识"该有的效果），k=60 是 RRF 的常用平滑常数。
--
-- 输出列与原来逐列一致（`media_key/gran/video_id/shot_index/name/batch/product/gname/duration_ms/score/match_kind`），
-- 因为替换的是 `ranked` 这一段，`merged` 与最终 `ORDER BY` 都不动。分数变成 0.01 量级，
-- 对"按分数排序"没有影响，对"分数阈值过滤"有影响 —— 调用方不该拿这个分数当相似度用（注释里已写明）。
--
-- 幂等：定义里已出现 `branch_rank` 就跳过；找不到 `ranked AS (` / `SELECT r.media_key,` 两个锚点就 NOTICE 跳过。
DO $$
DECLARE
  r record;
  def text;
  v_block text;
  v_start int;
  v_end int;
  patched int := 0;
BEGIN
  v_block := $block$  -- 分支内名次融合（RRF）：不在原始分数上合并（见 020 的说明）。
  branch AS (
    SELECT m.*,
           row_number() OVER (PARTITION BY m.match_kind ORDER BY m.score DESC, m.media_key) AS branch_rank
      FROM merged m
  ),
  fused AS (
    SELECT b.media_key,
           sum(1.0 / (60 + b.branch_rank))::real                    AS score,
           (array_agg(b.gran        ORDER BY b.branch_rank))[1]     AS gran,
           (array_agg(b.video_id    ORDER BY b.branch_rank))[1]     AS video_id,
           (array_agg(b.shot_index  ORDER BY b.branch_rank))[1]     AS shot_index,
           (array_agg(b.name        ORDER BY b.branch_rank))[1]     AS name,
           (array_agg(b.batch       ORDER BY b.branch_rank))[1]     AS batch,
           (array_agg(b.product     ORDER BY b.branch_rank))[1]     AS product,
           (array_agg(b.gname       ORDER BY b.branch_rank))[1]     AS gname,
           (array_agg(b.duration_ms ORDER BY b.branch_rank))[1]     AS duration_ms,
           (array_agg(b.match_kind  ORDER BY b.branch_rank))[1]     AS match_kind
      FROM branch b
     GROUP BY b.media_key
  ),
  ranked AS (SELECT * FROM fused)
$block$;

  FOR r IN
    SELECT p.oid, p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('media_search', 'media_search_4096')
     ORDER BY p.proname, p.oid
  LOOP
    def := pg_get_functiondef(r.oid);
    IF position('branch_rank' in def) > 0 THEN
      RAISE NOTICE '020: % 已是名次融合，跳过', r.proname;
      CONTINUE;
    END IF;
    v_start := position('  ranked AS (' in def);
    v_end   := position('  SELECT r.media_key,' in def);
    IF v_start = 0 OR v_end <= v_start THEN
      RAISE NOTICE '020: % 里找不到 ranked 段（形状变了），跳过 —— 需人工确认', r.proname;
      CONTINUE;
    END IF;
    def := overlay(def placing v_block from v_start for (v_end - v_start));
    EXECUTE def;
    patched := patched + 1;
    RAISE NOTICE '020: % 改为按分支名次融合（RRF k=60）', r.proname;
  END LOOP;

  IF patched = 0 THEN
    RAISE NOTICE '020: 没有需要改的函数';
  END IF;
END
$$;

COMMENT ON FUNCTION public.media_search_4096(text, text, jsonb, vector, integer) IS
  '4096 维检索：向量分支走 media_doc_vec4096_hnsw_idx（017），p_filters 认 oneLevel/twoLevel（019），'
  '四路结果按分支内名次 RRF 融合（020）—— score 是融合分（0.01 量级），不是余弦相似度。';
