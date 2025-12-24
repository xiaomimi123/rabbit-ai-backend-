import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ethers } from 'ethers';
import { ApplyWithdrawBodySchema, WithdrawHistoryQuerySchema, UserInfoQuerySchema } from '../schemas.js';
import { applyWithdraw, getWithdrawHistory } from '../../services/withdraw.js';
import { getRatBalance, getEarnings } from '../../services/earnings.js';
import { toErrorResponse } from '../errors.js';

export function registerAssetRoutes(app: FastifyInstance, deps: { getProvider: () => ethers.providers.Provider }) {
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
      const data = await getWithdrawHistory(parsed.data.address);
      return data || [];
    } catch (e) {
      console.error('Error in /api/asset/withdraw/history:', e);
      return []; // 返回空数组而不是错误
    }
  });

  // GET /api/asset/rat-balance?address=0x...
  // 返回用户钱包中的 RAT 余额（从链上读取）
  app.get('/api/asset/rat-balance', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = UserInfoQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: parsed.error.message });
    try {
      const provider = deps.getProvider();
      if (!provider) {
        return reply.status(503).send({ ok: false, code: 'SERVICE_UNAVAILABLE', message: 'Provider not available' });
      }
      const data = await getRatBalance(parsed.data.address, provider);
      return data;
    } catch (e) {
      // 即使出错也返回默认值，而不是错误响应
      console.error('Error in /api/asset/rat-balance:', e);
      return { balance: '0' };
    }
  });

  // GET /api/asset/earnings?address=0x...
  // 返回持币生息收益信息
  app.get('/api/asset/earnings', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = UserInfoQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: parsed.error.message });
    try {
      const provider = deps.getProvider();
      if (!provider) {
        return reply.status(503).send({ ok: false, code: 'SERVICE_UNAVAILABLE', message: 'Provider not available' });
      }
      const data = await getEarnings(parsed.data.address, provider);
      return data;
    } catch (e) {
      // 即使出错也返回默认值，而不是错误响应
      console.error('Error in /api/asset/earnings:', e);
      return {
        pendingUsdt: '0',
        dailyRate: 0,
        currentTier: 0,
        holdingDays: 0,
      };
    }
  });
}


