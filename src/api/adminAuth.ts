import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';

export function assertAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!config.adminApiKey) {
    reply.status(503).send({ ok: false, code: 'ADMIN_DISABLED', message: 'ADMIN_API_KEY is not configured' });
    return false;
  }

  const key = String((req.headers['x-admin-api-key'] as any) || '');
  if (!key || key !== config.adminApiKey) {
    reply.status(401).send({ ok: false, code: 'UNAUTHORIZED', message: 'Invalid admin api key' });
    return false;
  }
  return true;
}


