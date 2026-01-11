-- ============================================
-- 🔥 补偿扫描支持迁移
-- ============================================
-- 创建时间: 2026-01-11
-- 目的: 支持 Indexer 补偿扫描功能
--
-- 包含:
-- 1. compensation_logs 表：记录补偿操作日志
-- 2. find_missing_energy_users 函数：查找遗漏用户
-- ============================================

-- ========================================
-- 1. 创建补偿日志表
-- ========================================
CREATE TABLE IF NOT EXISTS compensation_logs (
  id BIGSERIAL PRIMARY KEY,
  address TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- 索引
  INDEX idx_compensation_logs_address (address),
  INDEX idx_compensation_logs_created_at (created_at DESC),
  INDEX idx_compensation_logs_status (status)
);

-- 添加表注释
COMMENT ON TABLE compensation_logs IS '补偿扫描操作日志';
COMMENT ON COLUMN compensation_logs.address IS '用户地址';
COMMENT ON COLUMN compensation_logs.tx_hash IS '交易哈希';
COMMENT ON COLUMN compensation_logs.status IS '补偿状态: success 或 failed';
COMMENT ON COLUMN compensation_logs.error_message IS '错误信息（仅失败时）';
COMMENT ON COLUMN compensation_logs.created_at IS '补偿时间';

-- ========================================
-- 2. 创建查找遗漏用户的函数
-- ========================================
-- 查找规则：
-- 1. 在 claims 表中有记录（说明链上已领取）
-- 2. 但在 users 表中 energy_total = 0 或不存在（说明后端未记录）
-- 3. 且记录在指定时间范围内

CREATE OR REPLACE FUNCTION find_missing_energy_users(
  lookback_date TIMESTAMPTZ,
  max_results INT DEFAULT 50
)
RETURNS TABLE (
  address TEXT,
  tx_hash TEXT,
  referrer TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT DISTINCT ON (c.address)
    c.address::TEXT,
    c.tx_hash::TEXT,
    COALESCE(c.referrer, '0x0000000000000000000000000000000000000000')::TEXT AS referrer
  FROM claims c
  LEFT JOIN users u ON LOWER(c.address) = LOWER(u.address)
  WHERE 
    -- 条件 1: 领取时间在回溯范围内
    c.block_time >= lookback_date
    -- 条件 2: 用户不存在 OR 能量为 0
    AND (u.address IS NULL OR u.energy_total = 0)
    -- 条件 3: 排除已成功补偿的用户（过去 1 天内）
    AND NOT EXISTS (
      SELECT 1 
      FROM compensation_logs cl 
      WHERE LOWER(cl.address) = LOWER(c.address)
        AND cl.status = 'success'
        AND cl.created_at > NOW() - INTERVAL '1 day'
    )
  ORDER BY c.address, c.block_time DESC
  LIMIT max_results;
END;
$$ LANGUAGE plpgsql;

-- 添加函数注释
COMMENT ON FUNCTION find_missing_energy_users IS '查找在 claims 表中有记录但 users 表中能量为 0 的用户';

-- ========================================
-- 3. 创建补偿统计视图（可选）
-- ========================================
CREATE OR REPLACE VIEW compensation_stats AS
SELECT 
  DATE(created_at) AS date,
  status,
  COUNT(*) AS count,
  COUNT(DISTINCT address) AS unique_users
FROM compensation_logs
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY DATE(created_at), status
ORDER BY date DESC, status;

COMMENT ON VIEW compensation_stats IS '补偿操作统计（最近 30 天）';

-- ========================================
-- 完成
-- ========================================
-- 迁移完成！现在可以启动补偿扫描服务了。

