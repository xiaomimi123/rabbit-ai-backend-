import Fastify from 'fastify';
import cors from '@fastify/cors';
import { registerHealthRoutes } from './api/routes/health.js';
import { registerUserRoutes } from './api/routes/user.js';
import { registerMiningRoutes } from './api/routes/mining.js';
import { registerAssetRoutes } from './api/routes/asset.js';
import { registerAdminRoutes } from './api/routes/admin.js';
import type { ethers } from 'ethers';
import { config } from './config.js';

export function createServer(deps: { getProvider: () => ethers.providers.Provider }) {
  const app = Fastify({ logger: true });

  // CORS for Admin Panel / Web frontends
  app.register(cors, {
    origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
      const allow = config.corsOrigins || '*';
      if (allow === '*') return cb(null, true);
      const list = allow.split(',').map((s) => s.trim()).filter(Boolean);
      if (!origin) return cb(null, true);
      if (list.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
  });

  registerHealthRoutes(app);
  registerUserRoutes(app);
  registerAssetRoutes(app);
  registerMiningRoutes(app, deps);
  registerAdminRoutes(app, deps);

  return app;
}


