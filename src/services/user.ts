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
    minEnergyToWithdraw: 50,
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
    .select('amount_wei')
    .eq('referrer_address', addr);

  if (error) throw error;

  const totalWei = (data || []).reduce((acc: bigint, row: any) => acc + BigInt(row.amount_wei), 0n);
  const totalRewards = ethers.utils.formatEther(totalWei.toString());

  return {
    address: addr,
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
 * @returns 邀请记录数组
 */
export async function getReferralHistory(address: string) {
  const addr = address.toLowerCase();

  // 从 claims 表查询，找到所有 referrer = address 的记录（即被该用户邀请的人）
  // 按时间升序排序，确保去重时保留第一次领取的记录
  const { data, error } = await supabase
    .from('claims')
    .select('address,created_at')
    .eq('referrer', addr)
    .order('created_at', { ascending: true })
    .limit(100);

  if (error) throw error;

  // 去重：同一个被邀请人可能多次领取，只返回第一次（最早的记录）
  const uniqueAddresses = new Map<string, any>();
  (data || []).forEach((row: any) => {
    const invitedAddr = (row.address || '').toLowerCase();
    if (invitedAddr && !uniqueAddresses.has(invitedAddr)) {
      uniqueAddresses.set(invitedAddr, {
        address: invitedAddr,
        energy: 5, // 每次邀请成功 +5 能量
        createdAt: row.created_at || new Date().toISOString(),
      });
    }
  });

  // 按创建时间降序返回（最新的在前）
  return Array.from(uniqueAddresses.values()).sort((a, b) => {
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}


