import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApplyWithdrawBodySchema, WithdrawHistoryQuerySchema } from '../schemas';
import { applyWithdraw, getWithdrawHistory } from '../../services/withdraw';
import { toErrorResponse } from '../errors';

export function registerAssetRoutes(app: FastifyInstance) {
  app.post('/api/asset/withdraw/apply', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = ApplyWithdrawBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: parsed.error.message });

    try {
      return await applyWithdraw(parsed.data.address, parsed.data.amount);
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });

  app.get('/api/asset/withdraw/history', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = WithdrawHistoryQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: parsed.error.message });

    try {
      return await getWithdrawHistory(parsed.data.address);
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });
}


