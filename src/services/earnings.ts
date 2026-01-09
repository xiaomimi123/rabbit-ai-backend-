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

  // 📊 检测外部转账（用于记录和统计，不影响收益计算）
  // 如果链上余额 > 系统记录余额 * 1.1（差异超过10%），说明有大额外部资金进入
  // 🟢 业务规则：允许外部转账用户产生持币生息收益（从 last_settlement_time 开始计算）
  let hasExternalTransfer = false;
  let systemRecordedBalance = 0;
  
  if (balance >= 10000) {
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
        console.log(`[Earnings] 📊 检测到外部转账: 用户 ${addr}`);
        console.log(`   系统记录余额: ${systemRecordedBalance.toFixed(2)} RAT`);
        console.log(`   当前链上余额: ${balance.toFixed(2)} RAT`);
        console.log(`   外部转账金额: ${externalTransferAmount.toFixed(2)} RAT`);
        console.log(`   差异比例: ${((balance / systemRecordedBalance - 1) * 100).toFixed(2)}%`);
        console.log(`   ✅ 允许产生持币生息收益（从 last_settlement_time 开始计算）`);
      }
    } catch (error: any) {
      // 检测失败不影响收益计算，但记录警告
      console.warn(`[Earnings] ⚠️ 检测外部转账失败: ${error?.message || error}`);
    }
  }

  // ========================================
  // 🔒 P0级修复：资金入账时间戳机制（三步走）
  // ========================================

  // 第一步：资金来源审计（增强 - 使用绝对值阈值）
  const EXTERNAL_TRANSFER_ABSOLUTE_THRESHOLD = 1000; // 1000 RAT 绝对阈值
  const externalTransferAmount = balance - systemRecordedBalance;
  const hasSignificantExternalTransfer = 
    externalTransferAmount > EXTERNAL_TRANSFER_ABSOLUTE_THRESHOLD;

  if (hasSignificantExternalTransfer) {
    console.log(`[Earnings] 🚨 检测到大量外部转账: 用户 ${addr}`);
    console.log(`   系统记录余额: ${systemRecordedBalance.toFixed(2)} RAT`);
    console.log(`   当前链上余额: ${balance.toFixed(2)} RAT`);
    console.log(`   外部转账金额: ${externalTransferAmount.toFixed(2)} RAT`);
  }

  // 第二步：VIP 门槛跨越判定（新增 + 🔧 P0修复：防止误判）
  // 🔒 只有当系统余额远低于10k（<5000 RAT）时，才认为是"刚跨越门槛"
  // 这样可以避免误判：系统余额 8,815 RAT 的用户不会被认为是"刚跨越"
  const THRESHOLD_BUFFER = 5000; // 缓冲阈值：5000 RAT
  const justCrossedThreshold = 
    systemRecordedBalance < THRESHOLD_BUFFER && balance >= 10000;

  if (justCrossedThreshold) {
    console.log(`[Earnings] 🎯 用户刚跨过10k门槛（系统余额 < ${THRESHOLD_BUFFER} RAT）`);
    console.log(`   系统记录余额: ${systemRecordedBalance.toFixed(2)} RAT < ${THRESHOLD_BUFFER}`);
    console.log(`   当前链上余额: ${balance.toFixed(2)} RAT >= 10,000`);
    console.log(`   触发"门槛跨越"保护机制`);
  }

  // 🔒 P0修复：添加"起息日锁定"机制
  // 如果用户已经有有效的USDT余额（>0），说明已经开始计息，不应该再重置起息日
  const currentUsdtTotal = Number((userRow as any)?.usdt_total || 0);
  const hasValidEarnings = currentUsdtTotal > 0;
  const shouldResetSettlementTime = 
    !hasValidEarnings && // 🔒 关键：只有没有收益的用户才允许重置
    hasSignificantExternalTransfer && 
    justCrossedThreshold;

  // 第三步：重置起息日（新增 + 🔧 P0修复）
  if (shouldResetSettlementTime) {
    // 🔒 关键保护：用户通过外部转账刚达到10k，必须从今天开始计息
    const nowIso = new Date().toISOString();
    
    // 更新数据库
    const { error: resetErr } = await supabase
      .from('users')
      .update({ 
        last_settlement_time: nowIso,
        updated_at: nowIso
      })
      .eq('address', addr);
    
    if (!resetErr) {
      console.log(`[Earnings] 🔒 起息日强制重置为现在: ${nowIso}`);
      console.log(`[Earnings] 📊 防止用户用外部转账本金 × 历史时间 = 虚假收益`);
      console.log(`[Earnings] ✅ 用户将从今天开始产生持币生息收益`);
      
      // ⚠️ 重要：立即返回收益0，因为用户刚刚达标
      return {
        pendingUsdt: '0',
        dailyRate,
        currentTier,
        holdingDays: 0,
        balance: balance.toFixed(2),
        grossEarnings: '0',
        totalWithdrawn: '0',
      };
    } else {
      console.error(`[Earnings] ⚠️ 重置起息日失败:`, resetErr);
    }
  }

  // ========================================
  // 继续原有的逻辑...
  // ========================================

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
  // 🟢 修复：增加条件 - 只有没有大量外部转账的用户，才执行自动初始化
  // 外部转账用户已经在"三步走"中处理，不会走到这里
  const needsInitialization = balance >= 10000 
    && currentBaseEarnings === 0 
    && Math.abs(lastSettlementTime - firstClaimTime) < 1000 // 时间差小于1秒，认为是同一个时间点
    && !hasSignificantExternalTransfer; // 🔒 新增：外部转账用户不执行自动初始化
  
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
          // 如果查询不到首次达到10k的时间，说明可能是通过外部转账获得的代币
          // 🟢 业务规则：允许外部转账用户产生持币生息收益
          // 使用首次领取时间作为保守估计（从账户创建开始计算收益）
          console.log(`[Earnings] ⚠️ Could not find first 10k time for ${addr} (total events: ${allEvents.length}, cumulative: ${cumulativeBalance.toFixed(2)} RAT, current balance: ${balance.toFixed(2)} RAT)`);
          console.log(`[Earnings] 💡 Using first claim time as conservative estimate. This allows external transfer users to earn interest.`);
          
          const firstClaimIso = firstClaim.created_at;
          const { error: updateErr } = await supabase
            .from('users')
            .update({ last_settlement_time: firstClaimIso })
            .eq('address', addr);
          
          if (!updateErr) {
            lastSettlementTime = new Date(firstClaimIso).getTime();
            console.log(`[Earnings] ✅ Set last_settlement_time to first claim time: ${firstClaimIso}`);
            if (hasExternalTransfer) {
              console.log(`[Earnings] 📝 Note: User has external transfers, but earnings will be calculated from account creation time as per business rules.`);
            }
          }
        }
      } else {
        // 没有任何代币来源记录（可能是纯外部转账用户）
        // 🟢 业务规则：允许外部转账用户产生持币生息收益
        // 使用首次领取时间作为保守估计（从账户创建开始计算收益）
        console.log(`[Earnings] ⚠️ No token events found for ${addr}, using first claim time`);
        const firstClaimIso = firstClaim.created_at;
        const { error: updateErr } = await supabase
          .from('users')
          .update({ last_settlement_time: firstClaimIso })
          .eq('address', addr);
        
        if (!updateErr) {
          lastSettlementTime = new Date(firstClaimIso).getTime();
          console.log(`[Earnings] ✅ Set last_settlement_time to first claim time: ${firstClaimIso}`);
          if (hasExternalTransfer) {
            console.log(`[Earnings] 📝 Note: User has external transfers, but earnings will be calculated from account creation time as per business rules.`);
          }
        }
      }
    } catch (error: any) {
      console.warn(`[Earnings] ⚠️ Error initializing last_settlement_time for ${addr}:`, error?.message || error);
      // 继续使用原来的时间，不影响收益计算
    }
  }
  
  // 🔒 P0级修复：持币生息最低门槛验证
  // 只有余额 >= 10,000 RAT 才能产生收益
  // 如果余额 < 10,000，增量收益必须为 0（即使有历史脏数据）
  const MIN_BALANCE_FOR_EARNINGS = 10000;
  
  // 计算从上次结算到现在的天数（不取整，保留小数）
  const timeElapsedMs = now - lastSettlementTime;
  const daysElapsed = timeElapsedMs / (24 * 3600 * 1000); // 精确到毫秒的天数

  // 计算增量收益 = Balance * 0.01 * Rate * Days（不取整）
  const TOKEN_PRICE = 0.01; // $0.01 per RAT
  let incrementalEarnings = 0;
  
  // 🔒 P0级修复：只有余额 >= 10,000 RAT 才能计算增量收益
  if (balance >= MIN_BALANCE_FOR_EARNINGS) {
    incrementalEarnings = balance * TOKEN_PRICE * (dailyRate / 100) * daysElapsed;
  } else {
    // 余额 < 10,000，不产生收益
    console.warn(`[Earnings] ⚠️ 用户 ${addr} 余额 ${balance.toFixed(2)} RAT < ${MIN_BALANCE_FOR_EARNINGS} RAT，不计算增量收益`);
  }

  // 🔒 关键安全修复：最大收益熔断限制（防止 Sybil Attack 和计算错误）
  // 理论最大值 = 当前余额 * 最高利率(10%) * (当前时间 - 账户创建时间)
  // 如果计算的收益超过理论最大值，说明可能存在时间回溯错误或攻击
  const accountCreatedTime = new Date(firstClaim.created_at).getTime();
  const maxPossibleDays = (now - accountCreatedTime) / (24 * 3600 * 1000);
  const MAX_DAILY_RATE = 0.10; // 最高日利率 10%（VIP 4）
  const theoreticalMaxEarnings = balance * TOKEN_PRICE * MAX_DAILY_RATE * maxPossibleDays;
  
  if (incrementalEarnings > theoreticalMaxEarnings) {
    console.error(`[Earnings] 🚨 收益计算异常：增量收益超过理论最大值`);
    console.error(`   计算的增量收益: ${incrementalEarnings.toFixed(6)} USDT`);
    console.error(`   理论最大值: ${theoreticalMaxEarnings.toFixed(6)} USDT`);
    console.error(`   账户创建时间: ${new Date(accountCreatedTime).toISOString()}`);
    console.error(`   当前时间: ${new Date(now).toISOString()}`);
    console.error(`   时间差: ${maxPossibleDays.toFixed(2)} 天`);
    console.error(`   🔒 安全措施: 将增量收益限制为理论最大值`);
    
    // 限制增量收益为理论最大值
    incrementalEarnings = Math.min(incrementalEarnings, theoreticalMaxEarnings);
  }

  // 基准收益（已固化的收益，来自数据库）
  const baseEarnings = Number((userRow as any)?.usdt_total || 0);
  
  // 🔒 P0级修复：区分"管理员赠送的USDT"和"持币生息收益"
  // 问题：之前的逻辑会将管理员赠送的USDT也过滤掉，导致前端不显示
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
    console.warn(`[Earnings] ⚠️ 查询管理员操作记录失败: ${error?.message || error}`);
    // 查询失败不影响收益计算，继续使用 baseEarnings
  }
  
  // 2. 计算持币生息产生的收益（baseEarnings - 管理员赠送的USDT）
  // 注意：如果用户提现了部分管理员赠送的USDT，这里计算的是"剩余的管理员赠送USDT"
  // 实际持币生息收益 = baseEarnings - (管理员赠送总额 - 已提现的管理员赠送部分)
  // 简化处理：假设 baseEarnings 中包含了剩余的管理员赠送USDT
  // 如果 baseEarnings >= adminGiftedUsdt，说明有持币生息收益
  // 如果 baseEarnings < adminGiftedUsdt，说明用户提现了部分管理员赠送的USDT
  const earningsFromHolding = Math.max(0, baseEarnings - adminGiftedUsdt);
  
  // 3. 验证持币生息收益（需要最低门槛）
  let validEarningsFromHolding = earningsFromHolding;
  
  // 情况1：当前余额 < 10,000，持币生息收益视为0
  if (balance < MIN_BALANCE_FOR_EARNINGS && earningsFromHolding > 0) {
    console.warn(`[Earnings] ⚠️ 检测到非法持币生息收益（脏数据）: 用户 ${addr}`);
    console.warn(`   当前余额: ${balance.toFixed(2)} RAT < ${MIN_BALANCE_FOR_EARNINGS} RAT`);
    console.warn(`   持币生息收益（脏数据）: ${earningsFromHolding.toFixed(6)} USDT`);
    console.warn(`   🔒 安全措施: 将持币生息收益视为 0，但保留管理员赠送的USDT`);
    validEarningsFromHolding = 0;
  }
  // 情况2：系统记录余额 < 10,000（即使当前余额 >= 10,000，可能是外部转账）
  else if (hasExternalTransfer && systemRecordedBalance > 0 && systemRecordedBalance < MIN_BALANCE_FOR_EARNINGS && earningsFromHolding > 0) {
    console.warn(`[Earnings] ⚠️ 检测到非法持币生息收益（脏数据）: 用户 ${addr}`);
    console.warn(`   系统记录余额: ${systemRecordedBalance.toFixed(2)} RAT < ${MIN_BALANCE_FOR_EARNINGS} RAT`);
    console.warn(`   当前余额: ${balance.toFixed(2)} RAT（包含外部转账）`);
    console.warn(`   持币生息收益（脏数据）: ${earningsFromHolding.toFixed(6)} USDT`);
    console.warn(`   🔒 安全措施: 系统记录余额 < 10,000，持币生息收益视为脏数据，但保留管理员赠送的USDT`);
    validEarningsFromHolding = 0;
  }
  
  // 4. 管理员赠送的USDT始终有效（不受最低门槛限制）
  // 注意：如果用户提现了部分管理员赠送的USDT，adminGiftedUsdt 是总额，baseEarnings 是剩余值
  // 所以实际可用的管理员赠送USDT = min(adminGiftedUsdt, baseEarnings)
  // 但为了简化，我们假设 baseEarnings 中已经扣除了提现部分
  // 如果 baseEarnings < adminGiftedUsdt，说明用户提现了部分，剩余的管理员赠送USDT = baseEarnings
  const validAdminGiftedUsdt = Math.min(adminGiftedUsdt, baseEarnings);
  
  // 5. 计算有效的基准收益 = 管理员赠送的USDT + 有效的持币生息收益
  const validBaseEarnings = validAdminGiftedUsdt + validEarningsFromHolding;
  
  // 调试日志
  if (adminGiftedUsdt > 0) {
    console.log(`[Earnings] 用户 ${addr} 管理员赠送USDT分析:`);
    console.log(`   管理员赠送总额: ${adminGiftedUsdt.toFixed(6)} USDT`);
    console.log(`   当前 baseEarnings: ${baseEarnings.toFixed(6)} USDT`);
    console.log(`   持币生息收益: ${earningsFromHolding.toFixed(6)} USDT`);
    console.log(`   有效持币生息收益: ${validEarningsFromHolding.toFixed(6)} USDT`);
    console.log(`   有效管理员赠送USDT: ${validAdminGiftedUsdt.toFixed(6)} USDT`);
    console.log(`   有效基准收益: ${validBaseEarnings.toFixed(6)} USDT`);
  }

  // 实时总收益 = 合法基准收益 + 增量收益
  const grossEarnings = validBaseEarnings + incrementalEarnings;

  // 计算持币天数（用于显示，从首次领取开始计算）
  const startTime = new Date(firstClaim.created_at).getTime();
  const daysHolding = Math.max(0, (now - startTime) / (24 * 3600 * 1000)); // 不取整，保留小数

  // 🟢 方案2修复：usdt_total 作为"当前余额"，不需要查询 withdrawals 表
  // 提现时已经从 usdt_total 扣除了金额，所以这里不需要再减去 totalWithdrawn
  // 步骤 6: 计算当前可领收益 = 实时总收益（余额 + 增量）
  const netEarnings = Math.max(0, grossEarnings);

  // 调试日志：记录计算过程（流式秒级结算）
  console.log(`[Earnings] User ${addr}: balance=${balance.toFixed(2)} RAT, validBaseEarnings=${validBaseEarnings.toFixed(6)} (原始: ${baseEarnings.toFixed(6)}), incrementalEarnings=${incrementalEarnings.toFixed(6)}, grossEarnings=${grossEarnings.toFixed(6)}, netEarnings=${netEarnings.toFixed(6)}`);

  // 🟢 移除：不再异步更新 usdt_total（Lazy Settle：只在提现时固化）
  // 这样可以避免频繁的数据库写入，提高性能

  return {
    pendingUsdt: netEarnings.toFixed(6), // 🟢 改为6位小数，支持秒级精度
    dailyRate: dailyRate * 100, // 转换为百分比（例如 0.02 -> 2）
    currentTier,
    holdingDays: Math.floor(daysHolding), // 显示时取整
    balance: balance.toFixed(2),
    grossEarnings: grossEarnings.toFixed(6), // 🟢 改为6位小数
    totalWithdrawn: '0', // 🟢 方案2修复：不再统计 totalWithdrawn，直接返回 '0'
  };
}

// 🟢 已移除：updateUserUsdtTotal 函数
// 原因：实现 Lazy Settle（按需结算），只在提现时才固化收益到数据库
// 这样可以避免频繁的数据库写入，提高性能
