import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { toErrorResponse } from '../errors.js';
import { getVipTiers, getVipTiersForAdmin, updateVipTier } from '../../services/vip.js';
import { assertAdmin } from '../adminAuth.js';

export function registerVipRoutes(app: FastifyInstance) {
  // GET /api/vip/tiers
  // 前端获取 VIP 等级配置（只返回启用的）
  app.get('/api/vip/tiers', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const data = await getVipTiers();
      return data;
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });

  // GET /api/admin/vip/tiers
  // 管理员获取所有 VIP 等级配置（包含禁用状态）
  app.get('/api/admin/vip/tiers', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    try {
      const data = await getVipTiersForAdmin();
      return data;
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });

  // PUT /api/admin/vip/tiers/:level
  // 管理员更新 VIP 等级配置
  app.put('/api/admin/vip/tiers/:level', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    const level = Number((req.params as any)?.level || 0);
    if (!Number.isInteger(level) || level < 1 || level > 4) {
      return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: 'Invalid level (1-4)' });
    }
    try {
      const body = req.body as any;
      const data = await updateVipTier(level, body);
      return data;
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });
}

