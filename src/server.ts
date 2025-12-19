import Fastify from 'fastify';
import { registerHealthRoutes } from './api/routes/health';
import { registerUserRoutes } from './api/routes/user';
import { registerMiningRoutes } from './api/routes/mining';
import { registerAssetRoutes } from './api/routes/asset';
import type { ethers } from 'ethers';

export function createServer(deps: { getProvider: () => ethers.providers.Provider }) {
  const app = Fastify({ logger: true });

  registerHealthRoutes(app);
  registerUserRoutes(app);
  registerAssetRoutes(app);
  registerMiningRoutes(app, deps);

  return app;
}


