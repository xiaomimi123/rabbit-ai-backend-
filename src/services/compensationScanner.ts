import { ethers } from 'ethers';
import { supabase } from '../infra/supabase.js';
import { config } from '../config.js';
import { AIRDROP_ABI } from '../infra/abis.js';
import { manualIndexTransaction } from './indexer.js';

/**
 * 补偿扫描服务
 * 
 * 功能：
 * 1. 定期扫描能量为0但余额不为0的用户（可能遗漏的用户）
 * 2. 查询链上是否有未被Indexer捕获的Claimed事件
 * 3. 自动补充缺失的领取记录
 * 4. 100%保证数据一致性
 * 
 * 适用场景：
 * - Indexer 冷启动延迟
 * - RPC 节点限流导致部分事件遗漏
 * - RPC 节点中断期间的交易
 * 
 * 执行频率：每10分钟
 */
export class CompensationScanner {
  private provider: ethers.providers.Provider;
  private contract: ethers.Contract;
  private isRunning: boolean = false;
  private scanInterval: NodeJS.Timeout | null = null;

  constructor(provider: ethers.providers.Provider) {
    this.provider = provider;
    this.contract = new ethers.Contract(config.airdropContract, AIRDROP_ABI, provider);
  }

  /**
   * 启动补偿扫描服务
   */
  async start() {
    console.log('[CompensationScanner] 🚀 启动自动补偿扫描服务...');

    // 立即执行一次
    await this.scanMissingClaims();

    // 每10分钟扫描一次
    this.scanInterval = setInterval(() => {
      this.scanMissingClaims().catch((error) => {
        console.error('[CompensationScanner] ❌ 定时扫描失败:', error);
      });
    }, 600000); // 10分钟

    console.log('[CompensationScanner] ✅ 自动补偿扫描服务已启动（每10分钟扫描一次）');
  }

