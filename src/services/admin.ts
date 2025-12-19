import { ethers } from 'ethers';
import { supabase } from '../infra/supabase.js';
import { config } from '../config.js';
import { ApiError } from '../api/errors.js';
import { AIRDROP_ABI, ERC20_ABI } from '../infra/abis.js';

function lower(addr: string) {
  return (addr || '').toLowerCase();
}

async function getSystemConfig<T = any>(key: string): Promise<T | null> {
  const { data, error } = await supabase.from('system_config').select('key,value').eq('key', key).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return (data as any).value as T;
}

async function setSystemConfig(key: string, value: any): Promise<void> {
  const { error } = await supabase.from('system_config').upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw error;
}

export async function adminGetSystemConfig() {
  const { data, error } = await supabase.from('system_config').select('key,value,updated_at').order('key', { ascending: true });
  if (error) throw error;
  return { ok: true, items: (data || []).map((r: any) => ({ key: r.key, value: r.value, updatedAt: r.updated_at })) };
}

export async function adminSetSystemConfig(key: string, value: any) {
  await setSystemConfig(key, value);
  return { ok: true };
}

async function getUsdtContract(): Promise<string | null> {
  const v = await getSystemConfig<{ address?: string }>('usdt');
  const addr = String(v?.address || '').trim();
  if (addr && ethers.utils.isAddress(addr)) return lower(addr);
  if (config.usdtContract && ethers.utils.isAddress(config.usdtContract)) return lower(config.usdtContract);
  return null;
}

async function getAdminPayoutAddress(): Promise<string | null> {
  const v = await getSystemConfig<{ address?: string }>('admin_payout');
  const addr = String(v?.address || '').trim();
  if (addr && ethers.utils.isAddress(addr)) return lower(addr);
  if (config.adminPayoutAddress && ethers.utils.isAddress(config.adminPayoutAddress)) return lower(config.adminPayoutAddress);
  return null;
}

export async function getAdminKpis(provider: ethers.providers.Provider) {
  // users count
  const { count: usersCount, error: usersErr } = await supabase.from('users').select('address', { count: 'exact', head: true });
  if (usersErr) throw usersErr;

  // pending withdraw total
  const { data: pend, error: pendErr } = await supabase.from('withdrawals').select('amount').eq('status', 'Pending');
  if (pendErr) throw pendErr;
  const pendingTotal = (pend || []).reduce((acc: number, r: any) => acc + Number(r.amount || 0), 0);

  // on-chain: airdrop config + fee recipient balance
  const airdrop = new ethers.Contract(config.airdropContract, AIRDROP_ABI, provider);
  const [claimFeeWei, cooldownSec, minReward, maxReward, feeRecipient, tokenAddr] = await Promise.all([
    airdrop.claimFee(),
    airdrop.cooldown(),
    airdrop.minReward(),
    airdrop.maxReward(),
    airdrop.feeRecipient(),
    airdrop.token(),
  ]);

  const feeRecipientBnbWei = await provider.getBalance(feeRecipient);

  // on-chain: TVL (RAT in staking)
  let tvlRat = null as null | { amount: string; symbol: string };
  if (config.ratTokenContract && config.stakingContract) {
    const rat = new ethers.Contract(config.ratTokenContract, ERC20_ABI, provider);
    const [bal, dec, sym] = await Promise.all([rat.balanceOf(config.stakingContract), rat.decimals(), rat.symbol()]);
    tvlRat = { amount: ethers.utils.formatUnits(bal, dec), symbol: sym };
  }

  return {
    ok: true,
    usersTotal: Number(usersCount || 0),
    pendingWithdrawTotal: String(pendingTotal),
    pendingWithdrawUnit: 'USDT',
    airdropFeeRecipient: lower(String(feeRecipient)),
    airdropFeeBalance: ethers.utils.formatEther(feeRecipientBnbWei),
    airdropFeeUnit: 'BNB',
    airdrop: {
      contract: config.airdropContract,
      token: lower(String(tokenAddr)),
      claimFee: ethers.utils.formatEther(claimFeeWei),
      claimFeeUnit: 'BNB',
      cooldownSec: Number(cooldownSec),
      rewardRange: { min: String(minReward), max: String(maxReward) },
    },
    tvl: tvlRat,
    time: new Date().toISOString(),
  };
}

