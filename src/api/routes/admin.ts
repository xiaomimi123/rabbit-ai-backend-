import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ethers } from 'ethers';
import { assertAdmin } from '../adminAuth.js';
import {
  AdminRecentQuerySchema,
  AddressSchema,
  AdminAdjustUserEnergyBodySchema,
  AdminAdjustUserUsdtBodySchema,
  AdminSetSettlementTimeBodySchema,
  AdminUserQuerySchema,
  AdminWithdrawCompleteBodySchema,
  AdminWithdrawListQuerySchema,
  AdminWithdrawRejectBodySchema,
  AdminFinanceQuerySchema,
  AdminUserListQuerySchema,
  AdminOperationsQuerySchema,
  AdminRevenueQuerySchema,
  AdminExpensesQuerySchema,
  AdminSendNotificationBodySchema,
  AdminBroadcastNotificationBodySchema,
  AdminVisitStatsQuerySchema,
  AdminCleanupVisitsBodySchema,
} from '../schemas.js';
import { toErrorResponse } from '../errors.js';
import {
  adminGetSystemConfig,
  adminAdjustUserEnergy,
  adminAdjustUserUsdt,
  adminSetUserSettlementTime,
  adminGetUser,
  adminGetUserTeam,
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
  getTopRATHolders,
  getAdminUsdtBalance,
  getRevenueStats,
  getAdminOperations,
  getAdminRevenueWithDateRange,
  getAdminExpensesWithDateRange,
} from '../../services/admin.js';
import { getVisitStats, getVisitSummary, getAnalyticsStats, cleanupOldVisits } from '../../services/analytics.js';
import { getAllEnergyConfigs } from '../../services/energyConfig.js';
import { sendUserNotification, broadcastNotification, getBroadcastHistory } from '../../services/notifications.js';
// 🟢 新增：能量配置管理
import { 
  getAllEnergyConfigs, 
  updateEnergyConfig, 
  getEnergyConfigHistory,
  clearEnergyConfigCache 
} from '../../services/energyConfig.js';

