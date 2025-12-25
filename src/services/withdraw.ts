import { supabase } from '../infra/supabase.js';
import { ApiError } from '../api/errors.js';

export async function applyWithdraw(address: string, amountStr: string) {
  const addr = address.toLowerCase();
  const amount = Number(amountStr);
  if (!Number.isFinite(amount) || amount <= 0) throw new ApiError('INVALID_REQUEST', 'Invalid amount');

  // load user balances
  const { data: user, error: userErr } = await supabase
    .from('users')
    .select('energy_total,energy_locked,usdt_total,usdt_locked,created_at')
    .eq('address', addr)
    .maybeSingle();
  if (userErr) throw userErr;

  const energyTotal = Number((user as any)?.energy_total || 0);
  const energyLocked = Number((user as any)?.energy_locked || 0);
  const energyAvailable = Math.max(0, energyTotal - energyLocked);

  const usdtTotal = Number((user as any)?.usdt_total || 0);
  const usdtLocked = Number((user as any)?.usdt_locked || 0);
  const usdtAvailable = Math.max(0, usdtTotal - usdtLocked);

  if (usdtAvailable < amount) {
    throw new ApiError('USDT_NOT_ENOUGH', `USDT not enough (available ${usdtAvailable}, need ${amount})`, 400);
  }

  // 业务规则：提现需要能量 >= 30，且能量需覆盖提现金额（1 USDT = 10 Energy）
  const minEnergyToWithdraw = 30;
  const requiredEnergy = Math.max(minEnergyToWithdraw, amount * 10);
  if (energyAvailable < requiredEnergy) {
    throw new ApiError('ENERGY_NOT_ENOUGH', `Energy not enough (need >= ${requiredEnergy})`, 400);
  }

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

  // lock energy + lock usdt (best-effort consistency: if insert fails, try to rollback locks)
  // 能量消耗：1 USDT = 10 Energy
  const energyCost = amount * 10;
  const nextEnergyLocked = energyLocked + energyCost;
  const nextUsdtLocked = usdtLocked + amount;
  const createdAt = (user as any)?.created_at || new Date().toISOString();

  const { error: lockErr } = await supabase
    .from('users')
    .upsert(
      {
        address: addr,
        energy_total: energyTotal,
        energy_locked: nextEnergyLocked,
        usdt_total: usdtTotal,
        usdt_locked: nextUsdtLocked,
        created_at: createdAt,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'address' }
    );
  if (lockErr) throw lockErr;

  const { data: inserted, error: insErr } = await supabase
    .from('withdrawals')
    .insert({
      address: addr,
      amount,
      status: 'Pending',
      energy_locked_amount: energyCost,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select('id,amount,status,created_at')
    .single();

  if (insErr) {
    // rollback locks (best-effort)
    await supabase.from('users').upsert(
      {
        address: addr,
        energy_total: energyTotal,
        energy_locked: energyLocked,
        usdt_total: usdtTotal,
        usdt_locked: usdtLocked,
        created_at: createdAt,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'address' }
    );
    throw insErr;
  }

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
  
  try {
    const { data, error } = await supabase
      .from('withdrawals')
      .select('id,amount,status,created_at')
      .eq('address', addr)
      .order('created_at', { ascending: false })
      .limit(50);
    
    if (error) {
      console.error('Error fetching withdraw history:', error);
      return [];
    }

    if (!data || data.length === 0) {
      return [];
    }

    return data.map((r: any) => ({
      id: r.id,
      amount: String(r.amount),
      status: r.status || 'Pending',
      time: new Date(r.created_at).toISOString().slice(0, 19).replace('T', ' '),
      createdAt: r.created_at,
    }));
  } catch (error: any) {
    console.error('Error in getWithdrawHistory:', error);
    return [];
  }
}


