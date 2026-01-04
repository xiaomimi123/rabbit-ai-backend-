-- 修复 process_claim_energy 函数：添加行锁防止并发问题
-- 问题：如果用户第一次领取，claims 表中没有记录，无法通过锁 claims 表来防止并发
-- 解决：锁 users 表（用户能领取空投，说明 users 表中一定有记录）
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
  -- 2. 🔒 关键修复：锁定 users 表中的用户行，防止并发问题
  -- ---------------------------------------------------
  -- 为什么锁 users 表而不是 claims 表？
  -- - 如果用户第一次领取，claims 表中没有记录，SELECT ... FOR UPDATE 锁不住任何东西
  -- - 但用户能领取空投，说明 users 表中一定有记录（或应该先创建）
  -- - 锁 users 表可以强制所有针对该用户的领取请求排队执行，彻底消除并发问题
  -- 
  -- 执行流程：
  -- 请求 A 进来 -> 锁住用户 -> 处理中...
  -- 请求 B 进来 -> 试图锁用户 -> 被阻塞，等待 A 完成
  -- 请求 C 进来 -> 试图锁用户 -> 被阻塞，等待 B 完成
  -- 
  -- 这样确保：请求 B 获得锁时，一定能看到请求 A 刚刚插入的 claim 记录
  
  -- 先确保用户记录存在（如果不存在则创建，但不加能量）
  INSERT INTO users (address, energy_total, created_at, updated_at)
  VALUES (p_address, 0, now(), now())
  ON CONFLICT (address) DO NOTHING;
  
  -- 🔒 关键：锁定该用户的 users 表行
  -- 这会强制所有针对该用户的领取请求排队执行
  PERFORM 1 FROM users WHERE address = p_address FOR UPDATE;

  -- ---------------------------------------------------
  -- 3. 🔒 关键修复：先统计（插入前），确保判断准确
  -- ---------------------------------------------------
  -- 此时已经锁住了 users 表，数据是安全的
  -- 在插入之前统计该用户已有的 claim 记录数
  -- 这样可以准确判断是否是首次领取
  SELECT count(*) INTO v_claim_count_before
  FROM claims
  WHERE address = p_address;

  -- ---------------------------------------------------
  -- 4. 幂等性插入 (防止重复处理同一笔交易)
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
  -- 5. 判断是否为首次领取 (核心逻辑修复)
  -- ---------------------------------------------------
  -- ✅ 关键修复：使用插入前的统计结果
  -- count_before = 0 表示首次，count_before > 0 表示非首次
  v_is_first_claim := (v_claim_count_before = 0);

  -- ---------------------------------------------------
  -- 6. 给用户自己加能量 (+1)
  -- ---------------------------------------------------
  -- 注意：users 表已经被锁住，这里直接更新是安全的
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
    'claim_count_before', v_claim_count_before,  -- ✅ 添加调试信息
    'reward_given_to_referrer', v_energy_reward
  );
END;
$function$;

