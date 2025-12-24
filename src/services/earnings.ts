import { ethers } from 'ethers';
import { supabase } from '../infra/supabase.js';
import { config } from '../config.js';
import { ERC20_ABI } from '../infra/abis.js';

const RAT_PRICE_USDT = 0.01; // 1 RAT = 0.01 USDT

// 获取用户 RAT 余额（从链上读取）
export async function getRatBalance(address: string, provider: ethers.providers.Provider): Promise<{ balance: string }> {
  const addr = address.toLowerCase();
  
  if (!config.ratTokenContract) {
    console.warn('RAT_TOKEN_CONTRACT is not configured, returning 0 balance');
    return { balance: '0' };
  }

  try {
    const ratContract = new ethers.Contract(config.ratTokenContract, ERC20_ABI, provider);
    const balanceWei = await ratContract.balanceOf(addr);
    const decimals = await ratContract.decimals();
    const balance = ethers.utils.formatUnits(balanceWei, decimals);

    // 更新或创建 user_holdings 记录（如果 Supabase 可用）
    try {
      const { data: existing } = await supabase
        .from('user_holdings')
        .select('first_hold_time')
        .eq('address', addr)
        .maybeSingle();

      const firstHoldTime = existing?.first_hold_time || (parseFloat(balance) > 0 ? new Date().toISOString() : null);

      await supabase
        .from('user_holdings')
        .upsert({
          address: addr,
          rat_balance: balance,
          first_hold_time: firstHoldTime,
          last_updated: new Date().toISOString(),
        }, { onConflict: 'address' });
    } catch (dbError) {
      // 数据库操作失败不影响返回余额
      console.warn('Failed to update user_holdings:', dbError);
    }

    return { balance };
  } catch (error: any) {
    console.error('Failed to fetch RAT balance from chain:', error);
    // 如果链上读取失败，返回 0 而不是抛出错误
    return { balance: '0' };
  }
}

// 获取用户持币生息收益
// 逻辑：用户必须达到 VIP 等级标准才能获得收益，收益从达到等级的时间开始计算
export async function getEarnings(address: string, provider: ethers.providers.Provider): Promise<{
  pendingUsdt: string;
  dailyRate: number;
  currentTier: number;
  holdingDays: number;
}> {
  const addr = address.toLowerCase();

  // 1. 获取用户 RAT 余额
  const { balance } = await getRatBalance(addr, provider);
  const ratBalance = parseFloat(balance);

  // 2. 获取 VIP 等级配置
  const { data: tiers, error: tiersErr } = await supabase
    .from('vip_tiers')
    .select('*')
    .eq('is_active', true)
    .order('display_order', { ascending: true });

  if (tiersErr) throw tiersErr;

  // 3. 匹配当前等级
  let currentTier = null as any;
  for (const tier of (tiers || [])) {
    const minBalance = Number(tier.min_balance);
    const maxBalance = tier.max_balance === null ? Infinity : Number(tier.max_balance);
    
    if (ratBalance >= minBalance && ratBalance <= maxBalance) {
      currentTier = tier;
      break;
    }
  }

  // 4. 获取用户持币记录（包含等级相关信息）
  const { data: holding } = await supabase
    .from('user_holdings')
    .select('first_hold_time, current_tier_level, tier_reached_at')
    .eq('address', addr)
    .maybeSingle();

  // 5. 如果用户不符合任何 VIP 等级标准，返回收益为 0
  if (!currentTier) {
    // 清除等级记录（如果之前有）
    if (holding?.current_tier_level !== null) {
      await supabase
        .from('user_holdings')
        .update({
          current_tier_level: null,
          tier_reached_at: null,
          last_updated: new Date().toISOString(),
        })
        .eq('address', addr);
    }
    
    return {
      pendingUsdt: '0',
      dailyRate: 0,
      currentTier: 0,
      holdingDays: 0,
    };
  }

  // 6. 用户符合 VIP 等级标准，处理等级变化和收益计算
  const now = new Date();
  const nowTime = now.getTime();
  let tierReachedAt: string | null = null;
  let shouldUpdateTier = false;

  // 6.1 检查用户是否首次达到等级，或等级发生变化
  if (!holding?.tier_reached_at) {
    // 首次达到等级，记录当前时间
    tierReachedAt = now.toISOString();
    shouldUpdateTier = true;
  } else if (holding.current_tier_level !== currentTier.level) {
    // 等级发生变化
    if (currentTier.level > (holding.current_tier_level || 0)) {
      // 升级：从达到新等级的时间开始计算
      tierReachedAt = now.toISOString();
      shouldUpdateTier = true;
    } else {
      // 降级：继续使用原来的达到时间（但这种情况理论上不应该发生，因为不符合等级标准时已经返回了）
      tierReachedAt = holding.tier_reached_at;
      shouldUpdateTier = true;
    }
  } else {
    // 等级未变化，继续使用原来的达到时间
    tierReachedAt = holding.tier_reached_at;
  }

  // 6.2 更新数据库中的等级信息
  if (shouldUpdateTier) {
    await supabase
      .from('user_holdings')
      .update({
        current_tier_level: currentTier.level,
        tier_reached_at: tierReachedAt,
        last_updated: now.toISOString(),
      })
      .eq('address', addr);
  }

  // 7. 计算从达到等级时间到现在的天数
  if (!tierReachedAt) {
    // 理论上不应该到这里，但为了安全起见
    return {
      pendingUsdt: '0',
      dailyRate: 0,
      currentTier: 0,
      holdingDays: 0,
    };
  }

  const tierReachedTime = new Date(tierReachedAt).getTime();
  const holdingDays = Math.max(1, Math.floor((nowTime - tierReachedTime) / (1000 * 60 * 60 * 24))); // 至少 1 天

  // 8. 计算收益（从达到等级的时间开始计算）
  const dailyRate = Number(currentTier.daily_rate);
  const dailyEarnings = ratBalance * RAT_PRICE_USDT * (dailyRate / 100);
  const totalEarnings = dailyEarnings * holdingDays;

  return {
    pendingUsdt: totalEarnings.toFixed(2),
    dailyRate,
    currentTier: currentTier.level,
    holdingDays,
  };
}

