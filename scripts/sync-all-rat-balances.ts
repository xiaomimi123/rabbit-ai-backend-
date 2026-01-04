/**
 * 全量同步 RAT 余额脚本
 * 
 * 功能：
 * 1. 查询所有用户
 * 2. 批量查询链上 RAT 余额
 * 3. 更新数据库中的 rat_balance_wei 字段
 * 
 * 使用方法：
 * 1. 确保环境变量已配置（BSC_RPC_URLS, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RAT_TOKEN_CONTRACT）
 * 2. 运行: npx tsx scripts/sync-all-rat-balances.ts
 * 
 * 注意事项：
 * - 大量 RPC 请求可能触发速率限制，脚本会自动重试和分批处理
 * - 建议在低峰期运行
 * - 脚本会显示进度和统计信息
 */

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import { ERC20_ABI } from '../src/infra/abis.js';

// 🟢 修复：在服务器上，环境变量可能已经设置，不需要 dotenv
try {
  dotenv.config();
} catch (e) {
  // 忽略 dotenv 错误，使用系统环境变量
}

// 🟢 修复：直接使用项目中已有的 supabase 实例，避免环境变量编码问题
// 这样可以确保使用与主应用相同的配置
let supabase: any;
try {
  // 尝试从编译后的代码导入 supabase 实例
  const supabaseModule = await import('../dist/infra/supabase.js');
  supabase = supabaseModule.supabase;
  console.log('[Supabase] ✅ 使用项目中的 supabase 实例');
} catch (e: any) {
  // 如果编译后的代码不存在或导入失败，回退到直接创建客户端
  console.warn('[Supabase] ⚠️ 无法导入 supabase 实例，尝试直接创建客户端...');
  console.warn('   错误:', e?.message || e);
  
  const supabaseUrl = process.env.SUPABASE_URL || '';
  const supabaseKey = 
    process.env.SUPABASE_SERVICE_ROLE_KEY || 
    process.env.SUPABASE_SERVICE_KEY || 
    '';
  
  if (!supabaseUrl || !supabaseKey) {
    console.error('❌ 缺少 Supabase 配置！');
    console.error('   请确保环境变量 SUPABASE_URL 和 SUPABASE_SERVICE_ROLE_KEY 已正确配置');
    process.exit(1);
  }
  
  // 使用 createClient 创建客户端（与 backfill-claim-fees.ts 相同的方式）
  const { createClient } = await import('@supabase/supabase-js');
  // 🟢 修复：确保 URL 和 Key 都是有效的字符串，去除可能的 BOM 或特殊字符
  const cleanUrl = String(supabaseUrl).trim();
  const cleanKey = String(supabaseKey).trim();
  supabase = createClient(cleanUrl, cleanKey);
  console.log('[Supabase] ✅ 使用直接创建的 supabase 客户端');
}

