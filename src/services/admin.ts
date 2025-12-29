import { ethers } from 'ethers';
import { supabase } from '../infra/supabase.js';
import { config } from '../config.js';
import { ApiError } from '../api/errors.js';
import { AIRDROP_ABI, ERC20_ABI } from '../infra/abis.js';

function lower(addr: string) {
  return (addr || '').toLowerCase();
}

async function getSystemConfig<T = any>(key: string): Promise<T | null> {
  const { data, error } = await supabase.from('system_config').select('key,value').eq('key', key).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return (data as any).value as T;
}

async function setSystemConfig(key: string, value: any): Promise<void> {
  const { error } = await supabase.from('system_config').upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw error;
}

export async function adminGetSystemConfig() {
  const { data, error } = await supabase.from('system_config').select('key,value,updated_at').order('key', { ascending: true });
  if (error) throw error;
  return { ok: true, items: (data || []).map((r: any) => ({ key: r.key, value: r.value, updatedAt: r.updated_at })) };
}

export async function adminSetSystemConfig(key: string, value: any) {
  await setSystemConfig(key, value);
  return { ok: true };
}

async function getUsdtContract(): Promise<string | null> {
  const v = await getSystemConfig<{ address?: string }>('usdt');
  const addr = String(v?.address || '').trim();
  if (addr && ethers.utils.isAddress(addr)) return lower(addr);
  if (config.usdtContract && ethers.utils.isAddress(config.usdtContract)) return lower(config.usdtContract);
  return null;
}

async function getAdminPayoutAddress(): Promise<string | null> {
  const v = await getSystemConfig<{ address?: string }>('admin_payout');
  const addr = String(v?.address || '').trim();
  if (addr && ethers.utils.isAddress(addr)) return lower(addr);
  if (config.adminPayoutAddress && ethers.utils.isAddress(config.adminPayoutAddress)) return lower(config.adminPayoutAddress);
  return null;
}

export async function getAdminKpis(provider: ethers.providers.Provider) {
  // users count
  const { count: usersCount, error: usersErr } = await supabase.from('users').select('address', { count: 'exact', head: true });
  if (usersErr) throw usersErr;

  // pending withdraw total
  const { data: pend, error: pendErr } = await supabase.from('withdrawals').select('amount').eq('status', 'Pending');
  if (pendErr) throw pendErr;
  const pendingTotal = (pend || []).reduce((acc: number, r: any) => acc + Number(r.amount || 0), 0);

  // on-chain: airdrop config + fee recipient balance
  const airdrop = new ethers.Contract(config.airdropContract, AIRDROP_ABI, provider);
  const [claimFeeWei, cooldownSec, minReward, maxReward, feeRecipient, tokenAddr] = await Promise.all([
    airdrop.claimFee(),
    airdrop.cooldown(),
    airdrop.minReward(),
    airdrop.maxReward(),
    airdrop.feeRecipient(),
    airdrop.token(),
  ]);

  const feeRecipientBnbWei = await provider.getBalance(feeRecipient);

  // 持币生息模式：不再计算质押 TVL，改为计算总持币量（可选）
  // 可以从 user_holdings 表汇总，或从链上统计
  // 这里暂时返回 null，后续可以实现持币总量统计
  let totalHoldings = null as null | { amount: string; symbol: string };
  // TODO: 实现持币总量统计（从 user_holdings 表或链上汇总）

  return {
    ok: true,
    usersTotal: Number(usersCount || 0),
    pendingWithdrawTotal: String(pendingTotal),
    pendingWithdrawUnit: 'USDT',
    airdropFeeRecipient: lower(String(feeRecipient)),
    airdropFeeBalance: ethers.utils.formatEther(feeRecipientBnbWei),
    airdropFeeUnit: 'BNB',
    airdrop: {
      contract: config.airdropContract,
      token: lower(String(tokenAddr)),
      claimFee: ethers.utils.formatEther(claimFeeWei),
      claimFeeUnit: 'BNB',
      cooldownSec: Number(cooldownSec),
      rewardRange: { min: String(minReward), max: String(maxReward) },
    },
    totalHoldings, // 持币总量（替代原来的 tvl）
    time: new Date().toISOString(),
  };
}

