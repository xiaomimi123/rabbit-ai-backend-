import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ethers } from 'ethers';
import { assertAdmin } from '../adminAuth.js';
import {
  AdminRecentQuerySchema,
  AddressSchema,
  AdminAdjustUserEnergyBodySchema,
  AdminAdjustUserUsdtBodySchema,
  AdminUserQuerySchema,
  AdminWithdrawCompleteBodySchema,
  AdminWithdrawListQuerySchema,
  AdminWithdrawRejectBodySchema,
  AdminFinanceQuerySchema,
  AdminUserListQuerySchema,
} from '../schemas.js';
import { toErrorResponse } from '../errors.js';
import {
  adminGetSystemConfig,
  adminAdjustUserEnergy,
  adminAdjustUserUsdt,
  adminGetUser,
  adminListRecentClaims,
  adminListRecentUsers,
  adminListUsers,
  adminSetSystemConfig,
  completeWithdrawal,
  getAdminKpis,
  getUsdtInfo,
  listPendingWithdrawals,
  rejectWithdrawal,
  getFinanceRevenue,
  getFinanceExpenses,
} from '../../services/admin.js';

export function registerAdminRoutes(app: FastifyInstance, deps: { getProvider: () => ethers.providers.Provider }) {
  app.get('/api/admin/kpis', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    try {
      return await getAdminKpis(deps.getProvider());
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });

  app.get('/api/admin/withdrawals/pending', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    const parsed = AdminWithdrawListQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: parsed.error.message });
    try {
      return await listPendingWithdrawals(parsed.data.limit);
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });

  app.post('/api/admin/withdrawals/:id/reject', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    const body = AdminWithdrawRejectBodySchema.safeParse(req.body || {});
    if (!body.success) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: body.error.message });
    const id = String((req.params as any)?.id || '');
    try {
      // reason is accepted (MVP), not persisted in DB schema by default
      return await rejectWithdrawal(id);
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });

  app.post('/api/admin/withdrawals/:id/complete', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    const body = AdminWithdrawCompleteBodySchema.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: body.error.message });
    const id = String((req.params as any)?.id || '');
    try {
      return await completeWithdrawal({ provider: deps.getProvider(), withdrawalId: id, payoutTxHash: body.data.payoutTxHash });
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });

  app.get('/api/admin/system/usdt', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    try {
      return await getUsdtInfo(deps.getProvider());
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });

  app.get('/api/admin/system/config', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    try {
      return await adminGetSystemConfig();
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });

  app.put('/api/admin/system/config/:key', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    const key = String((req.params as any)?.key || '').trim();
    if (!key) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: 'Missing key' });
    try {
      return await adminSetSystemConfig(key, (req.body as any) ?? {});
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });

  app.get('/api/admin/users', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    const parsed = AdminUserQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: parsed.error.message });
    try {
      return await adminGetUser(deps.getProvider(), parsed.data.address);
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });

  app.post('/api/admin/users/:address/energy', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    const addrParsed = AddressSchema.safeParse(String((req.params as any)?.address || '').toLowerCase());
    if (!addrParsed.success) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: addrParsed.error.message });

    const body = AdminAdjustUserEnergyBodySchema.safeParse(req.body || {});
    if (!body.success) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: body.error.message });

    try {
      return await adminAdjustUserEnergy(addrParsed.data, body.data.delta);
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });

  app.post('/api/admin/users/:address/usdt', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    const addrParsed = AddressSchema.safeParse(String((req.params as any)?.address || '').toLowerCase());
    if (!addrParsed.success) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: addrParsed.error.message });

    const body = AdminAdjustUserUsdtBodySchema.safeParse(req.body || {});
    if (!body.success) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: body.error.message });

    try {
      return await adminAdjustUserUsdt(addrParsed.data, body.data.delta);
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });

  app.get('/api/admin/users/recent', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    const parsed = AdminRecentQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: parsed.error.message });
    try {
      return await adminListRecentUsers(parsed.data.limit);
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });

  // GET /api/admin/users/list - 用户列表（支持分页和搜索）
  app.get('/api/admin/users/list', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    const parsed = AdminUserListQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: parsed.error.message });
    try {
      return await adminListUsers({
        limit: parsed.data.limit,
        offset: parsed.data.offset,
        search: parsed.data.search,
      });
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });

  app.get('/api/admin/claims/recent', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    const parsed = AdminRecentQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: parsed.error.message });
    try {
      return await adminListRecentClaims(parsed.data.limit);
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });

  app.get('/api/admin/finance/revenue', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    const parsed = AdminFinanceQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: parsed.error.message });
    try {
      return await getFinanceRevenue(deps.getProvider(), parsed.data.page, parsed.data.pageSize);
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });

  app.get('/api/admin/finance/expenses', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    const parsed = AdminFinanceQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: parsed.error.message });
    try {
      return await getFinanceExpenses(parsed.data.page, parsed.data.pageSize);
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });
}


