-- ============================================
-- P0级修复：推荐奖励插入函数（带事务和行锁）
-- 日期: 2026-01-09
-- 目的: 修复推荐奖励地址不匹配问题，添加并发保护
-- ============================================

-- 创建函数：安全地插入推荐奖励记录
CREATE OR REPLACE FUNCTION public.insert_referral_reward_safe(
  p_tx_hash text,
  p_claimer_address text,
  p_referrer_from_claim text,  -- 从 claims 表中获取的推荐人
  p_referrer_from_event text,  -- 从事件中获取的推荐人（用于验证）
  p_amount_wei text,
  p_block_number bigint,
  p_block_time text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_claim_referrer text;
  v_final_referrer text;
  v_existing_referrer text;
  v_inserted boolean := false;
BEGIN
  -- 标准化地址
  p_tx_hash := lower(p_tx_hash);
  p_claimer_address := lower(p_claimer_address);
  p_referrer_from_claim := lower(p_referrer_from_claim);
  p_referrer_from_event := lower(p_referrer_from_event);
  
  -- ============================================
  -- 1. 🔒 关键修复：锁定 claims 表行，防止并发
  -- ============================================
  -- 先检查交易是否已存在，并锁定该行
  SELECT referrer INTO v_claim_referrer
  FROM claims
  WHERE tx_hash = p_tx_hash
  FOR UPDATE;  -- 🔒 行锁：防止并发修改
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'status', 'error',
      'reason', 'claim_not_found',
      'message', '对应的 claim 记录不存在，无法插入推荐奖励'
    );
  END IF;
  
  -- ============================================
  -- 2. 🟢 关键修复：使用 claims 表中的 referrer
  -- ============================================
  -- 优先使用 claims 表中的 referrer（用户实际注册时的推荐人）
  IF v_claim_referrer IS NOT NULL 
     AND v_claim_referrer != '0x0000000000000000000000000000000000000000' 
     AND v_claim_referrer != '' THEN
    v_final_referrer := v_claim_referrer;
  ELSIF p_referrer_from_claim IS NOT NULL 
       AND p_referrer_from_claim != '0x0000000000000000000000000000000000000000' 
       AND p_referrer_from_claim != '' THEN
    v_final_referrer := p_referrer_from_claim;
  ELSE
    -- 如果没有推荐人，不插入推荐奖励记录
    RETURN jsonb_build_object(
      'status', 'skipped',
      'reason', 'no_referrer',
      'message', '没有有效的推荐人，跳过推荐奖励记录'
    );
  END IF;
  
  -- ============================================
  -- 3. ⚠️ 验证：检查事件中的 referrer 与 claims 表中的 referrer 是否一致
  -- ============================================
  IF p_referrer_from_event IS NOT NULL 
     AND p_referrer_from_event != '0x0000000000000000000000000000000000000000'
     AND p_referrer_from_event != v_final_referrer THEN
    -- 记录警告但不阻止插入（使用 claims 表中的 referrer）
    RAISE WARNING '[insert_referral_reward_safe] ⚠️ 推荐人不一致: 事件=%  claims=%  tx=%', 
      p_referrer_from_event, v_final_referrer, p_tx_hash;
  END IF;
  
  -- ============================================
  -- 4. 🔒 关键修复：锁定推荐人用户行，防止并发
  -- ============================================
  -- 确保推荐人记录存在
  INSERT INTO users (address, energy_total, created_at, updated_at)
  VALUES (v_final_referrer, 0, NOW(), NOW())
  ON CONFLICT (address) DO NOTHING;
  
  -- 🔒 锁定推荐人用户行（防止并发修改推荐人的数据）
  PERFORM 1 FROM users WHERE address = v_final_referrer FOR UPDATE;
  
  -- ============================================
  -- 5. 检查是否已存在推荐奖励记录
  -- ============================================
  SELECT referrer_address INTO v_existing_referrer
  FROM referral_rewards
  WHERE tx_hash = p_tx_hash;
  
  IF FOUND THEN
    -- 如果已存在，检查是否需要更新
    IF v_existing_referrer != v_final_referrer THEN
      -- 🟢 修复：更新为正确的推荐人
      UPDATE referral_rewards
      SET referrer_address = v_final_referrer
      WHERE tx_hash = p_tx_hash;
      
      RETURN jsonb_build_object(
        'status', 'updated',
        'old_referrer', v_existing_referrer,
        'new_referrer', v_final_referrer,
        'message', '已更新推荐奖励记录中的推荐人地址'
      );
    ELSE
      RETURN jsonb_build_object(
        'status', 'skipped',
        'reason', 'already_exists',
        'referrer', v_final_referrer
      );
    END IF;
  END IF;
  
  -- ============================================
  -- 6. 插入推荐奖励记录（原子操作）
  -- ============================================
  INSERT INTO referral_rewards (
    tx_hash,
    referrer_address,
    amount_wei,
    block_number,
    block_time,
    created_at
  )
  VALUES (
    p_tx_hash,
    v_final_referrer,
    p_amount_wei,
    p_block_number,
    COALESCE(p_block_time::timestamptz, NOW()),
    NOW()
  )
  ON CONFLICT (tx_hash) DO UPDATE
  SET referrer_address = EXCLUDED.referrer_address;
  
  v_inserted := true;
  
  RETURN jsonb_build_object(
    'status', 'success',
    'referrer', v_final_referrer,
    'amount_wei', p_amount_wei,
    'inserted', v_inserted
  );
  
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'status', 'error',
      'reason', 'database_error',
      'message', SQLERRM
    );
END;
$function$;

-- 📝 添加函数注释
COMMENT ON FUNCTION public.insert_referral_reward_safe(text, text, text, text, text, bigint, text) IS 
'安全地插入推荐奖励记录（带事务和行锁）
功能：
1. 使用 claims 表中的 referrer 而不是事件中的 referrer
2. 使用 FOR UPDATE 行锁防止并发问题
3. 验证事件中的 referrer 与 claims 表中的 referrer 是否一致
4. 如果已存在记录，自动修复推荐人地址';