export async function listPendingWithdrawals(limit: number) {
  const { data, error } = await supabase
    .from('withdrawals')
    .select('id,address,amount,status,energy_locked_amount,payout_tx_hash,created_at,updated_at')
    .eq('status', 'Pending')
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) throw error;

  return {
    ok: true,
    items: (data || []).map((r: any) => ({
      id: r.id,
      address: r.address,
      amount: String(r.amount),
      status: r.status,
      energyLockedAmount: String(r.energy_locked_amount || 0),
      payoutTxHash: r.payout_tx_hash,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      alert: Number(r.amount || 0) >= Number(config.withdrawAlertThreshold || 1000),
    })),
  };
}

async function getUserEnergyRow(address: string) {
  const { data, error } = await supabase
    .from('users')
    .select('energy_total,energy_locked,usdt_total,usdt_locked,created_at')
    .eq('address', address)
    .maybeSingle();
  if (error) throw error;
  const energyTotal = Number((data as any)?.energy_total || 0);
  const energyLocked = Number((data as any)?.energy_locked || 0);
  const usdtTotal = Number((data as any)?.usdt_total || 0);
  const usdtLocked = Number((data as any)?.usdt_locked || 0);
  return { energyTotal, energyLocked, usdtTotal, usdtLocked, createdAt: (data as any)?.created_at || new Date().toISOString() };
}

async function updateUserBalances(
  address: string,
  next: { energyTotal: number; energyLocked: number; usdtTotal: number; usdtLocked: number },
  createdAt: string
) {
  const { error } = await supabase.from('users').upsert(
    {
      address,
      energy_total: next.energyTotal,
      energy_locked: next.energyLocked,
      usdt_total: next.usdtTotal,
      usdt_locked: next.usdtLocked,
      updated_at: new Date().toISOString(),
      created_at: createdAt,
    },
    { onConflict: 'address' }
  );
  if (error) throw error;
}

export async function rejectWithdrawal(withdrawalId: string) {
  const { data: w, error: wErr } = await supabase
    .from('withdrawals')
    .select('id,address,amount,status')
    .eq('id', withdrawalId)
    .maybeSingle();
  if (wErr) throw wErr;
  if (!w) throw new ApiError('NOT_FOUND', 'Withdrawal not found', 404);

  if ((w as any).status !== 'Pending') {
    return { ok: true, id: (w as any).id, status: (w as any).status, ignored: true };
  }

  const addr = lower((w as any).address);
  const amount = Number((w as any).amount || 0);

  // unlock energy + unlock usdt (do not reduce totals)
  const u = await getUserEnergyRow(addr);
  const nextEnergyLocked = Math.max(0, u.energyLocked - amount);
  const nextUsdtLocked = Math.max(0, u.usdtLocked - amount);
  await updateUserBalances(
    addr,
    { energyTotal: u.energyTotal, energyLocked: nextEnergyLocked, usdtTotal: u.usdtTotal, usdtLocked: nextUsdtLocked },
    u.createdAt
  );

  const { error: upErr } = await supabase
    .from('withdrawals')
    .update({ status: 'Rejected', updated_at: new Date().toISOString() })
    .eq('id', withdrawalId);
  if (upErr) throw upErr;

  return { ok: true, id: withdrawalId, status: 'Rejected' };
}

export async function getUsdtInfo(provider: ethers.providers.Provider) {
  const usdtAddr = await getUsdtContract();
  if (!usdtAddr) throw new ApiError('CONFIG_ERROR', 'USDT_CONTRACT is not configured (env or system_config.usdt)', 400);
  const usdt = new ethers.Contract(usdtAddr, ERC20_ABI, provider);
  const [decimals, symbol] = await Promise.all([usdt.decimals(), usdt.symbol()]);
  return { ok: true, address: usdtAddr, decimals: Number(decimals), symbol };
}

