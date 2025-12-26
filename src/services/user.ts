import { ethers } from 'ethers';
import { supabase } from '../infra/supabase.js';

export async function getUserInfo(address: string) {
  const addr = address.toLowerCase();

  const { data, error } = await supabase
    .from('users')
    .select('address,invite_count,referrer_address,energy_total,energy_locked,usdt_total,usdt_locked,updated_at')
    .eq('address', addr)
    .maybeSingle();

  if (error) throw error;

  const inviteCount = Number((data as any)?.invite_count || 0);
  const energyTotal = Number((data as any)?.energy_total || 0);
  const energyLocked = Number((data as any)?.energy_locked || 0);
  const energy = Math.max(0, energyTotal - energyLocked);

  const usdtTotal = Number((data as any)?.usdt_total || 0);
  const usdtLocked = Number((data as any)?.usdt_locked || 0);
  const usdtAvailable = Math.max(0, usdtTotal - usdtLocked);

  return {
    address: addr,
    energy,
    energyTotal,
    energyLocked,
    minEnergyToWithdraw: 30, // ✅ 已修复：从 50 改为 30
    usdtAvailable,
    usdtTotal,
    usdtLocked,
    inviteCount,
    referrer: (data as any)?.referrer_address || '0x0000000000000000000000000000000000000000',
    updatedAt: (data as any)?.updated_at || new Date().toISOString(),
  };
}

export async function getTeamRewards(address: string) {
  const addr = address.toLowerCase();

  const { data, error } = await supabase
    .from('referral_rewards')
    .select('amount_wei,created_at')
    .eq('referrer_address', addr)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[getTeamRewards] Database error:', error);
    throw error;
  }

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

  console.log('[getTeamRewards] Calculated team rewards:', {
    address: addr,
    recordCount: data?.length || 0,
    totalRewards,
  });

  return {
    totalRewards,
    unit: 'RAT',
    updatedAt: new Date().toISOString(),
  };
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

  // 从 claims 表查询，找到所有 referrer = address 的记录（即被该用户邀请的人）
  // 用于获取被邀请人的地址和首次领取时间
  const { data: claimsData, error: claimsError } = await supabase
    .from('claims')
    .select('tx_hash,address,amount_wei,created_at')
    .eq('referrer', addr)
    .order('created_at', { ascending: true })
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

  // 去重：同一个被邀请人可能多次领取，只返回第一次（最早的记录）
  // 同时关联奖励金额
  const uniqueAddresses = new Map<string, any>();
  (claimsData || []).forEach((row: any) => {
    const invitedAddr = (row.address || '').toLowerCase();
    const txHash = (row.tx_hash || '').toLowerCase();
    
    if (invitedAddr && !uniqueAddresses.has(invitedAddr)) {
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
      
      uniqueAddresses.set(invitedAddr, {
        address: invitedAddr,
        energy: 5, // 每次邀请成功 +5 能量
        rewardAmount: rewardWeiStr ? ethers.utils.formatEther(rewardWeiStr) : '0', // 奖励金额（RAT）
        createdAt: row.created_at || new Date().toISOString(),
        txHash: row.tx_hash,
      });
    }
  });

  // 按创建时间降序返回（最新的在前）
  return Array.from(uniqueAddresses.values()).sort((a, b) => {
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}
