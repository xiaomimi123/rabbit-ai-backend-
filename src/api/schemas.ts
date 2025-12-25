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

export const AdminFinanceQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(20),
});

export const AdminUserListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
  search: z.string().max(200).optional(),
});