export async function listPendingWithdrawals(limit: number) {
  const { data, error } = await supabase
    .from('withdrawals')
    .select('id,address,amount,status,energy_locked_amount,payout_tx_hash,created_at,updated_at')
    .eq('status', 'Pending')
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) throw error;

  return {
    ok: true,
    items: (data || []).map((r: any) => ({
      id: r.id,
      address: r.address,
      amount: String(r.amount),
      status: r.status,
      energyLockedAmount: String(r.energy_locked_amount || 0),
      payoutTxHash: r.payout_tx_hash,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      alert: Number(r.amount || 0) >= Number(config.withdrawAlertThreshold || 1000),
    })),
  };
}

async function getUserEnergyRow(address: string) {
  const { data, error } = await supabase.from('users').select('energy_total,energy_locked,created_at').eq('address', address).maybeSingle();
  if (error) throw error;
  const energyTotal = Number((data as any)?.energy_total || 0);
  const energyLocked = Number((data as any)?.energy_locked || 0);
  return { energyTotal, energyLocked, createdAt: (data as any)?.created_at || new Date().toISOString() };
}

async function updateUserEnergy(address: string, nextTotal: number, nextLocked: number, createdAt: string) {
  const { error } = await supabase.from('users').upsert(
    { address, energy_total: nextTotal, energy_locked: nextLocked, updated_at: new Date().toISOString(), created_at: createdAt },
    { onConflict: 'address' }
  );
  if (error) throw error;
}

export async function rejectWithdrawal(withdrawalId: string) {
  const { data: w, error: wErr } = await supabase
    .from('withdrawals')
    .select('id,address,amount,status')
    .eq('id', withdrawalId)
    .maybeSingle();
  if (wErr) throw wErr;
  if (!w) throw new ApiError('NOT_FOUND', 'Withdrawal not found', 404);

  if ((w as any).status !== 'Pending') {
    return { ok: true, id: (w as any).id, status: (w as any).status, ignored: true };
  }

  const addr = lower((w as any).address);
  const amount = Number((w as any).amount || 0);

  // unlock energy (do not reduce total)
  const u = await getUserEnergyRow(addr);
  const nextLocked = Math.max(0, u.energyLocked - amount);
  await updateUserEnergy(addr, u.energyTotal, nextLocked, u.createdAt);

  const { error: upErr } = await supabase
    .from('withdrawals')
    .update({ status: 'Rejected', updated_at: new Date().toISOString() })
    .eq('id', withdrawalId);
  if (upErr) throw upErr;

  return { ok: true, id: withdrawalId, status: 'Rejected' };
}

export async function getUsdtInfo(provider: ethers.providers.Provider) {
  const usdtAddr = await getUsdtContract();
  if (!usdtAddr) throw new ApiError('CONFIG_ERROR', 'USDT_CONTRACT is not configured (env or system_config.usdt)', 400);
  const usdt = new ethers.Contract(usdtAddr, ERC20_ABI, provider);
  const [decimals, symbol] = await Promise.all([usdt.decimals(), usdt.symbol()]);
  return { ok: true, address: usdtAddr, decimals: Number(decimals), symbol };
}

