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
            
            // 插入 claim 记录
            const { error: claimError } = await supabase.from('claims').insert({
              tx_hash: txHash,
              address: user,
              referrer: referrer,
              amount_wei: amountWei,
              block_number: receipt.blockNumber,
              block_time: blockTimeIso,
              status: 'SUCCESS',
              energy_awarded: true,
            });
            
            if (claimError) {
              console.error(`[manualIndex] 插入 claim 失败:`, claimError);
              results.push({ type: 'Claimed', status: 'error', error: claimError.message });
            } else {
              console.log(`[manualIndex] ✅ 成功插入 claim 记录`);
              results.push({ type: 'Claimed', status: 'inserted', txHash, user, amount: ethers.utils.formatEther(amountWei) });
              
              // 确保用户记录存在，并更新能量
              const { data: userData } = await supabase
                .from('users')
                .select('energy_total,energy_locked,created_at')
                .eq('address', user)
                .maybeSingle();
              
              const currentEnergy = Number((userData as any)?.energy_total || 0);
              const newEnergy = currentEnergy + 1; // 每次领取空投 +1 能量
              
              await ensureUserRow(user, referrer);
              
              // 更新用户能量
              const { error: energyError } = await supabase.from('users').update({
                energy_total: newEnergy,
                updated_at: new Date().toISOString(),
              }).eq('address', user);
              
              if (energyError) {
                console.error(`[manualIndex] 更新用户能量失败:`, energyError);
              } else {
                console.log(`[manualIndex] ✅ 更新用户能量: ${currentEnergy} -> ${newEnergy}`);
              }
              
              // 处理推荐人的能量奖励
              const ref = lower(referrer);
              if (ref && ref !== '0x0000000000000000000000000000000000000000') {
                const { data: refData } = await supabase
                  .from('users')
                  .select('invite_count,energy_total,energy_locked,created_at')
                  .eq('address', ref)
                  .maybeSingle();
                
                let energyReward = 0;
                let newInviteCount = Number((refData as any)?.invite_count || 0);
                
                // 1. 邀请奖励：如果是第一次领取，奖励 +2 能量
                if (isFirstClaim) {
                  newInviteCount += 1;
                  energyReward += 2;
                }
                
                // 2. 管道收益：每次下级领取空投，上级获得 +1 能量
                energyReward += 1;
                
                if (refData) {
                  const newEnergyTotal = Number((refData as any)?.energy_total || 0) + energyReward;
                  await supabase.from('users').upsert(
                    {
                      address: ref,
                      invite_count: newInviteCount,
                      energy_total: newEnergyTotal,
                      energy_locked: Number((refData as any)?.energy_locked || 0),
                      updated_at: new Date().toISOString(),
                      created_at: (refData as any)?.created_at || new Date().toISOString(),
                    },
                    { onConflict: 'address' }
                  );
                  console.log(`[manualIndex] ✅ 更新推荐人能量: ${ref}, +${energyReward} 能量`);
                } else {
                  await supabase.from('users').upsert(
                    {
                      address: ref,
                      invite_count: newInviteCount > 0 ? newInviteCount : 1,
                      energy_total: energyReward,
                      energy_locked: 0,
                      created_at: new Date().toISOString(),
                      updated_at: new Date().toISOString(),
                    },
                    { onConflict: 'address' }
                  );
                  console.log(`[manualIndex] ✅ 创建推荐人记录: ${ref}, +${energyReward} 能量`);
                }
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

