import { supabase } from '../infra/supabase.js';

export async function getSystemLinks() {
  const { data, error } = await supabase
    .from('system_links')
    .select('key, url')
    .order('key', { ascending: true });

  if (error) throw error;

  const links: Record<string, string> = {};
  (data || []).forEach((row: any) => {
    links[row.key] = row.url;
  });

  return {
    whitepaper: links.whitepaper || '',
    audits: links.audits || '',
    support: links.support || '',
  };
}

export async function getSystemAnnouncement() {
  const { data, error } = await supabase
    .from('system_announcement')
    .select('content, updated_at')
    .eq('id', 'latest')
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    return null;
  }

  return {
    content: data.content,
    updatedAt: data.updated_at,
  };
}

// 管理员：更新系统公告
export async function updateSystemAnnouncement(content: string) {
  if (!content || content.trim().length === 0) {
    throw new Error('公告内容不能为空');
  }

  // 使用 upsert 操作：如果 id='latest' 存在则更新，不存在则插入
  const { data, error } = await supabase
    .from('system_announcement')
    .upsert({
      id: 'latest',
      content: content.trim(),
      updated_at: new Date().toISOString(),
    }, {
      onConflict: 'id',
    })
    .select('content, updated_at')
    .single();

  if (error) throw error;

  return {
    content: data.content,
    updatedAt: data.updated_at,
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

