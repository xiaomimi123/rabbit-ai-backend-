-- ========================================
-- P0级紧急修复：批量更新所有>=10,000 RAT用户的 last_settlement_time
-- 修复时间：2026-01-10
-- 影响：恢复所有外部转账用户的持币生息收益
-- ========================================

-- 第一步：创建备份表（安全措施）
CREATE TABLE IF NOT EXISTS users_settlement_time_backup_20260110 AS
SELECT 
  address,
  last_settlement_time,
  rat_balance_wei,
  usdt_total,
  updated_at,
  NOW() AS backup_time
FROM users
WHERE (rat_balance_wei::numeric / 1e18) >= 10000;

-- 第二步：识别需要修复的用户
WITH eligible_users AS (
  SELECT 
    u.address,
    (u.rat_balance_wei::numeric / 1e18) AS rat_balance,
    u.last_settlement_time,
    u.rat_balance_updated_at
  FROM users u
  WHERE (u.rat_balance_wei::numeric / 1e18) >= 10000
),
claim_summary AS (
  SELECT 
    c.address,
    SUM(c.amount_wei::numeric / 1e18) AS total_claimed_rat,
    MAX(c.block_time) AS last_claim_time
  FROM claims c
  WHERE c.address IN (SELECT address FROM eligible_users)
  GROUP BY c.address
),
needs_fix AS (
  SELECT 
    eu.address,
    eu.rat_balance,
    eu.last_settlement_time AS old_settlement_time,
    -- 优先使用 rat_balance_updated_at（外部转账时间）
    -- 如果不存在或早于 last_claim_time，则使用 last_claim_time
    CASE 
      WHEN eu.rat_balance_updated_at IS NOT NULL AND 
           eu.rat_balance_updated_at > COALESCE(cs.last_claim_time, eu.rat_balance_updated_at) THEN
        eu.rat_balance_updated_at
      WHEN cs.last_claim_time IS NOT NULL THEN
        cs.last_claim_time
      ELSE
        eu.last_settlement_time
    END AS new_settlement_time,
    -- 判断是否有外部转账
    CASE 
      WHEN (eu.rat_balance - COALESCE(cs.total_claimed_rat, 0)) > (eu.rat_balance * 0.1) THEN true
      ELSE false
    END AS has_external_transfer
  FROM eligible_users eu
  LEFT JOIN claim_summary cs ON eu.address = cs.address
  WHERE 
    -- 条件1：有外部转账
    (eu.rat_balance - COALESCE(cs.total_claimed_rat, 0)) > (eu.rat_balance * 0.1)
    -- 条件2：新的结算时间晚于当前结算时间
    AND (
      CASE 
        WHEN eu.rat_balance_updated_at IS NOT NULL AND 
             eu.rat_balance_updated_at > COALESCE(cs.last_claim_time, eu.rat_balance_updated_at) THEN
          eu.rat_balance_updated_at
        WHEN cs.last_claim_time IS NOT NULL THEN
          cs.last_claim_time
        ELSE
          eu.last_settlement_time
      END
    ) > eu.last_settlement_time
)
-- 第三步：执行批量更新
UPDATE users u
SET 
  last_settlement_time = nf.new_settlement_time,
  updated_at = NOW()
FROM needs_fix nf
WHERE u.address = nf.address
RETURNING 
  u.address,
  nf.old_settlement_time,
  u.last_settlement_time AS new_settlement_time,
  nf.rat_balance,
  EXTRACT(EPOCH FROM (u.last_settlement_time - nf.old_settlement_time)) / 86400.0 AS time_shift_days;

-- 第四步：验证修复结果
SELECT 
  '修复完成统计' AS report_type,
  COUNT(*) AS fixed_users_count,
  SUM(rat_balance) AS total_rat_affected,
  AVG(EXTRACT(EPOCH FROM (new_settlement_time - old_settlement_time)) / 86400.0) AS avg_time_shift_days
FROM users_settlement_time_backup_20260110 backup
INNER JOIN users u ON backup.address = u.address
WHERE backup.last_settlement_time != u.last_settlement_time;

-- 第五步：详细修复日志
SELECT 
  u.address,
  backup.last_settlement_time AS old_time,
  u.last_settlement_time AS new_time,
  (u.rat_balance_wei::numeric / 1e18) AS rat_balance,
  EXTRACT(EPOCH FROM (u.last_settlement_time - backup.last_settlement_time)) / 86400.0 AS time_shift_days,
  -- 计算恢复的收益
  CASE 
    WHEN (u.rat_balance_wei::numeric / 1e18) >= 200000 THEN 10
    WHEN (u.rat_balance_wei::numeric / 1e18) >= 100000 THEN 6
    WHEN (u.rat_balance_wei::numeric / 1e18) >= 50000 THEN 4
    ELSE 2
  END AS daily_rate,
  ROUND(
    (u.rat_balance_wei::numeric / 1e18) * 0.01 * 
    CASE 
      WHEN (u.rat_balance_wei::numeric / 1e18) >= 200000 THEN 0.10
      WHEN (u.rat_balance_wei::numeric / 1e18) >= 100000 THEN 0.06
      WHEN (u.rat_balance_wei::numeric / 1e18) >= 50000 THEN 0.04
      ELSE 0.02
    END * 
    EXTRACT(EPOCH FROM (u.last_settlement_time - backup.last_settlement_time)) / 86400.0,
    6
  ) AS recovered_earnings_usdt
FROM users_settlement_time_backup_20260110 backup
INNER JOIN users u ON backup.address = u.address
WHERE backup.last_settlement_time != u.last_settlement_time
ORDER BY (u.rat_balance_wei::numeric / 1e18) DESC;

