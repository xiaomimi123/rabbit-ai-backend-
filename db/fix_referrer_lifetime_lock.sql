-- ============================================
-- P0级修复：推荐人地址终身制（一次绑定，终身有效）
-- 日期: 2026-01-09
-- 目的: 彻底解决推荐人地址被错误更新的问题
-- 核心原则: 推荐关系应该是"一次绑定，终身有效"，而不是"随时可变"
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
  v_existing_referrer text;  -- 🟢 新增：存储数据库中已存在的推荐人地址
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
  -- 3. 🔒 P0级修复：先锁定用户行，防止竞态条件
  -- ---------------------------------------------------
  -- 确保用户记录存在
  INSERT INTO users (address, energy_total, created_at, updated_at)
  VALUES (p_address, 0, NOW(), NOW())
  ON CONFLICT (address) DO NOTHING;
  
  -- 🔒 锁定用户行（悲观锁），同时获取已存在的推荐人地址
  SELECT 
    energy_total,
    COALESCE(referrer_address, '')  -- 获取数据库中已存在的推荐人地址
  INTO 
    v_user_energy_before,
    v_existing_referrer
  FROM users
  WHERE address = p_address
  FOR UPDATE;

  -- ---------------------------------------------------
  -- 4. 🔒 P0级核心修复：推荐人地址终身制逻辑
  -- ---------------------------------------------------
  -- 原则：推荐关系应该是"一次绑定，终身有效"
  -- 逻辑：
  --   1. 如果 users 表中已有推荐人地址（不是空且不是零地址），强制使用数据库中的值
  --   2. 如果 users 表中没有推荐人地址（新用户），才使用前端传来的参数
  --   3. 首次绑定时，将推荐人地址写入 users 表，从此锁定
  
  IF v_existing_referrer IS NOT NULL 
     AND v_existing_referrer != '' 
     AND v_existing_referrer != '0x0000000000000000000000000000000000000000' THEN
    -- ✅ 用户已注册，强制使用数据库中锁定的推荐人地址（终身制）
    v_ref_address := lower(v_existing_referrer);
    RAISE NOTICE '[process_claim_energy] 🔒 终身制：用户 % 已注册，强制使用数据库中的推荐人: % (忽略前端传入的: %)', 
      p_address, v_ref_address, lower(p_referrer);
  ELSE
    -- ✅ 新用户首次注册，使用前端传来的推荐人地址，并写入数据库锁定
    v_ref_address := lower(p_referrer);
    
    -- 验证推荐人地址有效性
    IF v_ref_address IS NULL 
       OR v_ref_address = '' 
       OR v_ref_address = '0x0000000000000000000000000000000000000000' THEN
      v_ref_address := NULL;
      RAISE NOTICE '[process_claim_energy] ⚠️ 新用户 % 没有有效的推荐人地址', p_address;
    ELSE
      -- 首次绑定：将推荐人地址写入 users 表，从此锁定
      UPDATE users
      SET referrer_address = v_ref_address,
          updated_at = NOW()
      WHERE address = p_address;
      
      RAISE NOTICE '[process_claim_energy] ✅ 首次绑定：用户 % 的推荐人地址已锁定为: %', 
        p_address, v_ref_address;
    END IF;
  END IF;
  
  -- 🟢 允许自推荐（如果推荐人是自己，仍然处理推荐奖励）
  IF v_ref_address IS NOT NULL AND v_ref_address = p_address THEN
    RAISE NOTICE '[process_claim_energy] ✅ 允许自推荐: % 推荐自己', p_address;
  END IF;

  -- ---------------------------------------------------
  -- 5. 如果推荐人存在，锁定推荐人行
  -- ---------------------------------------------------
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
  -- 6. 统计用户当前 claim 总数（判断是否首次领取）
  -- ---------------------------------------------------
  SELECT COUNT(*) INTO v_claim_count_before
  FROM claims
  WHERE address = p_address;

  v_is_first_claim := (v_claim_count_before = 0);

  -- ---------------------------------------------------
  -- 7. 插入 claim 记录（原子操作）
  -- ---------------------------------------------------
  -- ✅ 使用锁定的推荐人地址（终身制）
  INSERT INTO claims (
    tx_hash, 
    address, 
    referrer,  -- 🔒 使用锁定的推荐人地址，而不是前端传来的
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
    v_ref_address,  -- 🔒 终身制的推荐人地址
    p_amount_wei, 
    p_block_number, 
    v_block_time_tz, 
    p_fee_amount_wei,
    'SUCCESS', 
    NOW(), 
    TRUE
  );

  -- ---------------------------------------------------
  -- 8. 🔒 关键修复：使用原子更新给用户自己加能量
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
  -- 9. 🔒 关键修复：使用原子更新处理推荐人逻辑
  -- ---------------------------------------------------
  IF v_ref_address IS NOT NULL AND v_ref_address != '0x0000000000000000000000000000000000000000' THEN
    
    -- 9.1 根据是否首次领取，计算推荐人奖励
    IF v_is_first_claim THEN
      v_energy_reward_referrer := p_referrer_first;
      v_invite_increment := 1;
      RAISE NOTICE '[process_claim_energy] 推荐人 % 首次邀请，获得能量: %', v_ref_address, v_energy_reward_referrer;
    ELSE
      v_energy_reward_referrer := p_referrer_repeat;
      v_invite_increment := 0;
      RAISE NOTICE '[process_claim_energy] 推荐人 % 管道收益，获得能量: %', v_ref_address, v_energy_reward_referrer;
    END IF;
    
    -- 9.2 🔒 关键修复：使用原子更新（推荐人行已被锁定）
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
  -- 10. 返回结果
  -- ---------------------------------------------------
  RETURN jsonb_build_object(
    'status', 'success',
    'is_first_claim', v_is_first_claim,
    'energy_reward_user', v_energy_reward_user,
    'energy_reward_referrer', CASE WHEN v_ref_address IS NOT NULL THEN v_energy_reward_referrer ELSE NULL END,
    'is_self_referral', CASE WHEN v_ref_address = p_address THEN true ELSE false END,
    'referrer_used', v_ref_address,  -- 🟢 新增：返回实际使用的推荐人地址
    'referrer_source', CASE 
      WHEN v_existing_referrer IS NOT NULL 
           AND v_existing_referrer != '' 
           AND v_existing_referrer != '0x0000000000000000000000000000000000000000' 
      THEN 'database_locked'  -- 来自数据库锁定值
      ELSE 'first_binding'  -- 首次绑定
    END
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
-- 1. 🔒 P0级核心修复：推荐人地址终身制
--    - 如果 users 表中已有推荐人地址，强制使用数据库中的值（终身制）
--    - 如果 users 表中没有推荐人地址，才使用前端传来的参数（首次绑定）
--    - 首次绑定时，将推荐人地址写入 users 表，从此锁定
--
-- 2. 彻底解决推荐人地址被错误更新的问题
--    - 无论前端传什么，后端只认"初恋"（首次注册时的推荐人）
--    - 推荐关系应该是"一次绑定，终身有效"，而不是"随时可变"
--
-- 3. 允许自推荐
--    - 如果推荐人是自己，仍然处理推荐奖励
--
-- 4. 所有能量变化都会记录在 energy_audit_log 中
--
-- 5. 使用行锁确保并发安全
--
-- 6. 返回结果中包含 referrer_source 字段，标识推荐人地址的来源
--    - 'database_locked': 来自数据库锁定值（终身制）
--    - 'first_binding': 首次绑定

