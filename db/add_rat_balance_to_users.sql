-- 添加 RAT 余额字段到 users 表
-- 用于优化用户管理页面，避免前端逐个查询链上数据
-- 创建时间: 2025-01-XX

-- 🟢 关键：使用 TEXT 类型存储 Wei 值，避免精度丢失
-- ⚠️ 绝对不要使用 FLOAT 或 DOUBLE，会丢失精度！

-- 方案 A：存储 Wei 值（推荐，精度最高）
ALTER TABLE public.users 
ADD COLUMN IF NOT EXISTS rat_balance_wei TEXT NOT NULL DEFAULT '0';

-- 添加更新时间字段（用于跟踪余额更新时间）
ALTER TABLE public.users 
ADD COLUMN IF NOT EXISTS rat_balance_updated_at TIMESTAMPTZ;

-- 添加索引（用于跟踪同步状态）
CREATE INDEX IF NOT EXISTS idx_users_rat_balance_updated ON public.users(rat_balance_updated_at DESC);

-- 添加注释
COMMENT ON COLUMN public.users.rat_balance_wei IS 'RAT 代币余额（Wei 值，TEXT 类型保证精度）';
COMMENT ON COLUMN public.users.rat_balance_updated_at IS 'RAT 余额最后更新时间';

