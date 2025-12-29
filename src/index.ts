import { ethers } from 'ethers';
import { config } from './config.js';
import { createServer } from './server.js';
import { RpcPool } from './infra/rpcPool.js';
import { startIndexer } from './indexer/indexer.js';
import { loadVipTiers } from './services/vipConfig.js';

async function main() {
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

  // provider factory with simple rotation on errors
  let provider = rpcPool.current();
  const getProvider = () => provider;

  const app = createServer({ getProvider });

  // start HTTP
  await app.listen({ host: '0.0.0.0', port: config.port });
  app.log.info({ port: config.port }, 'server started');

  // start indexer in background (do NOT block HTTP)
  setImmediate(() => {
    startIndexer(
      () => getProvider(),
      (e) => {
        // rotate provider on any error (best effort)
        provider = rpcPool.rotate();
        app.log.warn({ err: (e as any)?.message || e }, 'indexer error -> rotate rpc');
      }
    ).catch((e) => {
      app.log.error({ err: (e as any)?.message || e }, 'indexer fatal');
    });
  });
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('fatal', e);
  process.exit(1);
});


