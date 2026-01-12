-- ========================================
-- P0级紧急修复：立即固化3个用户的收益
-- 执行时间：2026-01-10（今晚立即执行）
-- 目的：防止后端自动初始化逻辑覆盖我们的 last_settlement_time 修复
-- ========================================

-- 背景说明：
-- 我们刚刚批量修复了14个用户的 last_settlement_time
-- 但其中3个用户的 usdt_total = 0，会触发后端的自动初始化逻辑
-- 这可能导致用户明天打开DAPP时看到错误的收益
-- 解决方案：立即将这3个用户的收益固化到 usdt_total，避免被覆盖

-- 第一步：备份当前数据
CREATE TABLE IF NOT EXISTS users_emergency_backup_20260110_2 AS
SELECT 
  address,
  usdt_total,
  last_settlement_time,
  rat_balance_wei,
  updated_at,
  NOW() AS backup_time
FROM users
WHERE address IN (
  '0x5f44b8aef38a74e83d5d412a19075b6cdfbe2606',
  '0x267d2c110fb1c60f427fe81952937542b83cdafc',
  '0x22d7f55275ce0cf84e073d6971e7aefb3ba910b2'
);

-- 第二步：计算并固化收益
WITH earnings_calc AS (
  SELECT 
    u.address,
    (u.rat_balance_wei::numeric / 1e18) AS rat_balance,
    u.last_settlement_time,
    u.usdt_total::numeric AS current_usdt_total,
    -- 计算距离上次结算的天数
    EXTRACT(EPOCH FROM (NOW() - u.last_settlement_time)) / 86400.0 AS days_elapsed,
    -- 计算VIP等级和日利率
    CASE 
      WHEN (u.rat_balance_wei::numeric / 1e18) >= 200000 THEN 10
      WHEN (u.rat_balance_wei::numeric / 1e18) >= 100000 THEN 6
      WHEN (u.rat_balance_wei::numeric / 1e18) >= 50000 THEN 4
      ELSE 2
    END AS daily_rate,
    -- 计算增量收益
    (u.rat_balance_wei::numeric / 1e18) * 0.01 * 
    CASE 
      WHEN (u.rat_balance_wei::numeric / 1e18) >= 200000 THEN 0.10
      WHEN (u.rat_balance_wei::numeric / 1e18) >= 100000 THEN 0.06
      WHEN (u.rat_balance_wei::numeric / 1e18) >= 50000 THEN 0.04
      ELSE 0.02
    END * 
    (EXTRACT(EPOCH FROM (NOW() - u.last_settlement_time)) / 86400.0) AS incremental_earnings
  FROM users u
  WHERE u.address IN (
    '0x5f44b8aef38a74e83d5d412a19075b6cdfbe2606',
    '0x267d2c110fb1c60f427fe81952937542b83cdafc',
    '0x22d7f55275ce0cf84e073d6971e7aefb3ba910b2'
  )
)
UPDATE users u
SET 
  usdt_total = ec.current_usdt_total + ec.incremental_earnings,
  last_settlement_time = NOW(),
  updated_at = NOW()
FROM earnings_calc ec
WHERE u.address = ec.address
RETURNING 
  u.address,
  ec.current_usdt_total AS old_usdt_total,
  u.usdt_total AS new_usdt_total,
  ec.incremental_earnings AS added_earnings,
  ec.days_elapsed AS days_since_last_settlement,
  ec.daily_rate AS vip_daily_rate;

-- 第三步：验证修复结果
SELECT 
  u.address,
  ROUND((u.rat_balance_wei::numeric / 1e18), 2) AS rat_balance,
  ROUND(u.usdt_total::numeric, 6) AS usdt_total_after_fix,
  u.last_settlement_time AS last_settlement_time_after_fix,
  ROUND(
    EXTRACT(EPOCH FROM (u.last_settlement_time - backup.last_settlement_time)) / 3600.0, 
    2
  ) AS time_moved_forward_hours,
  ROUND(u.usdt_total::numeric - backup.usdt_total::numeric, 6) AS earnings_solidified
FROM users u
INNER JOIN users_emergency_backup_20260110_2 backup ON u.address = backup.address
WHERE u.address IN (
  '0x5f44b8aef38a74e83d5d412a19075b6cdfbe2606',
  '0x267d2c110fb1c60f427fe81952937542b83cdafc',
  '0x22d7f55275ce0cf84e073d6971e7aefb3ba910b2'
)
ORDER BY (u.rat_balance_wei::numeric / 1e18) DESC;

-- 第四步：统计报告
SELECT 
  '紧急修复统计' AS report_type,
  COUNT(*) AS fixed_users,
  SUM(u.usdt_total::numeric) AS total_solidified_earnings,
  AVG(EXTRACT(EPOCH FROM (u.last_settlement_time - backup.last_settlement_time)) / 3600.0) AS avg_time_moved_hours
FROM users u
INNER JOIN users_emergency_backup_20260110_2 backup ON u.address = backup.address
WHERE u.address IN (
  '0x5f44b8aef38a74e83d5d412a19075b6cdfbe2606',
  '0x267d2c110fb1c60f427fe81952937542b83cdafc',
  '0x22d7f55275ce0cf84e073d6971e7aefb3ba910b2'
);

