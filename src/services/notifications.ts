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

// 发送个人通知（管理员功能）
export async function sendUserNotification(params: {
  address: string;
  title: string;
  content: string;
  type?: 'SYSTEM' | 'REWARD' | 'NETWORK';
}) {
  const addr = params.address.toLowerCase();
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('notifications')
    .insert({
      address: addr,
      type: params.type || 'SYSTEM',
      title: params.title,
      content: params.content,
      read: false,
      created_at: now,
      updated_at: now,
    })
    .select()
    .single();

  if (error) throw error;

  return { ok: true, notification: data };
}

// 广播通知给所有用户（管理员功能）
export async function broadcastNotification(params: {
  title: string;
  content: string;
  type?: 'SYSTEM' | 'REWARD' | 'NETWORK';
}) {
  // 获取所有用户地址
  const { data: users, error: usersError } = await supabase
    .from('users')
    .select('address');

  if (usersError) throw usersError;

  if (!users || users.length === 0) {
    return { ok: true, sent: 0 };
  }

  const now = new Date().toISOString();
  const notifications = users.map((user: any) => ({
    address: (user.address as string).toLowerCase(),
    type: params.type || 'SYSTEM',
    title: params.title,
    content: params.content,
    read: false,
    created_at: now,
    updated_at: now,
  }));

  // 批量插入通知
  const { error: insertError } = await supabase
    .from('notifications')
    .insert(notifications);

  if (insertError) throw insertError;

  return { ok: true, sent: notifications.length };
}

