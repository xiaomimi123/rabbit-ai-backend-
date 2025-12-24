import { supabase } from '../infra/supabase.js';

export async function getUserNotifications(address: string) {
  const addr = address.toLowerCase();

  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .eq('address', addr)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) throw error;

  return (data || []).map((n: any) => ({
    id: n.id,
    type: n.type,
    title: n.title,
    content: n.content,
    timestamp: new Date(n.created_at).getTime(),
    read: n.read,
  }));
}

export async function markNotificationAsRead(address: string, notificationId: string) {
  const addr = address.toLowerCase();

  const { error } = await supabase
    .from('notifications')
    .update({ read: true, updated_at: new Date().toISOString() })
    .eq('id', notificationId)
    .eq('address', addr);

  if (error) throw error;

  return { ok: true };
}

export async function markAllNotificationsAsRead(address: string) {
  const addr = address.toLowerCase();

  const { error } = await supabase
    .from('notifications')
    .update({ read: true, updated_at: new Date().toISOString() })
    .eq('address', addr)
    .eq('read', false);

  if (error) throw error;

  return { ok: true };
}

