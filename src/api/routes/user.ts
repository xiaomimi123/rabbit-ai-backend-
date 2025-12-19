import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { TeamRewardsQuerySchema, UserInfoQuerySchema } from '../schemas';
import { getTeamRewards, getUserInfo } from '../../services/user';

export function registerUserRoutes(app: FastifyInstance) {
  app.get('/api/user/info', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = UserInfoQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: parsed.error.message });
    const data = await getUserInfo(parsed.data.address);
    return data;
  });

  app.get('/api/user/team-rewards', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = TeamRewardsQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: parsed.error.message });
    const data = await getTeamRewards(parsed.data.address);
    return data;
  });
}


