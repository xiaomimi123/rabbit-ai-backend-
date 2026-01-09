-- ============================================
-- P0级修复：清理非法收益（脏数据）
-- 日期: 2026-01-09
-- 目的: 清理余额 < 10,000 RAT 但 usdt_total > 0 的非法收益
-- ============================================

-- 说明：
-- 1. 根据业务规则，只有余额 >= 10,000 RAT 才能产生收益
-- 2. 如果余额 < 10,000 RAT 但 usdt_total > 0，说明是历史脏数据（非法收益）
-- 3. 代码层面已经拒绝这些脏数据，但为了数据一致性，需要清理数据库

-- ============================================
-- 步骤 1：识别脏数据（仅查询，不修改）
-- ============================================

-- 查询所有可能的脏数据用户
-- 注意：这里使用系统记录余额（claims + referral_rewards），而不是链上余额
-- 因为链上余额可能包含外部转账，而历史收益是基于系统记录余额计算的
SELECT 
  u.address,
  u.usdt_total,
  u.energy_total,
  u.created_at,
  -- 计算系统记录余额
  COALESCE(
    (SELECT SUM(CAST(amount_wei AS NUMERIC) / 1e18) 
     FROM claims 
     WHERE address = u.address), 0
  ) + COALESCE(
    (SELECT SUM(CAST(amount_wei AS NUMERIC) / 1e18) 
     FROM referral_rewards 
     WHERE referrer_address = u.address), 0
  ) AS system_recorded_balance
FROM users u
WHERE 
  u.usdt_total > 0  -- 有历史收益
  AND (
    -- 情况1：系统记录余额 < 10,000（即使链上余额可能 >= 10,000）
    (
      COALESCE(
        (SELECT SUM(CAST(amount_wei AS NUMERIC) / 1e18) 
         FROM claims 
         WHERE address = u.address), 0
      ) + COALESCE(
        (SELECT SUM(CAST(amount_wei AS NUMERIC) / 1e18) 
         FROM referral_rewards 
         WHERE referrer_address = u.address), 0
      )
    ) < 10000
  )
ORDER BY u.usdt_total DESC;

-- ============================================
-- 步骤 2：创建审计表（记录清理前的数据）
-- ============================================

-- 创建审计表（如果不存在）
CREATE TABLE IF NOT EXISTS illegal_earnings_audit (
  id SERIAL PRIMARY KEY,
  address TEXT NOT NULL,
  original_usdt_total NUMERIC NOT NULL,
  system_recorded_balance NUMERIC NOT NULL,
  cleanup_reason TEXT NOT NULL,
  cleaned_at TIMESTAMPTZ DEFAULT NOW(),
  cleaned_by TEXT DEFAULT 'system'
);

COMMENT ON TABLE illegal_earnings_audit IS '非法收益清理审计表（记录清理前的数据）';

-- ============================================
-- 步骤 3：清理脏数据（可选：清零或保留用于审计）
-- ============================================

-- 选项 A：清零脏数据（推荐）
-- 注意：执行前请先备份数据库！
-- 这个操作会：
-- 1. 将脏数据记录到审计表
-- 2. 将 usdt_total 清零（如果系统记录余额 < 10,000）

DO $$
DECLARE
  v_user_record RECORD;
  v_system_balance NUMERIC;
  v_affected_count INTEGER := 0;
BEGIN
  -- 遍历所有可能的脏数据用户
  FOR v_user_record IN
    SELECT 
      u.address,
      u.usdt_total,
      COALESCE(
        (SELECT SUM(CAST(amount_wei AS NUMERIC) / 1e18) 
         FROM claims 
         WHERE address = u.address), 0
      ) + COALESCE(
        (SELECT SUM(CAST(amount_wei AS NUMERIC) / 1e18) 
         FROM referral_rewards 
         WHERE referrer_address = u.address), 0
      ) AS system_recorded_balance
    FROM users u
    WHERE 
      u.usdt_total > 0
      AND (
        COALESCE(
          (SELECT SUM(CAST(amount_wei AS NUMERIC) / 1e18) 
           FROM claims 
           WHERE address = u.address), 0
        ) + COALESCE(
          (SELECT SUM(CAST(amount_wei AS NUMERIC) / 1e18) 
           FROM referral_rewards 
           WHERE referrer_address = u.address), 0
        )
      ) < 10000
  LOOP
    -- 记录到审计表
    INSERT INTO illegal_earnings_audit (
      address,
      original_usdt_total,
      system_recorded_balance,
      cleanup_reason
    ) VALUES (
      v_user_record.address,
      v_user_record.usdt_total,
      v_user_record.system_recorded_balance,
      format('系统记录余额 %s RAT < 10,000 RAT，但存在历史收益 %s USDT（非法收益）', 
             v_user_record.system_recorded_balance, 
             v_user_record.usdt_total)
    );
    
    -- 清零 usdt_total
    UPDATE users
    SET 
      usdt_total = 0,
      updated_at = NOW()
    WHERE address = v_user_record.address;
    
    v_affected_count := v_affected_count + 1;
    
    RAISE NOTICE '已清理用户 % 的非法收益: % USDT (系统记录余额: % RAT)', 
                 v_user_record.address, 
                 v_user_record.usdt_total,
                 v_user_record.system_recorded_balance;
  END LOOP;
  
  RAISE NOTICE '清理完成: 共清理 % 个用户的非法收益', v_affected_count;
END $$;

-- ============================================
-- 步骤 4：验证清理结果
-- ============================================

-- 查询清理后的脏数据（应该为空）
SELECT 
  u.address,
  u.usdt_total,
  COALESCE(
    (SELECT SUM(CAST(amount_wei AS NUMERIC) / 1e18) 
     FROM claims 
     WHERE address = u.address), 0
  ) + COALESCE(
    (SELECT SUM(CAST(amount_wei AS NUMERIC) / 1e18) 
     FROM referral_rewards 
     WHERE referrer_address = u.address), 0
  ) AS system_recorded_balance
FROM users u
WHERE 
  u.usdt_total > 0
  AND (
    COALESCE(
      (SELECT SUM(CAST(amount_wei AS NUMERIC) / 1e18) 
       FROM claims 
       WHERE address = u.address), 0
    ) + COALESCE(
      (SELECT SUM(CAST(amount_wei AS NUMERIC) / 1e18) 
       FROM referral_rewards 
       WHERE referrer_address = u.address), 0
    )
  ) < 10000;

-- 查询审计表（查看清理记录）
SELECT 
  address,
  original_usdt_total,
  system_recorded_balance,
  cleanup_reason,
  cleaned_at
FROM illegal_earnings_audit
ORDER BY cleaned_at DESC;

-- ============================================
-- 重要提示
-- ============================================

-- 1. 执行清理前，请先备份数据库！
-- 2. 建议先在测试环境执行，验证无误后再在生产环境执行
-- 3. 清理操作会记录到审计表，可以追溯
-- 4. 如果不想清零，可以只执行步骤 1 和步骤 2，不执行步骤 3
-- 5. 代码层面已经拒绝脏数据，所以即使不清理，也不会影响系统安全
--    但为了数据一致性，建议清理

