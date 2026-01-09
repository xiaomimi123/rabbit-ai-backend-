-- ============================================
-- 允许用户自推荐功能
-- 日期: 2026-01-09
-- 目的: 移除自推荐检测逻辑，允许用户自己推荐自己并获得奖励
-- ============================================

-- 注意：这个脚本会更新 10 个参数的函数版本（后端实际使用的版本）

CREATE OR REPLACE FUNCTION public.process_claim_energy(
  p_tx_hash text, 
  p_address text, 
  p_referrer text, 
  p_amount_wei text, 
  p_block_number bigint, 
  p_block_time text,
  p_fee_amount_wei text DEFAULT NULL,
  p_self_reward integer DEFAULT 1,
  p_referrer_first integer DEFAULT 3,
  p_referrer_repeat integer DEFAULT 1
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_ref_address text;
  v_inserted integer;
  v_claim_count_before integer;
  v_is_first_claim boolean;
  v_energy_reward_user integer;
  v_energy_reward_referrer integer;
  v_invite_increment integer;
  v_block_time_tz timestamptz;
  -- 🟢 用于审计日志
  v_user_energy_before integer;
  v_user_energy_after integer;
  v_referrer_energy_before integer;
  v_referrer_energy_after integer;
BEGIN
  -- ---------------------------------------------------
  -- 1. 数据清洗与准备
  -- ---------------------------------------------------
  p_address := lower(p_address);
  v_ref_address := lower(p_referrer);
  
  -- 🟢 修改：允许自己推荐自己，不再过滤
  -- 如果推荐人是自己，仍然处理推荐奖励
  IF v_ref_address IS NOT NULL AND v_ref_address = p_address THEN
    RAISE NOTICE '[process_claim_energy] ✅ 允许自推荐: % 推荐自己', p_address;
    -- 不再将 v_ref_address 设为 NULL，允许自推荐获得奖励
  END IF;
  
  -- 处理时间格式
  IF p_block_time IS NULL OR TRIM(p_block_time) = '' THEN
    v_block_time_tz := NOW();
  ELSE
    v_block_time_tz := p_block_time::timestamptz;
  END IF;

  -- ---------------------------------------------------
  -- 2. 检查交易是否已存在（幂等性保护）
  -- ---------------------------------------------------
  SELECT 1 INTO v_inserted
  FROM claims
  WHERE tx_hash = p_tx_hash
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'status', 'skipped',
      'reason', 'tx_exists',
      'is_first_claim', NULL
    );
  END IF;

  -- ---------------------------------------------------
  -- 3. 🔒 关键修复：先锁定用户行，防止竞态条件
  -- ---------------------------------------------------
  -- 确保用户记录存在
  INSERT INTO users (address, energy_total, created_at, updated_at)
  VALUES (p_address, 0, NOW(), NOW())
  ON CONFLICT (address) DO NOTHING;
  
  -- 🔒 锁定用户行（悲观锁）
  SELECT energy_total INTO v_user_energy_before
  FROM users
  WHERE address = p_address
  FOR UPDATE;
  
  -- 如果推荐人存在，也锁定推荐人行
  -- 🟢 修改：自推荐时，推荐人就是自己，所以只需要锁定一次
  IF v_ref_address IS NOT NULL AND v_ref_address != '0x0000000000000000000000000000000000000000' THEN
    -- 如果是自推荐，推荐人就是自己，已经锁定过了
    IF v_ref_address != p_address THEN
      -- 确保推荐人记录存在
      INSERT INTO users (address, energy_total, created_at, updated_at)
      VALUES (v_ref_address, 0, NOW(), NOW())
      ON CONFLICT (address) DO NOTHING;
      
      -- 🔒 锁定推荐人行
      SELECT energy_total INTO v_referrer_energy_before
      FROM users
      WHERE address = v_ref_address
      FOR UPDATE;
    ELSE
      -- 自推荐：推荐人就是自己，使用已锁定的值
      v_referrer_energy_before := v_user_energy_before;
    END IF;
  END IF;

  -- ---------------------------------------------------
  -- 4. 统计用户当前 claim 总数（判断是否首次领取）
  -- ---------------------------------------------------
  SELECT COUNT(*) INTO v_claim_count_before
  FROM claims
  WHERE address = p_address;

  v_is_first_claim := (v_claim_count_before = 0);

  -- ---------------------------------------------------
  -- 5. 插入 claim 记录（原子操作）
  -- ---------------------------------------------------
  INSERT INTO claims (
    tx_hash, 
    address, 
    referrer, 
    amount_wei, 
    block_number, 
    block_time, 
    fee_amount_wei,
    status, 
    created_at, 
    energy_awarded
  )
  VALUES (
    p_tx_hash, 
    p_address, 
    v_ref_address,  -- 🟢 修改：自推荐时，这里会是自己的地址
    p_amount_wei, 
    p_block_number, 
    v_block_time_tz, 
    p_fee_amount_wei,
    'SUCCESS', 
    NOW(), 
    TRUE
  );

  -- ---------------------------------------------------
  -- 6. 🔒 关键修复：使用原子更新给用户自己加能量
  -- ---------------------------------------------------
  v_energy_reward_user := p_self_reward;

  UPDATE users
  SET 
    energy_total = energy_total + v_energy_reward_user,
    updated_at = NOW()
  WHERE address = p_address;
  
  -- 获取更新后的能量值（用于审计日志）
  SELECT energy_total INTO v_user_energy_after
  FROM users
  WHERE address = p_address;

  -- 🟢 记录审计日志：用户自己领取的能量
  INSERT INTO energy_audit_log (
    user_address,
    energy_before,
    energy_after,
    energy_delta,
    reason,
    tx_hash,
    created_at
  )
  VALUES (
    p_address,
    v_user_energy_before,
    v_user_energy_after,
    v_energy_reward_user,
    'claim_self',
    p_tx_hash,
    NOW()
  );

  RAISE NOTICE '[process_claim_energy] 用户 % 获得能量: % (从 % 到 %)', 
    p_address, v_energy_reward_user, v_user_energy_before, v_user_energy_after;

  -- ---------------------------------------------------
  -- 7. 🔒 关键修复：使用原子更新处理推荐人逻辑
  -- ---------------------------------------------------
  IF v_ref_address IS NOT NULL AND v_ref_address != '0x0000000000000000000000000000000000000000' THEN
    
    -- 7.1 根据是否首次领取，计算推荐人奖励
    IF v_is_first_claim THEN
      v_energy_reward_referrer := p_referrer_first;
      v_invite_increment := 1;
      RAISE NOTICE '[process_claim_energy] 推荐人 % 首次邀请，获得能量: %', v_ref_address, v_energy_reward_referrer;
    ELSE
      v_energy_reward_referrer := p_referrer_repeat;
      v_invite_increment := 0;
      RAISE NOTICE '[process_claim_energy] 推荐人 % 管道收益，获得能量: %', v_ref_address, v_energy_reward_referrer;
    END IF;
    
    -- 7.2 🔒 关键修复：使用原子更新（推荐人行已被锁定）
    -- 🟢 修改：自推荐时，推荐人就是自己，需要特殊处理
    IF v_ref_address = p_address THEN
      -- 自推荐：推荐人就是自己，直接更新自己的能量值
      UPDATE users
      SET 
        invite_count = invite_count + v_invite_increment,
        energy_total = energy_total + v_energy_reward_referrer,  -- 在原有基础上再加推荐奖励
        updated_at = NOW()
      WHERE address = p_address;
      
      -- 获取更新后的能量值（用于审计日志）
      SELECT energy_total INTO v_referrer_energy_after
      FROM users
      WHERE address = p_address;
    ELSE
      -- 正常推荐：推荐人是其他人
      UPDATE users
      SET 
        invite_count = invite_count + v_invite_increment,
        energy_total = energy_total + v_energy_reward_referrer,
        updated_at = NOW()
      WHERE address = v_ref_address;
      
      -- 获取更新后的能量值（用于审计日志）
      SELECT energy_total INTO v_referrer_energy_after
      FROM users
      WHERE address = v_ref_address;
    END IF;

    -- 🟢 记录审计日志：推荐人获得的能量
    INSERT INTO energy_audit_log (
      user_address,
      energy_before,
      energy_after,
      energy_delta,
      reason,
      tx_hash,
      referrer_address,
      created_at
    )
    VALUES (
      v_ref_address,
      v_referrer_energy_before,
      v_referrer_energy_after,
      v_energy_reward_referrer,
      CASE WHEN v_is_first_claim THEN 'referrer_first' ELSE 'referrer_repeat' END,
      p_tx_hash,
      p_address,  -- 被推荐人地址
      NOW()
    );
      
  END IF;

  -- ---------------------------------------------------
  -- 8. 返回结果
  -- ---------------------------------------------------
  RETURN jsonb_build_object(
    'status', 'success',
    'is_first_claim', v_is_first_claim,
    'energy_reward_user', v_energy_reward_user,
    'energy_reward_referrer', CASE WHEN v_ref_address IS NOT NULL THEN v_energy_reward_referrer ELSE NULL END,
    'is_self_referral', CASE WHEN v_ref_address = p_address THEN true ELSE false END
  );

EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING '[process_claim_energy] 错误: %', SQLERRM;
    RETURN jsonb_build_object(
      'status', 'error',
      'message', SQLERRM
    );
END;
$function$;

-- ============================================
-- 说明
-- ============================================
-- 1. 移除了自推荐检测逻辑，允许用户自己推荐自己
-- 2. 自推荐时，用户会同时获得：
--    - 自己领取的能量奖励（p_self_reward，默认1点）
--    - 推荐奖励的能量（首次3点，重复1点）
-- 3. 自推荐时，invite_count 也会增加（首次推荐时）
-- 4. 所有能量变化都会记录在 energy_audit_log 中
-- 5. 使用行锁确保并发安全

