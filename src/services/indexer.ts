/**
 * Indexer 服务函数
 * 用于手动索引单个交易
 */

import { ethers } from 'ethers';
import { supabase } from '../infra/supabase.js';
import { AIRDROP_ABI } from '../infra/abis.js';
import { config } from '../config.js';

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

async function getBlockTimeIso(provider: ethers.providers.Provider, blockNumber: number): Promise<string | null> {
  try {
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

/**
 * 手动索引单个交易
 * @param provider Ethers provider
 * @param txHash 交易哈希
 * @returns 索引结果
 */
export async function manualIndexTransaction(
  provider: ethers.providers.Provider,
  txHash: string
): Promise<{ success: boolean; message: string; details?: any }> {
  try {
    console.log(`[manualIndex] 开始处理交易: ${txHash}`);
    
    // 获取交易收据
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) {
      return { success: false, message: `交易 ${txHash} 不存在或尚未确认` };
    }
    
    if (receipt.status === 0) {
      return { success: false, message: `交易 ${txHash} 执行失败` };
    }
    
    console.log(`[manualIndex] 交易信息:`, {
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      status: receipt.status,
      logsCount: receipt.logs.length,
    });
    
    // 解析事件
    const iface = new ethers.utils.Interface(AIRDROP_ABI);
    const contractAddress = config.airdropContract.toLowerCase();
    
    let foundClaimed = false;
    let foundReferralReward = false;
    const results: any[] = [];
    
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== contractAddress) continue;
      
      try {
        const parsed = iface.parseLog(log);
        
        if (parsed.name === 'Claimed') {
          foundClaimed = true;
          const user = lower(parsed.args.user);
          const amountWei = (parsed.args.amount as ethers.BigNumber).toString();
          
          console.log(`[manualIndex] 找到 Claimed 事件:`, {
            user,
            amountWei,
            amount: ethers.utils.formatEther(amountWei),
          });
          
          // 获取区块时间
          const blockTimeIso = await getBlockTimeIso(provider, receipt.blockNumber);
          
          // 解析 referrer
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
              referrer = await decodeReferrerFromTx(provider, iface, txHash);
            }
          } catch (e) {
            referrer = await decodeReferrerFromTx(provider, iface, txHash);
          }
          
          // 检查是否已存在
          const { data: existing } = await supabase
            .from('claims')
            .select('tx_hash')
            .eq('tx_hash', txHash)
            .maybeSingle();
          
          if (existing) {
            results.push({ type: 'Claimed', status: 'already_exists', txHash });
            console.log(`[manualIndex] 交易已存在于数据库中，跳过插入`);
          } else {
            // 检查该被邀请人是否已经领取过
            const { data: existingClaims } = await supabase
              .from('claims')
              .select('tx_hash')
              .eq('address', user)
              .limit(1);
            
            const isFirstClaim = !existingClaims || existingClaims.length === 0;
            
            // ✅ 使用数据库 RPC 函数进行原子操作，解决并发问题
            const { data: rpcResult, error: rpcError } = await supabase.rpc('process_claim_energy', {
              p_tx_hash: txHash,
              p_address: user,
              p_referrer: referrer || '0x0000000000000000000000000000000000000000',
              p_amount_wei: amountWei,
              p_block_number: receipt.blockNumber,
              p_block_time: blockTimeIso || new Date().toISOString()
            });
            
            if (rpcError) {
              console.error(`[manualIndex] RPC 调用失败:`, rpcError);
              results.push({ type: 'Claimed', status: 'error', error: rpcError.message });
            } else {
              if (rpcResult?.status === 'skipped') {
                console.log(`[manualIndex] 交易已存在，跳过处理: ${txHash}`);
                results.push({ type: 'Claimed', status: 'skipped', txHash, user, amount: ethers.utils.formatEther(amountWei) });
              } else {
                console.log(`[manualIndex] ✅ 成功处理交易: ${txHash}, is_first_claim: ${rpcResult?.is_first_claim}`);
                results.push({ type: 'Claimed', status: 'inserted', txHash, user, amount: ethers.utils.formatEther(amountWei) });
              }
            }
          }
        }
        
        if (parsed.name === 'ReferralReward') {
          foundReferralReward = true;
          const referrer = lower(parsed.args.referrer);
          const amountWei = (parsed.args.amount as ethers.BigNumber).toString();
          
          console.log(`[manualIndex] 找到 ReferralReward 事件:`, {
            referrer,
            amountWei,
            amount: ethers.utils.formatEther(amountWei),
          });
          
          // 获取区块时间
          const blockTimeIso = await getBlockTimeIso(provider, receipt.blockNumber);
          
          // 检查是否已存在
          const { data: existing } = await supabase
            .from('referral_rewards')
            .select('tx_hash')
            .eq('tx_hash', txHash)
            .maybeSingle();
          
          if (existing) {
            results.push({ type: 'ReferralReward', status: 'already_exists', txHash });
            console.log(`[manualIndex] 推荐奖励已存在于数据库中，跳过插入`);
          } else {
            // 插入 referral_reward 记录
            const { error: rewardError } = await supabase.from('referral_rewards').insert({
              tx_hash: txHash,
              referrer_address: referrer,
              amount_wei: amountWei,
              block_number: receipt.blockNumber,
              block_time: blockTimeIso,
            });
            
            if (rewardError) {
              console.error(`[manualIndex] 插入 referral_reward 失败:`, rewardError);
              results.push({ type: 'ReferralReward', status: 'error', error: rewardError.message });
            } else {
              console.log(`[manualIndex] ✅ 成功插入 referral_reward 记录`);
              results.push({ type: 'ReferralReward', status: 'inserted', txHash, referrer, amount: ethers.utils.formatEther(amountWei) });
            }
          }
        }
      } catch (e) {
        // 忽略无法解析的日志
        continue;
      }
    }
    
    if (!foundClaimed && !foundReferralReward) {
      return {
        success: false,
        message: '未找到 Claimed 或 ReferralReward 事件',
        details: { txHash, blockNumber: receipt.blockNumber, logsCount: receipt.logs.length },
      };
    }
    
    return {
      success: true,
      message: '交易索引成功',
      details: {
        txHash,
        blockNumber: receipt.blockNumber,
        results,
      },
    };
  } catch (error: any) {
    console.error(`[manualIndex] 错误:`, error);
    return {
      success: false,
      message: error?.message || '索引失败',
      details: { error: String(error) },
    };
  }
}

