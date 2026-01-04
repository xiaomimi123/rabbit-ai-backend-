/**
 * RAT 余额同步服务
 * 
 * 🟢 关键策略：事件驱动 + 定时兜底
 * 
 * 事件驱动：每当用户 Claim 成功、提现成功、或手动修改数据时，立即同步该用户
 * 定时兜底：每天凌晨全量同步，校准数据
 */

import { ethers } from 'ethers';
import { supabase } from '../infra/supabase.js';
import { config } from '../config.js';
import { ERC20_ABI } from '../infra/abis.js';

function lower(addr: string) {
  return (addr || '').toLowerCase();
}

/**
 * 同步单个用户的 RAT 余额（事件驱动）
 * 在以下场景调用：
 * 1. 用户 Claim 成功后
 * 2. 用户提现成功后
 * 3. 管理员手动修改用户数据后
 */
export async function syncSingleUserRatBalance(
  provider: ethers.providers.Provider,
  address: string
) {
  try {
    const addr = lower(address);
    
    // 创建 RAT 代币合约实例
    const ratContract = new ethers.Contract(config.ratTokenContract, ERC20_ABI, provider);
    
    // 查询链上余额（Wei 值）
    const balanceWei = await ratContract.balanceOf(addr);
    
    // 🟢 存储 Wei 值（TEXT 类型），避免精度丢失
    const balanceWeiString = balanceWei.toString();
    
    // 更新数据库
    const { error } = await supabase
      .from('users')
      .update({
        rat_balance_wei: balanceWeiString,
        rat_balance_updated_at: new Date().toISOString(),
      })
      .eq('address', addr);
    
    if (error) throw error;
    
    console.log(`[RAT Balance Sync] Updated ${addr}: ${balanceWeiString} Wei`);
    return { ok: true, balanceWei: balanceWeiString };
  } catch (e: any) {
    console.error(`[RAT Balance Sync] Failed to sync ${address}:`, e);
    throw e;
  }
}

/**
 * 批量更新所有用户的 RAT 余额（定时兜底）
 * 建议每天凌晨执行一次，校准数据
 */
export async function syncAllRatBalances(provider: ethers.providers.Provider) {
  console.log('[RAT Balance Sync] Starting full sync...');
  
  // 获取所有用户地址
  const { data: users, error } = await supabase
    .from('users')
    .select('address');
  
  if (error) throw error;
  
  if (!users || users.length === 0) {
    console.log('[RAT Balance Sync] No users found');
    return { ok: true, updated: 0 };
  }
  
  // 🟢 批量查询链上 RAT 余额（使用批量查询优化性能）
  const ratContract = new ethers.Contract(config.ratTokenContract, ERC20_ABI, provider);
  
  // 分批处理，避免一次性查询过多
  const batchSize = 50;
  let updatedCount = 0;
  let errorCount = 0;
  
  for (let i = 0; i < users.length; i += batchSize) {
    const batch = users.slice(i, i + batchSize);
    
    const balancePromises = batch.map(async (user: any) => {
      try {
        const addr = lower(user.address);
        const balanceWei = await ratContract.balanceOf(addr);
        return {
          address: addr,
          balanceWei: balanceWei.toString(), // 存储 Wei 值
          success: true,
        };
      } catch (e) {
        console.error(`[RAT Balance Sync] Failed to fetch RAT balance for ${user.address}:`, e);
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
    
    console.log(`[RAT Balance Sync] Processed ${i + batch.length}/${users.length} users (${successful} updated, ${errorCount} errors)`);
    
    // 避免请求过快，每批之间稍作延迟
    if (i + batchSize < users.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  console.log(`[RAT Balance Sync] Full sync completed. Updated ${updatedCount} users, ${errorCount} errors`);
  return { ok: true, updated: updatedCount, errors: errorCount };
}

