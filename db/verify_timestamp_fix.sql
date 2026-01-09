-- ========================================
-- 验证资金入账时间戳机制修复效果
-- ========================================

-- 查询1: 验证需要修复的用户当前状态
WITH eligible_users AS (
  SELECT 
    address,
    (rat_balance_wei::numeric / 1e18) AS current_balance,
    last_settlement_time
  FROM users
  WHERE (rat_balance_wei::numeric / 1e18) >= 10000
),
system_recorded AS (
  SELECT 
    u.address,
    u.current_balance,
    u.last_settlement_time,
    COALESCE(SUM(c.amount_wei::numeric / 1e18), 0) + 
    COALESCE(SUM(r.amount_wei::numeric / 1e18), 0) AS system_balance
  FROM eligible_users u
  LEFT JOIN claims c ON u.address = c.address
  LEFT JOIN referral_rewards r ON u.address = r.referrer_address
  GROUP BY u.address, u.current_balance, u.last_settlement_time
)
SELECT 
  address,
  ROUND(current_balance, 2) AS balance,
  ROUND(system_balance, 2) AS system_balance,
  ROUND(current_balance - system_balance, 2) AS external_transfer,
  last_settlement_time,
  ROUND(
    EXTRACT(EPOCH FROM (NOW() - last_settlement_time)) / 86400.0, 
    2
  ) AS days_since_settlement,
  CASE 
    WHEN system_balance < 10000 AND current_balance >= 10000 THEN
      CASE
        WHEN EXTRACT(EPOCH FROM (NOW() - last_settlement_time)) / 86400.0 < 1 THEN
          '✅ 已修复（起息日很新）'
        ELSE
          '⚠️ 可能需要检查'
      END
    ELSE
      '✅ 正常（内生增长）'
  END AS fix_status
FROM system_recorded
WHERE system_balance < 10000 AND current_balance >= 10000
ORDER BY external_transfer DESC;

-- 查询2: 验证所有 >= 10k 用户的起息日是否合理
SELECT 
  address,
  ROUND((rat_balance_wei::numeric / 1e18), 2) AS balance,
  last_settlement_time,
  ROUND(
    EXTRACT(EPOCH FROM (NOW() - last_settlement_time)) / 86400.0, 
    2
  ) AS days_since_settlement,
  CASE 
    WHEN EXTRACT(EPOCH FROM (NOW() - last_settlement_time)) / 86400.0 > 60 THEN
      '⚠️ 起息日过早（>60天）'
    WHEN EXTRACT(EPOCH FROM (NOW() - last_settlement_time)) / 86400.0 < 0 THEN
      '❌ 起息日在未来（错误）'
    ELSE
      '✅ 正常'
  END AS status
FROM users
WHERE (rat_balance_wei::numeric / 1e18) >= 10000
ORDER BY last_settlement_time ASC
LIMIT 20;

