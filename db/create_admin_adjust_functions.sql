-- ============================================
-- P0级修复：创建管理员调整函数（带行锁和原子更新）
-- 日期: 2026-01-09
-- 目的: 修复高并发场景下的余额丢失问题
-- ============================================

-- 函数1：管理员调整用户能量（带行锁和原子更新）
CREATE OR REPLACE FUNCTION public.admin_adjust_user_energy_safe(
  p_address text,
  p_delta numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_user_row record;
  v_old_energy_total numeric;
  v_new_energy_total numeric;
  v_energy_locked numeric;
BEGIN
  p_address := lower(p_address);
  
  -- 参数验证
  IF p_delta IS NULL OR NOT (p_delta > 0 OR p_delta < 0) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'INVALID_DELTA',
      'message', 'Delta must be a valid number'
    );
  END IF;
  
  -- 🔒 锁定用户行，防止并发修改
  SELECT energy_total, energy_locked
  INTO v_user_row
  FROM users
  WHERE address = p_address
  FOR UPDATE;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'USER_NOT_FOUND',
      'message', 'User not found'
    );
  END IF;
  
  v_old_energy_total := COALESCE(v_user_row.energy_total, 0);
  v_energy_locked := COALESCE(v_user_row.energy_locked, 0);
  v_new_energy_total := GREATEST(0, v_old_energy_total + p_delta);
  
  -- 验证：energy_total 不能小于 energy_locked
  IF v_new_energy_total < v_energy_locked THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'INVALID_STATE',
      'message', format('energy_total (%s) cannot be less than energy_locked (%s)', 
                        v_new_energy_total, v_energy_locked)
    );
  END IF;
  
  -- ✅ P0级修复：使用原子更新
  UPDATE users
  SET energy_total = energy_total + p_delta,  -- ✅ 原子更新
      updated_at = NOW()
  WHERE address = p_address
    AND (energy_total + p_delta) >= energy_locked;  -- ✅ 确保更新后仍然满足约束
  
  -- 检查是否更新成功
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'UPDATE_FAILED',
      'message', 'Update failed: constraint violation'
    );
  END IF;
  
  -- 获取更新后的值
  SELECT energy_total INTO v_new_energy_total
  FROM users
  WHERE address = p_address;
  
  RETURN jsonb_build_object(
    'ok', true,
    'address', p_address,
    'old_energy_total', v_old_energy_total,
    'new_energy_total', v_new_energy_total,
    'delta', p_delta,
    'energy_locked', v_energy_locked
  );
  
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'DATABASE_ERROR',
      'message', SQLERRM
    );
END;
$function$;

-- 函数2：管理员调整用户USDT（带行锁和原子更新）
CREATE OR REPLACE FUNCTION public.admin_adjust_user_usdt_safe(
  p_address text,
  p_delta numeric,
  p_update_settlement_time boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_user_row record;
  v_old_usdt_total numeric;
  v_new_usdt_total numeric;
  v_usdt_locked numeric;
BEGIN
  p_address := lower(p_address);
  
  -- 参数验证
  IF p_delta IS NULL OR NOT (p_delta > 0 OR p_delta < 0) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'INVALID_DELTA',
      'message', 'Delta must be a valid number'
    );
  END IF;
  
  -- 🔒 锁定用户行，防止并发修改
  SELECT usdt_total, usdt_locked, last_settlement_time
  INTO v_user_row
  FROM users
  WHERE address = p_address
  FOR UPDATE;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'USER_NOT_FOUND',
      'message', 'User not found'
    );
  END IF;
  
  v_old_usdt_total := COALESCE(v_user_row.usdt_total, 0);
  v_usdt_locked := COALESCE(v_user_row.usdt_locked, 0);
  v_new_usdt_total := GREATEST(0, v_old_usdt_total + p_delta);
  
  -- 验证：usdt_total 不能小于 usdt_locked
  IF v_new_usdt_total < v_usdt_locked THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'INVALID_STATE',
      'message', format('usdt_total (%s) cannot be less than usdt_locked (%s)', 
                        v_new_usdt_total, v_usdt_locked)
    );
  END IF;
  
  -- ✅ P0级修复：使用原子更新
  IF p_update_settlement_time THEN
    UPDATE users
    SET usdt_total = usdt_total + p_delta,  -- ✅ 原子更新
        last_settlement_time = NOW(),
        updated_at = NOW()
    WHERE address = p_address
      AND (usdt_total + p_delta) >= usdt_locked;  -- ✅ 确保更新后仍然满足约束
  ELSE
    UPDATE users
    SET usdt_total = usdt_total + p_delta,  -- ✅ 原子更新
        updated_at = NOW()
    WHERE address = p_address
      AND (usdt_total + p_delta) >= usdt_locked;  -- ✅ 确保更新后仍然满足约束
  END IF;
  
  -- 检查是否更新成功
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'UPDATE_FAILED',
      'message', 'Update failed: constraint violation'
    );
  END IF;
  
  -- 获取更新后的值
  SELECT usdt_total INTO v_new_usdt_total
  FROM users
  WHERE address = p_address;
  
  RETURN jsonb_build_object(
    'ok', true,
    'address', p_address,
    'old_usdt_total', v_old_usdt_total,
    'new_usdt_total', v_new_usdt_total,
    'delta', p_delta,
    'usdt_locked', v_usdt_locked
  );
  
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'DATABASE_ERROR',
      'message', SQLERRM
    );
END;
$function$;

COMMENT ON FUNCTION public.admin_adjust_user_energy_safe(text, numeric) IS 
'管理员调整用户能量（P0级修复：使用行锁和原子更新防止高并发丢失）';

COMMENT ON FUNCTION public.admin_adjust_user_usdt_safe(text, numeric, boolean) IS 
'管理员调整用户USDT（P0级修复：使用行锁和原子更新防止高并发丢失）';

