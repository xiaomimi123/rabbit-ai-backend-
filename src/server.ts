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

export async function createServer(deps: { 
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
        const responseTime = reply.elapsedTime || 0;
        app.log.warn({
          method: request.method,
          url: request.url,
          statusCode: reply.statusCode,
          responseTime: `${responseTime.toFixed(2)}ms`,
        }, 'Request error');
      }
      done();
    });
  }

  // 🟢 新增：Sentry 错误处理钩子（零风险，只添加监控，不影响业务逻辑）
  if (config.sentryDsn && config.sentryEnabled) {
    app.setErrorHandler(async (error, request, reply) => {
      // 上报错误到 Sentry
      try {
        const Sentry = await import('@sentry/node');
        Sentry.captureException(error, {
          tags: {
            method: request.method,
            url: request.url,
            statusCode: reply.statusCode || 500,
          },
          extra: {
            headers: request.headers,
            query: request.query,
            body: request.body,
          },
        });
      } catch (sentryError) {
        // Sentry 上报失败不影响错误处理
        app.log.warn({ err: sentryError }, 'Failed to report error to Sentry');
      }

      // 继续使用原有的错误处理逻辑
      const err = error as any;
      if (err.statusCode) {
        return reply.status(err.statusCode).send({
          ok: false,
          code: err.code || 'INTERNAL_ERROR',
          message: err.message || 'Internal server error',
        });
      }

      app.log.error({ err: error }, 'Unhandled error');
      return reply.status(500).send({
        ok: false,
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      });
    });
  }

  // CORS for Admin Panel / Web frontends
  const allow = config.corsOrigins || '*';
  const origin = allow === '*' ? true : allow.split(',').map((s) => s.trim()).filter(Boolean);
  app.register(cors, { origin });

  // 🟢 新增：Swagger API 文档（零风险，只生成文档，不影响业务逻辑）
  // 使用动态导入，避免在依赖未安装时崩溃
  try {
    const swagger = await import('@fastify/swagger');
    const swaggerUi = await import('@fastify/swagger-ui');
    
    await app.register(swagger.default, {
      openapi: {
        info: {
          title: 'Rabbit AI Backend API',
          description: 'Rabbit AI Backend API Documentation',
          version: '1.0.0',
        },
        servers: [
          {
            url: process.env.API_BASE_URL || 'http://localhost:8080',
            description: 'API Server',
          },
        ],
        tags: [
          { name: 'health', description: 'Health check endpoints' },
          { name: 'user', description: 'User related endpoints' },
          { name: 'mining', description: 'Mining/Claiming endpoints' },
          { name: 'asset', description: 'Asset management endpoints' },
          { name: 'admin', description: 'Admin panel endpoints' },
          { name: 'analytics', description: 'Analytics endpoints' },
          { name: 'vip', description: 'VIP tier endpoints' },
          { name: 'system', description: 'System configuration endpoints' },
        ],
      },
    });

    await app.register(swaggerUi.default, {
      routePrefix: '/docs',
      uiConfig: {
        docExpansion: 'list',
        deepLinking: true,
      },
      staticCSP: true,
      transformStaticCSP: (header: string) => header,
    });

    console.log('[startup] ✅ Swagger API documentation available at /docs');
  } catch (e: any) {
    console.warn('[startup] ⚠️  Failed to register Swagger:', e?.message || e);
    // Swagger 注册失败不影响服务启动
  }

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



