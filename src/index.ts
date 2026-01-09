import { ethers } from 'ethers';
import { config } from './config.js';
import { createServer } from './server.js';
import { RpcPool } from './infra/rpcPool.js';
import { startIndexer } from './indexer/indexer.js';
import { loadVipTiers } from './services/vipConfig.js';

// 🟢 新增：初始化 Sentry 错误监控（零风险，只添加监控，不影响业务逻辑）
async function initSentry() {
  if (!config.sentryDsn || !config.sentryEnabled) {
    console.log('[startup] ℹ️  Sentry error monitoring disabled (SENTRY_DSN not configured or SENTRY_ENABLED=false)');
    return;
  }

  try {
    const Sentry = await import('@sentry/node');
    Sentry.init({
      dsn: config.sentryDsn,
      environment: config.sentryEnvironment,
      // 只监控错误，不监控性能（避免影响性能）
      tracesSampleRate: 0,
      // 采样率：100% 的错误都上报（推广阶段需要全面监控）
      sampleRate: 1.0,
      // 过滤已知错误（避免上报过多噪音）
      beforeSend(event: any, hint: any) {
        // 过滤掉数据库函数检查时的预期错误
        const error = hint.originalException;
        if (error && typeof error === 'object' && 'message' in error) {
          const msg = String(error.message).toLowerCase();
          if (msg.includes('function') && msg.includes('does not exist') && msg.includes('process_claim_energy')) {
            return null; // 不上报这个预期错误
          }
        }
        return event;
      },
    });
    console.log(`[startup] ✅ Sentry error monitoring initialized (environment: ${config.sentryEnvironment})`);
  } catch (e) {
    console.warn('[startup] ⚠️  Failed to initialize Sentry:', e);
    // Sentry 初始化失败不影响服务启动
  }
}

