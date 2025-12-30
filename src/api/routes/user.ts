import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { TeamRewardsQuerySchema, UserInfoQuerySchema } from '../schemas.js';
import { getTeamRewards, getUserInfo, getClaimsHistory, getReferralHistory } from '../../services/user.js';
import { getUserNotifications, markNotificationAsRead, markAllNotificationsAsRead, deleteNotification } from '../../services/notifications.js';
import { toErrorResponse } from '../errors.js';

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

  app.get('/api/user/claims', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = UserInfoQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: parsed.error.message });

    try {
      const data = await getClaimsHistory(parsed.data.address);
      return data || [];
    } catch (e) {
      console.error('Error in /api/user/claims:', e);
      return []; // 返回空数组而不是错误
    }
  });

  app.get('/api/user/referrals', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = UserInfoQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: parsed.error.message });

    try {
      const data = await getReferralHistory(parsed.data.address);
      return data || [];
    } catch (e) {
      console.error('Error in /api/user/referrals:', e);
      return []; // 返回空数组而不是错误
    }
  });

  // GET /api/user/notifications?address=0x...
  app.get('/api/user/notifications', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = UserInfoQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: parsed.error.message });
    try {
      const data = await getUserNotifications(parsed.data.address);
      // 如果没有通知，返回空数组而不是404
      return data || [];
    } catch (e) {
      // 如果查询失败，返回空数组而不是错误
      console.error('Failed to get user notifications:', e);
      return [];
    }
  });

  // POST /api/user/notifications/read
  app.post('/api/user/notifications/read', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as { address: string; notificationId: string };
    if (!body.address || !body.notificationId) {
      return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: 'Missing address or notificationId' });
    }
    try {
      const data = await markNotificationAsRead(body.address, body.notificationId);
      return data;
    } catch (e) {
      return reply.status(400).send({ ok: false, code: 'ERROR', message: String(e) });
    }
  });

  // POST /api/user/notifications/read-all
  app.post('/api/user/notifications/read-all', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as { address: string };
    if (!body.address) {
      return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: 'Missing address' });
    }
    try {
      const data = await markAllNotificationsAsRead(body.address);
      return data;
    } catch (e) {
      return reply.status(400).send({ ok: false, code: 'ERROR', message: String(e) });
    }
  });

  // POST /api/user/notifications/delete
  app.post('/api/user/notifications/delete', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as { address: string; notificationId: string };
    if (!body.address || !body.notificationId) {
      return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: 'Missing address or notificationId' });
    }
    try {
      const data = await deleteNotification(body.address, body.notificationId);
      return data;
    } catch (e) {
      return reply.status(400).send({ ok: false, code: 'ERROR', message: String(e) });
    }
  });
}
