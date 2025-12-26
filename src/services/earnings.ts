import { ethers } from 'ethers';
import { supabase } from '../infra/supabase.js';
import { ERC20_ABI } from '../infra/abis.js';
import { config } from '../config.js';
import { ApiError } from '../api/errors.js';
import { getVipTierByBalance } from './vipConfig.js';

/**
 * 计算用户收益
 * @param provider Ethers provider
 * @param userAddress 用户钱包地址
 * @returns 收益计算结果
 */
export async function calculateUserEarnings(
  provider: ethers.providers.Provider,
  userAddress: string
): Promise<{
  pendingUsdt: string; // 可领收益（USDT）
  dailyRate: number; // 日利率（百分比，例如 2 表示 2%）
  currentTier: number; // VIP 等级（0-4）
  holdingDays: number; // 持币天数
  balance: string; // 当前 RAT 余额
  grossEarnings: string; // 历史总收益
  totalWithdrawn: string; // 已提现总额
}> {
  const addr = userAddress.toLowerCase();

  // 步骤 1: 从链上读取 RAT 余额
  // 注意：RAT_TOKEN_CONTRACT 在启动时已检查，这里不需要再次检查
  let balanceWei: ethers.BigNumber;
  let balance: number;
  try {
    const ratContract = new ethers.Contract(config.ratTokenContract, ERC20_ABI, provider);
    balanceWei = await ratContract.balanceOf(userAddress);
    const decimals = await ratContract.decimals().catch(() => 18);
    const balanceStr = ethers.utils.formatUnits(balanceWei, decimals);
    balance = parseFloat(balanceStr);
  } catch (error: any) {
    throw new ApiError('RPC_ERROR', `Failed to fetch RAT balance: ${error?.message || error}`, 500);
  }

  // 步骤 2: 查询数据库 claims 表，找到用户最早的一条 created_at 时间
  const { data: firstClaim, error: claimErr } = await supabase
    .from('claims')
    .select('created_at')
    .eq('address', addr)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (claimErr) throw claimErr;

  // 如果用户从未领取过空投，返回收益 0
  if (!firstClaim || !firstClaim.created_at) {
    return {
      pendingUsdt: '0',
      dailyRate: 0,
      currentTier: 0,
      holdingDays: 0,
      balance: balance.toFixed(2),
      grossEarnings: '0',
      totalWithdrawn: '0',
    };
  }

  // 步骤 3: 计算持币天数
  const startTime = new Date(firstClaim.created_at).getTime();
  const now = Date.now();
  const daysHolding = Math.max(0, Math.floor((now - startTime) / (24 * 3600 * 1000)));

  // 步骤 4: 确定 VIP 等级和日利率（从数据库配置读取）
  const { dailyRate, tier: currentTier } = getVipTierByBalance(balance);

  // 步骤 5: 计算历史总收益 = Balance * 0.01 * Rate * Days
  const TOKEN_PRICE = 0.01; // $0.01 per RAT
  const calculatedGrossEarnings = balance * TOKEN_PRICE * dailyRate * daysHolding;

  // 步骤 5.5: 读取数据库中的 usdt_total（可能包含后台赠送的USDT）
  // ⚠️ 重要：如果后台赠送了USDT，数据库中的 usdt_total 会大于计算值
  // 此时应该使用数据库值，以确保后台赠送的USDT能正确显示
  const { data: userRow, error: userErr } = await supabase
    .from('users')
    .select('usdt_total')
    .eq('address', addr)
    .maybeSingle();

  if (userErr) {
    console.error(`[Earnings] Failed to query users.usdt_total for ${addr}:`, userErr);
    // 如果查询失败，使用计算值
  }

  const dbUsdtTotal = Number((userRow as any)?.usdt_total || 0);
  
  // 使用数据库值（如果更大）或计算值
  // 这样既能保持持币生息自动计算，又能兼容后台赠送逻辑
  const grossEarnings = Math.max(dbUsdtTotal, calculatedGrossEarnings);

  // 步骤 6: 查询数据库 withdrawals 表，统计该用户所有状态为 Pending 或 Completed 的提现总额
  // ⚠️ 重要：必须统计 Pending 和 Completed 两种状态，因为：
  // - Pending: 已申请但未完成，但金额已被锁定，应从可提现余额中扣除
  // - Completed: 已完成提现，金额已实际转出，必须扣除
  const { data: withdrawals, error: withdrawErr } = await supabase
    .from('withdrawals')
    .select('amount,status')
    .eq('address', addr)
    .in('status', ['Pending', 'Completed']);

  if (withdrawErr) {
    console.error(`[Earnings] Failed to query withdrawals for ${addr}:`, withdrawErr);
    throw withdrawErr;
  }

  // 计算总提现金额（包括 Pending 和 Completed）
  const totalWithdrawn = (withdrawals || []).reduce((sum: number, w: any) => {
    const amount = Number(w.amount || 0);
    return sum + amount;
  }, 0);

  // 步骤 7: 计算当前可领收益 = 历史总收益 - 已提现总额
  // ⚠️ 关键修复：必须减去所有 Pending 和 Completed 的提现金额
  // 如果计算结果小于 0，返回 0（不能为负数）
  const netEarnings = Math.max(0, grossEarnings - totalWithdrawn);

  // 调试日志：记录计算过程
  console.log(`[Earnings] User ${addr}: grossEarnings=${grossEarnings.toFixed(2)}, totalWithdrawn=${totalWithdrawn.toFixed(2)}, netEarnings=${netEarnings.toFixed(2)}`);

  // 步骤 8: 异步更新 users 表的 usdt_total 字段（不阻塞返回）
  // 注意：这是为了管理员后台能看到大致数据，不影响 API 响应
  updateUserUsdtTotal(addr, grossEarnings).catch((err) => {
    // 静默失败，不影响主流程
    console.error(`[Earnings] Failed to update usdt_total for ${addr}:`, err);
  });

  return {
    pendingUsdt: netEarnings.toFixed(2),
    dailyRate: dailyRate * 100, // 转换为百分比（例如 0.02 -> 2）
    currentTier,
    holdingDays: daysHolding,
    balance: balance.toFixed(2),
    grossEarnings: grossEarnings.toFixed(2),
    totalWithdrawn: totalWithdrawn.toFixed(2),
  };
}

/**
 * 异步更新用户的总收益（usdt_total）
 * 用于管理员后台查看大致数据
 */
async function updateUserUsdtTotal(address: string, grossEarnings: number): Promise<void> {
  try {
    const { error } = await supabase
      .from('users')
      .upsert(
        {
          address: address.toLowerCase(),
          usdt_total: grossEarnings,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'address' }
      );

    if (error) {
      throw error;
    }
  } catch (error: any) {
    // 重新抛出以便调用者处理
    throw new Error(`Failed to update usdt_total: ${error?.message || error}`);
  }
}
