import Fastify from 'fastify';
import cors from '@fastify/cors';
import { registerHealthRoutes } from './api/routes/health.js';
import { registerUserRoutes } from './api/routes/user.js';
import { registerMiningRoutes } from './api/routes/mining.js';
import { registerAssetRoutes } from './api/routes/asset.js';
import { registerAdminRoutes } from './api/routes/admin.js';
import { registerDebugRoutes } from './api/routes/debug.js';
import { registerSystemRoutes } from './api/routes/system.js';
import { registerVipRoutes } from './api/routes/vip.js';
import { registerAnalyticsRoutes } from './api/routes/analytics.js';
import type { ethers } from 'ethers';
import { config } from './config.js';

export function createServer(deps: { 
  getProvider: () => ethers.providers.Provider;
  getAdminProvider?: () => ethers.providers.Provider;
}) {
  // 🟢 优化：根据环境变量配置日志级别，生产环境减少日志输出
  // LOG_LEVEL 可选值：fatal, error, warn, info, debug, trace
  // 生产环境默认只记录 warn 及以上级别（错误和警告），不记录 info 级别的请求日志
  const logLevel = process.env.LOG_LEVEL || (config.nodeEnv === 'production' ? 'warn' : 'info');
  
  const app = Fastify({ 
    logger: {
      level: logLevel,
    }
  });
  
  // 🟢 生产环境：添加请求日志过滤钩子，只记录错误请求（4xx, 5xx）
  if (config.nodeEnv === 'production') {
    app.addHook('onResponse', (request, reply, done) => {
      // 只记录错误响应（4xx, 5xx），不记录成功请求（2xx, 3xx）
      if (reply.statusCode >= 400) {
        app.log.warn({
          method: request.method,
          url: request.url,
          statusCode: reply.statusCode,
          responseTime: reply.getResponseTime(),
        }, 'Request error');
      }
      done();
    });
  }

  // CORS for Admin Panel / Web frontends
  const allow = config.corsOrigins || '*';
  const origin = allow === '*' ? true : allow.split(',').map((s) => s.trim()).filter(Boolean);
  app.register(cors, { origin });

  registerHealthRoutes(app);
  registerUserRoutes(app);
  registerAssetRoutes(app, deps);
  registerMiningRoutes(app, deps);
  registerAdminRoutes(app, { 
    getProvider: deps.getProvider, 
    getAdminProvider: deps.getAdminProvider || deps.getProvider 
  });
  registerDebugRoutes(app);
  registerSystemRoutes(app);
  registerVipRoutes(app);
  registerAnalyticsRoutes(app);

  return app;
}



