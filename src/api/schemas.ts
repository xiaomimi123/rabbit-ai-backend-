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
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  country: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
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
  limit: z.coerce.number().int().min(1).max(200).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
  search: z.string().max(200).optional(),
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
  type: z.enum(['all', 'Withdrawal', 'AirdropClaim']).optional().default('all'),
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