  /**
   * 停止补偿扫描服务
   */
  stop() {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
      console.log('[CompensationScanner] 🛑 自动补偿扫描服务已停止');
    }
  }

  /**
   * 扫描缺失的领取记录
   */
  private async scanMissingClaims() {
    if (this.isRunning) {
      console.log('[CompensationScanner] ⏭️ 跳过扫描（上一次扫描仍在进行中）');
      return;
    }

    this.isRunning = true;

    try {
      console.log('[CompensationScanner] 🔍 开始扫描缺失的领取记录...');

      // 查询所有 energy_total = 0 且 RAT 余额 > 0 的用户（最近7天创建的）
      const { data: users, error } = await supabase
        .from('users')
        .select('address, created_at, rat_balance_wei, energy_total')
        .eq('energy_total', 0)
        .gte('created_at', new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString())
        .order('created_at', { ascending: false });

      if (error) {
        throw error;
      }

      if (!users || users.length === 0) {
        console.log('[CompensationScanner] ✅ 未发现缺失数据的用户');
        return;
      }

      console.log(`[CompensationScanner] ⚠️ 发现 ${users.length} 个可能遗漏的用户`);

      let fixedCount = 0;
      let skippedCount = 0;
      let errorCount = 0;

      for (const user of users) {
        const ratBalanceWei = BigInt(user.rat_balance_wei || '0');

        // 跳过余额为0或小于最小领取量的用户（可能是外部转账出去了）
        if (ratBalanceWei <= 0n || ratBalanceWei < BigInt('100000000000000000000')) {
          // 小于100 RAT
          skippedCount++;
          continue;
        }

        try {
          // 查询链上是否有 Claimed 事件
          // ⚠️ RPC节点限制：单次查询最多50000个区块
          // BSC约3秒一个区块，7天 = 201,600个区块
          // 我们查询最近30天(约300,000个区块)，分3次查询
          const currentBlock = await this.provider.getBlockNumber();
          const blocksToScan = 300000; // 约30天
          const fromBlock = Math.max(0, currentBlock - blocksToScan);
          
          const filter = this.contract.filters.Claimed(user.address);
          
          // 分批查询，每次50000个区块
          let events: any[] = [];
          const batchSize = 50000;
          
          for (let start = fromBlock; start <= currentBlock; start += batchSize) {
            const end = Math.min(start + batchSize - 1, currentBlock);
            try {
              const batchEvents = await this.contract.queryFilter(filter, start, end);
              events = events.concat(batchEvents);
              
              // 避免RPC限流，每次查询后等待1秒
              if (end < currentBlock) {
                await new Promise((resolve) => setTimeout(resolve, 1000));
              }
            } catch (batchError: any) {
              console.error(
                `[CompensationScanner] ⚠️ 查询用户 ${user.address} 区块范围 ${start}-${end} 失败:`,
                batchError?.message
              );
              // 继续查询下一批
            }
          }

          if (events.length === 0) {
            console.log(
              `[CompensationScanner] ℹ️ 用户 ${user.address} 链上没有领取记录（可能是外部转账或超过30天）`
            );
            skippedCount++;
            continue;
          }

          console.log(
            `[CompensationScanner] 🔴 用户 ${user.address} 有 ${events.length} 个链上领取记录，但能量为 0`
          );

          // 补充所有缺失的领取记录
          for (const event of events) {
            const txHash = event.transactionHash;

            // 检查是否已在数据库中
            const { data: existing } = await supabase
              .from('claims')
              .select('tx_hash')
              .eq('tx_hash', txHash)
              .maybeSingle();

            if (!existing) {
              try {
                await manualIndexTransaction(this.provider, txHash);
                console.log(`[CompensationScanner] ✅ 已自动补充交易: ${txHash}`);
                fixedCount++;

                // 避免RPC限流，每次补充后等待2秒
                await new Promise((resolve) => setTimeout(resolve, 2000));
              } catch (error: any) {
                console.error(`[CompensationScanner] ❌ 补充失败: ${txHash}`, error);
                errorCount++;
              }
            } else {
              console.log(`[CompensationScanner] ⏭️ 交易已存在，跳过: ${txHash}`);
              skippedCount++;
            }
          }
        } catch (error: any) {
          console.error(`[CompensationScanner] ❌ 处理用户 ${user.address} 失败:`, error);
          errorCount++;

          // 如果是RPC限流错误，等待更长时间
          if (error?.message?.includes('limit exceeded')) {
            console.warn('[CompensationScanner] ⚠️ RPC 限流，等待30秒后继续...');
            await new Promise((resolve) => setTimeout(resolve, 30000));
          }
        }
      }

      console.log('[CompensationScanner] 📊 补偿扫描完成:');
      console.log(`  ✅ 成功修复: ${fixedCount} 笔`);
      console.log(`  ⏭️ 已跳过: ${skippedCount} 笔`);
      console.log(`  ❌ 失败: ${errorCount} 笔`);

      // 如果有修复成功的记录，发送TG通知
      if (fixedCount > 0) {
        try {
          const { sendSystemErrorAlert } = await import('./telegram.js');
          await sendSystemErrorAlert({
            type: 'CRITICAL_ERROR',
            message: `自动补偿扫描完成：成功修复 ${fixedCount} 笔数据`,
            details: `✅ 成功修复: ${fixedCount} 笔\n⏭️ 已跳过: ${skippedCount} 笔\n❌ 失败: ${errorCount} 笔\n📊 总扫描: ${users.length} 个用户`,
            timestamp: new Date().toISOString(),
          });
        } catch (error) {
          console.error('[CompensationScanner] ❌ 发送TG通知失败:', error);
        }
      }
    } catch (error) {
      console.error('[CompensationScanner] ❌ 扫描失败:', error);

      // 发送错误告警
      try {
        const { sendSystemErrorAlert } = await import('./telegram.js');
        await sendSystemErrorAlert({
          type: 'CRITICAL_ERROR',
          message: `补偿扫描失败！`,
          details: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        });
      } catch (e) {
        console.error('[CompensationScanner] ❌ 发送错误告警失败:', e);
      }
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * 手动触发一次扫描（用于测试或紧急修复）
   */
  async triggerManualScan(): Promise<void> {
    console.log('[CompensationScanner] 🔧 触发手动扫描...');
    await this.scanMissingClaims();
  }
}
