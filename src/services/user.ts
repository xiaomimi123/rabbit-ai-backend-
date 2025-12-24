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

export async function getClaimsHistory(address: string) {
  const addr = address.toLowerCase();

  try {
    const { data, error } = await supabase
      .from('claims')
      .select('tx_hash, amount_wei, block_number, block_time, created_at, referrer')
      .eq('address', addr)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) {
      console.error('Error fetching claims history:', error);
      return [];
    }

    if (!data || data.length === 0) {
      return [];
    }

    // 获取用户的能量值（从 users 表）
    const { data: userData } = await supabase
      .from('users')
      .select('energy_total, energy_locked')
      .eq('address', addr)
      .maybeSingle();

    const baseEnergy = 1; // 每次领取空投的基础能量值
    const energyPerClaim = Math.max(1, Math.floor((Number(userData?.energy_total || 0) - Number(userData?.energy_locked || 0)) / Math.max(1, data.length)));

    return data.map((row: any) => ({
      txHash: row.tx_hash,
      amount: ethers.utils.formatEther(String(row.amount_wei || '0')),
      energy: energyPerClaim || baseEnergy, // 使用计算出的能量值或基础值
      createdAt: row.created_at || row.block_time,
      time: row.created_at || row.block_time,
    }));
  } catch (error: any) {
    console.error('Error in getClaimsHistory:', error);
    return [];
  }
}

export async function getReferralHistory(address: string) {
  const addr = address.toLowerCase();

  try {
    // 获取所有通过此地址邀请的用户
    const { data, error } = await supabase
      .from('claims')
      .select('address, created_at')
      .eq('referrer', addr)
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) {
      console.error('Error fetching referral history:', error);
      return [];
    }

    if (!data || data.length === 0) {
      return [];
    }

    // 去重并获取每个被邀请用户的能量值
    const uniqueAddresses = Array.from(new Set((data || []).map((r: any) => String(r.address).toLowerCase())));
    
    const referralList = await Promise.all(
      uniqueAddresses.slice(0, 100).map(async (inviteeAddr) => {
        // 获取被邀请用户的能量值（从 users 表）
        const { data: userData } = await supabase
          .from('users')
          .select('energy_total, energy_locked')
          .eq('address', inviteeAddr)
          .maybeSingle();

        const energy = Math.max(5, Math.floor((Number(userData?.energy_total || 0) - Number(userData?.energy_locked || 0)) / Math.max(1, data.filter((r: any) => String(r.address).toLowerCase() === inviteeAddr).length)));

        // 获取首次邀请时间
        const firstClaim = (data || []).find((r: any) => String(r.address).toLowerCase() === inviteeAddr);
        
        return {
          address: inviteeAddr,
          energy: energy || 5, // 默认5能量
          createdAt: firstClaim?.created_at || new Date().toISOString(),
          time: firstClaim?.created_at || new Date().toISOString(),
        };
      })
    );

    return referralList;
  } catch (error: any) {
    console.error('Error in getReferralHistory:', error);
    return [];
  }
}


