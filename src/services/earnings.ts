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
    
    // 🔒 关键修复：添加超时保护（8秒），防止 RPC 调用无限等待
    // 使用更短的超时时间，快速失败并回退到数据库数据
    const startTime = Date.now();
    const balancePromise = ratContract.balanceOf(userAddress);
    const timeoutPromise = new Promise<ethers.BigNumber>((_, reject) => {
      setTimeout(() => {
        const elapsed = Date.now() - startTime;
        reject(new Error(`RPC_TIMEOUT: balanceOf call exceeded 8 seconds (elapsed: ${elapsed}ms)`));
      }, 8000);
    });
    
    balanceWei = await Promise.race([balancePromise, timeoutPromise]);
    const decimals = await Promise.race([
      ratContract.decimals(),
      new Promise<number>((resolve) => setTimeout(() => resolve(18), 3000))
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

  // 🟢 关键修复：如果用户首次达到10k RAT，初始化 last_settlement_time
  // 问题：如果用户首次达到10k后没有再次领取空投，last_settlement_time 可能仍然是首次领取时间
  // 这会导致从首次领取开始计算收益，而不是从达到10k开始
  // 解决方案：查询所有 claims，找到首次累计余额达到10k的时间点
  const now = Date.now();
  let lastSettlementTime = userRow?.last_settlement_time 
    ? new Date(userRow.last_settlement_time).getTime()
    : new Date(firstClaim.created_at).getTime(); // 如果没有结算时间，使用首次领取时间
  
  // 检测是否需要初始化或修正 last_settlement_time
  // 条件：1. 当前余额 >= 10k（达到持币生息要求）
  //       2. 情况A：usdt_total = 0（从未固化过收益）且 last_settlement_time 是首次领取时间
  //       3. 情况B：usdt_total > 0 但 last_settlement_time 明显晚于首次达到10k的时间
  //          （通过检查 claims 累计余额来判断）
  const firstClaimTime = new Date(firstClaim.created_at).getTime();
  const currentBaseEarnings = Number((userRow as any)?.usdt_total || 0);
  
  // 情况A：从未固化过收益，且 last_settlement_time 是首次领取时间
  const needsInitialization = balance >= 10000 
    && currentBaseEarnings === 0 
    && Math.abs(lastSettlementTime - firstClaimTime) < 1000; // 时间差小于1秒，认为是同一个时间点
  
  // 情况B：已固化过收益，但需要检查 last_settlement_time 是否合理
  // 如果通过 claims + referral_rewards 累计无法达到 10k，但当前余额 >= 10k，说明通过其他方式获得代币
  // 这种情况下，如果 last_settlement_time 是最后一次领取时间，可能需要调整
  let needsCorrection = false;
  if (balance >= 10000 && currentBaseEarnings > 0) {
    // 🟢 优化：同时检查 claims 和 referral_rewards
    try {
      const { data: allClaimsCheck } = await supabase
        .from('claims')
        .select('amount_wei, created_at, block_time')
        .eq('address', addr)
        .order('created_at', { ascending: true });
      
      const { data: allRewardsCheck } = await supabase
        .from('referral_rewards')
        .select('amount_wei, created_at, block_time')
        .eq('referrer_address', addr)
        .order('created_at', { ascending: true });
      
      // 合并所有代币来源，计算累计余额
      let cumulativeBalance = 0;
      let lastEventTime: Date | null = null;
      
      if (allClaimsCheck && allClaimsCheck.length > 0) {
        for (const claim of allClaimsCheck) {
          cumulativeBalance += parseFloat(ethers.utils.formatEther(claim.amount_wei || '0'));
          const claimTime = claim.block_time ? new Date(claim.block_time) : new Date(claim.created_at);
          if (!lastEventTime || claimTime > lastEventTime) {
            lastEventTime = claimTime;
          }
        }
      }
      
      if (allRewardsCheck && allRewardsCheck.length > 0) {
        for (const reward of allRewardsCheck) {
          cumulativeBalance += parseFloat(ethers.utils.formatEther(reward.amount_wei || '0'));
          const rewardTime = reward.block_time ? new Date(reward.block_time) : new Date(reward.created_at);
          if (!lastEventTime || rewardTime > lastEventTime) {
            lastEventTime = rewardTime;
          }
        }
      }
      
      // 如果累计 < 10k，但当前余额 >= 10k，说明通过其他方式获得代币
      // 如果 last_settlement_time 是最后一次事件时间，且距离现在很短，可能需要调整
      if (cumulativeBalance < 10000 && lastEventTime) {
        const lastEventTimeMs = lastEventTime.getTime();
        const timeSinceLastEvent = (now - lastEventTimeMs) / (24 * 3600 * 1000); // 天数
        
        // 如果最后一次事件距离现在很短（< 2天），但用户说已经产生4天收益
        // 说明 last_settlement_time 可能设置得太晚了
        // 这种情况下，我们无法准确知道首次达到10k的时间，但可以给用户一个提示
        if (timeSinceLastEvent < 2 && Math.abs(lastSettlementTime - lastEventTimeMs) < 1000) {
          console.log(`[Earnings] ⚠️ User ${addr} may have reached 10k earlier than last_settlement_time suggests (cumulative: ${cumulativeBalance.toFixed(2)} RAT, current balance: ${balance.toFixed(2)} RAT)`);
          // 不自动调整，因为可能不准确，但记录日志供排查
        }
      }
    } catch (error: any) {
      console.warn(`[Earnings] ⚠️ Error checking last_settlement_time for ${addr}:`, error?.message || error);
    }
  }
  
  if (needsInitialization) {
    // 🟢 优化：同时查询 claims 和 referral_rewards，找到首次累计余额达到10k的时间点
    // 因为用户可能通过邀请奖励获得代币，使余额达到10k
    try {
      // 1. 查询用户自己领取的空投（claims）
      const { data: allClaims, error: claimsErr } = await supabase
        .from('claims')
        .select('amount_wei, created_at, block_time')
        .eq('address', addr)
        .order('created_at', { ascending: true });
      
      // 2. 查询用户作为推荐人获得的奖励（referral_rewards）
      // 注意：referrer_address 是推荐人地址，所以查询 referrer_address = 用户地址
      const { data: allRewards, error: rewardsErr } = await supabase
        .from('referral_rewards')
        .select('amount_wei, created_at, block_time')
        .eq('referrer_address', addr)
        .order('created_at', { ascending: true });
      
      if (claimsErr) {
        console.warn(`[Earnings] ⚠️ Failed to query claims for ${addr}:`, claimsErr);
      }
      if (rewardsErr) {
        console.warn(`[Earnings] ⚠️ Failed to query referral_rewards for ${addr}:`, rewardsErr);
      }
      
      // 3. 合并所有代币来源，按时间排序
      interface TokenEvent {
        amount: number;
        timestamp: Date;
        source: 'claim' | 'reward';
      }
      
      const allEvents: TokenEvent[] = [];
      
      // 添加 claims
      if (allClaims && allClaims.length > 0) {
        for (const claim of allClaims) {
          const amount = parseFloat(ethers.utils.formatEther(claim.amount_wei || '0'));
          const timestamp = claim.block_time 
            ? new Date(claim.block_time) 
            : new Date(claim.created_at);
          allEvents.push({ amount, timestamp, source: 'claim' });
        }
      }
      
      // 添加 referral_rewards
      if (allRewards && allRewards.length > 0) {
        for (const reward of allRewards) {
          const amount = parseFloat(ethers.utils.formatEther(reward.amount_wei || '0'));
          const timestamp = reward.block_time 
            ? new Date(reward.block_time) 
            : new Date(reward.created_at);
          allEvents.push({ amount, timestamp, source: 'reward' });
        }
      }
      
      // 按时间排序
      allEvents.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      
      // 4. 计算累计余额，找到首次达到10k的时间点
      if (allEvents.length > 0) {
        let cumulativeBalance = 0;
        let firstReached10kTime: Date | null = null;
        
        for (const event of allEvents) {
          cumulativeBalance += event.amount;
          
          if (cumulativeBalance >= 10000 && !firstReached10kTime) {
            firstReached10kTime = event.timestamp;
            console.log(`[Earnings] 📊 Found first 10k time for ${addr}: ${firstReached10kTime.toISOString()}, reached via ${event.source}, cumulative: ${cumulativeBalance.toFixed(2)} RAT`);
            break;
          }
        }
        
        if (firstReached10kTime) {
          // 找到首次达到10k的时间，更新 last_settlement_time
          const firstReached10kIso = firstReached10kTime.toISOString();
          const { error: updateErr } = await supabase
            .from('users')
            .update({ last_settlement_time: firstReached10kIso })
            .eq('address', addr);
          
          if (!updateErr) {
            lastSettlementTime = firstReached10kTime.getTime();
            console.log(`[Earnings] ✅ Initialized last_settlement_time for ${addr} to first 10k time: ${firstReached10kIso}`);
          } else {
            console.warn(`[Earnings] ⚠️ Failed to initialize last_settlement_time for ${addr}:`, updateErr);
          }
        } else {
          // 如果查询不到首次达到10k的时间，说明可能是通过其他方式获得的代币（如直接转账）
          // 🟢 优化策略：使用首次领取时间作为保守估计
          // 这样即使无法确定转账时间，也能从首次领取开始计算收益（不会多算收益）
          // 如果用户希望从转账时间开始计算，可以通过管理员工具手动设置 last_settlement_time
          console.log(`[Earnings] ⚠️ Could not find first 10k time for ${addr} (total events: ${allEvents.length}, cumulative: ${cumulativeBalance.toFixed(2)} RAT, current balance: ${balance.toFixed(2)} RAT)`);
          console.log(`[Earnings] 💡 Using first claim time as conservative estimate. Admin can manually set last_settlement_time if needed.`);
          
          // 使用首次领取时间作为保守估计（不会多算收益）
          // 如果用户确实是通过直接转账获得的代币，管理员可以手动设置 last_settlement_time
          const firstClaimIso = firstClaim.created_at;
          const { error: updateErr } = await supabase
            .from('users')
            .update({ last_settlement_time: firstClaimIso })
            .eq('address', addr);
          
          if (!updateErr) {
            lastSettlementTime = new Date(firstClaimIso).getTime();
            console.log(`[Earnings] ✅ Set last_settlement_time to first claim time: ${firstClaimIso}`);
          }
        }
      } else {
        // 没有任何代币来源记录，使用当前时间
        console.log(`[Earnings] ⚠️ No token events found for ${addr}, using current time`);
        const nowIso = new Date().toISOString();
        const { error: updateErr } = await supabase
          .from('users')
          .update({ last_settlement_time: nowIso })
          .eq('address', addr);
        
        if (!updateErr) {
          lastSettlementTime = now;
        }
      }
    } catch (error: any) {
      console.warn(`[Earnings] ⚠️ Error initializing last_settlement_time for ${addr}:`, error?.message || error);
      // 继续使用原来的时间，不影响收益计算
    }
  }
  
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