export async function completeWithdrawal(params: {
  provider: ethers.providers.Provider;
  withdrawalId: string;
  payoutTxHash: string;
}) {
  const usdtAddr = await getUsdtContract();
  if (!usdtAddr) throw new ApiError('CONFIG_ERROR', 'USDT_CONTRACT is not configured (env or system_config.usdt)', 400);

  const { data: w, error: wErr } = await supabase
    .from('withdrawals')
    .select('id,address,amount,status,payout_tx_hash')
    .eq('id', params.withdrawalId)
    .maybeSingle();
  if (wErr) throw wErr;
  if (!w) throw new ApiError('NOT_FOUND', 'Withdrawal not found', 404);

  const status = String((w as any).status);
  if (status === 'Completed') {
    return { ok: true, id: (w as any).id, status, duplicated: true, payoutTxHash: (w as any).payout_tx_hash };
  }
  if (status !== 'Pending') throw new ApiError('INVALID_STATE', `Withdrawal status is ${status}`, 400);

  // Anti-replay: the same payoutTxHash must be used at most once (prevents reusing a single transfer to close multiple requests).
  const { data: used, error: usedErr } = await supabase
    .from('withdrawals')
    .select('id,status')
    .eq('payout_tx_hash', params.payoutTxHash)
    .limit(1);
  if (usedErr) throw usedErr;
  if (used && used.length > 0 && String((used[0] as any).id) !== String((w as any).id)) {
    throw new ApiError('INVALID_PAYOUT', 'PAYOUT_TX_ALREADY_USED', 400);
  }

  const userAddr = lower((w as any).address);
  const amount = String((w as any).amount);

  // Verify payout tx on-chain: USDT Transfer(any -> user, value == amount)
  // 注意：允许从任何地址转出（支持 MetaMask 手动发放），只验证接收方和金额
  const usdt = new ethers.Contract(usdtAddr, ERC20_ABI, params.provider);
  const decimals = Number(await usdt.decimals());
  const expectedValue = ethers.utils.parseUnits(amount, decimals);

  const receipt = await params.provider.getTransactionReceipt(params.payoutTxHash);
  if (!receipt) throw new ApiError('TX_NOT_FOUND', 'Payout tx receipt not found', 404);
  if (receipt.status !== 1) throw new ApiError('TX_FAILED', 'Payout tx failed', 400);

  const iface = new ethers.utils.Interface(ERC20_ABI);
  let matched = false;
  for (const log of receipt.logs) {
    if (!log.address || lower(log.address) !== lower(usdtAddr)) continue;
    try {
      const parsed = iface.parseLog(log);
      if (parsed.name !== 'Transfer') continue;
      const to = lower(parsed.args.to);
      const value = parsed.args.value as ethers.BigNumber;
      // 只验证接收方和金额，不验证发送方（允许从任何地址转出）
      if (to === userAddr && value.eq(expectedValue)) {
        matched = true;
        break;
      }
    } catch {
      // ignore
    }
  }
  if (!matched) throw new ApiError('INVALID_PAYOUT', 'USDT Transfer not matched (to/value)', 400);

  // Update DB: withdrawal completed + adjust energy + adjust usdt
  const u = await getUserEnergyRow(userAddr);
  const amtNum = Number(amount);

  const nextEnergyLocked = Math.max(0, u.energyLocked - amtNum);
  const nextEnergyTotal = Math.max(0, u.energyTotal - amtNum);
  const nextUsdtLocked = Math.max(0, u.usdtLocked - amtNum);
  const nextUsdtTotal = Math.max(0, u.usdtTotal - amtNum);

  await updateUserBalances(
    userAddr,
    { energyTotal: nextEnergyTotal, energyLocked: nextEnergyLocked, usdtTotal: nextUsdtTotal, usdtLocked: nextUsdtLocked },
    u.createdAt
  );

  const { error: upErr } = await supabase
    .from('withdrawals')
    .update({ status: 'Completed', payout_tx_hash: params.payoutTxHash, updated_at: new Date().toISOString() })
    .eq('id', params.withdrawalId);
  if (upErr) throw upErr;

  return { ok: true, id: params.withdrawalId, status: 'Completed', payoutTxHash: params.payoutTxHash, verified: true };
}

