import { supabase } from '../infra/supabase.js';

/**
 * VIP 等级配置接口
 */
export interface VipTier {
  level: number;
  name: string;
  minBalance: number;
  maxBalance: number | null; // null 表示无上限
  dailyRate: number; // 日利率（百分比，例如 2.0 表示 2%）
  isActive: boolean;
  displayOrder: number;
}

/**
 * VIP 配置缓存（内存变量）
 */
let vipTiersCache: VipTier[] | null = null;

/**
 * 从数据库加载 VIP 配置到内存
 * 应该在服务启动时调用
 */
export async function loadVipTiers(): Promise<void> {
  try {
    const { data, error } = await supabase
      .from('vip_tiers')
      .select('level, name, min_balance, max_balance, daily_rate, is_active, display_order')
      .eq('is_active', true)
      .order('display_order', { ascending: true });

    if (error) {
      console.error('[VIP Config] Failed to load VIP tiers:', error);
      // 如果加载失败，使用默认配置作为降级方案
      vipTiersCache = getDefaultVipTiers();
      return;
    }

    if (!data || data.length === 0) {
      console.warn('[VIP Config] No VIP tiers found in database, using defaults');
      vipTiersCache = getDefaultVipTiers();
      return;
    }

    // 转换数据库格式到内存格式
    vipTiersCache = data.map((row: any) => ({
      level: row.level,
      name: row.name,
      minBalance: Number(row.min_balance),
      maxBalance: row.max_balance ? Number(row.max_balance) : null,
      dailyRate: Number(row.daily_rate) / 100, // 转换为小数（例如 2.0 -> 0.02）
      isActive: row.is_active,
      displayOrder: row.display_order,
    }));

    console.log(`[VIP Config] Loaded ${vipTiersCache.length} VIP tiers from database`);
  } catch (error: any) {
    console.error('[VIP Config] Error loading VIP tiers:', error);
    vipTiersCache = getDefaultVipTiers();
  }
}

/**
 * 获取默认 VIP 配置（降级方案）
 */
function getDefaultVipTiers(): VipTier[] {
  return [
    { level: 1, name: '🌱 新手', minBalance: 10000, maxBalance: 49999, dailyRate: 0.02, isActive: true, displayOrder: 1 },
    { level: 2, name: '🌿 进阶', minBalance: 50000, maxBalance: 99999, dailyRate: 0.04, isActive: true, displayOrder: 2 },
    { level: 3, name: '🌳 资深', minBalance: 100000, maxBalance: 199999, dailyRate: 0.06, isActive: true, displayOrder: 3 },
    { level: 4, name: '💎 核心', minBalance: 200000, maxBalance: null, dailyRate: 0.10, isActive: true, displayOrder: 4 },
  ];
}

/**
 * 获取内存中的 VIP 配置
 * 如果未加载，返回默认配置
 */
export function getVipTiers(): VipTier[] {
  if (!vipTiersCache) {
    console.warn('[VIP Config] Cache not loaded, using defaults');
    return getDefaultVipTiers();
  }
  return vipTiersCache;
}

/**
 * 根据 RAT 余额确定 VIP 等级和日利率
 * @param balance RAT 余额（数字）
 * @returns { dailyRate: number, tier: number } 日利率（小数）和 VIP 等级（0-4）
 */
export function getVipTierByBalance(balance: number): { dailyRate: number; tier: number } {
  const tiers = getVipTiers();
  
  // 从高到低查找匹配的等级
  for (let i = tiers.length - 1; i >= 0; i--) {
    const tier = tiers[i];
    if (balance >= tier.minBalance) {
      // 检查是否有上限
      if (tier.maxBalance === null || balance <= tier.maxBalance) {
        return { dailyRate: tier.dailyRate, tier: tier.level };
      }
    }
  }
  
  // 未达到任何等级
  return { dailyRate: 0, tier: 0 };
}

/**
 * 刷新 VIP 配置缓存（用于配置更新后刷新）
 */
export async function refreshVipTiers(): Promise<void> {
  await loadVipTiers();
}

