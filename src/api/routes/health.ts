import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export function registerHealthRoutes(app: FastifyInstance) {
  app.get('/api/health', async (_req: FastifyRequest, _reply: FastifyReply) => {
    return { ok: true, time: new Date().toISOString() };
  });
}


