-- 011 orange_delivery.content_key 的形状收敛。
--
-- 009 只给 orange_plan / orange_claim 的 content_key 加了 ^[0-9a-f]{64}$（010:191-230），
-- orange_delivery 的同名列漏掉了。客户端的 rpcResult 把 contentKey 当 sha256 读
-- （apps/api/src/supabase.ts:72），一条形状不对的投递记录会让之后每次读取都 503，而不是在写入时失败。
--
-- 幂等：先按 catalog 探测列是否存在；列不在时整份文件是 no-op，连约束注释也不碰
-- （COMMENT ON CONSTRAINT 对不存在的表会抛 42704，所以它必须在 IF 分支里面）。

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'orange_delivery' AND column_name = 'content_key'
  ) THEN
    ALTER TABLE public.orange_delivery DROP CONSTRAINT IF EXISTS orange_delivery_content_key_hex;
    ALTER TABLE public.orange_delivery
      ADD CONSTRAINT orange_delivery_content_key_hex
      CHECK (content_key ~ '^[0-9a-f]{64}$') NOT VALID;
    ALTER TABLE public.orange_delivery VALIDATE CONSTRAINT orange_delivery_content_key_hex;
    COMMENT ON CONSTRAINT orange_delivery_content_key_hex ON public.orange_delivery
      IS 'contentKey 是 sha256 小写 hex；客户端按 ^[a-f0-9]{64}$ 校验，形状不对必须写不进去。';
    RAISE NOTICE '011: orange_delivery.content_key 已加 64-hex 约束';
  ELSE
    RAISE NOTICE '011: orange_delivery.content_key 不存在，跳过（表形状见 009）';
  END IF;
END
$$;
