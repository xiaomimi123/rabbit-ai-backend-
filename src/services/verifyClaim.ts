import { ethers } from 'ethers';
import { AIRDROP_ABI } from '../infra/abis.js';
import { config } from '../config.js';
import { supabase } from '../infra/supabase.js';
import { ApiError } from '../api/errors.js';

async function ensureUserRow(address: string, referrer: string) {
  const addr = address.toLowerCase();
  const ref = (referrer || '0x0000000000000000000000000000000000000000').toLowerCase();

  const { data, error } = await supabase
    .from('users')
    .select('address,referrer_address,invite_count,energy_total,energy_locked,created_at')
    .eq('address', addr)
    .maybeSingle();
  if (error) throw error;

  const createdAt = (data as any)?.created_at || new Date().toISOString();
  const existingRef = String((data as any)?.referrer_address || '').toLowerCase();
  const nextRef = existingRef || (ref !== '0x0000000000000000000000000000000000000000' ? ref : null);

  // Upsert is idempotent; only fills referrer_address if empty.
  const { error: upErr } = await supabase.from('users').upsert(
    {
      address: addr,
      referrer_address: nextRef,
      invite_count: Number((data as any)?.invite_count || 0),
      energy_total: Number((data as any)?.energy_total || 0),
      energy_locked: Number((data as any)?.energy_locked || 0),
      created_at: createdAt,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'address' }
  );
  if (upErr) throw upErr;
}

async function addEnergyOnSuccessfulClaim(address: string) {
  const addr = address.toLowerCase();
  const { data, error } = await supabase
    .from('users')
    .select('energy_total,energy_locked,created_at')
    .eq('address', addr)
    .maybeSingle();
  if (error) throw error;

  const createdAt = (data as any)?.created_at || new Date().toISOString();
  const energyTotal = Number((data as any)?.energy_total || 0);
  const energyLocked = Number((data as any)?.energy_locked || 0);
  const nextTotal = energyTotal + 1; // 每成功领取一次空投，能量 +1

  const { error: upErr } = await supabase.from('users').upsert(
    { address: addr, energy_total: nextTotal, energy_locked: energyLocked, updated_at: new Date().toISOString(), created_at: createdAt },
    { onConflict: 'address' }
  );
  if (upErr) throw upErr;
}

export async function verifyClaim(params: { provider: ethers.providers.Provider; address: string; txHash: string; referrer: string }) {
  const address = params.address.toLowerCase();
  const txHash = params.txHash;
  const expectedTo = config.airdropContract;

  // idempotent: return existing claim if exists
  const { data: existing, error: exErr } = await supabase.from('claims').select('tx_hash,amount_wei,block_number,block_time').eq('tx_hash', txHash).maybeSingle();
  if (exErr) throw exErr;
  if (existing) {
    return {
      ok: true,
      txHash,
      amount: ethers.utils.formatEther((existing as any).amount_wei),
      unit: 'RAT',
      blockNumber: Number((existing as any).block_number || 0),
      blockTime: (existing as any).block_time,
      duplicated: true,
    };
  }

  const tx = await params.provider.getTransaction(txHash);
  if (!tx) throw new ApiError('TX_NOT_FOUND', 'Transaction not found', 404);
  if (!tx.to || tx.to.toLowerCase() !== expectedTo) throw new ApiError('INVALID_TX', 'TX_TO_MISMATCH', 400);
  if (!tx.from || tx.from.toLowerCase() !== address) throw new ApiError('INVALID_TX', 'TX_FROM_MISMATCH', 400);

  const receipt = await params.provider.getTransactionReceipt(txHash);
  if (!receipt) throw new ApiError('TX_NOT_FOUND', 'Receipt not found', 404);
  if (receipt.status !== 1) throw new ApiError('TX_FAILED', 'Transaction failed', 400);

  const iface = new ethers.utils.Interface(AIRDROP_ABI);
  let claimedAmountWei: string | null = null;
  for (const log of receipt.logs) {
    if (!log.address || log.address.toLowerCase() !== expectedTo) continue;
    try {
      const parsed = iface.parseLog(log);
      if (parsed.name === 'Claimed') {
        const user = String(parsed.args.user).toLowerCase();
        if (user === address) {
          claimedAmountWei = (parsed.args.amount as ethers.BigNumber).toString();
          break;
        }
      }
    } catch {
      // ignore
    }
  }
  if (!claimedAmountWei) throw new ApiError('INVALID_TX', 'EVENT_NOT_FOUND', 400);

  // block time (best effort)
  let blockTimeIso: string | null = null;
  try {
    const block = await params.provider.getBlock(receipt.blockNumber);
    blockTimeIso = block?.timestamp ? new Date(block.timestamp * 1000).toISOString() : null;
  } catch {
    blockTimeIso = null;
  }

  // upsert claim (tx_hash unique)
  const { error: insErr } = await supabase.from('claims').upsert(
    {
      tx_hash: txHash,
      address,
      referrer: (params.referrer || '0x0000000000000000000000000000000000000000').toLowerCase(),
      amount_wei: claimedAmountWei,
      block_number: receipt.blockNumber,
      block_time: blockTimeIso,
      status: 'SUCCESS',
      created_at: new Date().toISOString(),
    },
    { onConflict: 'tx_hash' }
  );
  if (insErr) throw insErr;

  // Ensure user row exists so Admin Panel "用户总数" can increase after first claim.
  await ensureUserRow(address, params.referrer);
  // 能量累积：每次成功领取空投 +1（用于提现能量约束）
  await addEnergyOnSuccessfulClaim(address);

  return {
    ok: true,
    txHash,
    amount: ethers.utils.formatEther(claimedAmountWei),
    unit: 'RAT',
    blockNumber: receipt.blockNumber,
    blockTime: blockTimeIso,
  };
}


