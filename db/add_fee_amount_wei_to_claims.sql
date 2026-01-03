-- 为 claims 表添加 fee_amount_wei 字段
-- 目的：存储用户实际支付的 BNB 手续费（wei），用于准确的收益计算
-- 执行时间: 2026-01-03
-- 
-- 原理：
-- 1. 在用户领取空投时，从链上读取 tx.value（用户实际支付的 BNB）
-- 2. 将实际支付金额存储到 fee_amount_wei 字段
-- 3. 收益计算时使用存储的实际支付金额，而不是当前的 claimFee
-- 4. 这样可以确保历史数据准确，不受手续费变更影响
--
-- 安全性保障：
-- - 字段允许 NULL（历史记录可能没有该字段）
-- - 添加索引优化查询性能
-- - 不影响现有功能（向后兼容）

-- 1. 添加 fee_amount_wei 字段
ALTER TABLE public.claims 
ADD COLUMN IF NOT EXISTS fee_amount_wei TEXT;

-- 2. 添加注释
COMMENT ON COLUMN public.claims.fee_amount_wei IS '用户实际支付的 BNB 手续费（wei），从链上 tx.value 读取';

-- 3. 添加索引（如果需要按手续费查询或统计）
CREATE INDEX IF NOT EXISTS idx_claims_fee_amount_wei 
ON public.claims(fee_amount_wei) 
WHERE fee_amount_wei IS NOT NULL;

-- 4. 验证字段是否添加成功
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 
    FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'claims' 
    AND column_name = 'fee_amount_wei'
  ) THEN
    RAISE NOTICE '✅ fee_amount_wei 字段已成功添加';
  ELSE
    RAISE EXCEPTION '❌ fee_amount_wei 字段添加失败';
  END IF;
END $$;

