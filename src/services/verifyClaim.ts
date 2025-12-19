import { ethers } from 'ethers';
import { AIRDROP_ABI } from '../infra/abis.js';
import { config } from '../config.js';
import { supabase } from '../infra/supabase.js';
import { ApiError } from '../api/errors.js';

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let t: any;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((resolve) => {
      t = setTimeout(() => resolve(fallback), ms);
    }),
  ]);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isTransientRpcError(e: any): boolean {
  const code = e?.error?.code ?? e?.code;
  const msg = String(e?.error?.message || e?.message || '').toLowerCase();
  return (
    code === -32005 ||
    msg.includes('limit exceeded') ||
    msg.includes('rate') ||
    msg.includes('too many') ||
    msg.includes('timeout') ||
    msg.includes('network error') ||
    msg.includes('header not found') ||
    msg.includes('connection')
  );
}

async function retryRpc<T>(fn: () => Promise<T>, opts?: { attempts?: number; baseDelayMs?: number; timeoutMs?: number }) {
  const attempts = opts?.attempts ?? 5;
  const baseDelayMs = opts?.baseDelayMs ?? 800;
  const timeoutMs = opts?.timeoutMs ?? 8000;
  let lastErr: any = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await withTimeout(fn(), timeoutMs, null as any);
      if (res === null) throw new Error('RPC_TIMEOUT');
      return res as T;
    } catch (e: any) {
      lastErr = e;
      if (i >= attempts || !isTransientRpcError(e)) break;
      await sleep(baseDelayMs * i);
    }
  }
  throw lastErr;
}

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

async function awardEnergyOnceForTx(address: string, txHash: string) {
  const addr = address.toLowerCase();
  const hash = txHash.toLowerCase();

  // Set claims.energy_awarded=true only once; only then increment energy_total.
  const { data: updated, error: upErr } = await supabase
    .from('claims')
    .update({ energy_awarded: true })
    .eq('tx_hash', hash)
    .eq('address', addr)
    .eq('energy_awarded', false)
    .select('tx_hash')
    .limit(1);
  if (upErr) throw upErr;
  if (!updated || updated.length === 0) return { ok: true, awarded: false };

  await addEnergyOnSuccessfulClaim(addr);
  return { ok: true, awarded: true };
}

export async function verifyClaim(params: { provider: ethers.providers.Provider; address: string; txHash: string; referrer: string }) {
  const address = params.address.toLowerCase();
  const txHash = params.txHash;
  const expectedTo = config.airdropContract;

  // idempotent: return existing claim if exists
  const { data: existing, error: exErr } = await supabase.from('claims').select('tx_hash,amount_wei,block_number,block_time').eq('tx_hash', txHash).maybeSingle();
  if (exErr) throw exErr;
  if (existing) {
    // Even if claim exists, still ensure user exists and energy awarded (idempotent).
    await ensureUserRow(address, params.referrer);
    await awardEnergyOnceForTx(address, txHash);
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

  const tx = await retryRpc(() => params.provider.getTransaction(txHash), { attempts: 5, baseDelayMs: 800, timeoutMs: 8000 });
  if (!tx) throw new ApiError('TX_NOT_FOUND', 'Transaction not found', 404);
  if (!tx.to || tx.to.toLowerCase() !== expectedTo) throw new ApiError('INVALID_TX', 'TX_TO_MISMATCH', 400);
  if (!tx.from || tx.from.toLowerCase() !== address) throw new ApiError('INVALID_TX', 'TX_FROM_MISMATCH', 400);

  const receipt = await retryRpc(() => params.provider.getTransactionReceipt(txHash), { attempts: 8, baseDelayMs: 1200, timeoutMs: 8000 });
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
    // Some RPCs can be slow here; don't block the whole claim sync just for a timestamp.
    const block = await withTimeout(params.provider.getBlock(receipt.blockNumber), 1500, null as any);
    blockTimeIso = (block as any)?.timestamp ? new Date(Number((block as any).timestamp) * 1000).toISOString() : null;
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
      energy_awarded: false,
      created_at: new Date().toISOString(),
    },
    { onConflict: 'tx_hash' }
  );
  if (insErr) throw insErr;

  // Ensure user row exists so Admin Panel "用户总数" can increase after first claim.
  await ensureUserRow(address, params.referrer);
  // 能量累积：每次成功领取空投 +1（幂等，不会重复加也不会漏加）
  await awardEnergyOnceForTx(address, txHash);

  return {
    ok: true,
    txHash,
    amount: ethers.utils.formatEther(claimedAmountWei),
    unit: 'RAT',
    blockNumber: receipt.blockNumber,
    blockTime: blockTimeIso,
  };
}


