import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { toErrorResponse } from '../errors.js';
import { getSystemLinks, getSystemAnnouncement } from '../../services/system.js';

export function registerSystemRoutes(app: FastifyInstance) {
  // GET /api/system/links
  // 返回系统链接配置（白皮书、审计报告、客服链接）
  app.get('/api/system/links', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const data = await getSystemLinks();
      // 如果所有链接都为空，返回404
      if (!data.whitepaper && !data.audits && !data.support) {
        return reply.status(404).send({ ok: false, code: 'NOT_FOUND', message: 'System links not configured' });
      }
      return data;
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });

  // GET /api/system/announcement
  // 返回系统公告
  app.get('/api/system/announcement', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const data = await getSystemAnnouncement();
      // 如果没有公告，返回404
      if (!data) {
        return reply.status(404).send({ ok: false, code: 'NOT_FOUND', message: 'No announcement found' });
      }
      return data;
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });
}

