/**
 * 🔥 Indexer 补偿扫描服务
 * 
 * 目的：每 10 分钟自动检查缺失的空投领取数据，并自动补齐
 * 
 * 核心功能：
 * 1. 扫描所有 energy_total = 0 但链上有 claim 交易的用户
 * 2. 自动调用 verifyClaim 补充数据
 * 3. 记录补偿日志
 * 4. 发送 Telegram 告警
 * 
 * 设计原则：
 * - 幂等性：重复执行不会产生副作用
 * - 故障容错：单个用户失败不影响其他用户
 * - 资源友好：使用间隔扫描，不占用太多数据库资源
 */

import { supabase } from '../infra/supabase.js';
import type { ethers } from 'ethers';
import { verifyClaim } from './verifyClaim.js';

// 补偿扫描配置
const SCAN_INTERVAL_MS = 10 * 60 * 1000; // 10 分钟
const MAX_USERS_PER_SCAN = 50; // 每次最多处理 50 个用户
const LOOKBACK_DAYS = 30; // 回溯 30 天内的数据

export class CompensationScanner {
  private provider: ethers.providers.Provider;
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;

  constructor(provider: ethers.providers.Provider) {
    this.provider = provider;
  }

  /**
   * 启动补偿扫描服务
   */
  start() {
    if (this.intervalId) {
      console.log('[CompensationScanner] 服务已经在运行');
      return;
    }

    console.log('[CompensationScanner] 🚀 启动补偿扫描服务');
    console.log(`[CompensationScanner] 扫描间隔: ${SCAN_INTERVAL_MS / 1000 / 60} 分钟`);
    console.log(`[CompensationScanner] 每次处理: ${MAX_USERS_PER_SCAN} 个用户`);
    console.log(`[CompensationScanner] 回溯天数: ${LOOKBACK_DAYS} 天`);

    // 立即执行第一次扫描
    this.runScan().catch((error) => {
      console.error('[CompensationScanner] ❌ 首次扫描失败:', error);
    });

    // 启动定时扫描
    this.intervalId = setInterval(() => {
      this.runScan().catch((error) => {
        console.error('[CompensationScanner] ❌ 定时扫描失败:', error);
      });
    }, SCAN_INTERVAL_MS);
  }

