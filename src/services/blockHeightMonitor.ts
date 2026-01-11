import { supabase } from '../infra/supabase.js';
import { sendSystemErrorAlert } from './telegram.js';
import type { ethers } from 'ethers';

/**
 * 区块高度监控服务
 * 
 * 功能：
 * 1. 每 5 分钟检查 Indexer 的区块同步进度
 * 2. 如果落后超过 10,000 个区块（约 7 小时），发送告警
 * 3. 如果落后超过 100,000 个区块（约 3 天），自动重置到最近区块
 * 4. 如果 10 分钟内没有任何进度，发送 Indexer 停滞告警
 */
export class BlockHeightMonitor {
  private provider: ethers.providers.Provider;
  private lastCheckedBlock: number = 0;
  private lastCheckTime: number = Date.now();
  private timer: NodeJS.Timeout | null = null;
  
  // 告警阈值（区块数）
  private readonly WARNING_THRESHOLD = 10000;    // 警告：落后 10,000 区块（约 7 小时）
  private readonly CRITICAL_THRESHOLD = 100000;  // 严重：落后 100,000 区块（约 3 天）
  private readonly AUTO_RESET_THRESHOLD = 500000; // 自动重置：落后 500,000 区块（约 17 天）
  
  // 检查间隔（毫秒）
  private readonly CHECK_INTERVAL = 5 * 60 * 1000; // 每 5 分钟检查一次

  constructor(provider: ethers.providers.Provider) {
    this.provider = provider;
  }

  /**
   * 启动监控服务
   */
  public start() {
    if (this.timer) {
      console.log('[BlockHeightMonitor] 监控服务已在运行中');
      return;
    }

    console.log('[BlockHeightMonitor] 启动区块高度监控服务...');
    
    // 立即执行一次检查
    this.checkBlockHeight();
    
    // 每 5 分钟检查一次
    this.timer = setInterval(() => {
      this.checkBlockHeight();
    }, this.CHECK_INTERVAL);
  }

