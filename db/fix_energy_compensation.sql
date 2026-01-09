-- ============================================
-- P0 级紧急修复：能量值补偿脚本
-- 日期: 2026-01-09
-- 目的: 补偿因竞态条件丢失的能量值
-- ============================================

-- 注意：执行前请先备份数据库！

-- 1. 计算每个用户的能量值差异
WITH user_energy_calc AS (
  SELECT 
    u.address,
    u.invite_count,
    u.energy_total as current_energy,
    -- 计算自己领取的能量
    (SELECT COUNT(*) FROM claims c WHERE c.address = u.address) as self_claim_count,
    -- 计算推荐人应该获得的能量（排除自己推荐自己）
    COUNT(DISTINCT CASE WHEN c.address != u.address THEN c.address END) as unique_invitees,
    COUNT(CASE WHEN c.address != u.address THEN 1 END) as total_referrer_claims,
    COUNT(DISTINCT CASE WHEN c.address != u.address THEN c.address END) * 3 + 
    (COUNT(CASE WHEN c.address != u.address THEN 1 END) - COUNT(DISTINCT CASE WHEN c.address != u.address THEN c.address END)) * 1 as calculated_referrer_energy
  FROM users u
  LEFT JOIN claims c ON c.referrer = u.address
  WHERE u.invite_count > 0
  GROUP BY u.address, u.invite_count, u.energy_total
),
energy_diff AS (
  SELECT 
    address,
    current_energy,
    self_claim_count,
    unique_invitees,
    total_referrer_claims,
    calculated_referrer_energy,
    self_claim_count + calculated_referrer_energy as calculated_total_energy,
    (self_claim_count + calculated_referrer_energy) - current_energy as energy_diff
  FROM user_energy_calc
  WHERE calculated_referrer_energy > 0
)
SELECT 
  address,
  current_energy,
  calculated_total_energy,
  energy_diff,
  CASE 
    WHEN energy_diff > 0 THEN '需要补偿'
    WHEN energy_diff < 0 THEN '能量值异常（可能多计算了）'
    ELSE '正常'
  END as status
FROM energy_diff
WHERE ABS(energy_diff) > 5  -- 只显示差异大于 5 的用户
ORDER BY ABS(energy_diff) DESC;

-- 2. 补偿特定用户的能量值（示例：用户 0x22d7f55275ce0cf84e073d6971e7aefb3ba910b2）
-- 注意：请根据上面的查询结果，手动计算每个用户的补偿值

-- 示例：补偿用户 0x22d7f55275ce0cf84e073d6971e7aefb3ba910b2
DO $$
DECLARE
  v_user_address TEXT := '0x22d7f55275ce0cf84e073d6971e7aefb3ba910b2';
  v_energy_before INTEGER;
  v_energy_after INTEGER;
  v_compensation INTEGER := 68;  -- 根据计算得出的补偿值
BEGIN
  -- 获取当前能量值
  SELECT energy_total INTO v_energy_before
  FROM users
  WHERE address = v_user_address;
  
  -- 更新能量值
  UPDATE users
  SET 
    energy_total = energy_total + v_compensation,
    updated_at = NOW()
  WHERE address = v_user_address;
  
  -- 获取更新后的能量值
  SELECT energy_total INTO v_energy_after
  FROM users
  WHERE address = v_user_address;
  
  -- 记录审计日志
  INSERT INTO energy_audit_log (
    user_address,
    energy_before,
    energy_after,
    energy_delta,
    reason,
    created_at
  )
  VALUES (
    v_user_address,
    v_energy_before,
    v_energy_after,
    v_compensation,
    'fix_race_condition_compensation',
    NOW()
  );
  
  RAISE NOTICE '✅ 用户 % 能量值已补偿: % -> % (补偿: %)', 
    v_user_address, v_energy_before, v_energy_after, v_compensation;
END $$;

-- 3. 批量补偿所有受影响用户（谨慎使用！）
-- 注意：这个脚本会补偿所有差异大于 5 的用户
-- 执行前请仔细检查计算结果！

/*
DO $$
DECLARE
  v_user RECORD;
  v_energy_before INTEGER;
  v_energy_after INTEGER;
  v_compensation INTEGER;
BEGIN
  FOR v_user IN 
    SELECT 
      u.address,
      u.energy_total as current_energy,
      (SELECT COUNT(*) FROM claims c WHERE c.address = u.address) as self_claim_count,
      COUNT(DISTINCT CASE WHEN c.address != u.address THEN c.address END) * 3 + 
      (COUNT(CASE WHEN c.address != u.address THEN 1 END) - COUNT(DISTINCT CASE WHEN c.address != u.address THEN c.address END)) * 1 as calculated_referrer_energy
    FROM users u
    LEFT JOIN claims c ON c.referrer = u.address
    WHERE u.invite_count > 0
    GROUP BY u.address, u.energy_total
    HAVING ABS(
      (SELECT COUNT(*) FROM claims c WHERE c.address = u.address) + 
      (COUNT(DISTINCT CASE WHEN c.address != u.address THEN c.address END) * 3 + 
       (COUNT(CASE WHEN c.address != u.address THEN 1 END) - COUNT(DISTINCT CASE WHEN c.address != u.address THEN c.address END)) * 1) - 
      u.energy_total
    ) > 5
  LOOP
    v_compensation := (v_user.self_claim_count + v_user.calculated_referrer_energy) - v_user.current_energy;
    
    IF v_compensation > 0 THEN
      SELECT energy_total INTO v_energy_before
      FROM users
      WHERE address = v_user.address;
      
      UPDATE users
      SET 
        energy_total = energy_total + v_compensation,
        updated_at = NOW()
      WHERE address = v_user.address;
      
      SELECT energy_total INTO v_energy_after
      FROM users
      WHERE address = v_user.address;
      
      INSERT INTO energy_audit_log (
        user_address,
        energy_before,
        energy_after,
        energy_delta,
        reason,
        created_at
      )
      VALUES (
        v_user.address,
        v_energy_before,
        v_energy_after,
        v_compensation,
        'fix_race_condition_compensation_batch',
        NOW()
      );
      
      RAISE NOTICE '✅ 用户 % 能量值已补偿: % -> % (补偿: %)', 
        v_user.address, v_energy_before, v_energy_after, v_compensation;
    END IF;
  END LOOP;
END $$;
*/

