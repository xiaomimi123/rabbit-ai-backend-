-- ============================================
-- P0级修复：修复历史推荐奖励地址不匹配问题
-- 日期: 2026-01-09
-- 目的: 修复 138 笔不匹配的交易记录
-- ============================================

-- 步骤1：查看需要修复的记录数量
DO $$
DECLARE
  v_mismatch_count integer;
BEGIN
  SELECT COUNT(*) INTO v_mismatch_count
  FROM claims c
  JOIN referral_rewards rr ON rr.tx_hash = c.tx_hash
  WHERE c.referrer != rr.referrer_address
    AND c.referrer IS NOT NULL
    AND c.referrer != '0x0000000000000000000000000000000000000000'
    AND rr.referrer_address IS NOT NULL;
  
  RAISE NOTICE '需要修复的记录数: %', v_mismatch_count;
END $$;

-- 步骤2：修复推荐奖励地址（使用 claims 表中的 referrer）
-- 🔒 使用事务确保原子性
BEGIN;

-- 创建临时表记录修复日志
CREATE TEMP TABLE IF NOT EXISTS referral_reward_fix_log (
  tx_hash text PRIMARY KEY,
  old_referrer text,
  new_referrer text,
  claimer_address text,
  amount_wei text,
  fixed_at timestamptz DEFAULT NOW()
);

-- 修复推荐奖励地址
UPDATE referral_rewards rr
SET 
  referrer_address = c.referrer,
  updated_at = NOW()
FROM claims c
WHERE rr.tx_hash = c.tx_hash
  AND c.referrer != rr.referrer_address
  AND c.referrer IS NOT NULL
  AND c.referrer != '0x0000000000000000000000000000000000000000'
  AND rr.referrer_address IS NOT NULL
RETURNING 
  rr.tx_hash,
  rr.referrer_address AS old_referrer,
  c.referrer AS new_referrer,
  c.address AS claimer_address,
  rr.amount_wei
INTO TEMP TABLE referral_reward_fix_log;

-- 显示修复结果
DO $$
DECLARE
  v_fixed_count integer;
BEGIN
  SELECT COUNT(*) INTO v_fixed_count FROM referral_reward_fix_log;
  RAISE NOTICE '✅ 已修复 % 条推荐奖励记录', v_fixed_count;
END $$;

-- 提交事务
COMMIT;

-- 步骤3：验证修复结果
SELECT 
  COUNT(*) as remaining_mismatches,
  '如果为 0 则修复成功' as status
FROM claims c
JOIN referral_rewards rr ON rr.tx_hash = c.tx_hash
WHERE c.referrer != rr.referrer_address
  AND c.referrer IS NOT NULL
  AND rr.referrer_address IS NOT NULL;

-- 步骤4：显示修复详情（前20条）
SELECT 
  tx_hash,
  old_referrer,
  new_referrer,
  claimer_address,
  amount_wei,
  fixed_at
FROM referral_reward_fix_log
ORDER BY fixed_at DESC
LIMIT 20;

