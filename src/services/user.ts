import { ethers } from 'ethers';
import { supabase } from '../infra/supabase.js';

export async function getUserInfo(address: string) {
  const addr = address.toLowerCase();

  console.log('[getUserInfo] 查询用户信息:', {
    originalAddress: address,
    normalizedAddress: addr,
    queryAddress: addr,
  });

  const { data, error } = await supabase
    .from('users')
    .select('address,invite_count,referrer_address,energy_total,energy_locked,usdt_total,usdt_locked,updated_at')
    .eq('address', addr)
    .maybeSingle();

  if (error) {
    console.error('[getUserInfo] 数据库查询错误:', error);
    throw error;
  }

  console.log('[getUserInfo] 数据库查询结果:', {
    found: data !== null,
    data: data ? JSON.stringify(data, null, 2) : 'null',
    rawData: data,
  });

  const inviteCount = Number((data as any)?.invite_count || 0);
  const energyTotal = Number((data as any)?.energy_total || 0);
  const energyLocked = Number((data as any)?.energy_locked || 0);
  const energy = Math.max(0, energyTotal - energyLocked);

  const usdtTotal = Number((data as any)?.usdt_total || 0);
  const usdtLocked = Number((data as any)?.usdt_locked || 0);
  const usdtAvailable = Math.max(0, usdtTotal - usdtLocked);

  const result = {
    address: addr,
    energy,
    energyTotal,
    energyLocked,
    // ✅ 已移除：不再有最低能量门槛，只需满足 1 USDT = 10 能量的关系
    usdtAvailable,
    usdtTotal,
    usdtLocked,
    inviteCount,
    referrer: (data as any)?.referrer_address || '0x0000000000000000000000000000000000000000',
    updatedAt: (data as any)?.updated_at || new Date().toISOString(),
  };

  console.log('[getUserInfo] 返回结果:', JSON.stringify(result, null, 2));

  return result;
}

export async function getTeamRewards(address: string) {
  const addr = address.toLowerCase();

  console.log('[getTeamRewards] 查询团队奖励:', {
    originalAddress: address,
    normalizedAddress: addr,
    queryAddress: addr,
  });

  const { data, error } = await supabase
    .from('referral_rewards')
    .select('amount_wei,created_at')
    .eq('referrer_address', addr)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[getTeamRewards] 数据库查询错误:', error);
    throw error;
  }

  console.log('[getTeamRewards] 数据库查询结果:', {
    recordCount: data?.length || 0,
    records: data ? JSON.stringify(data, null, 2) : '[]',
    rawData: data,
  });

  const totalWei = (data || []).reduce((acc: bigint, row: any) => {
    try {
      // 处理 amount_wei：去掉小数点和小数部分（如果有）
      let amountStr = String(row.amount_wei || '0').trim();
      // 如果包含小数点，只取整数部分
      if (amountStr.includes('.')) {
        amountStr = amountStr.split('.')[0];
      }
      // 确保是有效的整数字符串
      if (!/^\d+$/.test(amountStr)) {
        console.warn('[getTeamRewards] Invalid amount_wei format:', row.amount_wei);
        return acc;
      }
      return acc + BigInt(amountStr);
    } catch (e) {
      console.warn('[getTeamRewards] Invalid amount_wei:', row.amount_wei, e);
      return acc;
    }
  }, 0n);
  
  const totalRewards = ethers.utils.formatEther(totalWei.toString());

  const result = {
    totalRewards,
    unit: 'RAT',
    updatedAt: new Date().toISOString(),
  };

  console.log('[getTeamRewards] 返回结果:', JSON.stringify(result, null, 2));

  return result;
}

/**
 * 获取用户空投领取历史
 * @param address 用户钱包地址
 * @returns 空投领取记录数组
 */
export async function getClaimsHistory(address: string) {
  const addr = address.toLowerCase();

  const { data, error } = await supabase
    .from('claims')
    .select('tx_hash,amount_wei,created_at')
    .eq('address', addr)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) throw error;

  return (data || []).map((row: any) => ({
    txHash: row.tx_hash,
    amount: ethers.utils.formatEther(row.amount_wei || '0'),
    energy: 1, // 每次领取空投 +1 能量
    createdAt: row.created_at || new Date().toISOString(),
  }));
}

