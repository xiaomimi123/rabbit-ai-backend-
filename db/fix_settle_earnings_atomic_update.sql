-- ============================================
-- P0级修复：settle_earnings_on_claim 使用原子更新
-- 日期: 2026-01-09
-- 目的: 修复高并发场景下的收益丢失问题
-- ============================================

CREATE OR REPLACE FUNCTION public.settle_earnings_on_claim(
  p_address text,
  p_old_balance numeric,
  p_claim_time timestamptz
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
  v_old_usdt_total numeric;
  v_token_price numeric := 0.01;
BEGIN
  p_address := lower(p_address);
  
  -- 🔒 锁定用户行，防止并发计算导致的重复收益发放
  PERFORM 1 FROM users WHERE address = p_address FOR UPDATE;
  
  -- 获取用户数据（在锁定后重新读取，确保获取最新数据）
  SELECT usdt_total, last_settlement_time, created_at
  INTO v_user_row
  FROM users
  WHERE address = p_address;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'user_not_found');
  END IF;
  
  -- 保存旧的 usdt_total（用于返回）
  v_old_usdt_total := COALESCE(v_user_row.usdt_total, 0);
  
  -- 获取首次领取时间
  SELECT created_at
  INTO v_first_claim
  FROM claims
  WHERE address = p_address
  ORDER BY created_at ASC
  LIMIT 1;
  
  -- 确定 last_settlement_time
  IF v_user_row.last_settlement_time IS NOT NULL THEN
    v_last_settlement_time := v_user_row.last_settlement_time;
  ELSIF v_first_claim IS NOT NULL THEN
    v_last_settlement_time := v_first_claim.created_at;
  ELSE
    v_last_settlement_time := v_user_row.created_at;
  END IF;
  
  -- 如果 old_balance 为 0 或负数，或者没有达到持币生息要求（10,000 RAT），跳过收益计算
  IF p_old_balance IS NULL OR p_old_balance <= 0 OR p_old_balance < 10000 THEN
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
  
  -- 计算时间差（毫秒）
  v_time_elapsed_ms := EXTRACT(EPOCH FROM (p_claim_time - v_last_settlement_time)) * 1000;
  
  IF v_time_elapsed_ms <= 0 THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'no_time_elapsed');
  END IF;
  
  -- 转换为天数
  v_days_elapsed := v_time_elapsed_ms / (24.0 * 3600.0 * 1000.0);
  
  -- 确定 VIP 等级和日利率
  BEGIN
    SELECT daily_rate, level
    INTO v_daily_rate, v_current_tier
    FROM vip_tiers
    WHERE is_active = true
      AND p_old_balance >= min_balance
      AND (max_balance IS NULL OR p_old_balance <= max_balance)
    ORDER BY level DESC
    LIMIT 1;
    
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
    END IF;
  EXCEPTION
    WHEN OTHERS THEN
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
  
  -- 计算增量收益
  v_incremental_earnings := p_old_balance * v_token_price * (v_daily_rate / 100.0) * v_days_elapsed;
  
  -- ✅ P0级修复：使用原子更新（直接在 UPDATE 中计算）
  -- 这确保在高并发场景下不会丢失更新
  UPDATE users
  SET usdt_total = usdt_total + v_incremental_earnings,  -- ✅ 原子更新
      last_settlement_time = p_claim_time,
      updated_at = now()
  WHERE address = p_address;
  
  -- 获取更新后的值（用于返回）
  SELECT usdt_total INTO v_new_usdt_total
  FROM users
  WHERE address = p_address;
  
  RETURN jsonb_build_object(
    'status', 'success',
    'old_balance', p_old_balance,
    'old_usdt_total', v_old_usdt_total,
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

COMMENT ON FUNCTION public.settle_earnings_on_claim(text, numeric, timestamptz) IS 
'在用户领取空投时固化收益（P0级修复：使用原子更新防止高并发丢失）';

