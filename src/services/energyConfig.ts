import { supabase } from '../infra/supabase.js';
import { ApiError } from '../api/errors.js';

/**
 * 能量配置服务
 * 用于动态管理能量消耗和奖励规则
 */

// 配置键定义
export const EnergyConfigKeys = {
  WITHDRAW_RATIO: 'withdraw_energy_ratio',        // 提现能量消耗比例
  CLAIM_SELF: 'claim_self_reward',                // 用户领取空投奖励
  CLAIM_REFERRER_FIRST: 'claim_referrer_first',   // 推荐人首次邀请奖励
  CLAIM_REFERRER_REPEAT: 'claim_referrer_repeat', // 推荐人非首次奖励
  MIN_WITHDRAW: 'min_withdraw_energy',            // 最低提现能量
  LOCK_ENABLED: 'energy_lock_enabled',            // 锁定机制开关
} as const;

// 配置类型
export interface EnergyConfig {
  key: string;
  value: number;
  description: string;
  updatedAt: string;
}

// 配置历史类型
export interface EnergyConfigHistory {
  id: string;
  key: string;
  oldValue: number | null;
  newValue: number;
  changedBy: string | null;
  changeReason: string | null;
  createdAt: string;
}

/**
 * 获取单个配置值
 */
export async function getEnergyConfigValue(key: string): Promise<number> {
  try {
    // 优先从数据库读取
    const { data, error } = await supabase
      .rpc('get_energy_config', { p_key: key });
    
    if (error) {
      console.error(`[getEnergyConfigValue] 数据库函数调用失败:`, error);
      // 降级到直接查询
      const { data: configData, error: queryError } = await supabase
        .from('energy_config')
        .select('config_value')
        .eq('config_key', key)
        .maybeSingle();
      
      if (queryError) throw queryError;
      if (configData) return Number(configData.config_value);
    } else {
      return Number(data);
    }
  } catch (error: any) {
    console.error(`[getEnergyConfigValue] 获取配置失败 (${key}):`, error);
  }
  
  // 所有方法失败，返回硬编码默认值
  return getDefaultValue(key);
}

/**
 * 获取所有配置
 */
export async function getAllEnergyConfigs(): Promise<EnergyConfig[]> {
  const { data, error } = await supabase
    .from('energy_config')
    .select('config_key,config_value,description,updated_at')
    .order('config_key', { ascending: true });
  
  if (error) throw error;
  
  return (data || []).map((item: any) => ({
    key: item.config_key,
    value: Number(item.config_value),
    description: item.description || '',
    updatedAt: item.updated_at,
  }));
}

/**
 * 更新配置值
 */
export async function updateEnergyConfig(
  key: string,
  newValue: number,
  changedBy?: string,
  reason?: string
): Promise<{ ok: boolean; oldValue: number; newValue: number }> {
  // 验证输入
  if (!Number.isFinite(newValue) || newValue < 0) {
    throw new ApiError('INVALID_REQUEST', `Invalid config value: ${newValue}`, 400);
  }
  
  // 验证配置键是否存在
  const validKeys = Object.values(EnergyConfigKeys);
  if (!validKeys.includes(key as any)) {
    throw new ApiError('INVALID_REQUEST', `Unknown config key: ${key}`, 400);
  }
  
  // 业务规则验证
  validateConfigValue(key, newValue);
  
  // 调用数据库函数更新
  const { data, error } = await supabase.rpc('update_energy_config', {
    p_key: key,
    p_new_value: newValue,
    p_changed_by: changedBy || null,
    p_reason: reason || null,
  });
  
  if (error) throw error;
  
  console.log(`[updateEnergyConfig] ✅ 配置已更新: ${key} = ${newValue}`);
  
  return {
    ok: true,
    oldValue: Number(data.old_value),
    newValue: Number(data.new_value),
  };
}

/**
 * 获取配置历史
 */
export async function getEnergyConfigHistory(
  key?: string,
  limit: number = 50
): Promise<EnergyConfigHistory[]> {
  let query = supabase
    .from('energy_config_history')
    .select('id,config_key,old_value,new_value,changed_by,change_reason,created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  
  if (key) {
    query = query.eq('config_key', key);
  }
  
  const { data, error } = await query;
  if (error) throw error;
  
  return (data || []).map((item: any) => ({
    id: item.id,
    key: item.config_key,
    oldValue: item.old_value !== null ? Number(item.old_value) : null,
    newValue: Number(item.new_value),
    changedBy: item.changed_by,
    changeReason: item.change_reason,
    createdAt: item.created_at,
  }));
}

/**
 * 业务规则验证
 */
function validateConfigValue(key: string, value: number): void {
  switch (key) {
    case EnergyConfigKeys.WITHDRAW_RATIO:
      if (value < 1 || value > 100) {
        throw new ApiError('INVALID_REQUEST', '提现能量比例必须在 1-100 之间', 400);
      }
      break;
    
    case EnergyConfigKeys.CLAIM_SELF:
    case EnergyConfigKeys.CLAIM_REFERRER_FIRST:
    case EnergyConfigKeys.CLAIM_REFERRER_REPEAT:
      if (value < 0 || value > 100) {
        throw new ApiError('INVALID_REQUEST', '能量奖励必须在 0-100 之间', 400);
      }
      break;
    
    case EnergyConfigKeys.MIN_WITHDRAW:
      if (value < 0 || value > 1000) {
        throw new ApiError('INVALID_REQUEST', '最低提现能量必须在 0-1000 之间', 400);
      }
      break;
    
    case EnergyConfigKeys.LOCK_ENABLED:
      if (value !== 0 && value !== 1) {
        throw new ApiError('INVALID_REQUEST', '锁定开关只能是 0 或 1', 400);
      }
      break;
  }
}

/**
 * 获取硬编码默认值（降级方案）
 */
function getDefaultValue(key: string): number {
  const defaults: Record<string, number> = {
    [EnergyConfigKeys.WITHDRAW_RATIO]: 10,
    [EnergyConfigKeys.CLAIM_SELF]: 1,
    [EnergyConfigKeys.CLAIM_REFERRER_FIRST]: 3,
    [EnergyConfigKeys.CLAIM_REFERRER_REPEAT]: 1,
    [EnergyConfigKeys.MIN_WITHDRAW]: 0,
    [EnergyConfigKeys.LOCK_ENABLED]: 1,
  };
  
  return defaults[key] || 0;
}

/**
 * 缓存配置值（可选优化）
 */
const configCache: Map<string, { value: number; timestamp: number }> = new Map();
const CACHE_TTL = 60 * 1000; // 60 秒缓存

export async function getEnergyConfigValueCached(key: string): Promise<number> {
  const now = Date.now();
  const cached = configCache.get(key);
  
  if (cached && (now - cached.timestamp) < CACHE_TTL) {
    return cached.value;
  }
  
  const value = await getEnergyConfigValue(key);
  configCache.set(key, { value, timestamp: now });
  
  return value;
}

/**
 * 清除配置缓存
 */
export function clearEnergyConfigCache(): void {
  configCache.clear();
  console.log('[clearEnergyConfigCache] 配置缓存已清除');
}

