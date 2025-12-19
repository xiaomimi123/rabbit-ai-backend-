import type { FastifyInstance } from 'fastify';
import { config } from '../../config.js';

export function registerDebugRoutes(app: FastifyInstance) {
  // 注意：仅用于排查“环境变量/链配置不一致”问题，不返回任何敏感信息
  app.get('/api/debug/config', async () => {
    return {
      ok: true,
      airdropContract: config.airdropContract,
      rpcUrlsCount: config.rpcUrls.length,
      chainSyncId: config.chainSyncId,
      nodeEnv: config.nodeEnv,
    };
  });
}


