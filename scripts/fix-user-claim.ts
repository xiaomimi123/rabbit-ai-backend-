/**
 * 修复用户交易记录的脚本
 * 直接调用 verifyClaim 服务函数来处理遗漏的交易
 * 
 * 使用方法：
 * npx tsx scripts/fix-user-claim.ts <txHash> <address> [referrer]
 */

import { ethers } from 'ethers';
import { config } from '../src/config.js';
import { verifyClaim } from '../src/services/verifyClaim.js';

const txHash = process.argv[2];
const address = process.argv[3];
const referrer = process.argv[4] || '0x0000000000000000000000000000000000000000';

if (!txHash || !address) {
  console.error('请提供交易哈希和地址作为参数');
  console.error('使用方法: npx tsx scripts/fix-user-claim.ts <txHash> <address> [referrer]');
  process.exit(1);
}

async function main() {
  console.log(`[修复用户交易] 开始处理:`);
  console.log(`  交易哈希: ${txHash}`);
  console.log(`  用户地址: ${address}`);
  console.log(`  推荐人: ${referrer}`);
  
  // 创建 provider
  const rpcUrls = config.rpcUrls;
  if (!rpcUrls || rpcUrls.length === 0) {
    throw new Error('BSC_RPC_URLS 未配置');
  }
  const provider = new ethers.providers.JsonRpcProvider(rpcUrls[0]);
  
  try {
    const result = await verifyClaim({
      provider,
      address,
      txHash,
      referrer,
    });
    
    console.log(`[修复用户交易] ✅ 成功:`, result);
    console.log(`  金额: ${result.amount} ${result.unit}`);
    console.log(`  区块号: ${result.blockNumber}`);
    console.log(`  区块时间: ${result.blockTime || 'N/A'}`);
  } catch (error: any) {
    console.error(`[修复用户交易] ❌ 失败:`, error);
    console.error(`  错误代码: ${error?.code || 'UNKNOWN'}`);
    console.error(`  错误信息: ${error?.message || String(error)}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`[修复用户交易] 错误:`, e);
  process.exit(1);
});