export async function adminGetUser(provider: ethers.providers.Provider, address: string) {
  const addr = lower(address);

  const { data: user, error: uErr } = await supabase
    .from('users')
    .select('address,referrer_address,invite_count,energy_total,energy_locked,usdt_total,usdt_locked,created_at,updated_at')
    .eq('address', addr)
    .maybeSingle();
  if (uErr) throw uErr;

  const { data: claims, error: cErr } = await supabase
    .from('claims')
    .select('tx_hash,referrer,amount_wei,block_number,block_time,created_at')
    .eq('address', addr)
    .order('created_at', { ascending: false })
    .limit(20);
  if (cErr) throw cErr;

  const { data: withdrawals, error: wErr } = await supabase
    .from('withdrawals')
    .select('id,amount,status,payout_tx_hash,created_at')
    .eq('address', addr)
    .order('created_at', { ascending: false })
    .limit(20);
  if (wErr) throw wErr;

  // invitees: distinct claimers whose referrer == addr
  const { data: inviteeClaims, error: iErr } = await supabase
    .from('claims')
    .select('address,created_at')
    .eq('referrer', addr)
    .order('created_at', { ascending: false })
    .limit(200);
  if (iErr) throw iErr;
  const invitees = Array.from(new Set((inviteeClaims || []).map((r: any) => String(r.address)))).slice(0, 50);

  // airdrop contract snapshot
  const airdrop = new ethers.Contract(config.airdropContract, AIRDROP_ABI, provider);

  // Some deployments/ABIs may not expose lastClaimTime (or inviteCount). Guard against "is not a function".
  const airdropAny = airdrop as any;
  const lastClaimTime = await (async () => {
    try {
      if (typeof airdropAny.lastClaimTime !== 'function') return 0;
      return await airdropAny.lastClaimTime(addr);
    } catch {
      return 0;
    }
  })();

  const inviteCountOnchain = await (async () => {
    try {
      if (typeof airdropAny.inviteCount !== 'function') return 0;
      return await airdropAny.inviteCount(addr);
    } catch {
      return 0;
    }
  })();

  return {
    ok: true,
    user: user
      ? {
          address: (user as any).address,
          referrer: (user as any).referrer_address,
          inviteCount: String((user as any).invite_count || 0),
          energyTotal: String((user as any).energy_total || 0),
          energyLocked: String((user as any).energy_locked || 0),
          usdtTotal: String((user as any).usdt_total || 0),
          usdtLocked: String((user as any).usdt_locked || 0),
          createdAt: (user as any).created_at,
          updatedAt: (user as any).updated_at,
        }
      : null,
    claims: (claims || []).map((r: any) => ({
      txHash: r.tx_hash,
      referrer: r.referrer,
      amount: ethers.utils.formatEther(String(r.amount_wei)),
      unit: 'RAT',
      blockNumber: r.block_number,
      blockTime: r.block_time,
      createdAt: r.created_at,
    })),
    withdrawals: (withdrawals || []).map((r: any) => ({
      id: r.id,
      amount: String(r.amount),
      status: r.status,
      payoutTxHash: r.payout_tx_hash,
      createdAt: r.created_at,
    })),
    invitees,
    onchain: {
      lastClaimTime: Number(lastClaimTime || 0),
      inviteCount: String(inviteCountOnchain || 0),
    },
  };
}

