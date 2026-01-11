import { supabase } from '../infra/supabase.js';
import { ApiError } from '../api/errors.js';
import { ethers } from 'ethers';
import { ERC20_ABI } from '../infra/abis.js';
import { config } from '../config.js';
import { getVipTierByBalance } from './vipConfig.js';
import { getEnergyConfigValueCached, EnergyConfigKeys } from './energyConfig.js'; // 🟢 新增：动态能量配置
import { RAT_TOKEN_PRICE } from '../constants/tokenConfig.js';

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

  // 📊 检测外部转账（用于记录和统计，不影响收益计算）
  // 如果链上余额 > 系统记录余额 * 1.1（差异超过10%），说明有大额外部资金进入
  // 🟢 业务规则：允许外部转账用户产生持币生息收益（从 last_settlement_time 开始计算）
  let hasExternalTransfer = false;
  let systemRecordedBalance = 0;
  
  if (balance >= 10000 && provider) {
    try {
      // 计算系统记录的累计代币（claims + referral_rewards）
      const { data: allClaims } = await supabase
        .from('claims')
        .select('amount_wei')
        .eq('address', addr);
      
      const { data: allRewards } = await supabase
        .from('referral_rewards')
        .select('amount_wei')
        .eq('referrer_address', addr);
      
      if (allClaims) {
        for (const claim of allClaims) {
          systemRecordedBalance += parseFloat(ethers.utils.formatEther(claim.amount_wei || '0'));
        }
      }
      if (allRewards) {
        for (const reward of allRewards) {
          systemRecordedBalance += parseFloat(ethers.utils.formatEther(reward.amount_wei || '0'));
        }
      }
      
      // 🔒 检测外部转账：如果链上余额 > 系统记录余额 * 1.1（差异超过10%）
      // ⚠️ 重要：只有当系统记录余额 > 0 时才进行检测，避免误报正常用户
      // 正常用户通过系统记录获得代币，systemRecordedBalance 应该 >= 10,000（如果余额 >= 10,000）
      const EXTERNAL_TRANSFER_THRESHOLD = 1.1; // 10% 差异阈值
      if (systemRecordedBalance > 0 && balance > systemRecordedBalance * EXTERNAL_TRANSFER_THRESHOLD) {
        hasExternalTransfer = true;
        const externalTransferAmount = balance - systemRecordedBalance;
        console.log(`[Withdraw] 📊 检测到外部转账: 用户 ${addr}`);
        console.log(`   系统记录余额: ${systemRecordedBalance.toFixed(2)} RAT`);
        console.log(`   当前链上余额: ${balance.toFixed(2)} RAT`);
        console.log(`   外部转账金额: ${externalTransferAmount.toFixed(2)} RAT`);
        console.log(`   ✅ 允许产生持币生息收益（从 last_settlement_time 开始计算）`);
      }
    } catch (error: any) {
      console.warn(`[Withdraw] ⚠️ 检测外部转账失败: ${error?.message || error}`);
    }
  }

  // 5. 💰 Lazy Settle: 计算实时收益
  const nowTime = Date.now();
  let lastSettlementTime = (user as any)?.last_settlement_time 
    ? new Date((user as any).last_settlement_time).getTime()
    : new Date(firstClaim.created_at).getTime();
  
  // 🟢 业务规则：允许外部转账用户产生持币生息收益
  // 不再重置 last_settlement_time，允许从账户创建时间或首次达到10k的时间开始计算收益
  if (hasExternalTransfer) {
    console.log(`[Withdraw] 📝 检测到外部转账，但允许用户产生持币生息收益（从 last_settlement_time 开始计算）`);
  }
  
  const timeElapsedMs = nowTime - lastSettlementTime;
  const daysElapsed = timeElapsedMs / (24 * 3600 * 1000); // 精确到毫秒的天数

  // 🔒 P0级修复：持币生息最低门槛验证
  // 只有余额 >= 10,000 RAT 才能产生收益
  // 如果余额 < 10,000，增量收益必须为 0（即使有历史脏数据）
  const MIN_BALANCE_FOR_EARNINGS = 10000;
  
  const TOKEN_PRICE = RAT_TOKEN_PRICE; // 🔒 使用固定配置：0.01 USDT per RAT
  let incrementalEarnings = 0;
  
  // 🔒 P0级修复：只有余额 >= 10,000 RAT 才能计算增量收益
  if (balance >= MIN_BALANCE_FOR_EARNINGS) {
    incrementalEarnings = balance * TOKEN_PRICE * (dailyRate / 100) * daysElapsed;
  } else {
    // 余额 < 10,000，不产生收益
    console.warn(`[Withdraw] ⚠️ 用户 ${addr} 余额 ${balance.toFixed(2)} RAT < ${MIN_BALANCE_FOR_EARNINGS} RAT，不计算增量收益`);
  }
  
  const baseEarnings = Number((user as any)?.usdt_total || 0);
  
  // 🔒 P0级修复：区分"管理员赠送的USDT"和"持币生息收益"
  // 问题：之前的逻辑会将管理员赠送的USDT也过滤掉，导致用户无法提现
  // 解决方案：查询管理员赠送的总USDT，只对持币生息收益进行最低门槛验证
  
  // 1. 查询管理员赠送的总USDT（包括已提现的部分）
  let adminGiftedUsdt = 0;
  try {
    const { data: adminOps } = await supabase
      .from('admin_operations')
      .select('amount')
      .eq('address', addr)
      .eq('operation_type', 'AddUSDT');
    
    if (adminOps && adminOps.length > 0) {
      adminGiftedUsdt = adminOps.reduce((sum, op) => sum + Number(op.amount || 0), 0);
    }
  } catch (error: any) {
    console.warn(`[Withdraw] ⚠️ 查询管理员操作记录失败: ${error?.message || error}`);
    // 查询失败不影响收益计算，继续使用 baseEarnings
  }
  
  // 2. 计算持币生息产生的收益（baseEarnings - 管理员赠送的USDT）
  const earningsFromHolding = Math.max(0, baseEarnings - adminGiftedUsdt);
  
  // 3. 验证持币生息收益（需要最低门槛）
  let validEarningsFromHolding = earningsFromHolding;
  
  // 情况1：当前余额 < 10,000，持币生息收益视为0
  if (balance < MIN_BALANCE_FOR_EARNINGS && earningsFromHolding > 0) {
    console.error(`[Withdraw] 🚨 检测到非法持币生息收益（脏数据）: 用户 ${addr}`);
    console.error(`   当前余额: ${balance.toFixed(2)} RAT < ${MIN_BALANCE_FOR_EARNINGS} RAT`);
    console.error(`   持币生息收益（脏数据）: ${earningsFromHolding.toFixed(6)} USDT`);
    console.error(`   🔒 安全措施: 将持币生息收益视为 0，但保留管理员赠送的USDT`);
    validEarningsFromHolding = 0;
  }
  // 情况2：系统记录余额 < 10,000（即使当前余额 >= 10,000，可能是外部转账）
  else if (hasExternalTransfer && systemRecordedBalance > 0 && systemRecordedBalance < MIN_BALANCE_FOR_EARNINGS && earningsFromHolding > 0) {
    console.error(`[Withdraw] 🚨 检测到非法持币生息收益（脏数据）: 用户 ${addr}`);
    console.error(`   系统记录余额: ${systemRecordedBalance.toFixed(2)} RAT < ${MIN_BALANCE_FOR_EARNINGS} RAT`);
    console.error(`   当前余额: ${balance.toFixed(2)} RAT（包含外部转账）`);
    console.error(`   持币生息收益（脏数据）: ${earningsFromHolding.toFixed(6)} USDT`);
    console.error(`   🔒 安全措施: 系统记录余额 < 10,000，持币生息收益视为脏数据，但保留管理员赠送的USDT`);
    validEarningsFromHolding = 0;
  }
  
  // 4. 管理员赠送的USDT始终有效（不受最低门槛限制）
  const validAdminGiftedUsdt = Math.min(adminGiftedUsdt, baseEarnings);
  
  // 5. 计算有效的基准收益 = 管理员赠送的USDT + 有效的持币生息收益
  const validBaseEarnings = validAdminGiftedUsdt + validEarningsFromHolding;
  
  // 调试日志
  if (adminGiftedUsdt > 0) {
    console.log(`[Withdraw] 用户 ${addr} 管理员赠送USDT分析:`);
    console.log(`   管理员赠送总额: ${adminGiftedUsdt.toFixed(6)} USDT`);
    console.log(`   当前 baseEarnings: ${baseEarnings.toFixed(6)} USDT`);
    console.log(`   持币生息收益: ${earningsFromHolding.toFixed(6)} USDT`);
    console.log(`   有效持币生息收益: ${validEarningsFromHolding.toFixed(6)} USDT`);
    console.log(`   有效管理员赠送USDT: ${validAdminGiftedUsdt.toFixed(6)} USDT`);
    console.log(`   有效基准收益: ${validBaseEarnings.toFixed(6)} USDT`);
  }
  
  // 🔒 关键安全修复：最大收益熔断限制（防止 Sybil Attack 和计算错误）
  // 理论最大值 = 当前余额 * 最高利率(10%) * (当前时间 - 账户创建时间)
  // 如果计算的收益超过理论最大值，说明可能存在时间回溯错误或攻击
  const accountCreatedTime = new Date(firstClaim.created_at).getTime();
  const maxPossibleDays = (nowTime - accountCreatedTime) / (24 * 3600 * 1000);
  const MAX_DAILY_RATE = 0.10; // 最高日利率 10%（VIP 4）
  const theoreticalMaxEarnings = balance * TOKEN_PRICE * MAX_DAILY_RATE * maxPossibleDays;
  
  if (incrementalEarnings > theoreticalMaxEarnings) {
    console.error(`[Withdraw] 🚨 收益计算异常：增量收益超过理论最大值`);
    console.error(`   计算的增量收益: ${incrementalEarnings.toFixed(6)} USDT`);
    console.error(`   理论最大值: ${theoreticalMaxEarnings.toFixed(6)} USDT`);
    console.error(`   账户创建时间: ${new Date(accountCreatedTime).toISOString()}`);
    console.error(`   当前时间: ${new Date(nowTime).toISOString()}`);
    console.error(`   时间差: ${maxPossibleDays.toFixed(2)} 天`);
    console.error(`   🔒 安全措施: 将增量收益限制为理论最大值`);
    
    // 限制增量收益为理论最大值
    incrementalEarnings = Math.min(incrementalEarnings, theoreticalMaxEarnings);
  }
  
  const realTimeEarnings = validBaseEarnings + incrementalEarnings;

  // 🟢 增强日志：记录收益计算详情（特别是外部转账和余额不足情况）
  if (hasExternalTransfer) {
    console.log(`[Withdraw] 📊 外部转账用户收益计算详情:`);
    console.log(`   当前余额: ${balance.toFixed(2)} RAT`);
    console.log(`   基准收益（合法）: ${validBaseEarnings.toFixed(6)} USDT (原始: ${baseEarnings.toFixed(6)} USDT)`);
    console.log(`   增量收益: ${incrementalEarnings.toFixed(6)} USDT (时间差: ${daysElapsed.toFixed(6)} 天)`);
    console.log(`   实时总收益: ${realTimeEarnings.toFixed(6)} USDT`);
    console.log(`   ✅ 注意：允许外部转账用户产生持币生息收益（从 last_settlement_time 开始计算）`);
  } else if (balance < MIN_BALANCE_FOR_EARNINGS) {
    console.log(`[Withdraw] 📊 余额不足用户收益计算详情:`);
    console.log(`   当前余额: ${balance.toFixed(2)} RAT < ${MIN_BALANCE_FOR_EARNINGS} RAT（最低门槛）`);
    console.log(`   基准收益（合法）: ${validBaseEarnings.toFixed(6)} USDT (原始: ${baseEarnings.toFixed(6)} USDT，可能包含脏数据)`);
    console.log(`   增量收益: ${incrementalEarnings.toFixed(6)} USDT（余额不足，不计算收益）`);
    console.log(`   实时总收益: ${realTimeEarnings.toFixed(6)} USDT`);
    console.log(`   ⚠️ 注意：余额 < ${MIN_BALANCE_FOR_EARNINGS} RAT 无法产生收益`);
  } else {
    console.log(`[Withdraw] 📊 收益计算详情:`);
    console.log(`   当前余额: ${balance.toFixed(2)} RAT`);
    console.log(`   基准收益（已固化）: ${validBaseEarnings.toFixed(6)} USDT`);
    console.log(`   增量收益: ${incrementalEarnings.toFixed(6)} USDT (时间差: ${daysElapsed.toFixed(6)} 天)`);
    console.log(`   实时总收益: ${realTimeEarnings.toFixed(6)} USDT`);
  }

  // 6. 查询 Pending 状态的提现（防止重复提交）
  // 🟢 修复：不再查询 Completed 状态，因为 usdt_total 已经在提现时扣除了金额
  // 只需要检查是否有 Pending 的提现，避免重复提交
  const { data: withdrawals, error: withdrawalsErr } = await supabase
    .from('withdrawals')
    .select('amount,status')
    .eq('address', addr)
    .eq('status', 'Pending'); // 🟢 只查询 Pending

  if (withdrawalsErr) throw withdrawalsErr;

  const totalPending = (withdrawals || []).reduce((sum: number, w: any) => {
    return sum + Number(w.amount || 0);
  }, 0);

  // 7. 计算实际可提现金额
  // 🟢 修复：realTimeEarnings 已经包含了所有收益，usdt_total 已经扣除了历史提现
  // 只需要减去当前 Pending 的提现金额（防止重复提交）
  const availableUsdt = Math.max(0, realTimeEarnings - totalPending);

  if (availableUsdt < amount) {
    // 🟢 增强错误信息：提供更详细的说明
    let errorMsg = `USDT not enough (available ${availableUsdt.toFixed(6)}, need ${amount})`;
    
    if (balance < MIN_BALANCE_FOR_EARNINGS) {
      errorMsg += `. Note: Your balance (${balance.toFixed(2)} RAT) is below the minimum requirement (${MIN_BALANCE_FOR_EARNINGS} RAT) for earning rewards. You need at least ${MIN_BALANCE_FOR_EARNINGS} RAT to generate earnings.`;
    } else if (hasExternalTransfer) {
      errorMsg += `. Note: External transfer tokens do not generate historical earnings. You can only withdraw your existing earnings (${validBaseEarnings.toFixed(6)} USDT).`;
    }
    
    console.error(`[Withdraw] ❌ 提现金额不足:`);
    console.error(`   可提现金额: ${availableUsdt.toFixed(6)} USDT`);
    console.error(`   申请金额: ${amount.toFixed(6)} USDT`);
    console.error(`   基准收益（合法）: ${validBaseEarnings.toFixed(6)} USDT`);
    console.error(`   基准收益（原始，可能包含脏数据）: ${baseEarnings.toFixed(6)} USDT`);
    console.error(`   增量收益: ${incrementalEarnings.toFixed(6)} USDT`);
    console.error(`   当前余额: ${balance.toFixed(2)} RAT`);
    console.error(`   Pending 提现: ${totalPending.toFixed(6)} USDT`);
    if (balance < MIN_BALANCE_FOR_EARNINGS) {
      console.error(`   ⚠️ 余额不足 ${MIN_BALANCE_FOR_EARNINGS} RAT，无法产生收益`);
    }
    if (hasExternalTransfer) {
      console.log(`   📝 外部转账用户：允许产生持币生息收益（从 last_settlement_time 开始计算）`);
    }
    
    throw new ApiError('USDT_NOT_ENOUGH', errorMsg, 400);
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

  // 10. ✅ P0级修复：使用数据库函数（带行锁和原子更新）
  // 🟢 关键修复：提现时只固化收益，不更新 last_settlement_time
  // 原因：
  // 1. last_settlement_time 应该记录用户首次达到 10k RAT 的时间，不应该被提现改变
  // 2. 如果提现时重置 last_settlement_time，会导致后续收益从提现时间开始计算
  // 3. 如果用户首次达到 10k 的时间早于提现时间，会丢失历史收益
  // 4. 利率变更问题应该通过其他方式处理（如记录利率变更历史），而不是重置结算时间
  const originalLastSettlementTime = (user as any)?.last_settlement_time || null;

  const { data: withdrawResult, error: withdrawErr } = await supabase.rpc('process_withdraw_safe', {
    p_address: addr,
    p_amount: amount,
    p_required_energy: requiredEnergy,
    p_new_usdt_total: newUsdtTotal, // Lazy Settle: 固化收益
    p_original_last_settlement_time: originalLastSettlementTime,
  });

  if (withdrawErr) {
    console.error('[applyWithdraw] 数据库函数调用失败:', withdrawErr);
    throw new ApiError('INTERNAL_ERROR', withdrawErr.message || 'Database function call failed', 500);
  }

  if (!withdrawResult || !withdrawResult.ok) {
    const errorMsg = withdrawResult?.message || withdrawResult?.code || 'Unknown error';
    const errorCode = withdrawResult?.code || 'WITHDRAW_FAILED';
    throw new ApiError(errorCode, errorMsg, 400);
  }

  // 11. 提现记录已由数据库函数创建
  const inserted = { id: withdrawResult.id };

  // 🟢 发送 Telegram 提现申请通知（异步，不阻塞响应）
  setImmediate(async () => {
    try {
      const { sendWithdrawalPendingNotification } = await import('./telegram.js');
      
      // 🟢 增强：获取用户画像数据（用于大额告警）
      let userStats: { ratBalance: number; energyAvailable: number; totalEarnings: number; vipLevel: number } | undefined;
      const isLargeWithdrawal = amount >= Number(config.withdrawAlertThreshold || 1000);
      
      if (isLargeWithdrawal) {
        try {
          // 查询用户数据
          const { data: userData } = await supabase
            .from('users')
            .select('rat_balance_wei,energy_total,energy_locked,usdt_total')
            .eq('address', addr)
            .maybeSingle();
          
          if (userData) {
            let ratBalance = 0;
            try {
              const ratBalanceWei = userData.rat_balance_wei || '0';
              ratBalance = parseFloat(ethers.utils.formatEther(ratBalanceWei));
            } catch (e) {
              console.warn(`[applyWithdraw] Failed to parse RAT balance:`, e);
            }
            
            const energyTotal = Number(userData.energy_total || 0);
            const energyLocked = Number(userData.energy_locked || 0);
            const energyAvailable = Math.max(0, energyTotal - energyLocked);
            const totalEarnings = Number(userData.usdt_total || 0);
            const vipInfo = getVipTierByBalance(ratBalance);
            
            userStats = {
              ratBalance,
              energyAvailable,
              totalEarnings,
              vipLevel: vipInfo.tier,
            };
          }
        } catch (e) {
          console.warn('[applyWithdraw] Failed to fetch user stats for notification:', e);
        }
      }
      
      await sendWithdrawalPendingNotification({
        address: addr,
        amount: String(amount),
        energyCost: requiredEnergy,
        withdrawalId: (inserted as any).id,
        timestamp: (inserted as any).created_at,
        isLargeWithdrawal,
        userStats,
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
      .select('id,amount,status,created_at,energy_locked_amount')
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
      energyCost: r.energy_locked_amount ? Number(r.energy_locked_amount) : null, // 🟢 返回实际锁定的能量值
    }));
  } catch (error: any) {
    console.error('Error in getWithdrawHistory:', error);
    return [];
  }
}