  /**
   * 停止补偿扫描服务
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[CompensationScanner] ⏸️  补偿扫描服务已停止');
    }
  }

  /**
   * 执行一次完整的扫描
   */
  private async runScan() {
    if (this.isRunning) {
      console.log('[CompensationScanner] ⏭️  上次扫描尚未完成，跳过本次');
      return;
    }

    this.isRunning = true;
    const scanStartTime = Date.now();

    try {
      console.log('[CompensationScanner] 🔍 开始扫描...');

      // 步骤 1: 查找潜在的遗漏用户
      const missingUsers = await this.findMissingUsers();
      
      if (missingUsers.length === 0) {
        console.log('[CompensationScanner] ✅ 没有发现遗漏数据');
        return;
      }

      console.log(`[CompensationScanner] 🎯 发现 ${missingUsers.length} 个潜在遗漏用户`);

      // 步骤 2: 逐个补偿
      let successCount = 0;
      let failCount = 0;

      for (const user of missingUsers) {
        try {
          await this.compensateUser(user);
          successCount++;
        } catch (error) {
          failCount++;
          console.error(`[CompensationScanner] ❌ 补偿用户 ${user.address} 失败:`, error);
        }
      }

      // 步骤 3: 记录扫描结果
      const scanDuration = Date.now() - scanStartTime;
      console.log('[CompensationScanner] 📊 扫描完成!');
      console.log(`   - 扫描时间: ${scanDuration}ms`);
      console.log(`   - 成功补偿: ${successCount} 个用户`);
      console.log(`   - 失败: ${failCount} 个用户`);

      // 步骤 4: 如果有失败，发送告警
      if (failCount > 0) {
        await this.sendAlert(`补偿扫描完成，但有 ${failCount} 个用户补偿失败`);
      } else if (successCount > 0) {
        await this.sendAlert(`补偿扫描完成，成功补偿 ${successCount} 个用户 ✅`);
      }
    } catch (error) {
      console.error('[CompensationScanner] ❌ 扫描过程发生严重错误:', error);
      await this.sendAlert(`补偿扫描失败: ${error}`);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * 查找潜在的遗漏用户
   * 
   * 规则：
   * 1. energy_total = 0 (从未获得过能量)
   * 2. 但 claims 表中有记录
   * 3. 且记录在最近 30 天内
   */
  private async findMissingUsers(): Promise<Array<{ address: string; tx_hash: string; referrer: string | null }>> {
    try {
      // 计算回溯时间
      const lookbackDate = new Date();
      lookbackDate.setDate(lookbackDate.getDate() - LOOKBACK_DAYS);

      // 查询：在 claims 表中有记录，但 users 表中 energy_total = 0 的用户
      const { data, error } = await supabase
        .rpc('find_missing_energy_users', {
          lookback_date: lookbackDate.toISOString(),
          max_results: MAX_USERS_PER_SCAN
        });

      if (error) {
        console.error('[CompensationScanner] 查询遗漏用户失败:', error);
        return [];
      }

      return data || [];
    } catch (error) {
      console.error('[CompensationScanner] findMissingUsers 出错:', error);
      return [];
    }
  }

  /**
   * 补偿单个用户
   */
  private async compensateUser(user: { address: string; tx_hash: string; referrer: string | null }) {
    console.log(`[CompensationScanner] 🔧 补偿用户: ${user.address}`);
    console.log(`   - 交易哈希: ${user.tx_hash}`);
    console.log(`   - 推荐人: ${user.referrer || '无'}`);

    try {
      const result = await verifyClaim({
        provider: this.provider,
        address: user.address,
        txHash: user.tx_hash,
        referrer: user.referrer || '0x0000000000000000000000000000000000000000',
        ipAddress: undefined, // 补偿扫描不需要 IP
        country: undefined,   // 补偿扫描不需要国家
      });

      console.log(`[CompensationScanner] ✅ 用户 ${user.address} 补偿成功`);
      
      // 记录补偿日志到数据库（可选）
      await this.logCompensation(user.address, user.tx_hash, 'success');

      return result;
    } catch (error) {
      console.error(`[CompensationScanner] ❌ 用户 ${user.address} 补偿失败:`, error);
      
      // 记录补偿失败日志
      await this.logCompensation(user.address, user.tx_hash, 'failed', String(error));
      
      throw error;
    }
  }

  /**
   * 记录补偿日志到数据库
   */
  private async logCompensation(address: string, txHash: string, status: 'success' | 'failed', errorMessage?: string) {
    try {
      await supabase.from('compensation_logs').insert({
        address,
        tx_hash: txHash,
        status,
        error_message: errorMessage,
        created_at: new Date().toISOString(),
      });
    } catch (error) {
      // 日志失败不影响主流程
      console.error('[CompensationScanner] 记录补偿日志失败:', error);
    }
  }

  /**
   * 发送 Telegram 告警
   */
  private async sendAlert(message: string) {
    try {
      // 动态导入 telegram 服务，避免循环依赖
      const { sendSystemErrorAlert } = await import('./telegram.js');
      await sendSystemErrorAlert({
        type: 'CRITICAL_ERROR',
        message: `补偿扫描告警: ${message}`,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[CompensationScanner] 发送 Telegram 告警失败:', error);
    }
  }
}

// 导出单例实例（由主程序初始化）
export let compensationScannerInstance: CompensationScanner | null = null;

export function initializeCompensationScanner(provider: ethers.providers.Provider) {
  if (compensationScannerInstance) {
    console.log('[CompensationScanner] 实例已存在，跳过初始化');
    return compensationScannerInstance;
  }

  compensationScannerInstance = new CompensationScanner(provider);
  compensationScannerInstance.start();
  
  return compensationScannerInstance;
}

