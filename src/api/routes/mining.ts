import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { VerifyClaimBodySchema } from '../schemas';
import { toErrorResponse } from '../errors';
import { verifyClaim } from '../../services/verifyClaim';
import type { ethers } from 'ethers';

export function registerMiningRoutes(app: FastifyInstance, deps: { getProvider: () => ethers.providers.Provider }) {
  app.post('/api/mining/verify-claim', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = VerifyClaimBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: parsed.error.message });

    try {
      const res = await verifyClaim({
        provider: deps.getProvider(),
        address: parsed.data.address,
        txHash: parsed.data.txHash,
        referrer: parsed.data.referrer,
      });
      return res;
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });
}