export async function completeWithdrawal(params: {
  provider: ethers.providers.Provider;
  withdrawalId: string;
  payoutTxHash: string;
}) {
  const usdtAddr = await getUsdtContract();
  const adminPayout = await getAdminPayoutAddress();
  if (!usdtAddr) throw new ApiError('CONFIG_ERROR', 'USDT_CONTRACT is not configured (env or system_config.usdt)', 400);
  if (!adminPayout) throw new ApiError('CONFIG_ERROR', 'ADMIN_PAYOUT_ADDRESS is not configured (env or system_config.admin_payout)', 400);

  const { data: w, error: wErr } = await supabase
    .from('withdrawals')
    .select('id,address,amount,status,payout_tx_hash')
    .eq('id', params.withdrawalId)
    .maybeSingle();
  if (wErr) throw wErr;
  if (!w) throw new ApiError('NOT_FOUND', 'Withdrawal not found', 404);

  const status = String((w as any).status);
  if (status === 'Completed') {
    return { ok: true, id: (w as any).id, status, duplicated: true, payoutTxHash: (w as any).payout_tx_hash };
  }
  if (status !== 'Pending') throw new ApiError('INVALID_STATE', `Withdrawal status is ${status}`, 400);

  const userAddr = lower((w as any).address);
  const amount = String((w as any).amount);

  // Verify payout tx on-chain: USDT Transfer(admin -> user, value == amount)
  const usdt = new ethers.Contract(usdtAddr, ERC20_ABI, params.provider);
  const decimals = Number(await usdt.decimals());
  const expectedValue = ethers.utils.parseUnits(amount, decimals);

  const receipt = await params.provider.getTransactionReceipt(params.payoutTxHash);
  if (!receipt) throw new ApiError('TX_NOT_FOUND', 'Payout tx receipt not found', 404);
  if (receipt.status !== 1) throw new ApiError('TX_FAILED', 'Payout tx failed', 400);

  const iface = new ethers.utils.Interface(ERC20_ABI);
  let matched = false;
  for (const log of receipt.logs) {
    if (!log.address || lower(log.address) !== lower(usdtAddr)) continue;
    try {
      const parsed = iface.parseLog(log);
      if (parsed.name !== 'Transfer') continue;
      const from = lower(parsed.args.from);
      const to = lower(parsed.args.to);
      const value = parsed.args.value as ethers.BigNumber;
      if (from === lower(adminPayout) && to === userAddr && value.eq(expectedValue)) {
        matched = true;
        break;
      }
    } catch {
      // ignore
    }
  }
  if (!matched) throw new ApiError('INVALID_PAYOUT', 'USDT Transfer not matched (from/to/value)', 400);

  // Update DB: withdrawal completed + adjust energy
  const u = await getUserEnergyRow(userAddr);
  const amtNum = Number(amount);
  const nextLocked = Math.max(0, u.energyLocked - amtNum);
  const nextTotal = Math.max(0, u.energyTotal - amtNum);
  await updateUserEnergy(userAddr, nextTotal, nextLocked, u.createdAt);

  const { error: upErr } = await supabase
    .from('withdrawals')
    .update({ status: 'Completed', payout_tx_hash: params.payoutTxHash, updated_at: new Date().toISOString() })
    .eq('id', params.withdrawalId);
  if (upErr) throw upErr;

  return { ok: true, id: params.withdrawalId, status: 'Completed', payoutTxHash: params.payoutTxHash, verified: true };
}

export async function adminGetUser(provider: ethers.providers.Provider, address: string) {
  const addr = lower(address);

  const { data: user, error: uErr } = await supabase
    .from('users')
    .select('address,referrer_address,invite_count,energy_total,energy_locked,created_at,updated_at')
    .eq('address', addr)
    .maybeSingle();
  if (uErr) throw uErr;

  const { data: claims, error: cErr } = await supabase
    .from('claims')
    .select('tx_hash,referrer,amount_wei,block_number,block_time,created_at')
    .eq('address', addr)
    .order('created_at', { ascending: false })
    .limit(20);
  if (cErr) throw cErr;

  const { data: withdrawals, error: wErr } = await supabase
    .from('withdrawals')
    .select('id,amount,status,payout_tx_hash,created_at')
    .eq('address', addr)
    .order('created_at', { ascending: false })
    .limit(20);
  if (wErr) throw wErr;

  // invitees: distinct claimers whose referrer == addr
  const { data: inviteeClaims, error: iErr } = await supabase
    .from('claims')
    .select('address,created_at')
    .eq('referrer', addr)
    .order('created_at', { ascending: false })
    .limit(200);
  if (iErr) throw iErr;
  const invitees = Array.from(new Set((inviteeClaims || []).map((r: any) => String(r.address)))).slice(0, 50);

  // airdrop contract snapshot
  const airdrop = new ethers.Contract(config.airdropContract, AIRDROP_ABI, provider);
  const [lastClaimTime, inviteCountOnchain] = await Promise.all([
    airdrop.lastClaimTime(addr).catch(() => 0),
    airdrop.inviteCount(addr).catch(() => 0),
  ]);

  return {
    ok: true,
    user: user
      ? {
          address: (user as any).address,
          referrer: (user as any).referrer_address,
          inviteCount: String((user as any).invite_count || 0),
          energyTotal: String((user as any).energy_total || 0),
          energyLocked: String((user as any).energy_locked || 0),
          createdAt: (user as any).created_at,
          updatedAt: (user as any).updated_at,
        }
      : null,
    claims: (claims || []).map((r: any) => ({
      txHash: r.tx_hash,
      referrer: r.referrer,
      amount: ethers.utils.formatEther(String(r.amount_wei)),
      unit: 'RAT',
      blockNumber: r.block_number,
      blockTime: r.block_time,
      createdAt: r.created_at,
    })),
    withdrawals: (withdrawals || []).map((r: any) => ({
      id: r.id,
      amount: String(r.amount),
      status: r.status,
      payoutTxHash: r.payout_tx_hash,
      createdAt: r.created_at,
    })),
    invitees,
    onchain: {
      lastClaimTime: Number(lastClaimTime || 0),
      inviteCount: String(inviteCountOnchain || 0),
    },
  };
}


