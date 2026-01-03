import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { toErrorResponse } from '../errors.js';
import { recordPageVisit, getClientIp, checkRateLimit } from '../../services/analytics.js';
import { RecordVisitBodySchema } from '../schemas.js';
import { config } from '../../config.js';

export function registerAnalyticsRoutes(app: FastifyInstance) {
  // POST /api/analytics/visit
  // 记录页面访问（公开 API，无需认证）
  app.post('/api/analytics/visit', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      // 🟢 修复2: 来源验证 - 检查 Origin 和 Referer
      const origin = req.headers.origin || req.headers.referer || '';
      const allowedOrigins = config.corsOrigins === '*' 
        ? [] // 如果允许所有来源，则不验证
        : (config.corsOrigins || '').split(',').map(s => s.trim()).filter(Boolean);
      
      if (allowedOrigins.length > 0) {
        const isValidOrigin = allowedOrigins.some(allowed => {
          try {
            const originUrl = new URL(origin);
            const allowedUrl = new URL(allowed);
            return originUrl.origin === allowedUrl.origin;
          } catch {
            return false;
          }
        });
        
        if (!isValidOrigin && origin) {
          console.warn(`[Analytics] ⚠️ Invalid origin for visit API: ${origin}`);
          // 不直接拒绝，但记录警告（因为可能来自移动端或特殊场景）
        }
      }

      // 🟢 修复2: Rate Limit - 检查同一 IP 的请求频率
      const clientIp = getClientIp(req);
      if (clientIp) {
        const rateLimitResult = await checkRateLimit(clientIp);
        if (!rateLimitResult.allowed) {
          console.warn(`[Analytics] ⚠️ Rate limit exceeded for IP ${clientIp}`);
          // 静默失败，不返回错误（避免暴露限流信息）
          return { ok: false, message: 'Visit recording failed silently' };
        }
      }

      const body = RecordVisitBodySchema.safeParse(req.body || {});
      if (!body.success) {
        return reply.status(400).send({ 
          ok: false, 
          code: 'INVALID_REQUEST', 
          message: body.error.message 
        });
      }

      // 获取 User-Agent
      const userAgent = req.headers['user-agent'] || null;

      // 记录访问
      const result = await recordPageVisit({
        ip: clientIp,
        userAgent,
        pagePath: body.data.pagePath,
        walletAddress: body.data.walletAddress,
        referrer: body.data.referrer,
        language: body.data.language,
        isMobile: body.data.isMobile,
        sessionId: body.data.sessionId,
      });

      return {
        ok: result.ok,
        message: result.ok ? 'Visit recorded' : 'Failed to record visit',
      };
    } catch (e) {
      const err = toErrorResponse(e);
      // 不返回错误给前端，避免影响用户体验
      return { ok: false, message: 'Visit recording failed silently' };
    }
  });
}

