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

