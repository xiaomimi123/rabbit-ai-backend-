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
    
    // ✅ 注意：对于已存在的交易，RPC 函数会直接返回 skipped，不会重复计算能量
    // 这里我们只需要确保用户记录存在即可
    // 如果需要修复历史数据，应该运行一次性修复脚本
    
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
  let referralRewardWei: string | null = null;
  let referralRewardReferrer: string | null = null;
  let cooldownResetReferrer: string | null = null;
  
  for (const log of receipt.logs) {
    if (!log.address || log.address.toLowerCase() !== expectedTo) continue;
    try {
      const parsed = iface.parseLog(log);
      if (parsed.name === 'Claimed') {
        const user = String(parsed.args.user).toLowerCase();
        if (user === address) {
          claimedAmountWei = (parsed.args.amount as ethers.BigNumber).toString();
        }
      }
      if (parsed.name === 'ReferralReward') {
        const referrer = String(parsed.args.referrer).toLowerCase();
        referralRewardWei = (parsed.args.amount as ethers.BigNumber).toString();
        referralRewardReferrer = referrer;
      }
      if (parsed.name === 'CooldownReset') {
        const referrer = String(parsed.args.referrer).toLowerCase();
        cooldownResetReferrer = referrer;
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

  // ✅ 使用数据库 RPC 函数进行原子操作，解决并发问题
  console.log(`[verifyClaim] 开始处理交易: ${txHash}, 地址: ${address}, 金额: ${ethers.utils.formatEther(claimedAmountWei)} RAT`);
  
  const { data: rpcResult, error: rpcError } = await supabase.rpc('process_claim_energy', {
    p_tx_hash: txHash,
    p_address: address,
    p_referrer: (params.referrer || '0x0000000000000000000000000000000000000000').toLowerCase(),
    p_amount_wei: claimedAmountWei,
    p_block_number: receipt.blockNumber,
    p_block_time: blockTimeIso || new Date().toISOString()
  });

  if (rpcError) {
    console.error('[verifyClaim] ❌ 数据库 RPC 调用失败:', {
      error: rpcError,
      txHash,
      address,
      blockNumber: receipt.blockNumber,
      message: rpcError.message || String(rpcError),
      code: (rpcError as any)?.code,
      details: (rpcError as any)?.details,
    });
    throw new ApiError('INTERNAL_ERROR', `数据库处理失败: ${rpcError.message || String(rpcError)}`, 500);
  }

  // RPC 函数已经处理了 claim 插入和能量计算
  // data 会返回 { status: 'success' | 'skipped', is_first_claim: boolean }
  if (rpcResult?.status === 'skipped') {
    console.log(`[verifyClaim] ⚠️ 交易已存在，跳过处理: ${txHash}`);
  } else if (rpcResult?.status === 'success') {
    console.log(`[verifyClaim] ✅ 成功处理交易: ${txHash}, 地址: ${address}, 是否首次领取: ${rpcResult?.is_first_claim}`);
  } else {
    console.warn(`[verifyClaim] ⚠️ 未知的 RPC 返回状态:`, rpcResult);
  }

  // Ensure user row exists so Admin Panel "用户总数" can increase after first claim.
  await ensureUserRow(address, params.referrer);

  // ✅ 处理推荐奖励（如果有 ReferralReward 事件）
  if (referralRewardWei && referralRewardReferrer) {
    const refAddr = referralRewardReferrer.toLowerCase();
    const { error: refRewardErr } = await supabase.from('referral_rewards').upsert(
      {
        tx_hash: txHash,
        referrer_address: refAddr,
        amount_wei: referralRewardWei,
        block_number: receipt.blockNumber,
        block_time: blockTimeIso || new Date().toISOString(), // ✅ 确保 block_time 不为 null
        created_at: new Date().toISOString(),
      },
      { onConflict: 'tx_hash' }
    );
    if (refRewardErr) {
      console.error('[verifyClaim] 插入推荐奖励失败:', refRewardErr);
      // 不抛出错误，因为主要功能（claim）已经成功
    } else {
      console.log('[verifyClaim] ✅ 成功插入推荐奖励记录');
    }
  }

  // ✅ 处理冷却时间重置（如果有 CooldownReset 事件）
  if (cooldownResetReferrer) {
    const refAddr = cooldownResetReferrer.toLowerCase();
    const { error: cooldownErr } = await supabase.from('cooldown_resets').upsert(
      {
        tx_hash: txHash,
        referrer_address: refAddr,
        block_number: receipt.blockNumber,
        block_time: blockTimeIso || new Date().toISOString(), // ✅ 确保 block_time 不为 null
        created_at: new Date().toISOString(),
      },
      { onConflict: 'tx_hash' }
    );
    if (cooldownErr) {
      console.error('[verifyClaim] 插入冷却时间重置失败:', cooldownErr);
      // 不抛出错误，因为主要功能（claim）已经成功
    } else {
      console.log('[verifyClaim] ✅ 成功插入冷却时间重置记录，推荐人:', refAddr);
    }
  }

  return {
    ok: true,
    txHash,
    amount: ethers.utils.formatEther(claimedAmountWei),
    unit: 'RAT',
    blockNumber: receipt.blockNumber,
    blockTime: blockTimeIso,
    attempt: 1, // 标记为第一次尝试（用于前端显示）
  };
}


