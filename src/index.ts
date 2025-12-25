import { ethers } from 'ethers';
import { config } from './config.js';
import { createServer } from './server.js';
import { RpcPool } from './infra/rpcPool.js';
import { startIndexer } from './indexer/indexer.js';
import { loadVipTiers } from './services/vipConfig.js';

async function main() {
  // 在服务启动时加载 VIP 配置到内存
  await loadVipTiers();

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


