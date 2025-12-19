import { ethers } from 'ethers';
import { AIRDROP_ABI } from '../infra/abis';
import { config } from '../config';
import { supabase } from '../infra/supabase';
import { ApiError } from '../api/errors';

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

  return {
    ok: true,
    txHash,
    amount: ethers.utils.formatEther(claimedAmountWei),
    unit: 'RAT',
    blockNumber: receipt.blockNumber,
    blockTime: blockTimeIso,
  };
}


