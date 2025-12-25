import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ethers } from 'ethers';
import { ApplyWithdrawBodySchema, WithdrawHistoryQuerySchema, UserInfoQuerySchema } from '../schemas.js';
import { applyWithdraw, getWithdrawHistory } from '../../services/withdraw.js';
import { calculateUserEarnings } from '../../services/earnings.js';
import { ERC20_ABI } from '../../infra/abis.js';
import { config } from '../../config.js';
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

  // GET /api/asset/earnings?address=0x...
  // 返回持币生息收益信息
  app.get('/api/asset/earnings', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = UserInfoQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: parsed.error.message });

    try {
      const provider = deps.getProvider();
      const result = await calculateUserEarnings(provider, parsed.data.address);
      // 只返回前端需要的字段
      return {
        pendingUsdt: result.pendingUsdt,
        dailyRate: result.dailyRate,
        currentTier: result.currentTier,
        holdingDays: result.holdingDays,
      };
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });

  // GET /api/asset/rat-balance?address=0x...
  // 返回用户钱包中的 RAT 余额（从链上读取）
  app.get('/api/asset/rat-balance', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = UserInfoQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: parsed.error.message });

    try {
      // 注意：RAT_TOKEN_CONTRACT 在启动时已检查，这里不需要再次检查
      const provider = deps.getProvider();
      const ratContract = new ethers.Contract(config.ratTokenContract, ERC20_ABI, provider);
      const balanceWei = await ratContract.balanceOf(parsed.data.address);
      const decimals = await ratContract.decimals().catch(() => 18);
      const balanceStr = ethers.utils.formatUnits(balanceWei, decimals);
      const balance = parseFloat(balanceStr);

      return {
        balance: balance.toFixed(2),
      };
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });
}
