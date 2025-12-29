import { ethers } from 'ethers';
import { AIRDROP_ABI } from '../infra/abis.js';
import { supabase } from '../infra/supabase.js';
import { config } from '../config.js';

type ChainSyncStateRow = {
  id: string;
  last_block: number;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function lower(addr: string | null | undefined): string {
  return (addr || '').toLowerCase();
}

async function ensureUserRow(address: string, referrer: string | null | undefined): Promise<void> {
  const addr = lower(address);
  const ref = lower(referrer || '0x0000000000000000000000000000000000000000');

  const { data, error } = await supabase
    .from('users')
    .select('referrer_address,invite_count,energy_total,energy_locked,created_at')
    .eq('address', addr)
    .maybeSingle();
  if (error) throw error;

  const createdAt = (data as any)?.created_at || new Date().toISOString();
  const existingRef = lower((data as any)?.referrer_address || '');
  const nextRef = existingRef || (ref !== '0x0000000000000000000000000000000000000000' ? ref : null);

  const { error: upErr } = await supabase.from('users').upsert(
    {
      address: addr,
      referrer_address: nextRef,
      invite_count: Number((data as any)?.invite_count || 0),
      energy_total: Number((data as any)?.energy_total || 0),
      energy_locked: Number((data as any)?.energy_locked || 0),
      updated_at: new Date().toISOString(),
      created_at: createdAt,
    },
    { onConflict: 'address' }
  );
  if (upErr) throw upErr;
}

function isLimitExceededError(err: any): boolean {
  const code = err?.error?.code ?? err?.code;
  const msg = String(err?.error?.message || err?.message || '').toLowerCase();
  return code === -32005 || msg.includes('limit exceeded') || msg.includes('超出限制') || msg.includes('too many results');
}

async function ensureChainSyncRow(): Promise<void> {
  const { error } = await supabase
    .from('chain_sync_state')
    .upsert({ id: config.chainSyncId, last_block: 0, updated_at: new Date().toISOString() }, { onConflict: 'id' });
  if (error) throw error;
}

async function getLastBlockFromDb(): Promise<number> {
  const { data, error } = await supabase
    .from('chain_sync_state')
    .select('id,last_block')
    .eq('id', config.chainSyncId)
    .maybeSingle<ChainSyncStateRow>();
  if (error) throw error;
  if (!data) return 0;
  return Number(data.last_block || 0);
}

async function setLastBlockInDb(lastBlock: number): Promise<void> {
  const { error } = await supabase
    .from('chain_sync_state')
    .upsert({ id: config.chainSyncId, last_block: lastBlock, updated_at: new Date().toISOString() }, { onConflict: 'id' });
  if (error) throw error;
}

async function getBlockTimeIso(provider: ethers.providers.Provider, blockNumber: number): Promise<string | null> {
  try {
    // Avoid blocking indexer on slow RPCs for block timestamp
    const block = await Promise.race([
      provider.getBlock(blockNumber),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
    if (!(block as any)?.timestamp) return null;
    return new Date(Number((block as any).timestamp) * 1000).toISOString();
  } catch {
    return null;
  }
}

async function decodeReferrerFromTx(provider: ethers.providers.Provider, iface: ethers.utils.Interface, txHash: string): Promise<string> {
  try {
    const tx = await provider.getTransaction(txHash);
    if (!tx?.data) return '0x0000000000000000000000000000000000000000';
    const decoded = iface.decodeFunctionData('claim', tx.data);
    const ref = decoded?.[0];
    if (typeof ref === 'string' && ethers.utils.isAddress(ref)) return lower(ref);
    return '0x0000000000000000000000000000000000000000';
  } catch {
    return '0x0000000000000000000000000000000000000000';
  }
}

async function insertClaim(args: {
  txHash: string;
  address: string;
  referrer: string;
  amountWei: string;
  blockNumber: number;
  blockTimeIso: string | null;
}) {
  // ✅ 使用数据库 RPC 函数进行原子操作，解决并发问题
  const { data, error } = await supabase.rpc('process_claim_energy', {
    p_tx_hash: args.txHash,
    p_address: args.address,
    p_referrer: args.referrer || '0x0000000000000000000000000000000000000000',
    p_amount_wei: args.amountWei,
    p_block_number: args.blockNumber,
    p_block_time: args.blockTimeIso || new Date().toISOString()
  });

  if (error) {
    console.error('[insertClaim] RPC 调用失败:', error);
    throw error;
  }

  // data 会返回 { status: 'success' | 'skipped', is_first_claim: boolean }
  // 如果是 skipped，说明交易已存在，无需担心能量重复计算
  if (data?.status === 'skipped') {
    console.log(`[insertClaim] 交易已存在，跳过处理: ${args.txHash}`);
  } else {
    console.log(`[insertClaim] ✅ 成功处理交易: ${args.txHash}, is_first_claim: ${data?.is_first_claim}`);
  }

  // ensure user exists (Admin Panel user count) - 即使交易已存在也要确保用户记录存在
  await ensureUserRow(args.address, args.referrer);
}

async function insertReferralReward(args: {
  txHash: string;
  referrer: string;
  amountWei: string;
  blockNumber: number;
  blockTimeIso: string | null;
}) {
  const { error } = await supabase.from('referral_rewards').upsert(
    {
      tx_hash: args.txHash,
      referrer_address: args.referrer,
      amount_wei: args.amountWei,
      block_number: args.blockNumber,
      block_time: args.blockTimeIso || new Date().toISOString(), // ✅ 确保 block_time 不为 null
      created_at: new Date().toISOString(),
    },
    { onConflict: 'tx_hash' }
  );
  if (error) throw error;
}

async function handleCooldownReset(args: { txHash: string; referrer: string; blockNumber: number; blockTimeIso: string | null }) {
  // insert cooldown_resets (tx_hash PK => idempotent)
  // ✅ 修复：只记录 cooldown_resets 事件，不再处理能量奖励
  // 能量奖励统一在 insertClaim 中处理，避免重复奖励
  const insert = await supabase.from('cooldown_resets').insert({
    tx_hash: args.txHash,
    referrer_address: args.referrer,
    block_number: args.blockNumber,
    block_time: args.blockTimeIso || new Date().toISOString(), // ✅ 确保 block_time 不为 null
    created_at: new Date().toISOString(),
  });

  // already processed
  if (insert.error && String(insert.error.message || '').toLowerCase().includes('duplicate')) return;
  if (insert.error) throw insert.error;
  
  // ✅ 已删除能量奖励逻辑，避免与 insertClaim 重复奖励
}

async function runOnce(provider: ethers.providers.Provider): Promise<void> {
  const latest = await provider.getBlockNumber();
  const safeHead = Math.max(0, latest - config.confirmations);

  const last = await getLastBlockFromDb();
  const fromBlock = last + 1;
  if (fromBlock > safeHead) return;

  const iface = new ethers.utils.Interface(AIRDROP_ABI);
  // Filter by event topics to reduce RPC load/response size (important for public BSC RPC limits)
  const eventTopics = [
    iface.getEventTopic('Claimed'),
    iface.getEventTopic('ReferralReward'),
    iface.getEventTopic('CooldownReset'),
  ];

  // Fetch logs with adaptive range split on RPC limits (-32005)
  let span = Math.min(config.batchBlocks, safeHead - fromBlock + 1);
  let attempt = 0;
  let backoffMs = 2_000;
  let logs: ethers.providers.Log[] = [];
  let toBlock = fromBlock + span - 1;

  // Cap retries inside a single runOnce to avoid hammering public RPC.
  while (attempt < 8) {
    toBlock = Math.min(safeHead, fromBlock + span - 1);
    try {
      logs = await provider.getLogs({
        address: config.airdropContract,
        fromBlock,
        toBlock,
        topics: [eventTopics],
      });
      break;
    } catch (e: any) {
      attempt += 1;

      if (isLimitExceededError(e)) {
        // Two common causes:
        // 1) Too many logs in one query => reduce span
        // 2) RPC rate-limit window => exponential backoff
        const prevSpan = span;
        span = Math.max(1, Math.floor(span / 2));
        console.warn(`[indexer] getLogs limit exceeded, reduce span and retry`, { attempt, span, prevSpan, fromBlock, toBlock, backoffMs });
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 60_000);
        continue;
      }

      // short backoff for other transient errors
      console.warn(`[indexer] getLogs failed`, { attempt, fromBlock, toBlock, msg: e?.message || String(e) });
      await sleep(1000 * Math.min(attempt, 10));
      throw e;
    }
  }

  // Still rate-limited after retries: cool down and let the next loop try again (avoid spamming rotate/logs)
  if (attempt >= 8 && logs.length === 0) {
    console.warn(`[indexer] getLogs still limited after retries, cool down`, { fromBlock, span });
    await sleep(60_000);
    return;
  }

  const blockTimeCache = new Map<number, string | null>();

  for (const log of logs) {
    let parsed: ethers.utils.LogDescription | null = null;
    try {
      parsed = iface.parseLog(log);
    } catch {
      continue;
    }

    const bn = log.blockNumber;
    if (!blockTimeCache.has(bn)) blockTimeCache.set(bn, await getBlockTimeIso(provider, bn));
    const blockTimeIso = blockTimeCache.get(bn) || null;

    if (parsed.name === 'Claimed') {
      const user = lower(parsed.args.user);
      const amountWei = (parsed.args.amount as ethers.BigNumber).toString();
      // ✅ 修复：优先从数据库获取 referrer，如果数据库没有再用 decodeReferrerFromTx
      let referrer = '0x0000000000000000000000000000000000000000';
      try {
        const { data: userData } = await supabase
          .from('users')
          .select('referrer_address')
          .eq('address', user)
          .maybeSingle();
        if (userData && (userData as any)?.referrer_address) {
          referrer = lower((userData as any).referrer_address);
        } else {
          // 数据库没有 referrer，尝试从交易数据解析
          referrer = await decodeReferrerFromTx(provider, iface, log.transactionHash);
        }
      } catch (e) {
        // 如果查询失败，回退到解析交易数据
        referrer = await decodeReferrerFromTx(provider, iface, log.transactionHash);
      }
      await insertClaim({ txHash: log.transactionHash, address: user, referrer, amountWei, blockNumber: bn, blockTimeIso });
      continue;
    }

    if (parsed.name === 'ReferralReward') {
      const ref = lower(parsed.args.referrer);
      const amountWei = (parsed.args.amount as ethers.BigNumber).toString();
      await insertReferralReward({ txHash: log.transactionHash, referrer: ref, amountWei, blockNumber: bn, blockTimeIso });
      continue;
    }

    if (parsed.name === 'CooldownReset') {
      const ref = lower(parsed.args.referrer);
      await handleCooldownReset({ txHash: log.transactionHash, referrer: ref, blockNumber: bn, blockTimeIso });
      continue;
    }
  }

  await setLastBlockInDb(toBlock);
  console.log(`[indexer] synced blocks ${fromBlock}-${toBlock} (safeHead=${safeHead}, logs=${logs.length})`);
}

export async function startIndexer(providerFactory: () => ethers.providers.Provider, onFatal?: (e: unknown) => void) {
  await ensureChainSyncRow();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const provider = providerFactory();
      await runOnce(provider);
    } catch (e) {
      console.error('[indexer] error', (e as any)?.message || e);
      onFatal?.(e);
    }
    await sleep(config.pollIntervalMs);
  }
}


