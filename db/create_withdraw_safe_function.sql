-- ============================================
-- P0级修复：创建安全的提现处理函数（带行锁和原子更新）
-- 日期: 2026-01-09
-- 目的: 修复高并发场景下的提现余额丢失问题
-- ============================================

CREATE OR REPLACE FUNCTION public.process_withdraw_safe(
  p_address text,
  p_amount numeric,
  p_required_energy numeric,
  p_new_usdt_total numeric,
  p_original_last_settlement_time timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_user_row record;
  v_energy_total numeric;
  v_energy_locked numeric;
  v_energy_available numeric;
  v_usdt_total numeric;
  v_usdt_locked numeric;
  v_usdt_available numeric;
  v_withdrawal_id uuid;
BEGIN
  p_address := lower(p_address);
  
  -- 🔒 锁定用户行，防止并发提现
  SELECT 
    energy_total,
    energy_locked,
    usdt_total,
    usdt_locked
  INTO v_user_row
  FROM users
  WHERE address = p_address
  FOR UPDATE;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'USER_NOT_FOUND',
      'message', 'User not found'
    );
  END IF;
  
  -- 验证能量
  v_energy_total := COALESCE(v_user_row.energy_total, 0);
  v_energy_locked := COALESCE(v_user_row.energy_locked, 0);
  v_energy_available := GREATEST(0, v_energy_total - v_energy_locked);
  
  IF v_energy_available < p_required_energy THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'ENERGY_NOT_ENOUGH',
      'message', format('Energy not enough (need >= %s, available %s)', 
                        p_required_energy, v_energy_available)
    );
  END IF;
  
  -- 验证USDT
  v_usdt_total := COALESCE(v_user_row.usdt_total, 0);
  v_usdt_locked := COALESCE(v_user_row.usdt_locked, 0);
  v_usdt_available := GREATEST(0, v_usdt_total - v_usdt_locked);
  
  IF v_usdt_available < p_amount THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'USDT_NOT_ENOUGH',
      'message', format('USDT not enough (need >= %s, available %s)', 
                        p_amount, v_usdt_available)
    );
  END IF;
  
  -- ✅ P0级修复：使用原子更新
  -- 注意：这里使用传入的 p_new_usdt_total，因为它是从外部计算好的（Lazy Settle）
  -- 但为了安全，我们仍然使用原子更新来锁定能量和USDT
  UPDATE users
  SET 
    energy_locked = energy_locked + p_required_energy,  -- ✅ 原子更新
    usdt_locked = usdt_locked + p_amount,  -- ✅ 原子更新
    usdt_total = p_new_usdt_total,  -- 使用外部计算的值（Lazy Settle）
    last_settlement_time = COALESCE(p_original_last_settlement_time, last_settlement_time),  -- 保留原始时间
    updated_at = NOW()
  WHERE address = p_address
    AND (energy_total - energy_locked) >= p_required_energy  -- ✅ 确保能量足够
    AND (usdt_total - usdt_locked) >= p_amount;  -- ✅ 确保USDT足够
  
  -- 检查是否更新成功
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'UPDATE_FAILED',
      'message', 'Update failed: insufficient balance or energy'
    );
  END IF;
  
  -- 创建提现记录
  INSERT INTO withdrawals (address, amount, status, energy_locked_amount, created_at, updated_at)
  VALUES (p_address, p_amount, 'Pending', p_required_energy, NOW(), NOW())
  RETURNING id INTO v_withdrawal_id;
  
  RETURN jsonb_build_object(
    'ok', true,
    'id', v_withdrawal_id,
    'status', 'Pending',
    'amount', p_amount,
    'energy_locked', p_required_energy
  );
  
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'DATABASE_ERROR',
      'message', SQLERRM
    );
END;
$function$;

COMMENT ON FUNCTION public.process_withdraw_safe(text, numeric, numeric, numeric, timestamptz) IS 
'安全的提现处理函数（P0级修复：使用行锁和原子更新防止高并发丢失）';

