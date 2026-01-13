-- ============================================
-- 修复：为 process_claim_energy 函数添加能量审计日志
-- 日期: 2026-01-13
-- 问题: 用户反馈"活动记录显示给3能量，但总能量只增加1个"
-- 原因: process_claim_energy 函数没有记录能量审计日志
-- 解决: 更新函数，添加能量审计日志记录
-- ============================================

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
  -- 🟢 新增：用于审计日志
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
  -- 3. 🟢 新增：获取用户当前能量值（用于审计日志）
  -- ---------------------------------------------------
  SELECT COALESCE(energy_total, 0)::integer INTO v_user_energy_before
  FROM users
  WHERE address = p_address;
  
  -- 如果用户不存在，设为0
  IF v_user_energy_before IS NULL THEN
    v_user_energy_before := 0;
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
    v_ref_address, 
    p_amount_wei, 
    p_block_number, 
    v_block_time_tz, 
    p_fee_amount_wei,
    'SUCCESS', 
    NOW(), 
    TRUE
  );

  -- ---------------------------------------------------
  -- 6. 🟢 使用动态配置：给用户自己加能量
  -- ---------------------------------------------------
  v_energy_reward_user := p_self_reward;

  INSERT INTO users (address, energy_total, created_at, updated_at)
  VALUES (p_address, v_energy_reward_user, NOW(), NOW())
  ON CONFLICT (address) DO UPDATE
  SET 
    energy_total = users.energy_total + v_energy_reward_user,
    updated_at = NOW();
  
  -- 获取更新后的能量值
  SELECT energy_total::integer INTO v_user_energy_after
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
  -- 7. 🟢 使用动态配置：处理推荐人逻辑
  -- ---------------------------------------------------
  IF v_ref_address IS NOT NULL AND v_ref_address != '0x0000000000000000000000000000000000000000' THEN
    
    -- 7.1 🟢 获取推荐人当前能量值（用于审计日志）
    SELECT COALESCE(energy_total, 0)::integer INTO v_referrer_energy_before
    FROM users
    WHERE address = v_ref_address;
    
    -- 如果推荐人不存在，设为0
    IF v_referrer_energy_before IS NULL THEN
      v_referrer_energy_before := 0;
    END IF;
    
    -- 7.2 根据是否首次领取，计算推荐人奖励
    IF v_is_first_claim THEN
      v_energy_reward_referrer := p_referrer_first;
      v_invite_increment := 1;
      RAISE NOTICE '[process_claim_energy] 推荐人 % 首次邀请，获得能量: %', v_ref_address, v_energy_reward_referrer;
    ELSE
      v_energy_reward_referrer := p_referrer_repeat;
      v_invite_increment := 0;
      RAISE NOTICE '[process_claim_energy] 推荐人 % 管道收益，获得能量: %', v_ref_address, v_energy_reward_referrer;
    END IF;
    
    -- 7.3 原子更新推荐人数据
    INSERT INTO users (address, invite_count, energy_total, created_at, updated_at)
    VALUES (
      v_ref_address, 
      v_invite_increment, 
      v_energy_reward_referrer, 
      NOW(), 
      NOW()
    )
    ON CONFLICT (address) DO UPDATE
    SET 
      invite_count = users.invite_count + v_invite_increment,
      energy_total = users.energy_total + v_energy_reward_referrer,
      updated_at = NOW();
    
    -- 获取更新后的能量值
    SELECT energy_total::integer INTO v_referrer_energy_after
    FROM users
    WHERE address = v_ref_address;

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
    
    RAISE NOTICE '[process_claim_energy] 推荐人 % 能量更新: % → % (+%)', 
      v_ref_address, v_referrer_energy_before, v_referrer_energy_after, v_energy_reward_referrer;
      
  END IF;

  -- ---------------------------------------------------
  -- 8. 返回处理结果
  -- ---------------------------------------------------
  RETURN jsonb_build_object(
    'status', 'success', 
    'is_first_claim', v_is_first_claim,
    'user_energy_reward', v_energy_reward_user,
    'referrer_energy_reward', COALESCE(v_energy_reward_referrer, 0)
  );

END;
$function$;

-- 📝 添加函数注释
COMMENT ON FUNCTION public.process_claim_energy(text, text, text, text, bigint, text, text, integer, integer, integer) IS 
'处理空投领取并计算能量奖励（支持动态配置+完整审计日志）
修复日期: 2026-01-13
修复内容: 添加能量审计日志，记录所有能量变化
参数：
- p_tx_hash: 交易哈希
- p_address: 领取者地址
- p_referrer: 推荐人地址
- p_amount_wei: 领取金额（wei）
- p_block_number: 区块号
- p_block_time: 区块时间
- p_fee_amount_wei: 实际支付的手续费（wei）
- p_self_reward: 用户自己获得的能量（默认1）
- p_referrer_first: 推荐人首次邀请奖励（默认3）
- p_referrer_repeat: 推荐人非首次奖励（默认1）';

-- ✅ 测试函数
DO $$
DECLARE
  test_result jsonb;
  test_tx_hash text;
  test_user text;
  test_referrer text;
BEGIN
  RAISE NOTICE '开始测试 process_claim_energy 函数（带审计日志）...';
  
  -- 生成随机测试数据
  test_tx_hash := '0xtest_audit_' || floor(random() * 1000000)::text;
  test_user := '0xtest_user_' || floor(random() * 1000000)::text;
  test_referrer := '0xtest_ref_' || floor(random() * 1000000)::text;
  
  -- 测试场景：新用户首次领取，有推荐人
  -- 预期：用户获得 1 能量，推荐人获得 3 能量，都有审计日志
  test_result := process_claim_energy(
    test_tx_hash,
    test_user,
    test_referrer,
    '1000000000000000000',  -- 1 RAT
    123456,
    NOW()::text,
    NULL,
    1,    -- 用户奖励 1 能量
    3,    -- 推荐人首次 3 能量
    1     -- 推荐人管道 1 能量
  );
  
  RAISE NOTICE '测试结果: %', test_result;
  
  -- 验证审计日志
  RAISE NOTICE '验证审计日志...';
  RAISE NOTICE '用户审计日志: %', (
    SELECT json_agg(row_to_json(t))
    FROM (
      SELECT user_address, energy_before, energy_after, energy_delta, reason
      FROM energy_audit_log
      WHERE tx_hash = test_tx_hash AND user_address = test_user
    ) t
  );
  RAISE NOTICE '推荐人审计日志: %', (
    SELECT json_agg(row_to_json(t))
    FROM (
      SELECT user_address, energy_before, energy_after, energy_delta, reason
      FROM energy_audit_log
      WHERE tx_hash = test_tx_hash AND user_address = test_referrer
    ) t
  );
  
  RAISE NOTICE '✅ 函数更新成功！已添加能量审计日志功能。';
END $$;

