-- 创建自动放款配置和日志表
-- 目的：支持自动放款功能，提高小额提现处理效率
-- 执行时间：2026-01-09
-- 优先级：高 - 提升运营效率

-- 1. 创建自动放款配置表
CREATE TABLE IF NOT EXISTS auto_payout_config (
  id                    SERIAL PRIMARY KEY,
  private_key_encrypted TEXT NOT NULL,              -- 加密后的私钥
  wallet_address        TEXT NOT NULL,              -- 钱包地址（用于验证）
  threshold_usdt        NUMERIC(18, 6) NOT NULL DEFAULT 10.0,  -- 自动放款阈值（USDT）
  enabled               BOOLEAN NOT NULL DEFAULT false,  -- 是否启用
  min_balance_usdt      NUMERIC(18, 6) NOT NULL DEFAULT 100.0,  -- 最小余额阈值（USDT）
  daily_limit_usdt      NUMERIC(18, 6),            -- 每日自动放款总额限制（USDT）
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by            TEXT                         -- 最后更新人（管理员地址）
);

-- 2. 创建自动放款日志表
CREATE TABLE IF NOT EXISTS auto_payout_logs (
  id                    SERIAL PRIMARY KEY,
  withdrawal_id         UUID NOT NULL REFERENCES withdrawals(id) ON DELETE CASCADE,
  amount                NUMERIC(18, 6) NOT NULL,   -- 放款金额
  tx_hash               TEXT,                      -- 交易哈希
  status                TEXT NOT NULL,              -- 状态：'success', 'failed', 'pending'
  error_message         TEXT,                      -- 错误信息（如果失败）
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. 创建索引
CREATE INDEX IF NOT EXISTS idx_auto_payout_config_enabled ON auto_payout_config(enabled);
CREATE INDEX IF NOT EXISTS idx_auto_payout_logs_withdrawal_id ON auto_payout_logs(withdrawal_id);
CREATE INDEX IF NOT EXISTS idx_auto_payout_logs_status ON auto_payout_logs(status);
CREATE INDEX IF NOT EXISTS idx_auto_payout_logs_created_at ON auto_payout_logs(created_at DESC);

-- 4. 添加注释
COMMENT ON TABLE auto_payout_config IS '自动放款配置表：存储私钥、阈值等配置信息';
COMMENT ON TABLE auto_payout_logs IS '自动放款日志表：记录所有自动放款操作的历史';

COMMENT ON COLUMN auto_payout_config.private_key_encrypted IS '加密后的私钥（使用环境变量密钥加密）';
COMMENT ON COLUMN auto_payout_config.wallet_address IS '钱包地址（从私钥派生，用于验证）';
COMMENT ON COLUMN auto_payout_config.threshold_usdt IS '自动放款阈值：金额低于此值的提现将自动放款';
COMMENT ON COLUMN auto_payout_config.enabled IS '是否启用自动放款功能';
COMMENT ON COLUMN auto_payout_config.min_balance_usdt IS '最小余额阈值：钱包余额低于此值时停止自动放款';
COMMENT ON COLUMN auto_payout_config.daily_limit_usdt IS '每日自动放款总额限制（NULL 表示无限制）';

COMMENT ON COLUMN auto_payout_logs.withdrawal_id IS '关联的提现记录 ID';
COMMENT ON COLUMN auto_payout_logs.status IS '状态：success=成功，failed=失败，pending=处理中';
COMMENT ON COLUMN auto_payout_logs.tx_hash IS '链上交易哈希（如果已发送）';

-- 5. 确保只有一条配置记录（使用唯一约束）
-- 注意：PostgreSQL 不支持直接对整表添加唯一约束，我们通过应用层保证只有一条记录
-- 或者可以使用触发器，但为了简单，我们在应用层处理

