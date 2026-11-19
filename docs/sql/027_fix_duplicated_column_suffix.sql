-- 027 修复 026 的一次重复替换：`d.embedding_768_bge_base_768_bge_base`
--
-- 026 的第一版按列引用替换（`d.embedding` → `d.embedding_768_bge_base`）。它在**已经换过一半**的函数体上
-- 又跑了一次：`d.embedding` 是 `d.embedding_768_bge_base` 的前缀，于是后缀被叠了一层，函数在词法那一路
-- 报 `column d.embedding_768_bge_base_768_bge_base does not exist`。
--
-- 这里只做一件事：把叠出来的多余后缀收回去。幂等 —— 干净的函数体直接跳过。
DO $$
DECLARE
  def text;
BEGIN
  def := pg_get_functiondef('public.media_search(text,text,jsonb,vector,integer)'::regprocedure);
  IF position('_768_bge_base_768_bge_base' in def) = 0 THEN
    RAISE NOTICE '027: media_search 没有重复后缀，跳过';
    RETURN;
  END IF;
  def := replace(def, '_768_bge_base_768_bge_base', '_768_bge_base');
  EXECUTE def;
  RAISE NOTICE '027: 收回重复的 _768_bge_base 后缀';
END
$$;