async function main() {
  // 🟢 优先初始化 Sentry（在服务启动前）
  await initSentry();

  // 🟢 初始化 Telegram Bot（用于提现通知）
  try {
    const { initTelegramBot } = await import('./services/telegram.js');
    initTelegramBot();
  } catch (e) {
    console.warn('[startup] ⚠️  Failed to initialize Telegram Bot:', e);
    // Telegram 初始化失败不影响服务启动
  }

  // 在服务启动时加载 VIP 配置到内存
  await loadVipTiers();

  // ✅ 启动时检查数据库函数是否存在
  console.log('[startup] 检查数据库函数 process_claim_energy...');
  try {
    const { supabase } = await import('./infra/supabase.js');
    const { data, error } = await supabase.rpc('process_claim_energy', {
      p_tx_hash: '0x0000000000000000000000000000000000000000000000000000000000000000',
      p_address: '0x0000000000000000000000000000000000000000',
      p_referrer: '0x0000000000000000000000000000000000000000',
      p_amount_wei: '0',
      p_block_number: 0,
      p_block_time: new Date().toISOString(),
    });
    
    if (error) {
      const errorMsg = String(error.message || '').toLowerCase();
      if (errorMsg.includes('function') && errorMsg.includes('does not exist')) {
        console.error('[startup] ❌ 致命错误：数据库函数 process_claim_energy 不存在！');
        console.error('[startup] 请执行数据库迁移脚本：db/fix_process_claim_energy_block_time.sql');
        process.exit(1);
      }
      // 其他错误（如参数验证错误）说明函数存在，可以继续
      console.log('[startup] ✅ 数据库函数 process_claim_energy 存在（参数验证错误是预期的）');
    } else {
      console.log('[startup] ✅ 数据库函数 process_claim_energy 存在');
    }
  } catch (e: any) {
    const errorMsg = String(e?.message || '').toLowerCase();
    if (errorMsg.includes('function') && errorMsg.includes('does not exist')) {
      console.error('[startup] ❌ 致命错误：数据库函数 process_claim_energy 不存在！');
      console.error('[startup] 请执行数据库迁移脚本：db/fix_process_claim_energy_block_time.sql');
      process.exit(1);
    }
    // 其他异常（可能是网络问题），记录警告但继续启动
    console.warn('[startup] ⚠️ 检查数据库函数时出现异常（可能是网络问题），继续启动:', e?.message || e);
  }

  const rpcPool = new RpcPool(config.rpcUrls);

  // 🟢 增强：使用 RpcPool 的智能选择（自动选择健康的节点）
  const getProvider = () => rpcPool.current();

  // 🟢 为后台管理创建专用的 RPC Provider（如果配置了 ADMIN_RPC_URL）
  let adminProvider: ethers.providers.Provider | null = null;
  if (config.adminRpcUrl) {
    // 🟢 为 Admin RPC 也配置超时
    adminProvider = new ethers.providers.JsonRpcProvider({
      url: config.adminRpcUrl,
      timeout: 30000, // 30 秒超时
    });
    console.log(`[startup] ✅ Admin RPC provider initialized: ${config.adminRpcUrl}`);
  } else {
    console.log('[startup] ℹ️  Admin RPC URL not configured, using default RPC pool for admin operations');
  }
  const getAdminProvider = () => adminProvider || getProvider();

  // 🟢 初始化自动放款服务
  const { AutoPayoutService } = await import('./services/autoPayout.js');
  const autoPayoutService = new AutoPayoutService(getProvider());
  await autoPayoutService.initialize();
  
  const getAutoPayoutService = () => autoPayoutService;

  const app = await createServer({ getProvider, getAdminProvider, getAutoPayoutService });

  // start HTTP
  await app.listen({ host: '0.0.0.0', port: config.port });
  app.log.info({ port: config.port }, 'server started');

  // start indexer in background (do NOT block HTTP)
  setImmediate(() => {
    startIndexer(
      () => getProvider(),
      (e) => {
        // 🟢 增强：标记 RPC 失败，并轮换到下一个节点
        rpcPool.markFailure();
        const newProvider = rpcPool.rotate();
        app.log.warn({ err: (e as any)?.message || e }, 'indexer error -> rotate rpc');
        return newProvider;
      },
      () => {
        // 🟢 新增：标记 RPC 成功（用于健康检查）
        rpcPool.markSuccess();
      }
    ).catch((e) => {
      app.log.error({ err: (e as any)?.message || e }, 'indexer fatal');
    });
  });

  // 🟢 新增：启动访问统计数据定期清理任务
  if (config.analyticsCleanupEnabled) {
    const cleanupIntervalMs = config.analyticsCleanupIntervalHours * 60 * 60 * 1000;
    console.log(`[startup] ✅ Analytics cleanup enabled: will run every ${config.analyticsCleanupIntervalHours} hours, keeping ${config.analyticsCleanupDays} days of data`);
    
    // 立即执行一次清理（可选）
    setImmediate(async () => {
      try {
        const { cleanupOldVisits } = await import('./services/analytics.js');
        const result = await cleanupOldVisits(config.analyticsCleanupDays);
        if (result.ok) {
          console.log(`[Analytics Cleanup] Initial cleanup completed: deleted ${result.deletedCount} records`);
        } else {
          console.error(`[Analytics Cleanup] Initial cleanup failed: ${result.error}`);
        }
      } catch (e) {
        console.error('[Analytics Cleanup] Initial cleanup error:', e);
      }
    });

    // 设置定期清理
    setInterval(async () => {
      try {
        const { cleanupOldVisits } = await import('./services/analytics.js');
        const result = await cleanupOldVisits(config.analyticsCleanupDays);
        if (result.ok) {
          console.log(`[Analytics Cleanup] Scheduled cleanup completed: deleted ${result.deletedCount} records`);
        } else {
          console.error(`[Analytics Cleanup] Scheduled cleanup failed: ${result.error}`);
        }
      } catch (e) {
        console.error('[Analytics Cleanup] Scheduled cleanup error:', e);
      }
    }, cleanupIntervalMs);
  } else {
    console.log('[startup] ℹ️  Analytics cleanup disabled (set ANALYTICS_CLEANUP_ENABLED=true to enable)');
  }

  // 🟢 新增：启动自动放款定时任务
  // 每 30 秒检查一次待审批提现
  const AUTO_PAYOUT_INTERVAL_MS = 30000; // 30 秒
  
  setInterval(async () => {
    if (autoPayoutService.isEnabled()) {
      try {
        await autoPayoutService.processPendingWithdrawals();
      } catch (e) {
        console.error('[AutoPayout] 定时任务执行失败:', e);
      }
    }
  }, AUTO_PAYOUT_INTERVAL_MS);
  
  console.log(`[startup] ✅ 自动放款定时任务已启动（每 ${AUTO_PAYOUT_INTERVAL_MS / 1000} 秒检查一次）`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('fatal', e);
  process.exit(1);
});


