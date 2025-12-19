import { ethers } from 'ethers';
import { supabase } from '../infra/supabase.js';

export async function getUserInfo(address: string) {
  const addr = address.toLowerCase();

  const { data, error } = await supabase
    .from('users')
    .select('address,invite_count,referrer_address,energy_total,energy_locked,updated_at')
    .eq('address', addr)
    .maybeSingle();

  if (error) throw error;

  const inviteCount = Number((data as any)?.invite_count || 0);
  const energyTotal = Number((data as any)?.energy_total || 0);
  const energyLocked = Number((data as any)?.energy_locked || 0);
  const energy = Math.max(0, energyTotal - energyLocked);

  return {
    address: addr,
    energy,
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


