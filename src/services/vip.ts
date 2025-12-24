import { supabase } from '../infra/supabase.js';
import { ApiError } from '../api/errors.js';

// 前端获取 VIP 等级配置（只返回启用的）
export async function getVipTiers() {
  const { data, error } = await supabase
    .from('vip_tiers')
    .select('*')
    .eq('is_active', true)
    .order('display_order', { ascending: true });

  if (error) throw error;

  return {
    ok: true,
    tiers: (data || []).map((t: any) => ({
      level: t.level,
      name: t.name,
      min: Number(t.min_balance),
      max: t.max_balance === null ? Infinity : Number(t.max_balance),
      dailyRate: Number(t.daily_rate),
    })),
  };
}

// 管理员获取所有 VIP 等级配置
export async function getVipTiersForAdmin() {
  const { data, error } = await supabase
    .from('vip_tiers')
    .select('*')
    .order('display_order', { ascending: true });

  if (error) throw error;

  return {
    ok: true,
    tiers: (data || []).map((t: any) => ({
      level: t.level,
      name: t.name,
      minBalance: String(t.min_balance),
      maxBalance: t.max_balance === null ? null : String(t.max_balance),
      dailyRate: Number(t.daily_rate),
      isActive: t.is_active,
      displayOrder: t.display_order,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
    })),
  };
}

// 管理员更新 VIP 等级配置
export async function updateVipTier(level: number, updates: {
  name?: string;
  minBalance?: number;
  maxBalance?: number | null;
  dailyRate?: number;
  isActive?: boolean;
}) {
  // 验证配置
  if (updates.dailyRate !== undefined && (updates.dailyRate < 0 || updates.dailyRate > 20)) {
    throw new ApiError('INVALID_REQUEST', 'Daily rate must be between 0 and 20', 400);
  }

  if (updates.minBalance !== undefined && updates.minBalance < 0) {
    throw new ApiError('INVALID_REQUEST', 'Min balance must be >= 0', 400);
  }

  // 更新数据库
  const updateData: any = {
    updated_at: new Date().toISOString(),
  };

  if (updates.name !== undefined) updateData.name = updates.name;
  if (updates.minBalance !== undefined) updateData.min_balance = updates.minBalance;
  if (updates.maxBalance !== undefined) updateData.max_balance = updates.maxBalance;
  if (updates.dailyRate !== undefined) updateData.daily_rate = updates.dailyRate;
  if (updates.isActive !== undefined) updateData.is_active = updates.isActive;

  const { data, error } = await supabase
    .from('vip_tiers')
    .update(updateData)
    .eq('level', level)
    .select()
    .single();

  if (error) throw error;

  return {
    ok: true,
    tier: {
      level: data.level,
      name: data.name,
      minBalance: String(data.min_balance),
      maxBalance: data.max_balance === null ? null : String(data.max_balance),
      dailyRate: Number(data.daily_rate),
      isActive: data.is_active,
      displayOrder: data.display_order,
      updatedAt: data.updated_at,
    },
  };
}