  /**
   * 停止监控服务
   */
  public stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[BlockHeightMonitor] 监控服务已停止');
    }
  }

  /**
   * 检查区块高度
   */
  private async checkBlockHeight() {
    try {
      // 1. 获取当前链上的最新区块
      const currentBlock = await this.provider.getBlockNumber();
      
      // 2. 获取 Indexer 最后同步的区块
      const { data, error } = await supabase
        .from('chain_sync_state')
        .select('last_block, updated_at')
        .eq('id', 'bsc_airdrop')
        .single();

      if (error) {
        console.error('[BlockHeightMonitor] 查询数据库失败:', error);
        return;
      }

      const indexerBlock = Number(data.last_block || 0);
      const updatedAt = new Date(data.updated_at).getTime();
      const now = Date.now();
      
      // 3. 计算落后程度
      const blocksBehind = currentBlock - indexerBlock;
      const hoursBehind = (blocksBehind / 20 / 60).toFixed(1); // BSC 每分钟约 20 个区块
      
      console.log(`[BlockHeightMonitor] 区块同步进度检查:`);
      console.log(`  - 当前链上区块: ${currentBlock}`);
      console.log(`  - Indexer 区块: ${indexerBlock}`);
      console.log(`  - 落后区块数: ${blocksBehind} (约 ${hoursBehind} 小时)`);
      console.log(`  - 最后更新时间: ${new Date(updatedAt).toISOString()}`);

      // 4. 检查是否停滞（10 分钟内没有进度）
      const timeSinceUpdate = now - updatedAt;
      if (timeSinceUpdate > 10 * 60 * 1000) {
        const minutesSinceUpdate = Math.floor(timeSinceUpdate / 60000);
        console.error(`[BlockHeightMonitor] ❌ Indexer 已 ${minutesSinceUpdate} 分钟未更新！`);
        await this.sendAlert('INDEXER_STALLED', {
          message: `Indexer 已 ${minutesSinceUpdate} 分钟未更新`,
          indexerBlock,
          currentBlock,
          blocksBehind,
          hoursBehind: parseFloat(hoursBehind),
          lastUpdateTime: new Date(updatedAt).toISOString(),
        });
      }

      // 5. 检查区块落后程度
      if (blocksBehind > this.AUTO_RESET_THRESHOLD) {
        // 🔴 严重落后：自动重置到最近区块
        console.error(`[BlockHeightMonitor] 🔴 严重落后 ${blocksBehind} 个区块，执行自动重置！`);
        await this.autoResetBlockHeight(currentBlock);
      } else if (blocksBehind > this.CRITICAL_THRESHOLD) {
        // 🟠 严重告警
        console.warn(`[BlockHeightMonitor] 🟠 严重落后 ${blocksBehind} 个区块！`);
        await this.sendAlert('CRITICAL_BEHIND', {
          message: `Indexer 严重落后 ${blocksBehind} 个区块（约 ${hoursBehind} 小时）`,
          indexerBlock,
          currentBlock,
          blocksBehind,
          hoursBehind: parseFloat(hoursBehind),
        });
      } else if (blocksBehind > this.WARNING_THRESHOLD) {
        // 🟡 警告
        console.warn(`[BlockHeightMonitor] 🟡 落后 ${blocksBehind} 个区块`);
        await this.sendAlert('WARNING_BEHIND', {
          message: `Indexer 落后 ${blocksBehind} 个区块（约 ${hoursBehind} 小时）`,
          indexerBlock,
          currentBlock,
          blocksBehind,
          hoursBehind: parseFloat(hoursBehind),
        });
      } else {
        // ✅ 正常
        console.log(`[BlockHeightMonitor] ✅ 同步进度正常`);
      }

      // 6. 检查同步速度
      if (this.lastCheckedBlock > 0) {
        const blocksSynced = indexerBlock - this.lastCheckedBlock;
        const timeDiff = now - this.lastCheckTime;
        const blocksPerMinute = (blocksSynced / timeDiff) * 60000;
        
        console.log(`  - 同步速度: ${blocksPerMinute.toFixed(2)} 区块/分钟`);
        
        // BSC 每分钟约 20 个区块，如果同步速度低于 5 个/分钟则告警
        if (blocksPerMinute < 5 && blocksPerMinute > 0) {
          console.warn(`[BlockHeightMonitor] ⚠️ 同步速度过慢: ${blocksPerMinute.toFixed(2)} 区块/分钟`);
          await this.sendAlert('SLOW_SYNC', {
            message: `Indexer 同步速度过慢: ${blocksPerMinute.toFixed(2)} 区块/分钟`,
            blocksPerMinute: blocksPerMinute.toFixed(2),
            expectedSpeed: '20 区块/分钟',
            indexerBlock,
          });
        }
      }

      // 7. 更新检查状态
      this.lastCheckedBlock = indexerBlock;
      this.lastCheckTime = now;

    } catch (error) {
      console.error('[BlockHeightMonitor] 检查失败:', error);
    }
  }

  /**
   * 自动重置区块高度到最近区块
   */
  private async autoResetBlockHeight(currentBlock: number) {
    try {
      // 重置到最近 100,000 个区块（约 3.5 天前）
      const resetBlock = currentBlock - 100000;
      
      console.log(`[BlockHeightMonitor] 执行自动重置: ${resetBlock}`);
      
      const { error } = await supabase
        .from('chain_sync_state')
        .update({
          last_block: resetBlock,
          updated_at: new Date().toISOString(),
        })
        .eq('id', 'bsc_airdrop');

      if (error) {
        console.error('[BlockHeightMonitor] 自动重置失败:', error);
        await this.sendAlert('AUTO_RESET_FAILED', {
          message: `自动重置区块高度失败: ${error.message}`,
          targetBlock: resetBlock,
          currentBlock,
        });
      } else {
        console.log(`[BlockHeightMonitor] ✅ 自动重置成功: ${resetBlock}`);
        await this.sendAlert('AUTO_RESET_SUCCESS', {
          message: `Indexer 区块高度已自动重置到 ${resetBlock}`,
          resetBlock,
          currentBlock,
          reason: '落后区块数超过 500,000',
        });
      }
    } catch (error) {
      console.error('[BlockHeightMonitor] 自动重置失败:', error);
    }
  }

  /**
   * 发送 Telegram 告警
   */
  private async sendAlert(type: string, details: any) {
    try {
      await sendSystemErrorAlert({
        type: 'BLOCK_HEIGHT_ALERT',
        message: `[区块高度监控] ${type}: ${details.message}`,
        timestamp: new Date().toISOString(),
        details,
      });
    } catch (error) {
      console.error('[BlockHeightMonitor] 发送告警失败:', error);
    }
  }
}

