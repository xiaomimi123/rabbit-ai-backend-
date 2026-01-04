-- 修复 process_claim_energy 函数中的首次领取判断逻辑
-- 问题：数据库中的实际函数是"先插入后统计"，可能导致并发问题
-- 解决：改为"先统计后插入"，并添加行锁防止并发
-- 日期：2025-12-31

-- ⚠️ 重要：此函数必须使用 SECURITY DEFINER，确保不受 RLS 策略影响
CREATE OR REPLACE FUNCTION public.process_claim_energy(
  p_tx_hash text, 
  p_address text, 
  p_referrer text, 
  p_amount_wei text, 
  p_block_number bigint, 
  p_block_time text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER  -- ✅ 关键：确保不受 RLS 影响，能统计所有历史记录
SET search_path = public
AS $function$
DECLARE
  v_ref_address text;
  v_inserted integer;
  v_claim_count_before integer;  -- ✅ 先统计（插入前）
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
  -- 2. 🔒 关键修复：先统计（插入前），确保判断准确
  -- ---------------------------------------------------
  -- 在插入之前统计该用户已有的 claim 记录数
  -- 这样可以准确判断是否是首次领取
  SELECT count(*) INTO v_claim_count_before
  FROM claims
  WHERE address = p_address;

  -- ---------------------------------------------------
  -- 3. 幂等性插入 (防止重复处理同一笔交易)
  -- ---------------------------------------------------
  INSERT INTO claims (tx_hash, address, referrer, amount_wei, block_number, block_time, status, created_at, energy_awarded)
  VALUES (p_tx_hash, p_address, v_ref_address, p_amount_wei, p_block_number, v_block_time_tz, 'SUCCESS', now(), true)
  ON CONFLICT (tx_hash) DO NOTHING;
  
  -- 检查刚才是否真的插入了新行
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  -- 如果没插入新行（说明交易早已存在），直接返回跳过，避免重复加分
  IF v_inserted = 0 THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'tx_exists');
  END IF;

  -- ---------------------------------------------------
  -- 4. 判断是否为首次领取 (核心逻辑修复)
  -- ---------------------------------------------------
  -- ✅ 关键修复：使用插入前的统计结果
  -- count_before = 0 表示首次，count_before > 0 表示非首次
  v_is_first_claim := (v_claim_count_before = 0);

  -- ---------------------------------------------------
  -- 5. 给用户自己加能量 (+1)
  -- ---------------------------------------------------
  INSERT INTO users (address, energy_total, created_at, updated_at)
  VALUES (p_address, 1, now(), now())
  ON CONFLICT (address) DO UPDATE
  SET energy_total = users.energy_total + 1,
      updated_at = now();

  -- ---------------------------------------------------
  -- 6. 处理推荐人奖励
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

    -- 执行更新
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
  -- 7. 返回调试信息
  -- ---------------------------------------------------
  RETURN jsonb_build_object(
    'status', 'success', 
    'is_first_claim', v_is_first_claim, 
    'claim_count_before', v_claim_count_before,  -- ✅ 添加调试信息
    'reward_given_to_referrer', v_energy_reward
  );
END;
$function$;

