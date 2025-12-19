import Fastify from 'fastify';
import cors from '@fastify/cors';
import { registerHealthRoutes } from './api/routes/health.js';
import { registerUserRoutes } from './api/routes/user.js';
import { registerMiningRoutes } from './api/routes/mining.js';
import { registerAssetRoutes } from './api/routes/asset.js';
import { registerAdminRoutes } from './api/routes/admin.js';
import { registerDebugRoutes } from './api/routes/debug.js';
import type { ethers } from 'ethers';
import { config } from './config.js';

export function createServer(deps: { getProvider: () => ethers.providers.Provider }) {
  const app = Fastify({ logger: true });

  // CORS for Admin Panel / Web frontends
  const allow = config.corsOrigins || '*';
  const origin = allow === '*' ? true : allow.split(',').map((s) => s.trim()).filter(Boolean);
  app.register(cors, { origin });

  registerHealthRoutes(app);
  registerUserRoutes(app);
  registerAssetRoutes(app);
  registerMiningRoutes(app, deps);
  registerAdminRoutes(app, deps);
  registerDebugRoutes(app);

  return app;
}


