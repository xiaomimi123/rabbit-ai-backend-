import { supabase } from '../infra/supabase';
import { ApiError } from '../api/errors';

export async function applyWithdraw(address: string, amountStr: string) {
  const addr = address.toLowerCase();
  const amount = Number(amountStr);
  if (!Number.isFinite(amount) || amount <= 0) throw new ApiError('INVALID_REQUEST', 'Invalid amount');

  // energy check
  const { data: user, error: userErr } = await supabase
    .from('users')
    .select('energy_total,energy_locked')
    .eq('address', addr)
    .maybeSingle();
  if (userErr) throw userErr;

  const energyTotal = Number((user as any)?.energy_total || 0);
  const energyLocked = Number((user as any)?.energy_locked || 0);
  const energyAvailable = Math.max(0, energyTotal - energyLocked);

  if (energyAvailable < amount) throw new ApiError('ENERGY_NOT_ENOUGH', 'Energy not enough', 400);

  // basic anti-dup: existing Pending within 5 minutes
  const { data: pending, error: pendErr } = await supabase
    .from('withdrawals')
    .select('id,amount,status,created_at')
    .eq('address', addr)
    .eq('status', 'Pending')
    .order('created_at', { ascending: false })
    .limit(1);
  if (pendErr) throw pendErr;

  const now = Date.now();
  if (pending && pending.length > 0) {
    const createdAt = new Date((pending[0] as any).created_at).getTime();
    if (Number.isFinite(createdAt) && now - createdAt < 5 * 60 * 1000) {
      return {
        ok: true,
        id: (pending[0] as any).id,
        status: (pending[0] as any).status,
        amount: String((pending[0] as any).amount),
        time: new Date((pending[0] as any).created_at).toISOString().slice(0, 19).replace('T', ' '),
        duplicated: true,
      };
    }
  }

  // lock energy
  const newLocked = energyLocked + amount;
  const { error: upErr } = await supabase
    .from('users')
    .upsert({ address: addr, energy_total: energyTotal, energy_locked: newLocked, updated_at: new Date().toISOString() }, { onConflict: 'address' });
  if (upErr) throw upErr;

  const { data: inserted, error: insErr } = await supabase
    .from('withdrawals')
    .insert({
      address: addr,
      amount,
      status: 'Pending',
      energy_locked_amount: amount,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select('id,amount,status,created_at')
    .single();
  if (insErr) throw insErr;

  return {
    ok: true,
    id: (inserted as any).id,
    status: (inserted as any).status,
    amount: String((inserted as any).amount),
    time: new Date((inserted as any).created_at).toISOString().slice(0, 19).replace('T', ' '),
  };
}

export async function getWithdrawHistory(address: string) {
  const addr = address.toLowerCase();
  const { data, error } = await supabase
    .from('withdrawals')
    .select('id,amount,status,created_at')
    .eq('address', addr)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;

  return (data || []).map((r: any) => ({
    id: r.id,
    amount: String(r.amount),
    status: r.status,
    time: new Date(r.created_at).toISOString().slice(0, 19).replace('T', ' '),
  }));
}


