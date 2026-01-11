import { supabase } from '../infra/supabase.js';

/**
 * VIP 等级配置接口
 */
export interface VipTier {
  level: number;
  name: string;
  minBalance: number;
  maxBalance: number | null; // null 表示无上限
  dailyRate: number; // 🔧 修复：日利率（百分比整数，例如 4 表示 4%，使用时需除以100）
  isActive: boolean;
  displayOrder: number;
}

/**
 * VIP 配置缓存（内存变量）
 */
let vipTiersCache: VipTier[] | null = null;
let lastCacheTime: number = 0;
const CACHE_TTL = 60 * 1000; // 🟢 缓存有效期：60秒（1分钟）

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
      dailyRate: Number(row.daily_rate), // 🔧 修复：保持百分比整数（例如 4 表示 4%），在使用时除以100
      isActive: row.is_active,
      displayOrder: row.display_order,
    }));

    lastCacheTime = Date.now(); // 🟢 记录缓存时间
    console.log(`[VIP Config] ✅ Loaded ${vipTiersCache.length} VIP tiers from database:`, 
      vipTiersCache.map(t => `${t.name}=${t.dailyRate * 100}%`).join(', '));
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
    { level: 1, name: '🌱 新手', minBalance: 10000, maxBalance: 49999, dailyRate: 2, isActive: true, displayOrder: 1 },
    { level: 2, name: '🌿 进阶', minBalance: 50000, maxBalance: 99999, dailyRate: 4, isActive: true, displayOrder: 2 },
    { level: 3, name: '🌳 资深', minBalance: 100000, maxBalance: 199999, dailyRate: 6, isActive: true, displayOrder: 3 },
    { level: 4, name: '💎 核心', minBalance: 200000, maxBalance: null, dailyRate: 10, isActive: true, displayOrder: 4 },
  ];
}

/**
 * 获取内存中的 VIP 配置
 * 如果未加载或缓存过期，异步刷新缓存（但仍返回旧缓存）
 */
export function getVipTiers(): VipTier[] {
  const now = Date.now();
  
  // 🟢 如果缓存过期（超过1分钟），异步刷新缓存
  if (vipTiersCache && (now - lastCacheTime) > CACHE_TTL) {
    console.log('[VIP Config] Cache expired, refreshing in background...');
    // 异步刷新，不阻塞当前请求
    loadVipTiers().catch(err => {
      console.error('[VIP Config] Background refresh failed:', err);
    });
  }
  
  // 如果从未加载过，返回默认配置并触发加载
  if (!vipTiersCache) {
    console.warn('[VIP Config] Cache not loaded, using defaults and loading...');
    loadVipTiers().catch(err => {
      console.error('[VIP Config] Initial load failed:', err);
    });
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

