-- 028 收掉换模型期间留下的历史向量列与旧检索函数 —— 只留客户端在用的那一档。
--
-- # 现状（本机实测，收之前）
--
--   media_doc 总计 6 422 MB：表 82 MB、TOAST 3 038 MB（八列向量）、向量索引约 3.3 GB
--   八列：embedding(768 老 nomic)、embedding_1024、embedding_1024_bge(m3)、embedding_4096(8B)、
--         embedding_512(8B 截断)、embedding_512_06b(qwen 0.6B)、embedding_512_bge_small、embedding_768_bge_base
--   四个检索函数：media_search(768, 010)、media_search_4096、media_search_512、media_search_1024
--
-- 现在只有 **media_search + embedding_768_bge_base**（bge-base-zh-v1.5）在用，其余都是换模型路上的中间产物。
-- 它们各自带着一份 HNSW（最大 1 075 MB）和一列 TOAST，加起来 1 GB 以上 —— 留着不是"可回滚"，是每天在付磁盘。
--
-- # 回滚说明
--
-- 回滚不再是"删掉一句 SQL 就回来"，而是"用 `scripts/bench-onnx-model.mjs --write-column` 重算一遍"
-- （bge-m3 约 28 分钟、bge-small 约 28 分钟、qwen 0.6B 约 80 分钟）。这是**有意的取舍**：模型已经定型，
-- 留着五套向量换来的只是"少跑一次重算"，代价是每个安装 1 GB。
--
-- 顺序很重要：先删函数（它们引用这些列），再删列（索引随列一起走）。
DO $$
BEGIN
  EXECUTE 'DROP FUNCTION IF EXISTS public.media_search_4096(text,text,jsonb,vector,integer)';
  EXECUTE 'DROP FUNCTION IF EXISTS public.media_search_512(text,text,jsonb,vector,integer)';
  EXECUTE 'DROP FUNCTION IF EXISTS public.media_search_1024(text,text,jsonb,vector,integer)';
END
$$;

ALTER TABLE public.media_doc
  DROP COLUMN IF EXISTS embedding,
  DROP COLUMN IF EXISTS embedding_ver,
  DROP COLUMN IF EXISTS embedding_1024,
  DROP COLUMN IF EXISTS embedding_1024_bge,
  DROP COLUMN IF EXISTS embedding_ver_1024_bge,
  DROP COLUMN IF EXISTS embedding_4096,
  DROP COLUMN IF EXISTS embedding_ver_4096,
  DROP COLUMN IF EXISTS embedding_512,
  DROP COLUMN IF EXISTS embedding_ver_512,
  DROP COLUMN IF EXISTS embedding_512_06b,
  DROP COLUMN IF EXISTS embedding_ver_512_06b,
  DROP COLUMN IF EXISTS embedding_512_bge_small,
  DROP COLUMN IF EXISTS embedding_ver_512_bge_small;

COMMENT ON TABLE public.media_doc IS
  '素材文档与它们的向量。一个模型、一列向量：bge-base-zh-v1.5（768 维，ONNX，池化=CLS，分词=WordPiece），'
  '检索入口是 media_search。历史上的 8B / qwen3-0.6b / bge-m3 / bge-small 列已在 028 删掉 —— '
  '换模型时新开一列重算，不要在同一列上覆写。';
