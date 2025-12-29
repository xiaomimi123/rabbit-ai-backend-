-- 修复被拒绝提现但能量未完全解锁的问题
-- 问题：在修复 rejectWithdrawal 函数之前，拒绝提现时只解锁了 USDT 金额对应的能量（错误），而不是实际锁定的能量
-- 解决：对于所有状态为 Rejected 的提现，解锁对应的 energy_locked_amount
-- 日期：2025-12-29

-- 第一步：找出所有需要修复的用户（被拒绝的提现但能量未完全解锁）
-- 这些用户有 Rejected 状态的提现，但 energy_locked 仍然大于 0

-- 第二步：修复这些用户的 energy_locked
-- 对于每个用户，减去所有被拒绝提现的 energy_locked_amount 总和
UPDATE users u
SET 
  energy_locked = GREATEST(0, u.energy_locked - COALESCE(
    (SELECT SUM(w.energy_locked_amount)
     FROM withdrawals w
     WHERE w.address = u.address
       AND w.status = 'Rejected'
       AND w.energy_locked_amount > 0),
    0
  )),
  updated_at = now()
WHERE u.energy_locked > 0
  AND EXISTS (
    SELECT 1
    FROM withdrawals w
    WHERE w.address = u.address
      AND w.status = 'Rejected'
      AND w.energy_locked_amount > 0
  );

-- 验证修复结果
SELECT 
  u.address,
  u.energy_total,
  u.energy_locked as energy_locked_after_fix,
  u.energy_total - u.energy_locked as energy_available,
  (SELECT COUNT(*) FROM withdrawals WHERE address = u.address AND status = 'Rejected' AND energy_locked_amount > 0) as rejected_withdrawals_count,
  (SELECT SUM(energy_locked_amount) FROM withdrawals WHERE address = u.address AND status = 'Rejected' AND energy_locked_amount > 0) as total_should_unlock
FROM users u
WHERE EXISTS (
  SELECT 1
  FROM withdrawals w
  WHERE w.address = u.address
    AND w.status = 'Rejected'
    AND w.energy_locked_amount > 0
)
ORDER BY u.updated_at DESC;

