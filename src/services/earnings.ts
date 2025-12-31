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
  // 🟢 改进：如果 RPC 失败或超时，使用默认值 0，避免阻塞整个请求
  let balanceWei: ethers.BigNumber;
  let balance: number = 0;
  try {
    const ratContract = new ethers.Contract(config.ratTokenContract, ERC20_ABI, provider);
    
    // 🔒 关键修复：添加超时保护（10秒），防止 RPC 调用无限等待
    // 240秒超时说明 RPC 节点可能有问题，添加超时保护可以快速失败
    const balancePromise = ratContract.balanceOf(userAddress);
    const timeoutPromise = new Promise<ethers.BigNumber>((_, reject) => {
      setTimeout(() => reject(new Error('RPC_TIMEOUT: balanceOf call exceeded 10 seconds')), 10000);
    });
    
    balanceWei = await Promise.race([balancePromise, timeoutPromise]);
    const decimals = await Promise.race([
      ratContract.decimals(),
      new Promise<number>((resolve) => setTimeout(() => resolve(18), 5000))
    ]).catch(() => 18);
    const balanceStr = ethers.utils.formatUnits(balanceWei, decimals);
    balance = parseFloat(balanceStr);
  } catch (error: any) {
    // 🟢 改进：记录警告但不抛出异常，使用默认值 0
    // 这样即使 RPC 失败或超时，也能返回基本的收益信息（基于数据库数据）
    const errorMsg = error?.message || String(error);
    if (errorMsg.includes('TIMEOUT') || errorMsg.includes('timeout')) {
      console.warn(`[Earnings] RPC timeout for ${addr} (balanceOf), using default 0`);
    } else {
      console.warn(`[Earnings] Failed to fetch RAT balance for ${addr}: ${errorMsg}, using default 0`);
    }
    balance = 0;
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

  // 步骤 3: 读取用户数据（包括 last_settlement_time 和 usdt_total）
  const { data: userRow, error: userErr } = await supabase
    .from('users')
    .select('usdt_total, last_settlement_time, created_at')
    .eq('address', addr)
    .maybeSingle();

  if (userErr) {
    console.error(`[Earnings] Failed to query users table for ${addr}:`, userErr);
    throw userErr;
  }

  // 步骤 4: 确定 VIP 等级和日利率（从数据库配置读取）
  const { dailyRate, tier: currentTier } = getVipTierByBalance(balance);

  // 步骤 5: 计算实时收益（流式秒级结算）
  // 🟢 核心改进：使用 last_settlement_time 作为基准时间，实现 Lazy Settle
  const now = Date.now();
  const lastSettlementTime = userRow?.last_settlement_time 
    ? new Date(userRow.last_settlement_time).getTime()
    : new Date(firstClaim.created_at).getTime(); // 如果没有结算时间，使用首次领取时间
  
  // 计算从上次结算到现在的天数（不取整，保留小数）
  const timeElapsedMs = now - lastSettlementTime;
  const daysElapsed = timeElapsedMs / (24 * 3600 * 1000); // 精确到毫秒的天数

  // 计算增量收益 = Balance * 0.01 * Rate * Days（不取整）
  const TOKEN_PRICE = 0.01; // $0.01 per RAT
  const incrementalEarnings = balance * TOKEN_PRICE * (dailyRate / 100) * daysElapsed;

  // 基准收益（已固化的收益，来自数据库）
  const baseEarnings = Number((userRow as any)?.usdt_total || 0);

  // 实时总收益 = 基准收益 + 增量收益
  const grossEarnings = baseEarnings + incrementalEarnings;

  // 计算持币天数（用于显示，从首次领取开始计算）
  const startTime = new Date(firstClaim.created_at).getTime();
  const daysHolding = Math.max(0, (now - startTime) / (24 * 3600 * 1000)); // 不取整，保留小数

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

  // 步骤 7: 计算当前可领收益 = 实时总收益 - 已提现总额
  // ⚠️ 关键修复：必须减去所有 Pending 和 Completed 的提现金额
  // 如果计算结果小于 0，返回 0（不能为负数）
  const netEarnings = Math.max(0, grossEarnings - totalWithdrawn);

  // 调试日志：记录计算过程（流式秒级结算）
  console.log(`[Earnings] User ${addr}: baseEarnings=${baseEarnings.toFixed(6)}, incrementalEarnings=${incrementalEarnings.toFixed(6)}, grossEarnings=${grossEarnings.toFixed(6)}, totalWithdrawn=${totalWithdrawn.toFixed(6)}, netEarnings=${netEarnings.toFixed(6)}`);

  // 🟢 移除：不再异步更新 usdt_total（Lazy Settle：只在提现时固化）
  // 这样可以避免频繁的数据库写入，提高性能

  return {
    pendingUsdt: netEarnings.toFixed(6), // 🟢 改为6位小数，支持秒级精度
    dailyRate: dailyRate * 100, // 转换为百分比（例如 0.02 -> 2）
    currentTier,
    holdingDays: Math.floor(daysHolding), // 显示时取整
    balance: balance.toFixed(2),
    grossEarnings: grossEarnings.toFixed(6), // 🟢 改为6位小数
    totalWithdrawn: totalWithdrawn.toFixed(6), // 🟢 改为6位小数
  };
}

// 🟢 已移除：updateUserUsdtTotal 函数
// 原因：实现 Lazy Settle（按需结算），只在提现时才固化收益到数据库
// 这样可以避免频繁的数据库写入，提高性能