export function registerAdminRoutes(app: FastifyInstance, deps: { 
  getProvider: () => ethers.providers.Provider;
  getAdminProvider: () => ethers.providers.Provider;
}) {
  // 🌐 公开API：获取能量配置（用于用户前端显示）
  // 不需要管理员权限，任何用户都可以访问
  app.get('/api/public/energy-config', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const configs = await getAllEnergyConfigs();
      
      // 将数组转换为对象格式，方便前端使用
      const configObj: any = {};
      configs.forEach((item) => {
        configObj[item.key] = item.value;
      });
      
      return {
        ok: true,
        config: {
          withdraw_energy_ratio: configObj['withdraw_energy_ratio'] || 10,
          claim_self_reward: configObj['claim_self_reward'] || 1,
          claim_referrer_first: configObj['claim_referrer_first'] || 3,
          claim_referrer_repeat: configObj['claim_referrer_repeat'] || 1,
        }
      };
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(500).send({
        ok: false,
        config: {
          withdraw_energy_ratio: 10,
          claim_self_reward: 1,
          claim_referrer_first: 3,
          claim_referrer_repeat: 1,
        },
        error: err.message
      });
    }
  });

  // 🟢 新增：简单的认证验证接口，只验证密钥，不调用 RPC
  // 用于登录验证，避免在登录时触发网络错误
  app.get('/api/admin/auth/verify', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    // 如果 assertAdmin 通过，说明密钥有效
    return {
      ok: true,
      message: 'Admin key verified successfully',
      timestamp: new Date().toISOString(),
    };
  });

  app.get('/api/admin/kpis', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    try {
      // 🟢 使用专用的 Admin RPC Provider 查询 RAT 持仓
      return await getAdminKpis(deps.getAdminProvider());
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
      // 🟢 使用专用的 Admin RPC Provider 查询用户 RAT 余额
      return await adminGetUser(deps.getAdminProvider(), parsed.data.address);
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });

  app.get('/api/admin/users/:address/team', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    const addrParsed = AddressSchema.safeParse(String((req.params as any)?.address || '').toLowerCase());
    if (!addrParsed.success) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: addrParsed.error.message });
    
    // 🟢 解析分页参数
    const limit = Number((req.query as any)?.limit || 50);
    const offset = Number((req.query as any)?.offset || 0);
    
    // 验证参数
    if (limit < 1 || limit > 200) {
      return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: 'limit must be between 1 and 200' });
    }
    if (offset < 0) {
      return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: 'offset must be >= 0' });
    }
    
    try {
      return await adminGetUserTeam(addrParsed.data, { limit, offset });
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });

  // GET /api/admin/users/:address/earnings - 获取用户实时收益（需要 admin 认证）
  app.get('/api/admin/users/:address/earnings', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    const addrParsed = AddressSchema.safeParse(String((req.params as any)?.address || '').toLowerCase());
    if (!addrParsed.success) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: addrParsed.error.message });
    try {
      const { calculateUserEarnings } = await import('../../services/earnings.js');
      // 🟢 使用专用的 Admin RPC Provider 查询用户 RAT 余额
      const result = await calculateUserEarnings(deps.getAdminProvider(), addrParsed.data);
      // 只返回前端需要的字段
      return {
        ok: true,
        pendingUsdt: result.pendingUsdt,
        dailyRate: result.dailyRate,
        currentTier: result.currentTier,
        holdingDays: result.holdingDays,
      };
    } catch (e) {
      // 🟢 改进：即使计算失败，也返回默认值，避免阻塞用户列表加载
      console.error(`[Admin] Failed to calculate earnings for ${addrParsed.data}:`, e);
      const err = toErrorResponse(e);
      // 返回默认值而不是错误，确保前端能正常显示
      return {
        ok: true,
        pendingUsdt: '0',
        dailyRate: 0,
        currentTier: 0,
        holdingDays: 0,
      };
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

  // POST /api/admin/users/:address/settlement-time
  // 管理员手动设置用户的 last_settlement_time
  // 用于处理通过直接转账获得代币的情况，确保收益从正确的时间开始计算
  app.post('/api/admin/users/:address/settlement-time', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    const addrParsed = AddressSchema.safeParse(String((req.params as any)?.address || '').toLowerCase());
    if (!addrParsed.success) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: addrParsed.error.message });

    const body = AdminSetSettlementTimeBodySchema.safeParse(req.body || {});
    if (!body.success) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: body.error.message });

    try {
      return await adminSetUserSettlementTime(addrParsed.data, body.data.settlementTime);
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

  // GET /api/admin/users/list - 用户列表（支持分页、搜索和排序）
  app.get('/api/admin/users/list', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    const parsed = AdminUserListQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: parsed.error.message });
    try {
      return await adminListUsers({
        limit: parsed.data.limit,
        offset: parsed.data.offset,
        search: parsed.data.search,
        sortBy: parsed.data.sortBy,
        sortOrder: parsed.data.sortOrder,
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

  // GET /api/admin/top-holders?limit=5 - 获取 RAT 持币大户排行
  app.get('/api/admin/top-holders', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    const limit = Number((req.query as any)?.limit || 5);
    if (limit < 1 || limit > 20) {
      return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: 'limit must be between 1 and 20' });
    }
    try {
      // 🟢 使用专用的 Admin RPC Provider 查询 RAT 持币大户
      return await getTopRATHolders(deps.getAdminProvider(), limit);
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });

  // GET /api/admin/usdt-balance - 获取管理员支付地址的 USDT 余额
  app.get('/api/admin/usdt-balance', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    try {
      const balance = await getAdminUsdtBalance(deps.getProvider());
      return { ok: true, balance };
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });

  // GET /api/admin/revenue/stats - 获取收益统计信息
  app.get('/api/admin/revenue/stats', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    try {
      return await getRevenueStats(deps.getProvider());
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });


  // GET /api/admin/indexer/status
  // 获取 Indexer 同步状态
  app.get('/api/admin/indexer/status', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    try {
      const { supabase } = await import('../../infra/supabase.js');
      const { config } = await import('../../config.js');
      const provider = deps.getProvider();
      
      // 获取链上最新区块
      const latestBlock = await provider.getBlockNumber();
      const safeHead = Math.max(0, latestBlock - config.confirmations);
      
      // 获取数据库中的最后同步区块
      const { data: syncState, error } = await supabase
        .from('chain_sync_state')
        .select('id,last_block,updated_at')
        .eq('id', config.chainSyncId)
        .maybeSingle();
      
      if (error) throw error;
      
      const lastSyncedBlock = syncState ? Number(syncState.last_block || 0) : 0;
      const blocksBehind = Math.max(0, safeHead - lastSyncedBlock);
      const isSyncing = blocksBehind > 0;
      
      return {
        ok: true,
        latestBlock,
        safeHead,
        lastSyncedBlock,
        blocksBehind,
        isSyncing,
        confirmations: config.confirmations,
        pollIntervalMs: config.pollIntervalMs,
        lastUpdated: syncState?.updated_at || null,
      };
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });

  // POST /api/admin/indexer/manual-index
  // 手动索引单个交易（用于修复 Indexer 遗漏的交易）
  app.post('/api/admin/indexer/manual-index', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    try {
      const body = req.body as { txHash: string };
      if (!body.txHash || typeof body.txHash !== 'string') {
        return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: 'Missing or invalid txHash' });
      }
      
      const { manualIndexTransaction } = await import('../../services/indexer.js');
      const provider = deps.getProvider();
      const result = await manualIndexTransaction(provider, body.txHash);
      
      if (result.success) {
        return { ok: true, ...result };
      } else {
        return reply.status(400).send({ ok: false, code: 'INDEX_FAILED', message: result.message, details: result.details });
      }
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });

  // GET /api/admin/revenue - 获取收益明细（支持日期范围）
  app.get('/api/admin/revenue', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    const parsed = AdminRevenueQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: parsed.error.message });
    try {
      return await getAdminRevenueWithDateRange(deps.getProvider(), parsed.data);
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });

  // GET /api/admin/expenses - 获取支出明细（支持日期范围）
  app.get('/api/admin/expenses', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    const parsed = AdminExpensesQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: parsed.error.message });
    try {
      return await getAdminExpensesWithDateRange(parsed.data);
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });

  // GET /api/admin/operations - 获取操作记录（提现和空投领取）
  app.get('/api/admin/operations', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    const parsed = AdminOperationsQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: parsed.error.message });
    try {
      return await getAdminOperations(parsed.data);
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });

  // POST /api/admin/notifications/send - 发送个人通知
  app.post('/api/admin/notifications/send', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    const body = AdminSendNotificationBodySchema.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: body.error.message });
    try {
      return await sendUserNotification(body.data);
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });

  // GET /api/admin/analytics/visits - 获取访问统计列表
  app.get('/api/admin/analytics/visits', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    const parsed = AdminVisitStatsQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: parsed.error.message });
    try {
      return await getVisitStats(parsed.data);
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });

  // GET /api/admin/analytics/summary - 获取访问统计摘要
  app.get('/api/admin/analytics/summary', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    const parsed = AdminVisitStatsQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: parsed.error.message });
    try {
      return await getVisitSummary({
        startDate: parsed.data.startDate,
        endDate: parsed.data.endDate,
      });
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });

  // 🟢 新增：GET /api/admin/analytics/stats - 获取数据库统计信息
  app.get('/api/admin/analytics/stats', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    try {
      const stats = await getAnalyticsStats();
      return stats;
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(500).send(err);
    }
  });

  // 🟢 新增：POST /api/admin/analytics/cleanup - 清理旧数据
  app.post('/api/admin/analytics/cleanup', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    const body = AdminCleanupVisitsBodySchema.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: body.error.message });
    try {
      const result = await cleanupOldVisits(body.data.daysToKeep);
      return result;
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(500).send(err);
    }
  });

  // POST /api/admin/notifications/broadcast - 广播通知给所有用户
  app.post('/api/admin/notifications/broadcast', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    const body = AdminBroadcastNotificationBodySchema.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: body.error.message });
    try {
      return await broadcastNotification(body.data);
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });

  // GET /api/admin/notifications/broadcast/history - 获取广播历史记录
  app.get('/api/admin/notifications/broadcast/history', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    try {
      return await getBroadcastHistory();
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });

  // 🟢 新增：POST /api/admin/telegram/test - 测试 Telegram Bot 连接
  app.post('/api/admin/telegram/test', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    try {
      const { sendTestMessage } = await import('../../services/telegram.js');
      const result = await sendTestMessage();
      return result;
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(500).send(err);
    }
  });

  // ⚡ 能量配置管理路由
  
  // GET /api/admin/energy-config - 获取所有能量配置
  app.get('/api/admin/energy-config', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    try {
      const configs = await getAllEnergyConfigs();
      return { ok: true, configs };
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });

  // POST /api/admin/energy-config/update - 更新能量配置
  app.post('/api/admin/energy-config/update', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    const { key, value, reason } = req.body as any;
    
    if (!key || typeof value !== 'number') {
      return reply.status(400).send({ 
        ok: false, 
        code: 'INVALID_REQUEST',
        message: 'Invalid request: key and value are required' 
      });
    }
    
    try {
      // TODO: 从 session/token 获取管理员信息
      const changedBy = 'admin'; // 临时硬编码
      
      const result = await updateEnergyConfig(key, value, changedBy, reason);
      
      // 清除缓存，确保新配置立即生效
      clearEnergyConfigCache();
      
      console.log(`[Admin] ✅ 能量配置已更新: ${key} = ${value}`);
      
      return { 
        ...result,
        message: `配置已更新: ${key} = ${value}` 
      };
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });

  // GET /api/admin/energy-config/history - 获取配置变更历史
  app.get('/api/admin/energy-config/history', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    const { key, limit } = req.query as any;
    const limitNum = limit ? parseInt(limit, 10) : 50;
    
    try {
      const history = await getEnergyConfigHistory(key, limitNum);
      return { ok: true, history };
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });

  // POST /api/admin/energy-config/clear-cache - 清除配置缓存
  app.post('/api/admin/energy-config/clear-cache', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(req, reply)) return;
    try {
      clearEnergyConfigCache();
      console.log('[Admin] 🔄 能量配置缓存已清除');
      return { ok: true, message: '配置缓存已清除' };
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });
}


