-- 在用户领取空投时固化收益的函数
-- 目的：确保新领取的代币从领取时间开始计算收益，而不是从旧的 last_settlement_time 开始
-- 执行时间: 2025-01-XX
-- 
-- 原理：
-- 1. 使用 FOR UPDATE 锁定用户行，防止并发计算导致的重复收益发放
-- 2. 计算从 last_settlement_time 到现在的收益（使用旧余额）
-- 3. 将这部分收益固化到 usdt_total
-- 4. 更新 last_settlement_time 为当前时间
-- 5. 新领取的代币从领取时间开始计算收益
--
-- 安全性保障：
-- - 行级锁（FOR UPDATE）：防止并发请求重复计算收益
-- - 幂等性：如果用户不存在或余额不足，安全跳过
-- - 边界处理：处理时间差为 0、余额不足等边界情况

CREATE OR REPLACE FUNCTION public.settle_earnings_on_claim(
  p_address text,
  p_old_balance numeric,  -- 领取前的余额（从链上读取）
  p_claim_time timestamptz -- 领取时间
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_user_row record;
  v_first_claim record;
  v_last_settlement_time timestamptz;
  v_time_elapsed_ms bigint;
  v_days_elapsed numeric;
  v_daily_rate numeric;
  v_current_tier integer;
  v_incremental_earnings numeric;
  v_new_usdt_total numeric;
  v_token_price numeric := 0.01;
BEGIN
  -- 1. 标准化地址
  p_address := lower(p_address);
  
  -- 🔒 关键修复：锁定用户行，防止并发计算导致的重复收益发放
  -- 使用 FOR UPDATE 确保同一时间只有一个请求能读取和更新该用户的结算时间
  -- 这解决了"竞态条件"漏洞：如果两个请求同时处理，第二个请求必须等待第一个完成
  PERFORM 1 FROM users WHERE address = p_address FOR UPDATE;
  
  -- 2. 获取用户数据（在锁定后重新读取，确保获取最新数据）
  SELECT usdt_total, last_settlement_time, created_at
  INTO v_user_row
  FROM users
  WHERE address = p_address;
  
  -- 如果用户不存在，返回（首次领取时可能还没有用户记录）
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'user_not_found');
  END IF;
  
  -- 3. 获取首次领取时间（用于确定 last_settlement_time 的默认值）
  SELECT created_at
  INTO v_first_claim
  FROM claims
  WHERE address = p_address
  ORDER BY created_at ASC
  LIMIT 1;
  
  -- 4. 确定 last_settlement_time
  IF v_user_row.last_settlement_time IS NOT NULL THEN
    v_last_settlement_time := v_user_row.last_settlement_time;
  ELSIF v_first_claim IS NOT NULL THEN
    v_last_settlement_time := v_first_claim.created_at;
  ELSE
    -- 如果没有结算时间和首次领取记录，使用用户创建时间
    v_last_settlement_time := v_user_row.created_at;
  END IF;
  
  -- 5. 如果 old_balance 为 0 或负数，或者没有达到持币生息要求（10,000 RAT），跳过收益计算
  IF p_old_balance IS NULL OR p_old_balance <= 0 OR p_old_balance < 10000 THEN
    -- 只更新 last_settlement_time，不计算收益
    UPDATE users
    SET last_settlement_time = p_claim_time,
        updated_at = now()
    WHERE address = p_address;
    
    RETURN jsonb_build_object(
      'status', 'skipped',
      'reason', 'balance_too_low',
      'old_balance', p_old_balance
    );
  END IF;
  
  -- 6. 计算时间差（毫秒）
  v_time_elapsed_ms := EXTRACT(EPOCH FROM (p_claim_time - v_last_settlement_time)) * 1000;
  
  -- 如果时间差为 0 或负数，跳过（避免除零或负数计算）
  IF v_time_elapsed_ms <= 0 THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'no_time_elapsed');
  END IF;
  
  -- 7. 转换为天数（精确到毫秒）
  v_days_elapsed := v_time_elapsed_ms / (24.0 * 3600.0 * 1000.0);
  
  -- 8. 确定 VIP 等级和日利率（根据旧余额）
  -- 从 vip_tiers 表读取配置，如果表不存在或查询失败，使用默认配置
  -- 默认配置（降级方案）：
  -- - Tier 1: 10,000 - 49,999 RAT, 日利率 2%
  -- - Tier 2: 50,000 - 99,999 RAT, 日利率 4%
  -- - Tier 3: 100,000 - 199,999 RAT, 日利率 6%
  -- - Tier 4: >= 200,000 RAT, 日利率 10%
  BEGIN
    SELECT daily_rate, level
    INTO v_daily_rate, v_current_tier
    FROM vip_tiers
    WHERE is_active = true
      AND p_old_balance >= min_balance
      AND (max_balance IS NULL OR p_old_balance <= max_balance)
    ORDER BY level DESC
    LIMIT 1;
    
    -- 如果查询失败或没有匹配的等级，使用默认配置
    IF NOT FOUND THEN
      IF p_old_balance >= 200000 THEN
        v_daily_rate := 10.0;
        v_current_tier := 4;
      ELSIF p_old_balance >= 100000 THEN
        v_daily_rate := 6.0;
        v_current_tier := 3;
      ELSIF p_old_balance >= 50000 THEN
        v_daily_rate := 4.0;
        v_current_tier := 2;
      ELSIF p_old_balance >= 10000 THEN
        v_daily_rate := 2.0;
        v_current_tier := 1;
      ELSE
        v_daily_rate := 0.0;
        v_current_tier := 0;
      END IF;
    ELSE
      -- 数据库中的 daily_rate 是百分比（例如 2.0 表示 2%）
      -- 后面计算时使用 (v_daily_rate / 100.0)，所以这里直接使用百分比即可
      -- 如果数据库中的 daily_rate 是小数（0.02），需要乘以 100
      -- 根据 db/supabase.sql 的注释，daily_rate 是百分比格式，所以这里不需要转换
    END IF;
  EXCEPTION
    WHEN OTHERS THEN
      -- 如果查询失败（例如表不存在），使用默认配置
      IF p_old_balance >= 200000 THEN
        v_daily_rate := 10.0;
        v_current_tier := 4;
      ELSIF p_old_balance >= 100000 THEN
        v_daily_rate := 6.0;
        v_current_tier := 3;
      ELSIF p_old_balance >= 50000 THEN
        v_daily_rate := 4.0;
        v_current_tier := 2;
      ELSIF p_old_balance >= 10000 THEN
        v_daily_rate := 2.0;
        v_current_tier := 1;
      ELSE
        v_daily_rate := 0.0;
        v_current_tier := 0;
      END IF;
  END;
  
  -- 9. 计算增量收益 = 旧余额 × 代币价格 × 日利率 × 天数
  v_incremental_earnings := p_old_balance * v_token_price * (v_daily_rate / 100.0) * v_days_elapsed;
  
  -- 10. 计算新的 usdt_total = 旧的 usdt_total + 增量收益
  v_new_usdt_total := COALESCE(v_user_row.usdt_total, 0) + v_incremental_earnings;
  
  -- 11. 更新用户数据：固化收益并更新结算时间
  UPDATE users
  SET usdt_total = v_new_usdt_total,
      last_settlement_time = p_claim_time,
      updated_at = now()
  WHERE address = p_address;
  
  -- 12. 返回结果
  RETURN jsonb_build_object(
    'status', 'success',
    'old_balance', p_old_balance,
    'old_usdt_total', COALESCE(v_user_row.usdt_total, 0),
    'incremental_earnings', v_incremental_earnings,
    'new_usdt_total', v_new_usdt_total,
    'days_elapsed', v_days_elapsed,
    'daily_rate', v_daily_rate,
    'tier', v_current_tier,
    'last_settlement_time', v_last_settlement_time,
    'new_settlement_time', p_claim_time
  );
END;
$function$;

-- 添加注释
COMMENT ON FUNCTION public.settle_earnings_on_claim IS 
'在用户领取空投时固化收益。确保新领取的代币从领取时间开始计算收益，而不是从旧的 last_settlement_time 开始。';

