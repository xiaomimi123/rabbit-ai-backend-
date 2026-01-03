/**
 * 历史数据补充脚本：为 claims 表补充 fee_amount_wei 字段
 * 
 * 功能：
 * 1. 查询所有 fee_amount_wei 为 NULL 的记录
 * 2. 通过 RPC 读取每笔交易的 tx.value（用户实际支付的 BNB）
 * 3. 更新数据库记录
 * 
 * 使用方法：
 * 1. 确保环境变量已配置（BSC_RPC_URLS, SUPABASE_URL, SUPABASE_SERVICE_KEY）
 * 2. 运行: npx tsx scripts/backfill-claim-fees.ts
 * 
 * 注意事项：
 * - 大量 RPC 请求可能触发速率限制，脚本会自动重试
 * - 建议在低峰期运行
 * - 可以分批处理，避免一次性处理过多记录
 */

import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import { config } from '../src/config.js';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_KEY || ''
);

// RPC 配置
const RPC_URLS = (process.env.BSC_RPC_URLS || '').split(',').filter(Boolean);
if (RPC_URLS.length === 0) {
  console.error('❌ BSC_RPC_URLS 环境变量未配置');
  process.exit(1);
}

// 创建 RPC 提供者（使用第一个 RPC URL）
let currentRpcIndex = 0;
function getProvider(): ethers.providers.Provider {
  return new ethers.providers.JsonRpcProvider(RPC_URLS[currentRpcIndex]);
}

// RPC 重试函数
async function retryRpc<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; baseDelay?: number } = {}
): Promise<T> {
  const maxRetries = options.maxRetries || 3;
  const baseDelay = options.baseDelay || 1000;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const isLastAttempt = attempt === maxRetries - 1;
      const errorMsg = error?.message || String(error);
      
      // 如果是速率限制错误，尝试切换 RPC
      if (errorMsg.includes('429') || errorMsg.includes('rate limit') || errorMsg.includes('too many requests')) {
        if (RPC_URLS.length > 1) {
          currentRpcIndex = (currentRpcIndex + 1) % RPC_URLS.length;
          console.log(`[RPC] 切换到备用 RPC: ${currentRpcIndex + 1}/${RPC_URLS.length}`);
        }
      }
      
      if (isLastAttempt) {
        throw error;
      }
      
      const delay = baseDelay * Math.pow(2, attempt);
      console.warn(`[RPC] 重试 ${attempt + 1}/${maxRetries}，等待 ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw new Error('所有重试均失败');
}

// 获取交易的实际支付金额
async function getTransactionValue(txHash: string): Promise<string | null> {
  try {
    const provider = getProvider();
    const tx = await retryRpc(
      () => provider.getTransaction(txHash),
      { maxRetries: 3, baseDelay: 1000 }
    );
    
    if (!tx || !tx.value) {
      return null;
    }
    
    return tx.value.toString();
  } catch (error: any) {
    console.error(`[getTransactionValue] 获取交易 ${txHash} 失败:`, error?.message || error);
    return null;
  }
}

// 主函数
async function main() {
  console.log('🚀 开始补充历史数据：fee_amount_wei');
  console.log(`📊 RPC 节点数量: ${RPC_URLS.length}`);
  console.log(`📊 当前使用 RPC: ${RPC_URLS[currentRpcIndex]}`);
  
  // 查询所有 fee_amount_wei 为 NULL 的记录
  const { data: claims, error: queryError } = await supabase
    .from('claims')
    .select('tx_hash, fee_amount_wei')
    .is('fee_amount_wei', null)
    .order('created_at', { ascending: true });
  
  if (queryError) {
    console.error('❌ 查询 claims 表失败:', queryError);
    process.exit(1);
  }
  
  if (!claims || claims.length === 0) {
    console.log('✅ 没有需要补充的记录');
    return;
  }
  
  console.log(`📊 找到 ${claims.length} 条需要补充的记录`);
  
  // 批量处理（每次处理 10 条，避免 RPC 速率限制）
  const BATCH_SIZE = 10;
  let successCount = 0;
  let failCount = 0;
  let skipCount = 0;
  
  for (let i = 0; i < claims.length; i += BATCH_SIZE) {
    const batch = claims.slice(i, i + BATCH_SIZE);
    console.log(`\n📦 处理批次 ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(claims.length / BATCH_SIZE)} (${i + 1}-${Math.min(i + BATCH_SIZE, claims.length)})`);
    
    // 并行处理批次内的记录
    const promises = batch.map(async (claim) => {
      const txHash = claim.tx_hash;
      
      // 如果已经有 fee_amount_wei，跳过
      if (claim.fee_amount_wei) {
        skipCount++;
        return { txHash, success: true, skipped: true };
      }
      
      // 获取交易的实际支付金额
      const feeAmountWei = await getTransactionValue(txHash);
      
      if (!feeAmountWei) {
        console.warn(`⚠️  交易 ${txHash} 无法获取实际支付金额，跳过`);
        failCount++;
        return { txHash, success: false, skipped: false };
      }
      
      // 更新数据库
      const { error: updateError } = await supabase
        .from('claims')
        .update({ fee_amount_wei: feeAmountWei })
        .eq('tx_hash', txHash);
      
      if (updateError) {
        console.error(`❌ 更新交易 ${txHash} 失败:`, updateError);
        failCount++;
        return { txHash, success: false, skipped: false };
      }
      
      const feeAmountBNB = ethers.utils.formatEther(feeAmountWei);
      console.log(`✅ 交易 ${txHash.substring(0, 10)}... 手续费: ${feeAmountBNB} BNB`);
      successCount++;
      return { txHash, success: true, skipped: false };
    });
    
    // 等待批次完成
    await Promise.all(promises);
    
    // 批次间延迟，避免 RPC 速率限制
    if (i + BATCH_SIZE < claims.length) {
      await new Promise(resolve => setTimeout(resolve, 2000)); // 延迟 2 秒
    }
  }
  
  // 输出统计信息
  console.log('\n📊 补充完成统计:');
  console.log(`✅ 成功: ${successCount} 条`);
  console.log(`❌ 失败: ${failCount} 条`);
  console.log(`⏭️  跳过: ${skipCount} 条`);
  console.log(`📊 总计: ${claims.length} 条`);
  
  // 验证结果
  const { count: remainingCount } = await supabase
    .from('claims')
    .select('tx_hash', { count: 'exact', head: true })
    .is('fee_amount_wei', null);
  
  if (remainingCount && remainingCount > 0) {
    console.log(`\n⚠️  仍有 ${remainingCount} 条记录未补充，可以重新运行脚本`);
  } else {
    console.log('\n🎉 所有记录已成功补充！');
  }
}

// 运行主函数
main().catch((error) => {
  console.error('❌ 脚本执行失败:', error);
  process.exit(1);
});

