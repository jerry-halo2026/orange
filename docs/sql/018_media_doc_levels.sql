-- 018 把"分类"落成列：one_level / two_level（一级分类、二级分类）。
--
-- 为什么需要：67 156 条 live 行里 **66 766 条 product 与 gname 都为空**。那两个列来自
-- `日期-产品-分组 (n)` 这种严格形状的名字，而 78 874 条索引里只有 390 条符合 —— 于是
--   · 按产品/分组过滤等于没有；
--   · 云管家的 collections 只能是一坨"未分类"；
--   · 向量检索没法先收窄再排序。
--
-- 而分类信息一直都在：索引 entry 的 `oneLevel` / `twoLevel`（78 874 条里 67 035 条两者都有，
-- 一级 8+ 类、二级 520 个值，二级的取值本身就是产品名：`油弃乌龙60g/盒`、`头采柑普茶`、`莓茶`、
-- `柠檬红茶`……）。它们已经被渲染进 `text`（所以向量不用重算），只是没有落成可过滤的列。
--
-- 这一条只做三件事：加两列、加两个部分索引、把口径写进注释。**值由 `scripts/media-doc-levels.mjs`
-- 从索引回填**——不在迁移里做 67 000 行 UPDATE（迁移要能在任何库上快速跑完，数据回填是另一件事）。
--
-- 为什么不在 upsert_media_doc 里加这两列：那要重写 012/013/014 三版拼起来的函数体，改错就是
-- "写入成功但字段静默为空"。回填脚本是幂等的，重跑一次就对，风险低得多。
ALTER TABLE public.media_doc
  ADD COLUMN IF NOT EXISTS one_level text,
  ADD COLUMN IF NOT EXISTS two_level text;

COMMENT ON COLUMN public.media_doc.one_level IS
  '一级分类（索引 entry 的 oneLevel）：花草养生茶 / 陈皮柑普 / 普洱茶类 …；由 media-doc-levels.mjs 回填。';
COMMENT ON COLUMN public.media_doc.two_level IS
  '二级分类（索引 entry 的 twoLevel，取值本身就是产品：油弃乌龙60g/盒 / 头采柑普茶 / 莓茶 …）。';

-- 部分索引：检索与 collections 只看存活行，索引也跟着只覆盖存活行（更小、更快）。
CREATE INDEX IF NOT EXISTS media_doc_one_level_idx
  ON public.media_doc (company_key, one_level)
  WHERE superseded_at IS NULL AND one_level IS NOT NULL;

CREATE INDEX IF NOT EXISTS media_doc_two_level_idx
  ON public.media_doc (company_key, two_level)
  WHERE superseded_at IS NULL AND two_level IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON public.media_doc TO orange_app;
