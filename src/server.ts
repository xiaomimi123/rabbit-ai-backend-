import Fastify from 'fastify';
import { registerHealthRoutes } from './api/routes/health.js';
import { registerUserRoutes } from './api/routes/user.js';
import { registerMiningRoutes } from './api/routes/mining.js';
import { registerAssetRoutes } from './api/routes/asset.js';
import type { ethers } from 'ethers';

export function createServer(deps: { getProvider: () => ethers.providers.Provider }) {
  const app = Fastify({ logger: true });

  registerHealthRoutes(app);
  registerUserRoutes(app);
  registerAssetRoutes(app);
  registerMiningRoutes(app, deps);

  return app;
}