/**
 * 获取用户邀请历史（作为推荐人）
 * @param address 推荐人钱包地址
 * @returns 邀请记录数组，包含被邀请人地址、奖励金额、时间等
 */
export async function getReferralHistory(address: string) {
  const addr = address.toLowerCase();

  // 从 referral_rewards 表查询，获取所有推荐奖励记录
  // 这个表记录了每次推荐奖励的详细信息，包括奖励金额
  const { data: rewardsData, error: rewardsError } = await supabase
    .from('referral_rewards')
    .select('tx_hash,amount_wei,created_at,block_time')
    .eq('referrer_address', addr)
    .order('created_at', { ascending: false })
    .limit(100);

  if (rewardsError) throw rewardsError;

  // ✅ 修改：返回所有 claims 记录（不只是第一次），用于显示每次下级领取的能量奖励
  const { data: claimsData, error: claimsError } = await supabase
    .from('claims')
    .select('tx_hash,address,amount_wei,created_at')
    .eq('referrer', addr)
    .order('created_at', { ascending: false })
    .limit(100);

  if (claimsError) throw claimsError;

  // 创建奖励金额映射：tx_hash -> amount_wei
  const rewardMap = new Map<string, string>();
  (rewardsData || []).forEach((row: any) => {
    // 处理 amount_wei：去掉小数点（如果有）
    let amountWei = String(row.amount_wei || '0').trim();
    if (amountWei.includes('.')) {
      amountWei = amountWei.split('.')[0];
    }
    rewardMap.set(row.tx_hash.toLowerCase(), amountWei);
  });

  // ✅ 修改：记录每个被邀请人的第一次领取时间，用于计算能量奖励
  const firstClaimMap = new Map<string, string>();
  (claimsData || []).forEach((row: any) => {
    const invitedAddr = (row.address || '').toLowerCase();
    if (invitedAddr && !firstClaimMap.has(invitedAddr)) {
      firstClaimMap.set(invitedAddr, row.created_at || new Date().toISOString());
    }
  });

  // ✅ 修改：返回所有 claims 记录，计算每次的能量奖励
  const result: any[] = [];
  (claimsData || []).forEach((row: any) => {
    const invitedAddr = (row.address || '').toLowerCase();
    const txHash = (row.tx_hash || '').toLowerCase();
    const createdAt = row.created_at || new Date().toISOString();
    
    // 判断是否是第一次领取
    const firstClaimTime = firstClaimMap.get(invitedAddr);
    const isFirstClaim = firstClaimTime === createdAt;
    
    // ✅ 计算能量奖励：第一次领取 = 2（邀请）+ 1（管道）= 3，之后每次 = 1（管道）
    const energyReward = isFirstClaim ? 3 : 1;
    
    // 从 rewardMap 获取奖励金额，如果没有则从 claims 的 amount_wei 计算 10%
    let rewardWei = rewardMap.get(txHash);
    if (!rewardWei && row.amount_wei) {
      // 如果没有在 referral_rewards 表中找到，计算 10%
      let claimAmountStr = String(row.amount_wei || '0').trim();
      // 处理小数点：只取整数部分
      if (claimAmountStr.includes('.')) {
        claimAmountStr = claimAmountStr.split('.')[0];
      }
      const claimAmount = BigInt(claimAmountStr);
      rewardWei = (claimAmount * BigInt(10) / BigInt(100)).toString();
    }
    
    // 处理 rewardWei：确保是整数字符串（去掉小数点）
    let rewardWeiStr = rewardWei || '0';
    if (typeof rewardWeiStr === 'string' && rewardWeiStr.includes('.')) {
      rewardWeiStr = rewardWeiStr.split('.')[0];
    }
    
    result.push({
      address: invitedAddr,
      energy: energyReward, // ✅ 动态计算能量奖励
      rewardAmount: rewardWeiStr ? ethers.utils.formatEther(rewardWeiStr) : '0', // 奖励金额（RAT）
      createdAt: createdAt,
      txHash: row.tx_hash,
      isFirstClaim: isFirstClaim, // 标记是否是第一次领取
    });
  });

  // 按创建时间降序返回（最新的在前）
  return result.sort((a, b) => {
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}
