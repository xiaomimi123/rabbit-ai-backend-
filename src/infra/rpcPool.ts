import { ethers } from 'ethers';

interface RpcNode {
  provider: ethers.providers.JsonRpcProvider;
  url: string;
  failureCount: number;
  lastFailureTime: number;
  lastSuccessTime: number;
  isHealthy: boolean;
}

/**
 * BSC 主网网络配置
 * Chain ID: 56
 * 
 * 🔒 关键修复：显式指定网络配置，避免 JsonRpcProvider 自动检测网络失败
 * 错误信息：could not detect network (event="noNetwork", code=NETWORK_ERROR)
 */
export const BSC_MAINNET: ethers.providers.Network = {
  chainId: 56,
  name: 'bsc',
  ensAddress: undefined,
};

/**
 * 🟢 增强的 RPC 连接池
 * - 健康检查：定期检查 RPC 节点可用性
 * - 智能轮换：优先使用健康的 RPC
 * - 错误统计：记录每个 RPC 的失败次数
 * - 超时配置：30 秒超时（比默认 120 秒快）
 * - 🔒 显式指定网络：避免 "could not detect network" 错误
 */
export class RpcPool {
  private nodes: RpcNode[] = [];
  private currentIdx = 0;
  private readonly HEALTH_CHECK_INTERVAL_MS = 60 * 1000; // 60 秒检查一次
  private readonly MAX_FAILURES_BEFORE_MARK_UNHEALTHY = 3; // 连续失败 3 次标记为不健康
  private readonly FAILURE_COOLDOWN_MS = 5 * 60 * 1000; // 5 分钟后重试失败的节点
  private healthCheckTimer: NodeJS.Timeout | null = null;

  constructor(urls: string[]) {
    if (urls.length === 0) {
      throw new Error('RPC URLs cannot be empty');
    }

    // 🟢 创建 RPC 节点，配置 30 秒超时（比默认 120 秒快）
    // 🔒 关键修复：显式指定 BSC 主网网络，避免自动检测失败导致的 "could not detect network" 错误
    this.nodes = urls.map((url) => {
      const provider = new ethers.providers.JsonRpcProvider({
        url,
        timeout: 30000, // 30 秒超时
      }, BSC_MAINNET); // 显式指定 BSC 主网（Chain ID: 56）
      return {
        provider,
        url,
        failureCount: 0,
        lastFailureTime: 0,
        lastSuccessTime: Date.now(),
        isHealthy: true,
      };
    });

    // 启动健康检查
    this.startHealthCheck();
  }

  /**
   * 获取当前可用的 RPC Provider
   * 优先返回健康的节点，如果所有节点都不健康，返回当前节点
   */
  current(): ethers.providers.JsonRpcProvider {
    // 优先返回健康的节点
    const healthyNodes = this.nodes.filter((n) => n.isHealthy);
    if (healthyNodes.length > 0) {
      // 找到当前索引对应的健康节点
      let found = false;
      for (let i = 0; i < this.nodes.length; i++) {
        const idx = (this.currentIdx + i) % this.nodes.length;
        if (this.nodes[idx].isHealthy) {
          this.currentIdx = idx;
          found = true;
          break;
        }
      }
      if (found) {
        return this.nodes[this.currentIdx].provider;
      }
      // 如果找不到，使用第一个健康节点
      this.currentIdx = this.nodes.findIndex((n) => n.isHealthy);
      return this.nodes[this.currentIdx].provider;
    }

    // 如果没有健康节点，返回当前节点（降级处理）
    return this.nodes[this.currentIdx].provider;
  }

  /**
   * 轮换到下一个 RPC Provider
   * 优先选择健康的节点
   */
  rotate(): ethers.providers.JsonRpcProvider {
    const startIdx = this.currentIdx;
    const healthyNodes = this.nodes.filter((n) => n.isHealthy);

    // 如果有健康节点，优先使用
    if (healthyNodes.length > 0) {
      do {
        this.currentIdx = (this.currentIdx + 1) % this.nodes.length;
        if (this.nodes[this.currentIdx].isHealthy) {
          return this.nodes[this.currentIdx].provider;
        }
      } while (this.currentIdx !== startIdx);
    }

    // 如果没有健康节点，简单轮换
    this.currentIdx = (this.currentIdx + 1) % this.nodes.length;
    return this.nodes[this.currentIdx].provider;
  }

  /**
   * 标记当前 RPC 节点失败
   */
  markFailure(): void {
    const node = this.nodes[this.currentIdx];
    node.failureCount++;
    node.lastFailureTime = Date.now();

    // 如果连续失败次数超过阈值，标记为不健康
    if (node.failureCount >= this.MAX_FAILURES_BEFORE_MARK_UNHEALTHY) {
      node.isHealthy = false;
      console.warn(`[RpcPool] ⚠️ RPC 节点标记为不健康: ${node.url} (失败 ${node.failureCount} 次)`);
    }
  }

  /**
   * 标记当前 RPC 节点成功
   */
  markSuccess(): void {
    const node = this.nodes[this.currentIdx];
    node.lastSuccessTime = Date.now();
    
    // 如果之前失败过，重置失败计数
    if (node.failureCount > 0) {
      node.failureCount = 0;
      if (!node.isHealthy) {
        node.isHealthy = true;
        console.log(`[RpcPool] ✅ RPC 节点恢复健康: ${node.url}`);
      }
    }
  }

  /**
   * 启动健康检查定时任务
   */
  private startHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }

    this.healthCheckTimer = setInterval(async () => {
      await this.checkAllNodesHealth();
    }, this.HEALTH_CHECK_INTERVAL_MS);

    // 立即执行一次健康检查
    setImmediate(() => this.checkAllNodesHealth());
  }

  /**
   * 检查所有节点的健康状态
   */
  private async checkAllNodesHealth(): Promise<void> {
    const now = Date.now();
    
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      
      // 如果节点被标记为不健康，检查是否过了冷却期
      if (!node.isHealthy) {
        const timeSinceFailure = now - node.lastFailureTime;
        if (timeSinceFailure < this.FAILURE_COOLDOWN_MS) {
          continue; // 还在冷却期，跳过
        }
      }

      // 尝试 ping 节点（简单的 getBlockNumber 调用）
      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Health check timeout')), 10000); // 10 秒超时
        });
        
        await Promise.race([
          node.provider.getBlockNumber(),
          timeoutPromise,
        ]);
        
        // 健康检查成功
        if (!node.isHealthy) {
          node.isHealthy = true;
          node.failureCount = 0;
          console.log(`[RpcPool] ✅ RPC 节点恢复健康: ${node.url}`);
        }
        node.lastSuccessTime = now;
      } catch (error) {
        // 健康检查失败
        if (node.isHealthy) {
          node.isHealthy = false;
          console.warn(`[RpcPool] ⚠️ RPC 节点健康检查失败: ${node.url}`, error);
        }
        node.lastFailureTime = now;
      }
    }
  }

  /**
   * 获取所有节点的状态（用于监控）
   */
  getStatus(): Array<{ url: string; isHealthy: boolean; failureCount: number; lastSuccessTime: number }> {
    return this.nodes.map((n) => ({
      url: n.url,
      isHealthy: n.isHealthy,
      failureCount: n.failureCount,
      lastSuccessTime: n.lastSuccessTime,
    }));
  }

  /**
   * 清理资源
   */
  destroy(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }
}


