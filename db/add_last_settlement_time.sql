-- 添加 last_settlement_time 字段，用于流式秒级结算
-- 执行时间: 2024-12-XX
-- 说明: 用于记录用户收益的最后结算时间，实现 Lazy Settle（按需结算）

-- 1. 添加 last_settlement_time 字段
ALTER TABLE public.users 
ADD COLUMN IF NOT EXISTS last_settlement_time TIMESTAMP WITH TIME ZONE;

-- 2. 为现有用户设置初始值（使用 created_at 或第一次领取空投的时间）
UPDATE public.users u
SET last_settlement_time = COALESCE(
  (SELECT MIN(c.created_at) FROM public.claims c WHERE c.address = u.address),
  u.created_at
)
WHERE last_settlement_time IS NULL;

-- 3. 设置默认值约束（新用户自动使用 created_at）
ALTER TABLE public.users 
ALTER COLUMN last_settlement_time SET DEFAULT now();

-- 4. 添加索引以优化查询性能
CREATE INDEX IF NOT EXISTS idx_users_last_settlement_time 
ON public.users(last_settlement_time) 
WHERE last_settlement_time IS NOT NULL;

-- 5. 添加注释
COMMENT ON COLUMN public.users.last_settlement_time IS 
'收益最后结算时间（Lazy Settle）。提现时会将实时计算的收益固化到 pending_usdt，并更新此字段为当前时间。';

