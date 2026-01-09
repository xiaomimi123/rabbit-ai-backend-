import { z } from 'zod';

export const AddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid address');

export const TxHashSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, 'Invalid txHash');

export const UserInfoQuerySchema = z.object({
  address: AddressSchema,
});

export const TeamRewardsQuerySchema = z.object({
  address: AddressSchema,
});

export const WithdrawHistoryQuerySchema = z.object({
  address: AddressSchema,
});

export const VerifyClaimBodySchema = z.object({
  address: AddressSchema,
  txHash: TxHashSchema,
  referrer: AddressSchema.optional().default('0x0000000000000000000000000000000000000000'),
});

export const ApplyWithdrawBodySchema = z.object({
  address: AddressSchema,
  amount: z.string().min(1),
});

// Admin
export const AdminWithdrawCompleteBodySchema = z.object({
  payoutTxHash: TxHashSchema,
});

export const AdminWithdrawRejectBodySchema = z.object({
  reason: z.string().max(200).optional(),
});

export const AdminWithdrawListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

export const AdminUserQuerySchema = z.object({
  address: AddressSchema,
});

export const AdminRecentQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

export const AdminAdjustUserEnergyBodySchema = z.object({
  delta: z.coerce.number().finite().min(-1_000_000_000).max(1_000_000_000),
  reason: z.string().max(200).optional(),
});

export const AdminAdjustUserUsdtBodySchema = z.object({
  delta: z.coerce.number().finite().min(-1_000_000_000).max(1_000_000_000),
  reason: z.string().max(200).optional(),
});

// Analytics
export const RecordVisitBodySchema = z.object({
  pagePath: z.string().max(255).default('/'),
  walletAddress: AddressSchema.optional().nullable(),
  referrer: z.string().max(255).optional().nullable(),
  language: z.string().max(10).optional(),
  isMobile: z.boolean().optional().default(false),
  sessionId: z.string().max(64),
});

export const AdminVisitStatsQuerySchema = z.object({
  // 🟢 修复：接受日期格式（YYYY-MM-DD）或完整的 ISO 8601 日期时间格式
  startDate: z.string().refine(
    (val) => {
      if (!val) return true; // 可选字段
      // 接受 YYYY-MM-DD 或 ISO 8601 格式
      return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?)?$/.test(val);
    },
    { message: 'Invalid date format. Expected YYYY-MM-DD or ISO 8601 datetime' }
  ).optional(),
  endDate: z.string().refine(
    (val) => {
      if (!val) return true; // 可选字段
      // 接受 YYYY-MM-DD 或 ISO 8601 格式
      return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?)?$/.test(val);
    },
    { message: 'Invalid date format. Expected YYYY-MM-DD or ISO 8601 datetime' }
  ).optional(),
  country: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

// 🟢 新增：清理旧数据请求体
export const AdminCleanupVisitsBodySchema = z.object({
  daysToKeep: z.coerce.number().int().min(1).max(3650).optional().default(90), // 默认保留 90 天，最多 10 年
});

export const AdminSetSettlementTimeBodySchema = z.object({
  settlementTime: z.string().refine(
    (val) => !isNaN(new Date(val).getTime()),
    { message: 'Invalid ISO 8601 date format. Example: "2025-12-29T09:41:37.000Z"' }
  ),
  reason: z.string().max(200).optional(),
});

export const AdminFinanceQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(20),
});

export const AdminUserListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
  search: z.string().max(200).optional(),
  sortBy: z.enum(['ratBalance', 'inviteCount', 'createdAt']).optional().default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
});

export const AdminAdjustAssetBodySchema = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid address'),
  asset: z.enum(['RAT', 'USDT']),
  action: z.enum(['add', 'sub']),
  amount: z.string().regex(/^\d+(\.\d+)?$/, 'Invalid amount'),
});


// 操作记录查询参数
export const AdminOperationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
  type: z.enum(['all', 'Withdrawal', 'AirdropClaim', 'AddUSDT', 'DeductUSDT', 'AddEnergy', 'DeductEnergy']).optional().default('all'),
  address: AddressSchema.optional(),
});

// Revenue/Expenses 查询参数（支持日期范围）
export const AdminRevenueQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export const AdminExpensesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

// 通知相关 Schema
export const AdminSendNotificationBodySchema = z.object({
  address: AddressSchema,
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(2000),
  type: z.enum(['SYSTEM', 'REWARD', 'NETWORK']).optional().default('SYSTEM'),
});

export const AdminBroadcastNotificationBodySchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(2000),
  type: z.enum(['SYSTEM', 'REWARD', 'NETWORK']).optional().default('SYSTEM'),
});

// Auto Payout
export const AutoPayoutConfigBodySchema = z.object({
  privateKey: z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'Invalid private key format'),
  threshold: z.coerce.number().positive().max(1000), // 最大 1000 USDT
  enabled: z.boolean(),
  minBalance: z.coerce.number().positive().optional(),
  dailyLimit: z.coerce.number().positive().optional().nullable(),
});

export const AutoPayoutLogsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});