// RPC 配置
const RPC_URLS = (process.env.BSC_RPC_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
if (RPC_URLS.length === 0) {
  console.error('❌ BSC_RPC_URLS 环境变量未配置');
  process.exit(1);
}

// RAT 代币合约地址（将在 main 函数中初始化）
let RAT_TOKEN_CONTRACT: string = '';

console.log('📊 RPC 节点数量:', RPC_URLS.length);
console.log('📊 当前使用 RPC:', RPC_URLS[0]);

// 创建 RPC 提供者（使用第一个 RPC URL，如果需要可以轮换）
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
  let lastError: any = null;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastError = e;
      const isRateLimit = e?.message?.includes('429') || 
                         e?.message?.includes('rate limit') ||
                         e?.code === -32005;
      
      if (isRateLimit && i < maxRetries - 1) {
        const delay = baseDelay * (i + 1);
        console.warn(`  ⚠️ RPC 速率限制，${delay}ms 后重试 (${i + 1}/${maxRetries})...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      if (i < maxRetries - 1) {
        const delay = baseDelay * (i + 1);
        console.warn(`  ⚠️ RPC 错误，${delay}ms 后重试 (${i + 1}/${maxRetries}):`, e?.message || e);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError;
}

function lower(addr: string) {
  return (addr || '').toLowerCase();
}

async function main() {
  console.log('\n🚀 开始全量同步 RAT 余额...\n');
  
  // 🟢 初始化 RAT_TOKEN_CONTRACT（尝试从环境变量或编译后的 config.js 读取）
  RAT_TOKEN_CONTRACT = (process.env.RAT_TOKEN_CONTRACT || '').toLowerCase();
  
  if (!RAT_TOKEN_CONTRACT || !ethers.utils.isAddress(RAT_TOKEN_CONTRACT)) {
    // 尝试从编译后的 config.js 读取
    try {
      const { config } = await import('../dist/config.js');
      RAT_TOKEN_CONTRACT = config.ratTokenContract;
      console.log('📊 从 config.js 读取 RAT_TOKEN_CONTRACT:', RAT_TOKEN_CONTRACT);
    } catch (e) {
      console.error('❌ RAT_TOKEN_CONTRACT 环境变量未配置或无效');
      console.error('   请设置环境变量 RAT_TOKEN_CONTRACT，或确保已编译项目（npm run build）');
      console.error('   示例: RAT_TOKEN_CONTRACT=0x03853d1B9a6DEeCE10ADf0EE20D836f06aFca47B');
      process.exit(1);
    }
  }
  
  if (!RAT_TOKEN_CONTRACT || !ethers.utils.isAddress(RAT_TOKEN_CONTRACT)) {
    console.error('❌ RAT_TOKEN_CONTRACT 无效:', RAT_TOKEN_CONTRACT);
    process.exit(1);
  }
  
  console.log('📊 RAT 代币合约:', RAT_TOKEN_CONTRACT);
  
  // 获取所有用户地址
  const { data: users, error: usersError } = await supabase
    .from('users')
    .select('address');
  
  if (usersError) {
    console.error('❌ 获取用户列表失败:', usersError);
    process.exit(1);
  }
  
  if (!users || users.length === 0) {
    console.log('✅ 没有用户需要同步');
    process.exit(0);
  }
  
  console.log(`📊 找到 ${users.length} 个用户需要同步\n`);
  
  // 创建 RAT 代币合约实例
  const provider = getProvider();
  const ratContract = new ethers.Contract(RAT_TOKEN_CONTRACT, ERC20_ABI, provider);
  
  // 分批处理，避免一次性查询过多
  const batchSize = 50;
  let updatedCount = 0;
  let errorCount = 0;
  const startTime = Date.now();
  
  for (let i = 0; i < users.length; i += batchSize) {
    const batch = users.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(users.length / batchSize);
    
    console.log(`📦 处理批次 ${batchNum}/${totalBatches} (${i + 1}-${Math.min(i + batchSize, users.length)})`);
    
    const balancePromises = batch.map(async (user: any) => {
      try {
        const addr = lower(user.address);
        const balanceWei = await retryRpc(
          () => ratContract.balanceOf(addr),
          { maxRetries: 3, baseDelay: 1000 }
        );
        return {
          address: addr,
          balanceWei: balanceWei.toString(),
          success: true,
        };
      } catch (e: any) {
        console.error(`  ❌ 查询失败 ${user.address}:`, e?.message || e);
        errorCount++;
        return {
          address: lower(user.address),
          balanceWei: '0',
          success: false,
        };
      }
    });
    
    const balances = await Promise.allSettled(balancePromises);
    
    // 批量更新数据库
    const updates = balances.map((result) => {
      if (result.status === 'fulfilled') {
        const { address, balanceWei } = result.value;
        return supabase
          .from('users')
          .update({
            rat_balance_wei: balanceWei,
            rat_balance_updated_at: new Date().toISOString(),
          })
          .eq('address', address);
      }
      return null;
    }).filter(Boolean);
    
    // 执行批量更新
    const updateResults = await Promise.allSettled(updates);
    const successful = updateResults.filter(r => r.status === 'fulfilled').length;
    updatedCount += successful;
    
    const formattedBalance = (wei: string) => {
      try {
        return parseFloat(ethers.utils.formatEther(wei)).toFixed(4);
      } catch {
        return '0';
      }
    };
    
    // 显示批次统计
    const successCount = balances.filter(r => r.status === 'fulfilled' && r.value.success).length;
    console.log(`  ✅ 成功: ${successCount}/${batch.length}, 已更新: ${successful}`);
    
    // 显示前几个用户的余额（用于验证）
    if (batchNum === 1) {
      console.log('  📊 示例数据:');
      balances.slice(0, 3).forEach((result, idx) => {
        if (result.status === 'fulfilled') {
          const { address, balanceWei } = result.value;
          const formatted = formattedBalance(balanceWei);
          console.log(`    ${address.slice(0, 10)}...${address.slice(-8)}: ${formatted} RAT`);
        }
      });
    }
    
    // 避免请求过快，每批之间稍作延迟
    if (i + batchSize < users.length) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  
  console.log('\n📊 同步完成统计:');
  console.log(`  ✅ 成功: ${updatedCount} 条`);
  console.log(`  ❌ 失败: ${errorCount} 条`);
  console.log(`  ⏱️  耗时: ${elapsed} 秒`);
  console.log(`  📊 总计: ${users.length} 条\n`);
  
  if (errorCount > 0) {
    console.log('⚠️  仍有部分记录同步失败，可以重新运行脚本');
  } else {
    console.log('🎉 所有用户 RAT 余额已成功同步！');
  }
}

main().catch((e) => {
  console.error('❌ 脚本执行失败:', e);
  process.exit(1);
});

