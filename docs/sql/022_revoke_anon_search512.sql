-- 022 新函数默认带 `EXECUTE TO PUBLIC`，必须显式收回。
--
-- PostgreSQL 建函数时默认 `GRANT EXECUTE ... TO PUBLIC`。010 已经收回过 anon/PUBLIC 在 public 下的
-- 全部函数权限，但那只覆盖**当时已存在**的函数 —— 021 新建的 `media_search_512` 又带上了默认授权，
-- 于是 `verify` 的"anon 有效权限必须 0 项"立刻报出来（这是那条断言存在的意义：漏一次就会被发现）。
--
-- 这里只做两件事：收回 PUBLIC，再按 014 的口径授给 authenticated / service_role / orange_app。
-- 幂等：重复执行是同样的结果。
REVOKE ALL ON FUNCTION public.media_search_512(text, text, jsonb, vector, integer) FROM public;
REVOKE ALL ON FUNCTION public.media_search_512(text, text, jsonb, vector, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.media_search_512(text, text, jsonb, vector, integer)
  TO authenticated, service_role, orange_app;
