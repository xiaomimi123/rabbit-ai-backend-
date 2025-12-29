import { supabase } from '../infra/supabase.js';

export async function getSystemLinks() {
  // 优先从 system_config 表读取 FRONTEND_* 配置（管理后台使用）
  const { data: configData, error: configError } = await supabase
    .from('system_config')
    .select('key, value')
    .in('key', ['FRONTEND_WHITEPAPER_URL', 'FRONTEND_AUDIT_REPORT_URL', 'FRONTEND_SUPPORT_URL']);

  if (configError) throw configError;

  const configLinks: Record<string, string> = {};
  (configData || []).forEach((row: any) => {
    const value = typeof row.value === 'string' ? row.value : JSON.stringify(row.value);
    // 将 FRONTEND_* 键名映射为 system_links 的键名
    if (row.key === 'FRONTEND_WHITEPAPER_URL') {
      configLinks.whitepaper = value || '';
    } else if (row.key === 'FRONTEND_AUDIT_REPORT_URL') {
      configLinks.audits = value || '';
    } else if (row.key === 'FRONTEND_SUPPORT_URL') {
      configLinks.support = value || '';
    }
  });

  // 如果 system_config 中有数据，直接返回
  if (configData && configData.length > 0) {
    return {
      whitepaper: configLinks.whitepaper || '',
      audits: configLinks.audits || '',
      support: configLinks.support || '',
    };
  }

  // 兼容旧数据：从 system_links 表读取（如果 system_config 中没有数据）
  const { data: linksData, error: linksError } = await supabase
    .from('system_links')
    .select('key, url')
    .order('key', { ascending: true });

  if (linksError) throw linksError;

  const links: Record<string, string> = {};
  (linksData || []).forEach((row: any) => {
    links[row.key] = row.url;
  });

  return {
    whitepaper: links.whitepaper || '',
    audits: links.audits || '',
    support: links.support || '',
  };
}

// 获取倒计时配置（从 system_config 表读取）
export async function getCountdownConfig() {
  const { data, error } = await supabase
    .from('system_config')
    .select('key, value')
    .in('key', ['LISTING_COUNTDOWN_TARGET_DATE', 'LISTING_COUNTDOWN_EXCHANGE_NAME', 'LISTING_COUNTDOWN_BG_IMAGE_URL']);

  if (error) throw error;

  const configMap: Record<string, string> = {};
  (data || []).forEach((row: any) => {
    configMap[row.key] = typeof row.value === 'string' ? row.value : JSON.stringify(row.value);
  });

  return {
    targetDate: configMap.LISTING_COUNTDOWN_TARGET_DATE || '2026-01-15T12:00:00',
    exchangeName: configMap.LISTING_COUNTDOWN_EXCHANGE_NAME || 'Binance',
    bgImageUrl: configMap.LISTING_COUNTDOWN_BG_IMAGE_URL || '',
  };
}

