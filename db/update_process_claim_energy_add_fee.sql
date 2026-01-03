-- 更新 process_claim_energy 函数：添加 fee_amount_wei 参数
-- 目的：在记录 claim 时保存用户实际支付的 BNB 手续费
-- 执行时间: 2026-01-03
-- 
-- 原理：
-- 1. 添加 p_fee_amount_wei 参数（用户实际支付的 BNB，wei 单位）
-- 2. 在插入 claims 记录时，同时保存 fee_amount_wei
-- 3. 这样收益计算时可以使用实际支付金额，而不是当前的 claimFee
--
-- 安全性保障：
-- - 参数允许 NULL（向后兼容，历史记录可能没有该字段）
-- - 不影响现有功能（向后兼容）

CREATE OR REPLACE FUNCTION public.process_claim_energy(
  p_tx_hash text, 
  p_address text, 
  p_referrer text, 
  p_amount_wei text, 
  p_block_number bigint, 
  p_block_time text,
  p_fee_amount_wei text DEFAULT NULL  -- 🟢 新增：用户实际支付的 BNB 手续费（wei）
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
  v_energy_reward int;
  v_invite_increment int;
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
  -- 2. 🔒 关键修复：锁定 users 表中的用户行，防止并发问题
  -- ---------------------------------------------------
  -- 先确保用户记录存在（如果不存在则创建，但不加能量）
  INSERT INTO users (address, energy_total, created_at, updated_at)
  VALUES (p_address, 0, now(), now())
  ON CONFLICT (address) DO NOTHING;
  
  -- 🔒 关键：锁定该用户的 users 表行
  PERFORM 1 FROM users WHERE address = p_address FOR UPDATE;

  -- ---------------------------------------------------
  -- 3. 🔒 关键修复：先统计（插入前），确保判断准确
  -- ---------------------------------------------------
  SELECT count(*) INTO v_claim_count_before
  FROM claims
  WHERE address = p_address;

  -- ---------------------------------------------------
  -- 4. 幂等性插入 (防止重复处理同一笔交易)
  -- 🟢 新增：同时保存 fee_amount_wei
  -- ---------------------------------------------------
  INSERT INTO claims (
    tx_hash, 
    address, 
    referrer, 
    amount_wei, 
    block_number, 
    block_time, 
    status, 
    created_at, 
    energy_awarded,
    fee_amount_wei  -- 🟢 新增：保存实际支付的手续费
  )
  VALUES (
    p_tx_hash, 
    p_address, 
    v_ref_address, 
    p_amount_wei, 
    p_block_number, 
    v_block_time_tz, 
    'SUCCESS', 
    now(), 
    true,
    p_fee_amount_wei  -- 🟢 新增：保存实际支付的手续费
  )
  ON CONFLICT (tx_hash) DO UPDATE
  SET fee_amount_wei = COALESCE(EXCLUDED.fee_amount_wei, claims.fee_amount_wei);  -- 🟢 如果新值不为空，则更新
  
  -- 检查刚才是否真的插入了新行
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  -- 如果没插入新行（说明交易早已存在），直接返回跳过，避免重复加分
  IF v_inserted = 0 THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'tx_exists');
  END IF;

  -- ---------------------------------------------------
  -- 5. 判断是否为首次领取 (核心逻辑修复)
  -- ---------------------------------------------------
  v_is_first_claim := (v_claim_count_before = 0);

  -- ---------------------------------------------------
  -- 6. 给用户自己加能量 (+1)
  -- ---------------------------------------------------
  UPDATE users
  SET energy_total = energy_total + 1,
      updated_at = now()
  WHERE address = p_address;

  -- ---------------------------------------------------
  -- 7. 处理推荐人奖励
  -- ---------------------------------------------------
  IF v_ref_address IS NOT NULL AND v_ref_address != '0x0000000000000000000000000000000000000000' THEN
    
    -- 规则判定：
    IF v_is_first_claim THEN
      -- 首次领取：上级获得 3 能量 (1管道 + 2首邀)，邀请人数 +1
      v_energy_reward := 3;
      v_invite_increment := 1;
    ELSE
      -- 非首次领取：上级获得 1 能量 (仅管道)，邀请人数不变
      v_energy_reward := 1;
      v_invite_increment := 0;
    END IF;

    -- 执行更新（推荐人的 users 表行也需要更新）
    INSERT INTO users (address, invite_count, energy_total, created_at, updated_at)
    VALUES (
      v_ref_address, 
      v_invite_increment, 
      v_energy_reward, 
      now(), 
      now()
    )
    ON CONFLICT (address) DO UPDATE
    SET 
      invite_count = users.invite_count + v_invite_increment,
      energy_total = users.energy_total + v_energy_reward,
      updated_at = now();
      
  END IF;

  -- ---------------------------------------------------
  -- 8. 返回调试信息
  -- ---------------------------------------------------
  RETURN jsonb_build_object(
    'status', 'success', 
    'is_first_claim', v_is_first_claim, 
    'claim_count_before', v_claim_count_before,
    'reward_given_to_referrer', v_energy_reward
  );
END;
$function$;

-- 添加注释
COMMENT ON FUNCTION public.process_claim_energy IS 
'处理空投领取并计算能量奖励。新增 fee_amount_wei 参数用于保存用户实际支付的 BNB 手续费。';