export async function adminListRecentUsers(limit: number) {
  const { data, error } = await supabase
    .from('users')
    .select('address,referrer_address,invite_count,energy_total,energy_locked,usdt_total,usdt_locked,created_at,updated_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return {
    ok: true,
    items: (data || []).map((r: any) => ({
      address: r.address,
      referrer: r.referrer_address,
      inviteCount: String(r.invite_count || 0),
      energyTotal: String(r.energy_total || 0),
      energyLocked: String(r.energy_locked || 0),
      usdtTotal: String(r.usdt_total || 0),
      usdtLocked: String(r.usdt_locked || 0),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  };
}

/**
 * 获取用户列表（支持分页和搜索）
 * 用于管理后台用户管理页面
 */
export async function adminListUsers(params: { limit: number; offset: number; search?: string }) {
  let query = supabase
    .from('users')
    .select('address,referrer_address,invite_count,energy_total,energy_locked,usdt_total,usdt_locked,created_at,updated_at', { count: 'exact' });

  // 搜索功能：如果提供了搜索词，按地址搜索
  if (params.search && params.search.trim()) {
    const searchTerm = params.search.trim().toLowerCase();
    query = query.ilike('address', `%${searchTerm}%`);
  }

  // 排序：按创建时间倒序
  query = query.order('created_at', { ascending: false });

  // 分页
  const from = params.offset;
  const to = from + params.limit - 1;
  query = query.range(from, to);

  const { data, error, count } = await query;
  if (error) throw error;

  return {
    ok: true,
    items: (data || []).map((r: any) => ({
      address: r.address,
      energyTotal: Number(r.energy_total || 0),
      energyLocked: Number(r.energy_locked || 0),
      inviteCount: Number(r.invite_count || 0),
      referrer: r.referrer_address || null,
      registeredAt: r.created_at,
      lastActive: r.updated_at,
      usdtBalance: Number(r.usdt_total || 0) - Number(r.usdt_locked || 0), // 可提现余额
    })),
    total: count || 0,
  };
}

export async function adminListRecentClaims(limit: number) {
  const { data, error } = await supabase
    .from('claims')
    .select('tx_hash,address,referrer,amount_wei,block_number,block_time,created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;

  return {
    ok: true,
    items: (data || []).map((r: any) => ({
      txHash: r.tx_hash,
      address: r.address,
      referrer: r.referrer,
      amount: ethers.utils.formatEther(String(r.amount_wei)),
      unit: 'RAT',
      blockNumber: r.block_number,
      createdAt: r.created_at,
    })),
  };
}

/**
 * 获取 RAT 持币大户排行（Top Holders）
 * 从数据库获取所有用户，然后从链上读取他们的 RAT 余额，按余额排序
 */
export async function getTopRATHolders(provider: ethers.providers.Provider, limit: number = 5) {
  // 从数据库获取所有用户地址
  const { data: users, error } = await supabase
    .from('users')
    .select('address')
    .limit(100); // 限制查询数量，避免 RPC 调用过多
  if (error) throw error;

  if (!users || users.length === 0) {
    return { ok: true, items: [] };
  }

  // 从链上读取每个用户的 RAT 余额
  const ratContract = new ethers.Contract(config.ratTokenContract, ERC20_ABI, provider);
  const decimals = await ratContract.decimals().catch(() => 18);

  const balances = await Promise.all(
    users.map(async (user: any) => {
      try {
        const balanceWei = await ratContract.balanceOf(user.address);
        const balance = parseFloat(ethers.utils.formatUnits(balanceWei, decimals));
        return {
          address: user.address,
          balance,
        };
      } catch (err) {
        // 如果读取失败，返回余额 0
        return {
          address: user.address,
          balance: 0,
        };
      }
    })
  );

  // 按余额排序，取前 N 名
  const topHolders = balances
    .filter((item) => item.balance > 0)
    .sort((a, b) => b.balance - a.balance)
    .slice(0, limit)
    .map((item, index) => ({
      rank: index + 1,
      address: item.address,
      balance: item.balance,
    }));

  return { ok: true, items: topHolders };
}

/**
 * 获取管理员支付地址的 USDT 余额（从链上读取）
 */
export async function getAdminUsdtBalance(provider: ethers.providers.Provider): Promise<string> {
  const usdtAddr = await getUsdtContract();
  if (!usdtAddr) {
    throw new ApiError('CONFIG_ERROR', 'USDT_CONTRACT is not configured', 400);
  }

  const adminPayout = await getAdminPayoutAddress();
  if (!adminPayout) {
    throw new ApiError('CONFIG_ERROR', 'ADMIN_PAYOUT_ADDRESS is not configured', 400);
  }

  try {
    const usdtContract = new ethers.Contract(usdtAddr, ERC20_ABI, provider);
    const balanceWei = await usdtContract.balanceOf(adminPayout);
    const decimals = await usdtContract.decimals().catch(() => 18);
    const balance = ethers.utils.formatUnits(balanceWei, decimals);
    return balance;
  } catch (error: any) {
    throw new ApiError('RPC_ERROR', `Failed to fetch USDT balance: ${error?.message || error}`, 500);
  }
}

/**
 * 获取收益统计信息（用于 Revenue 页面）
 */
export async function getRevenueStats(provider: ethers.providers.Provider) {
  // 从链上读取 claimFee
  const airdrop = new ethers.Contract(config.airdropContract, AIRDROP_ABI, provider);
  const claimFeeWei = await airdrop.claimFee();
  const claimFee = parseFloat(ethers.utils.formatEther(claimFeeWei));

  // 获取今日的收益记录数
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const { count: todayCount, error: todayErr } = await supabase
    .from('claims')
    .select('tx_hash', { count: 'exact', head: true })
    .gte('created_at', todayStart.toISOString());
  if (todayErr) throw todayErr;

  // 获取昨日的收益记录数（用于计算趋势）
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const yesterdayEnd = new Date(todayStart);
  const { count: yesterdayCount, error: yesterdayErr } = await supabase
    .from('claims')
    .select('tx_hash', { count: 'exact', head: true })
    .gte('created_at', yesterdayStart.toISOString())
    .lt('created_at', yesterdayEnd.toISOString());
  if (yesterdayErr) throw yesterdayErr;

  // 计算趋势（今日 vs 昨日）
  const todayRevenue = (todayCount || 0) * claimFee;
  const yesterdayRevenue = (yesterdayCount || 0) * claimFee;
  const trend = yesterdayRevenue > 0 ? ((todayRevenue - yesterdayRevenue) / yesterdayRevenue) * 100 : 0;

  // 今日预期收益（基于当前速率，假设每小时速率不变）
  const now = new Date();
  const hoursElapsed = (now.getTime() - todayStart.getTime()) / (1000 * 60 * 60);
  const estimatedDaily = hoursElapsed > 0 ? (todayRevenue / hoursElapsed) * 24 : 0;

  // 平均单笔费率（就是 claimFee）
  const avgFee = claimFee;

  return {
    ok: true,
    totalRevenue: todayRevenue.toFixed(4),
    trend: trend.toFixed(1), // 百分比
    estimatedDaily: estimatedDaily.toFixed(4),
    avgFee: avgFee.toFixed(4),
  };
}

export async function adminAdjustUserEnergy(address: string, delta: number) {
  const addr = lower(address);
  if (!Number.isFinite(delta)) throw new ApiError('INVALID_REQUEST', 'Invalid delta', 400);

  const u = await getUserEnergyRow(addr);
  const nextTotal = Math.max(0, u.energyTotal + delta);
  if (nextTotal < u.energyLocked) {
    throw new ApiError('INVALID_STATE', 'energy_total cannot be less than energy_locked', 400);
  }

  await updateUserBalances(
    addr,
    { energyTotal: nextTotal, energyLocked: u.energyLocked, usdtTotal: u.usdtTotal, usdtLocked: u.usdtLocked },
    u.createdAt
  );

  return {
    ok: true,
    address: addr,
    energyTotal: String(nextTotal),
    energyLocked: String(u.energyLocked),
  };
}

export async function adminAdjustUserUsdt(address: string, delta: number) {
  const addr = lower(address);
  if (!Number.isFinite(delta)) throw new ApiError('INVALID_REQUEST', 'Invalid delta', 400);

  const u = await getUserEnergyRow(addr);
  const nextTotal = Math.max(0, u.usdtTotal + delta);
  if (nextTotal < u.usdtLocked) {
    throw new ApiError('INVALID_STATE', 'usdt_total cannot be less than usdt_locked', 400);
  }

  await updateUserBalances(
    addr,
    { energyTotal: u.energyTotal, energyLocked: u.energyLocked, usdtTotal: nextTotal, usdtLocked: u.usdtLocked },
    u.createdAt
  );

  return {
    ok: true,
    address: addr,
    usdtTotal: String(nextTotal),
    usdtLocked: String(u.usdtLocked),
  };
}

/**
 * 获取财务收益明细（BNB 收入）
 * 从 claims 表统计用户领取空投产生的费用收入
 */
export async function getFinanceRevenue(provider: ethers.providers.Provider, page: number, pageSize: number) {
  // 从链上读取 claimFee（每次查询时读取，确保数据准确）
  const airdrop = new ethers.Contract(config.airdropContract, AIRDROP_ABI, provider);
  const claimFeeWei = await airdrop.claimFee();
  const claimFee = ethers.utils.formatEther(claimFeeWei);

  // 获取总数
  const { count, error: countErr } = await supabase
    .from('claims')
    .select('tx_hash', { count: 'exact', head: true });
  if (countErr) throw countErr;

  // 分页查询
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const { data, error } = await supabase
    .from('claims')
    .select('tx_hash,address,created_at')
    .order('created_at', { ascending: false })
    .range(from, to);
  if (error) throw error;

  // 计算总收入 = claimFee * 总记录数
  const totalRevenue = Number(claimFee) * Number(count || 0);

  return {
    ok: true,
    items: (data || []).map((r: any) => ({
      txHash: r.tx_hash,
      address: r.address,
      amount: claimFee,
      unit: 'BNB',
      createdAt: r.created_at,
    })),
    total: totalRevenue.toFixed(6),
    totalCount: count || 0,
  };
}

/**
 * 获取财务支出明细（USDT 支出）
 * 从 withdrawals 表统计已完成的提现记录
 */
export async function getFinanceExpenses(page: number, pageSize: number) {
  // 获取总数和总支出
  const { data: allData, error: allErr } = await supabase
    .from('withdrawals')
    .select('amount')
    .eq('status', 'Completed');
  if (allErr) throw allErr;

  const totalExpense = (allData || []).reduce((sum: number, r: any) => sum + Number(r.amount || 0), 0);
  const totalCount = allData?.length || 0;

  // 分页查询
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const { data, error } = await supabase
    .from('withdrawals')
    .select('id,address,amount,payout_tx_hash,created_at,updated_at')
    .eq('status', 'Completed')
    .order('updated_at', { ascending: false })
    .range(from, to);
  if (error) throw error;

  return {
    ok: true,
    items: (data || []).map((r: any) => ({
      id: r.id,
      address: r.address,
      amount: String(r.amount),
      payoutTxHash: r.payout_tx_hash,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
    total: totalExpense.toFixed(2),
    totalCount,
  };
}

/**
 * 获取操作记录（提现和空投领取）
 */
export async function getAdminOperations(params: {
  limit?: number;
  offset?: number;
  type?: 'all' | 'Withdrawal' | 'AirdropClaim';
  address?: string;
}) {
  const limit = params.limit || 100;
  const offset = params.offset || 0;
  const type = params.type || 'all';
  const address = params.address ? lower(params.address) : null;

  // 合并 withdrawals 和 claims 表的数据
  const operations: any[] = [];

  // 1. 获取提现记录
  if (type === 'all' || type === 'Withdrawal') {
    let withdrawalsQuery = supabase
      .from('withdrawals')
      .select('id,address,amount,status,payout_tx_hash,created_at,updated_at')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (address) {
      withdrawalsQuery = withdrawalsQuery.eq('address', address);
    }

    const { data: withdrawals, error: wErr } = await withdrawalsQuery;
    if (wErr) throw wErr;

    (withdrawals || []).forEach((w: any) => {
      operations.push({
        id: w.id,
        address: w.address,
        type: 'Withdrawal',
        amount: String(w.amount),
        status: w.status === 'Completed' ? 'Success' : w.status === 'Rejected' ? 'Rejected' : 'Pending',
        timestamp: w.updated_at || w.created_at,
        txHash: w.payout_tx_hash || undefined,
      });
    });
  }

  // 2. 获取空投领取记录
  if (type === 'all' || type === 'AirdropClaim') {
    let claimsQuery = supabase
      .from('claims')
      .select('tx_hash,address,amount_wei,created_at')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (address) {
      claimsQuery = claimsQuery.eq('address', address);
    }

    const { data: claims, error: cErr } = await claimsQuery;
    if (cErr) throw cErr;

    (claims || []).forEach((c: any) => {
      operations.push({
        id: c.tx_hash,
        address: c.address,
        type: 'AirdropClaim',
        amount: ethers.utils.formatEther(c.amount_wei || '0'),
        status: 'Success',
        timestamp: c.created_at,
        txHash: c.tx_hash,
      });
    });
  }

  // 按时间戳排序（最新的在前）
  operations.sort((a, b) => {
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
  });

  // 获取总数
  let totalCount = 0;
  if (type === 'all') {
    const { count: wCount } = await supabase
      .from('withdrawals')
      .select('*', { count: 'exact', head: true });
    const { count: cCount } = await supabase
      .from('claims')
      .select('*', { count: 'exact', head: true });
    totalCount = (wCount || 0) + (cCount || 0);
  } else if (type === 'Withdrawal') {
    const { count } = await supabase
      .from('withdrawals')
      .select('*', { count: 'exact', head: true });
    totalCount = count || 0;
  } else if (type === 'AirdropClaim') {
    const { count } = await supabase
      .from('claims')
      .select('*', { count: 'exact', head: true });
    totalCount = count || 0;
  }

  return {
    ok: true,
    items: operations.slice(0, limit),
    total: totalCount,
  };
}

/**
 * 获取收益明细（支持日期范围）
 */
export async function getAdminRevenueWithDateRange(
  provider: ethers.providers.Provider,
  params: {
    limit?: number;
    offset?: number;
    startDate?: string;
    endDate?: string;
  }
) {
  const limit = params.limit || 100;
  const offset = params.offset || 0;

  // 从链上读取 claimFee
  const airdrop = new ethers.Contract(config.airdropContract, AIRDROP_ABI, provider);
  const claimFeeWei = await airdrop.claimFee();
  const claimFee = ethers.utils.formatEther(claimFeeWei);

  // 构建查询
  let query = supabase
    .from('claims')
    .select('tx_hash,address,created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  // 应用日期过滤
  if (params.startDate) {
    query = query.gte('created_at', params.startDate);
  }
  if (params.endDate) {
    query = query.lte('created_at', params.endDate);
  }

  const { data, count, error } = await query;
  if (error) throw error;

  // 计算总收入
  const totalRevenue = Number(claimFee) * (count || 0);

  return {
    ok: true,
    items: (data || []).map((r: any) => ({
      id: r.tx_hash,
      address: r.address,
      feeAmount: Number(claimFee),
      asset: 'BNB' as const,
      timestamp: r.created_at,
      txHash: r.tx_hash,
    })),
    total: totalRevenue,
  };
}

/**
 * 获取支出明细（支持日期范围）
 */
export async function getAdminExpensesWithDateRange(params: {
  limit?: number;
  offset?: number;
  startDate?: string;
  endDate?: string;
}) {
  const limit = params.limit || 100;
  const offset = params.offset || 0;

  // 构建查询
  let query = supabase
    .from('withdrawals')
    .select('id,address,amount,payout_tx_hash,created_at,updated_at', { count: 'exact' })
    .eq('status', 'Completed')
    .order('updated_at', { ascending: false })
    .range(offset, offset + limit - 1);

  // 应用日期过滤
  if (params.startDate) {
    query = query.gte('updated_at', params.startDate);
  }
  if (params.endDate) {
    query = query.lte('updated_at', params.endDate);
  }

  const { data, count, error } = await query;
  if (error) throw error;

  // 计算总支出
  const totalExpense = (data || []).reduce((sum: number, r: any) => sum + Number(r.amount || 0), 0);

  return {
    ok: true,
    items: (data || []).map((r: any) => ({
      id: r.id,
      address: r.address,
      amount: Number(r.amount),
      status: 'Completed',
      createdAt: r.created_at,
      payoutTxHash: r.payout_tx_hash,
    })),
    total: totalExpense,
  };
}


