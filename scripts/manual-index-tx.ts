/**
 * 手动索引单个交易的脚本
 * 用于修复 Indexer 遗漏的交易
 * 
 * 使用方法：
 * npx tsx scripts/manual-index-tx.ts <txHash>
 */

import { ethers } from 'ethers';
import { config } from '../src/config.js';
import { supabase } from '../src/infra/supabase.js';
import { AIRDROP_ABI } from '../src/infra/abis.js';

const txHash = process.argv[2];

if (!txHash) {
  console.error('请提供交易哈希作为参数');
  console.error('使用方法: npx tsx scripts/manual-index-tx.ts <txHash>');
  process.exit(1);
}

async function main() {
  console.log(`[手动索引] 开始处理交易: ${txHash}`);
  
  // 创建 provider
  const rpcUrls = config.bscRpcUrls;
  if (!rpcUrls || rpcUrls.length === 0) {
    throw new Error('BSC_RPC_URLS 未配置');
  }
  const provider = new ethers.providers.JsonRpcProvider(rpcUrls[0]);
  
  // 获取交易收据
  console.log(`[手动索引] 获取交易收据...`);
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) {
    throw new Error(`交易 ${txHash} 不存在或尚未确认`);
  }
  
  console.log(`[手动索引] 交易信息:`, {
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
  
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contractAddress) continue;
    
    try {
      const parsed = iface.parseLog(log);
      
      if (parsed.name === 'Claimed') {
        foundClaimed = true;
        const user = parsed.args.user.toLowerCase();
        const amountWei = (parsed.args.amount as ethers.BigNumber).toString();
        
        console.log(`[手动索引] 找到 Claimed 事件:`, {
          user,
          amountWei,
          amount: ethers.utils.formatEther(amountWei),
        });
        
        // 获取区块时间
        const block = await provider.getBlock(receipt.blockNumber);
        const blockTimeIso = block ? new Date(block.timestamp * 1000).toISOString() : new Date().toISOString();
        
        // 解析 referrer
        let referrer = '0x0000000000000000000000000000000000000000';
        try {
          const tx = await provider.getTransaction(txHash);
          if (tx?.data) {
            const decoded = iface.decodeFunctionData('claim', tx.data);
            const ref = decoded?.[0];
            if (typeof ref === 'string' && ethers.utils.isAddress(ref)) {
              referrer = ref.toLowerCase();
            }
          }
        } catch (e) {
          console.warn(`[手动索引] 解析 referrer 失败:`, e);
        }
        
        // 检查是否已存在
        const { data: existing } = await supabase
          .from('claims')
          .select('tx_hash')
          .eq('tx_hash', txHash)
          .maybeSingle();
        
        if (existing) {
          console.log(`[手动索引] 交易已存在于数据库中，跳过插入`);
        } else {
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
            console.error(`[手动索引] 插入 claim 失败:`, claimError);
          } else {
            console.log(`[手动索引] ✅ 成功插入 claim 记录`);
          }
          
          // 确保用户记录存在
          const { error: userError } = await supabase.from('users').upsert(
            {
              address: user,
              referrer_address: referrer !== '0x0000000000000000000000000000000000000000' ? referrer : null,
              energy_total: 1, // 首次领取 +1 能量
              energy_locked: 0,
              invite_count: 0,
              usdt_total: 0,
              usdt_locked: 0,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'address' }
          );
          
          if (userError) {
            console.error(`[手动索引] 更新用户记录失败:`, userError);
          } else {
            console.log(`[手动索引] ✅ 成功更新用户记录`);
          }
        }
      }
      
      if (parsed.name === 'ReferralReward') {
        foundReferralReward = true;
        const referrer = parsed.args.referrer.toLowerCase();
        const amountWei = (parsed.args.amount as ethers.BigNumber).toString();
        
        console.log(`[手动索引] 找到 ReferralReward 事件:`, {
          referrer,
          amountWei,
          amount: ethers.utils.formatEther(amountWei),
        });
        
        // 获取区块时间
        const block = await provider.getBlock(receipt.blockNumber);
        const blockTimeIso = block ? new Date(block.timestamp * 1000).toISOString() : new Date().toISOString();
        
        // 检查是否已存在
        const { data: existing } = await supabase
          .from('referral_rewards')
          .select('tx_hash')
          .eq('tx_hash', txHash)
          .maybeSingle();
        
        if (existing) {
          console.log(`[手动索引] 推荐奖励已存在于数据库中，跳过插入`);
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
            console.error(`[手动索引] 插入 referral_reward 失败:`, rewardError);
          } else {
            console.log(`[手动索引] ✅ 成功插入 referral_reward 记录`);
          }
        }
      }
    } catch (e) {
      // 忽略无法解析的日志
      continue;
    }
  }
  
  if (!foundClaimed && !foundReferralReward) {
    console.warn(`[手动索引] ⚠️ 未找到 Claimed 或 ReferralReward 事件`);
    console.warn(`[手动索引] 请确认交易哈希是否正确，以及是否调用了空投合约`);
  } else {
    console.log(`[手动索引] ✅ 处理完成`);
  }
}

main().catch((e) => {
  console.error(`[手动索引] 错误:`, e);
  process.exit(1);
});

