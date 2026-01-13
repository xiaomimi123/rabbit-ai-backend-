-- 🔥 紧急修复：更新 process_claim_energy 函数到最新版本
-- 问题：代码调用时传递 10 个参数，但数据库函数只接受 6 个参数
-- 解决：更新函数到支持 10 个参数的版本
-- 执行时间：2026-01-13
-- 优先级：P0 - 立即执行

CREATE OR REPLACE FUNCTION public.process_claim_energy(
  p_tx_hash text, 
  p_address text, 
  p_referrer text, 
  p_amount_wei text, 
  p_block_number bigint, 
  p_block_time text,
  p_fee_amount_wei text DEFAULT NULL,  -- 用户实际支付的 BNB 手续费（wei）
  -- 🟢 新增：动态能量配置参数
  p_self_reward integer DEFAULT 1,     -- 用户自己领取奖励
  p_referrer_first integer DEFAULT 3,  -- 推荐人首次邀请奖励
  p_referrer_repeat integer DEFAULT 1  -- 推荐人非首次邀请奖励（管道收益）
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
  v_energy_reward_user integer;      -- 用户本次获得的能量
  v_energy_reward_referrer integer;  -- 推荐人本次获得的能量
  v_invite_increment integer;
  v_block_time_tz timestamptz;
BEGIN
  -- ---------------------------------------------------
  -- 1. 数据清洗与准备
  -- ---------------------------------------------------
  p_address := lower(p_address);
  v_ref_address := lower(p_referrer);
  
  -- 处理时间格式，防止空值报错
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
  -- 3. 统计用户当前 claim 总数（判断是否首次领取）
  -- ---------------------------------------------------
  SELECT COUNT(*) INTO v_claim_count_before
  FROM claims
  WHERE address = p_address;

  v_is_first_claim := (v_claim_count_before = 0);

  -- ---------------------------------------------------
  -- 4. 插入 claim 记录（原子操作）
  -- ---------------------------------------------------
  INSERT INTO claims (
    tx_hash, 
    address, 
    referrer, 
    amount_wei, 
    block_number, 
    block_time, 
    fee_amount_wei,  -- 🟢 保存实际支付的手续费
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
    p_fee_amount_wei,  -- 🟢 保存实际支付的手续费
    'SUCCESS', 
    NOW(), 
    TRUE
  );

  -- ---------------------------------------------------
  -- 5. 🟢 使用动态配置：给用户自己加能量
  -- ---------------------------------------------------
  v_energy_reward_user := p_self_reward;

  INSERT INTO users (address, energy_total, created_at, updated_at)
  VALUES (p_address, v_energy_reward_user, NOW(), NOW())
  ON CONFLICT (address) DO UPDATE
  SET 
    energy_total = users.energy_total + v_energy_reward_user,
    updated_at = NOW();

  RAISE NOTICE '[process_claim_energy] 用户 % 获得能量: %', p_address, v_energy_reward_user;

  -- ---------------------------------------------------
  -- 6. 🟢 使用动态配置:处理推荐人逻辑
  -- ---------------------------------------------------
  IF v_ref_address IS NOT NULL AND v_ref_address != '0x0000000000000000000000000000000000000000' THEN
    
    -- 6.1 根据是否首次领取，计算推荐人奖励
    IF v_is_first_claim THEN
      v_energy_reward_referrer := p_referrer_first;  -- 🟢 首次邀请奖励（额外）
      v_invite_increment := 1;                       -- 邀请计数 +1
      RAISE NOTICE '[process_claim_energy] 推荐人 % 首次邀请，获得能量: %', v_ref_address, v_energy_reward_referrer;
    ELSE
      v_energy_reward_referrer := p_referrer_repeat; -- 🟢 非首次邀请（管道收益）
      v_invite_increment := 0;                       -- 邀请计数不变
      RAISE NOTICE '[process_claim_energy] 推荐人 % 管道收益，获得能量: %', v_ref_address, v_energy_reward_referrer;
    END IF;
    
    -- 6.2 原子更新推荐人数据
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
      
  END IF;

  -- ---------------------------------------------------
  -- 7. 返回处理结果
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
'处理空投领取并计算能量奖励（支持动态配置）
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

-- ✅ 验证函数是否更新成功
SELECT 
  routine_name,
  routine_type,
  data_type
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name = 'process_claim_energy';

