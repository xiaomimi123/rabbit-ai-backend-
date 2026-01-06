import { supabase } from '../infra/supabase.js';
import { ApiError } from '../api/errors.js';
import { ethers } from 'ethers';
import { ERC20_ABI } from '../infra/abis.js';
import { config } from '../config.js';
import { getVipTierByBalance } from './vipConfig.js';
import { getEnergyConfigValueCached, EnergyConfigKeys } from './energyConfig.js'; // 🟢 新增：动态能量配置

export async function applyWithdraw(
  address: string, 
  amountStr: string,
  provider?: ethers.providers.Provider
) {
  const addr = address.toLowerCase();
  const amount = Number(amountStr);
  if (!Number.isFinite(amount) || amount <= 0) throw new ApiError('INVALID_REQUEST', 'Invalid amount');

  // 🟢 Lazy Settle: 计算实时收益并固化
  // 1. 读取用户数据（包括 last_settlement_time）
  const { data: user, error: userErr } = await supabase
    .from('users')
    .select('energy_total,energy_locked,usdt_total,usdt_locked,last_settlement_time,created_at')
    .eq('address', addr)
    .maybeSingle();
  if (userErr) throw userErr;
  if (!user) throw new ApiError('NOT_FOUND', 'User not found', 404);

  // 2. 读取首次领取时间
  const { data: firstClaim, error: claimErr } = await supabase
    .from('claims')
    .select('created_at')
    .eq('address', addr)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (claimErr) throw claimErr;

  if (!firstClaim || !firstClaim.created_at) {
    throw new ApiError('NOT_FOUND', 'User has no claims', 400);
  }

  // 3. 从链上读取 RAT 余额（如果提供了 provider）
  let balance = 0;
  if (provider) {
    try {
      const ratContract = new ethers.Contract(config.ratTokenContract, ERC20_ABI, provider);
      const balanceWei = await ratContract.balanceOf(address);
      const decimals = await ratContract.decimals().catch(() => 18);
      const balanceStr = ethers.utils.formatUnits(balanceWei, decimals);
      balance = parseFloat(balanceStr);
    } catch (error: any) {
      console.warn(`[Withdraw] Failed to fetch RAT balance: ${error?.message || error}`);
      // 如果读取失败，使用默认值 0（会导致收益为 0）
    }
  }

  // 4. 确定 VIP 等级和日利率
  const { dailyRate, tier: currentTier } = getVipTierByBalance(balance);

  // 5. 💰 Lazy Settle: 计算实时收益
  const nowTime = Date.now();
  const lastSettlementTime = (user as any)?.last_settlement_time 
    ? new Date((user as any).last_settlement_time).getTime()
    : new Date(firstClaim.created_at).getTime();
  
  const timeElapsedMs = nowTime - lastSettlementTime;
  const daysElapsed = timeElapsedMs / (24 * 3600 * 1000); // 精确到毫秒的天数

  const TOKEN_PRICE = 0.01; // $0.01 per RAT
  const incrementalEarnings = balance * TOKEN_PRICE * (dailyRate / 100) * daysElapsed;
  const baseEarnings = Number((user as any)?.usdt_total || 0);
  const realTimeEarnings = baseEarnings + incrementalEarnings;

  // 6. 查询 Pending 状态的提现（防止重复提交）
  // 🟢 修复：不再查询 Completed 状态，因为 usdt_total 已经在提现时扣除了金额
  // 只需要检查是否有 Pending 的提现，避免重复提交
  const { data: withdrawals, error: withdrawErr } = await supabase
    .from('withdrawals')
    .select('amount,status')
    .eq('address', addr)
    .eq('status', 'Pending'); // 🟢 只查询 Pending

  if (withdrawErr) throw withdrawErr;

  const totalPending = (withdrawals || []).reduce((sum: number, w: any) => {
    return sum + Number(w.amount || 0);
  }, 0);

  // 7. 计算实际可提现金额
  // 🟢 修复：realTimeEarnings 已经包含了所有收益，usdt_total 已经扣除了历史提现
  // 只需要减去当前 Pending 的提现金额（防止重复提交）
  const availableUsdt = Math.max(0, realTimeEarnings - totalPending);

  if (availableUsdt < amount) {
    throw new ApiError('USDT_NOT_ENOUGH', `USDT not enough (available ${availableUsdt.toFixed(6)}, need ${amount})`, 400);
  }

  // 8. 验证能量
  const energyTotal = Number((user as any)?.energy_total || 0);
  const energyLocked = Number((user as any)?.energy_locked || 0);
  const energyAvailable = Math.max(0, energyTotal - energyLocked);

  // ⚠️ 业务规则（风控参数）：
  // 🟢 动态能量消耗比例：从配置表读取（默认 1 USDT = 10 Energy）
  // 所需能量 = 提现金额 × 配置比例（向上取整，确保能量值始终是整数）
  // 🟢 修复：使用 Math.ceil() 向上取整，避免浮点数精度问题
  // 例如：0.99 USDT * 10 = 9.9 → Math.ceil(9.9) = 10
  const withdrawEnergyRatio = await getEnergyConfigValueCached(EnergyConfigKeys.WITHDRAW_RATIO);
  const requiredEnergy = Math.ceil(amount * withdrawEnergyRatio);
  console.log(`[applyWithdraw] 🔋 提现 ${amount} USDT 需要 ${requiredEnergy} Energy (比例: ${withdrawEnergyRatio})`);
  if (energyAvailable < requiredEnergy) {
    throw new ApiError('ENERGY_NOT_ENOUGH', `Energy not enough (need >= ${requiredEnergy}, available ${energyAvailable})`, 400);
  }

  // 9. 💰 Lazy Settle: 固化收益到数据库
  // 计算新的 usdt_total = 实时收益 - 提现金额
  const newUsdtTotal = realTimeEarnings - amount;
  const newEnergyLocked = energyLocked + requiredEnergy;
  const newUsdtLocked = Number((user as any)?.usdt_locked || 0) + amount;

  // basic anti-dup: existing Pending within 5 minutes
  const { data: pending, error: pendErr } = await supabase
    .from('withdrawals')
    .select('id,amount,status,created_at')
    .eq('address', addr)
    .eq('status', 'Pending')
    .order('created_at', { ascending: false })
    .limit(1);
  if (pendErr) throw pendErr;

  const checkTime = Date.now();
  if (pending && pending.length > 0) {
    const createdAt = new Date((pending[0] as any).created_at).getTime();
    if (Number.isFinite(createdAt) && checkTime - createdAt < 5 * 60 * 1000) {
      return {
        ok: true,
        id: (pending[0] as any).id,
        status: (pending[0] as any).status,
        amount: String((pending[0] as any).amount),
        time: new Date((pending[0] as any).created_at).toISOString().slice(0, 19).replace('T', ' '),
        duplicated: true,
      };
    }
  }

  // 10. 🔒 原子更新：同时更新收益、结算时间和锁定金额
  // 注意：虽然 Supabase JS 客户端不支持真正的行锁，但通过业务逻辑保证一致性
  // 🔥 关键修复：提现时固化收益 + 重置结算时间
  // 原因：如果保留旧的 last_settlement_time，利率变更后会用新利率重新计算旧时间段的收益
  // 正确做法：提现时固化当前收益到 usdt_total，同时更新 last_settlement_time 为当前时间
  // 这样新利率只会影响未来的增量收益，不会错误地重新计算历史收益
  const createdAt = (user as any)?.created_at || new Date().toISOString();
  const nowIso = new Date(nowTime).toISOString();

  const { error: lockErr } = await supabase
    .from('users')
    .upsert(
      {
        address: addr,
        energy_total: energyTotal,
        energy_locked: newEnergyLocked,
        usdt_total: newUsdtTotal, // 🟢 Lazy Settle: 固化收益
        usdt_locked: newUsdtLocked,
        // 🔥 关键修复：更新 last_settlement_time 为提现时间，确保历史收益被正确固化
        // 这样下次计算增量收益时，只会从提现时间开始，用当时的利率计算
        // 防止利率变更后，用新利率错误地重新计算旧时间段的收益
        last_settlement_time: nowIso, // ✅ 更新为提现时间
        created_at: createdAt,
        updated_at: nowIso,
      },
      { onConflict: 'address' }
    );
  if (lockErr) throw lockErr;

  // 11. 创建提现记录
  const { data: inserted, error: insErr } = await supabase
    .from('withdrawals')
    .insert({
      address: addr,
      amount,
      status: 'Pending',
      energy_locked_amount: requiredEnergy,
      created_at: nowIso,
      updated_at: nowIso,
    })
    .select('id,amount,status,created_at')
    .single();

  if (insErr) {
    // 🔄 回滚：恢复锁定状态（best-effort）
    // 注意：这里回滚到原始状态，包括原始的 last_settlement_time
    const originalLastSettlementTime = (user as any)?.last_settlement_time || null;
    await supabase.from('users').upsert(
      {
        address: addr,
        energy_total: energyTotal,
        energy_locked: energyLocked,
        usdt_total: baseEarnings, // 恢复为基准收益（不包含增量）
        usdt_locked: Number((user as any)?.usdt_locked || 0),
        last_settlement_time: originalLastSettlementTime, // 恢复原始的结算时间
        created_at: createdAt,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'address' }
    );
    throw insErr;
  }

  // 🟢 发送 Telegram 提现申请通知（异步，不阻塞响应）
  setImmediate(async () => {
    try {
      const { sendWithdrawalPendingNotification } = await import('./telegram.js');
      await sendWithdrawalPendingNotification({
        address: addr,
        amount: String(amount),
        energyCost: requiredEnergy,
        withdrawalId: (inserted as any).id,
        timestamp: (inserted as any).created_at,
      });
    } catch (e) {
      console.error('[applyWithdraw] Telegram 通知发送失败（不影响提现）:', e);
    }
  });

  return {
    ok: true,
    id: (inserted as any).id,
    status: (inserted as any).status,
    amount: String((inserted as any).amount),
    time: new Date((inserted as any).created_at).toISOString().slice(0, 19).replace('T', ' '),
  };
}

export async function getWithdrawHistory(address: string) {
  const addr = address.toLowerCase();
  
  try {
    const { data, error } = await supabase
      .from('withdrawals')
      .select('id,amount,status,created_at')
      .eq('address', addr)
      .order('created_at', { ascending: false })
      .limit(50);
    
    if (error) {
      console.error('Error fetching withdraw history:', error);
      return [];
    }

    if (!data || data.length === 0) {
      return [];
    }

    return data.map((r: any) => ({
      id: r.id,
      amount: String(r.amount),
      status: r.status || 'Pending',
      time: new Date(r.created_at).toISOString().slice(0, 19).replace('T', ' '),
      createdAt: r.created_at,
    }));
  } catch (error: any) {
    console.error('Error in getWithdrawHistory:', error);
    return [];
  }
}


