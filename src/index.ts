import { ethers } from 'ethers';
import { config } from './config';
import { createServer } from './server';
import { RpcPool } from './infra/rpcPool';
import { startIndexer } from './indexer/indexer';

async function main() {
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


