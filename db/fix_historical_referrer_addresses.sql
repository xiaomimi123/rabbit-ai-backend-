-- ============================================
-- P0级修复：修复历史数据中推荐人地址被错误更新的问题
-- 日期: 2026-01-09
-- 目的: 将每个用户的所有 claims 记录的 referrer 都更新为其首次注册时的推荐人地址
-- 核心原则: 推荐关系应该是"一次绑定，终身有效"
-- ============================================

-- ⚠️ 警告：此脚本会修改历史数据，执行前请备份数据库！

BEGIN;

-- ============================================
-- 步骤1：创建临时表，存储每个用户的首次推荐人地址
-- ============================================
CREATE TEMP TABLE user_first_referrer AS
SELECT 
  address,
  referrer as first_referrer,
  created_at as first_claim_time,
  tx_hash as first_tx_hash
FROM (
  SELECT 
    address,
    referrer,
    created_at,
    tx_hash,
    ROW_NUMBER() OVER (PARTITION BY address ORDER BY created_at ASC) as rn
  FROM claims
  WHERE referrer IS NOT NULL
    AND referrer != '0x0000000000000000000000000000000000000000'
    AND referrer != ''
) ranked
WHERE rn = 1;

-- 创建索引以提高性能
CREATE INDEX idx_user_first_referrer_address ON user_first_referrer(address);

-- ============================================
-- 步骤2：找出所有推荐人地址被错误更新的记录
-- ============================================
CREATE TEMP TABLE wrong_referrer_claims AS
SELECT 
  c.tx_hash,
  c.address,
  c.referrer as current_referrer,
  ufr.first_referrer as correct_referrer,
  c.created_at
FROM claims c
INNER JOIN user_first_referrer ufr ON c.address = ufr.address
WHERE c.referrer != ufr.first_referrer
  AND c.referrer IS NOT NULL
  AND c.referrer != '0x0000000000000000000000000000000000000000'
  AND ufr.first_referrer IS NOT NULL
  AND ufr.first_referrer != '0x0000000000000000000000000000000000000000';

-- ============================================
-- 步骤3：更新 claims 表中的推荐人地址
-- ============================================
UPDATE claims c
SET referrer = wrc.correct_referrer
FROM wrong_referrer_claims wrc
WHERE c.tx_hash = wrc.tx_hash;

-- ============================================
-- 步骤4：更新 users 表中的推荐人地址（确保一致性）
-- ============================================
UPDATE users u
SET referrer_address = ufr.first_referrer,
    updated_at = NOW()
FROM user_first_referrer ufr
WHERE u.address = ufr.address
  AND (
    u.referrer_address IS NULL
    OR u.referrer_address = ''
    OR u.referrer_address = '0x0000000000000000000000000000000000000000'
    OR u.referrer_address != ufr.first_referrer
  );

-- ============================================
-- 步骤5：更新 referral_rewards 表中的推荐人地址
-- ============================================
UPDATE referral_rewards rr
SET referrer_address = ufr.first_referrer
FROM claims c
INNER JOIN user_first_referrer ufr ON c.address = ufr.address
WHERE rr.tx_hash = c.tx_hash
  AND rr.referrer_address != ufr.first_referrer
  AND ufr.first_referrer IS NOT NULL
  AND ufr.first_referrer != '0x0000000000000000000000000000000000000000';

-- ============================================
-- 步骤6：生成修复报告
-- ============================================
DO $$
DECLARE
  v_total_fixed_claims integer;
  v_total_fixed_users integer;
  v_total_fixed_rewards integer;
BEGIN
  SELECT COUNT(*) INTO v_total_fixed_claims FROM wrong_referrer_claims;
  SELECT COUNT(DISTINCT address) INTO v_total_fixed_users FROM wrong_referrer_claims;
  SELECT COUNT(*) INTO v_total_fixed_rewards
  FROM referral_rewards rr
  INNER JOIN claims c ON rr.tx_hash = c.tx_hash
  INNER JOIN user_first_referrer ufr ON c.address = ufr.address
  WHERE rr.referrer_address = ufr.first_referrer;
  
  RAISE NOTICE '========================================';
  RAISE NOTICE '修复完成报告';
  RAISE NOTICE '========================================';
  RAISE NOTICE '修复的 claims 记录数: %', v_total_fixed_claims;
  RAISE NOTICE '修复的用户数: %', v_total_fixed_users;
  RAISE NOTICE '修复的 referral_rewards 记录数: %', v_total_fixed_rewards;
  RAISE NOTICE '========================================';
END $$;

-- ============================================
-- 步骤7：验证修复结果
-- ============================================
-- 检查是否还有推荐人地址不一致的记录
DO $$
DECLARE
  v_remaining_issues integer;
BEGIN
  SELECT COUNT(*) INTO v_remaining_issues
  FROM claims c
  INNER JOIN user_first_referrer ufr ON c.address = ufr.address
  WHERE c.referrer != ufr.first_referrer
    AND c.referrer IS NOT NULL
    AND c.referrer != '0x0000000000000000000000000000000000000000'
    AND ufr.first_referrer IS NOT NULL
    AND ufr.first_referrer != '0x0000000000000000000000000000000000000000';
  
  IF v_remaining_issues > 0 THEN
    RAISE WARNING '⚠️ 仍有 % 条记录推荐人地址不一致，请检查！', v_remaining_issues;
  ELSE
    RAISE NOTICE '✅ 所有推荐人地址已修复，数据一致性验证通过！';
  END IF;
END $$;

-- 提交事务
COMMIT;

-- ============================================
-- 说明
-- ============================================
-- 1. 此脚本会修复所有推荐人地址被错误更新的历史数据
-- 2. 对于每个用户，将其所有 claims 记录的 referrer 都更新为其首次注册时的推荐人地址
-- 3. 同时更新 users 表和 referral_rewards 表，确保数据一致性
-- 4. 执行前请备份数据库！
-- 5. 执行后请验证修复结果

