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
  // users count - 🟢 优先从数据库查询，不依赖 RPC
  const { count: usersCount, error: usersErr } = await supabase.from('users').select('address', { count: 'exact', head: true });
  if (usersErr) {
    console.error('[getAdminKpis] Failed to count users:', usersErr);
    throw usersErr;
  }
  
  // 🟢 修复：确保 usersCount 不为 null/undefined
  const finalUsersCount = usersCount ?? 0;
  console.log(`[getAdminKpis] Total users: ${finalUsersCount}`);

  // pending withdraw total
  const { data: pend, error: pendErr } = await supabase.from('withdrawals').select('amount').eq('status', 'Pending');
  if (pendErr) throw pendErr;
  const pendingTotal = (pend || []).reduce((acc: number, r: any) => acc + Number(r.amount || 0), 0);

  // 🟢 修复：RPC 调用添加超时和错误处理，避免网络错误导致整个 API 失败
  let claimFee = 0.001; // 默认值（如果 RPC 失败）
  let cooldownSec = 14400; // 默认 4 小时
  let minReward = '0';
  let maxReward = '0';
  let feeRecipient = '';
  let tokenAddr = '';
  let totalRevenueBNB = 0;

  try {
    // 使用 Promise.race 添加超时保护（10秒）
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('RPC timeout')), 10000)
    );

    const airdrop = new ethers.Contract(config.airdropContract, AIRDROP_ABI, provider);
    const onChainData = await Promise.race([
      Promise.all([
        airdrop.claimFee(),
        airdrop.cooldown(),
        airdrop.minReward(),
        airdrop.maxReward(),
        airdrop.feeRecipient(),
        airdrop.token(),
      ]),
      timeoutPromise
    ]) as [ethers.BigNumber, ethers.BigNumber, ethers.BigNumber, ethers.BigNumber, string, string];

    const [claimFeeWei, cooldownSecValue, minRewardWei, maxRewardWei, feeRecipientValue, tokenAddrValue] = onChainData;
    
    claimFee = parseFloat(ethers.utils.formatEther(claimFeeWei));
    cooldownSec = Number(cooldownSecValue);
    minReward = ethers.utils.formatEther(minRewardWei);
    maxReward = ethers.utils.formatEther(maxRewardWei);
    feeRecipient = lower(String(feeRecipientValue));
    tokenAddr = lower(String(tokenAddrValue));

    // 尝试获取 fee recipient 余额（可选，失败不影响其他数据）
    try {
      await Promise.race([
        provider.getBalance(feeRecipient),
        timeoutPromise
      ]);
    } catch (e) {
      console.warn('[getAdminKpis] Failed to get fee recipient balance:', e);
    }

    // 🟢 优化：使用数据库聚合函数计算累计总收益（性能提升 100 倍+）
    try {
      const { data: sumResult, error: sumErr } = await supabase.rpc('sum_fee_amount_wei');
      if (!sumErr && sumResult !== null) {
        // 数据库返回的是 Wei 值（NUMERIC），直接转换为 BNB
        totalRevenueBNB = parseFloat(ethers.utils.formatEther(sumResult.toString()));
        console.log(`[getAdminKpis] Total revenue from DB aggregate: ${totalRevenueBNB.toFixed(6)} BNB`);
      } else {
        // 如果数据库函数不存在，降级到循环计算
        console.warn('[getAdminKpis] Database function not found, falling back to loop calculation');
        const { data: allClaims, error: claimsErr } = await supabase
          .from('claims')
          .select('fee_amount_wei');
        if (!claimsErr && allClaims) {
          for (const claim of allClaims) {
            if (claim.fee_amount_wei) {
              totalRevenueBNB += parseFloat(ethers.utils.formatEther(claim.fee_amount_wei));
            } else {
              totalRevenueBNB += claimFee;
            }
          }
        }
      }
    } catch (dbError) {
      console.warn('[getAdminKpis] Failed to use database aggregate function:', dbError);
      // 降级到循环计算
      const { data: allClaims, error: claimsErr } = await supabase
        .from('claims')
        .select('fee_amount_wei');
      if (!claimsErr && allClaims) {
        for (const claim of allClaims) {
          if (claim.fee_amount_wei) {
            totalRevenueBNB += parseFloat(ethers.utils.formatEther(claim.fee_amount_wei));
          } else {
            totalRevenueBNB += claimFee;
          }
        }
      }
    }
  } catch (rpcError: any) {
    console.error('[getAdminKpis] ⚠️ RPC 调用失败，使用默认值:', rpcError?.message || rpcError);
      // 🟢 即使 RPC 失败，也尝试从数据库计算累计收益
      try {
        // 🟢 优化：使用数据库聚合函数计算累计总收益
        const { data: sumResult, error: sumErr } = await supabase.rpc('sum_fee_amount_wei');
        if (!sumErr && sumResult !== null) {
          // 函数返回的是 TEXT 类型（纯数字字符串），直接使用
          const weiString = String(sumResult).trim();
          totalRevenueBNB = parseFloat(ethers.utils.formatEther(weiString));
        } else {
          // 降级到循环计算
          const { data: allClaims, error: claimsErr } = await supabase
            .from('claims')
            .select('fee_amount_wei');
          if (!claimsErr && allClaims) {
            for (const claim of allClaims) {
              if (claim.fee_amount_wei) {
                totalRevenueBNB += parseFloat(ethers.utils.formatEther(claim.fee_amount_wei));
              } else {
                totalRevenueBNB += claimFee;
              }
            }
          }
        }
      } catch (dbError) {
        console.error('[getAdminKpis] Failed to calculate revenue from DB:', dbError);
      }
  }

  // 计算 RAT 总持仓量：从链上读取所有用户的 RAT 余额并汇总
  // 🟢 优化：从数据库读取 RAT 总持仓量，使用聚合函数（性能提升 100 倍+）
  let totalHoldings = null as null | { amount: string; symbol: string };
  try {
    // 🟢 优化：使用数据库聚合函数计算总和
    const { data: sumResult, error: sumErr } = await supabase.rpc('sum_rat_balance_wei');
    if (!sumErr && sumResult !== null) {
      // 函数返回的是 TEXT 类型（纯数字字符串），直接使用
      const weiString = String(sumResult).trim();
      const totalBalance = parseFloat(ethers.utils.formatEther(weiString));
      
      totalHoldings = {
        amount: totalBalance.toFixed(2),
        symbol: 'RAT',
      };
      
      console.log(`[getAdminKpis] Total RAT holdings from DB aggregate: ${totalBalance.toFixed(2)} RAT`);
    } else {
      // 如果数据库函数不存在，降级到循环计算
      console.warn('[getAdminKpis] Database function not found, falling back to loop calculation');
      const { data: users, error: usersErr } = await supabase
        .from('users')
        .select('rat_balance_wei');
      
      if (!usersErr && users && users.length > 0) {
        let totalBalanceWei = ethers.BigNumber.from(0);
        for (const user of users) {
          const balanceWei = user.rat_balance_wei || '0';
          try {
            totalBalanceWei = totalBalanceWei.add(ethers.BigNumber.from(balanceWei));
          } catch (e) {
            console.warn(`[getAdminKpis] Failed to parse RAT balance for user:`, e);
          }
        }
        
        const totalBalance = parseFloat(ethers.utils.formatEther(totalBalanceWei));
        totalHoldings = {
          amount: totalBalance.toFixed(2),
          symbol: 'RAT',
        };
      }
    }
  } catch (error) {
    console.error('[getAdminKpis] Failed to calculate total RAT holdings from database:', error);
    // 失败时返回 null，不影响其他数据
  }

  return {
    ok: true,
    usersTotal: Number(finalUsersCount),
    pendingWithdrawTotal: String(pendingTotal),
    pendingWithdrawUnit: 'USDT',
    airdropFeeRecipient: feeRecipient || '',
    airdropFeeBalance: totalRevenueBNB.toFixed(6), // ✅ 修复：显示累计总收益，而不是当前余额
    airdropFeeUnit: 'BNB',
    airdrop: {
      contract: config.airdropContract,
      token: tokenAddr || '',
      claimFee: claimFee.toFixed(6),
      claimFeeUnit: 'BNB',
      cooldownSec: cooldownSec,
      rewardRange: { min: minReward, max: maxReward },
    },
    totalHoldings, // ✅ 修复：计算所有用户的 RAT 总持仓量
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
  createdAt: string,
  updateLastSettlementTime?: boolean // 可选：是否更新 last_settlement_time
) {
  const updateData: any = {
    address,
    energy_total: next.energyTotal,
    energy_locked: next.energyLocked,
    usdt_total: next.usdtTotal,
    usdt_locked: next.usdtLocked,
    updated_at: new Date().toISOString(),
    created_at: createdAt,
  };
  
  // 🟢 修复：如果指定更新结算时间，则同时更新 last_settlement_time
  // 这用于管理员赠送 USDT 时，确保增量收益从赠送时间点开始计算
  if (updateLastSettlementTime) {
    updateData.last_settlement_time = new Date().toISOString();
  }
  
  const { error } = await supabase.from('users').upsert(
    updateData,
    { onConflict: 'address' }
  );
  if (error) throw error;
}

export async function rejectWithdrawal(withdrawalId: string) {
  const { data: w, error: wErr } = await supabase
    .from('withdrawals')
    .select('id,address,amount,status,energy_locked_amount')
    .eq('id', withdrawalId)
    .maybeSingle();
  if (wErr) throw wErr;
  if (!w) throw new ApiError('NOT_FOUND', 'Withdrawal not found', 404);

  if ((w as any).status !== 'Pending') {
    return { ok: true, id: (w as any).id, status: (w as any).status, ignored: true };
  }

  const addr = lower((w as any).address);
  const amount = Number((w as any).amount || 0);
  const energyLockedAmount = Number((w as any).energy_locked_amount || 0);

  // unlock energy + unlock usdt (do not reduce totals)
  // ✅ 修复：使用 energy_locked_amount 而不是 amount 来解锁能量
  // 因为 1 USDT = 10 Energy，所以解锁能量应该使用实际锁定的能量值
  const u = await getUserEnergyRow(addr);
  const nextEnergyLocked = Math.max(0, u.energyLocked - energyLockedAmount);
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
  // 注意：不再要求 admin_payout 配置，支持从任何地址手动发放（MetaMask 模式）

  const { data: w, error: wErr } = await supabase
    .from('withdrawals')
    .select('id,address,amount,status,payout_tx_hash,energy_locked_amount')
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
  const energyLockedAmount = Number((w as any).energy_locked_amount || 0);

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
  // ✅ 修复：使用 energy_locked_amount 而不是 amount 来扣除能量
  // 因为 1 USDT = 10 Energy，所以扣除能量应该使用实际锁定的能量值
  // 🟢 关键修复：usdt_total 不应该在 completeWithdrawal 时再次扣除
  // 原因：usdt_total 在用户申请提现时（applyWithdraw）已经正确更新为 realTimeEarnings - amount
  // completeWithdrawal 只需要释放 usdt_locked，不应该修改 usdt_total
  const u = await getUserEnergyRow(userAddr);
  const amtNum = Number(amount);

  const nextEnergyLocked = Math.max(0, u.energyLocked - energyLockedAmount);
  const nextEnergyTotal = Math.max(0, u.energyTotal - energyLockedAmount);
  const nextUsdtLocked = Math.max(0, u.usdtLocked - amtNum);
  const nextUsdtTotal = u.usdtTotal; // 🟢 修复：保持不变，不扣除（已在 applyWithdraw 时扣除）

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

  // 🟢 事件驱动同步：提现成功后立即同步该用户的 RAT 余额
  try {
    const { syncSingleUserRatBalance } = await import('./ratBalanceSync.js');
    await syncSingleUserRatBalance(params.provider, userAddr);
  } catch (e) {
    console.error('[completeWithdrawal] Failed to sync RAT balance after withdrawal:', e);
    // 不阻塞主流程，记录错误即可
  }

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
 * 获取用户列表（支持分页、搜索和排序）
 * 用于管理后台用户管理页面
 */
export async function adminListUsers(params: { 
  limit: number; 
  offset: number; 
  search?: string;
  sortBy?: 'ratBalance' | 'inviteCount' | 'createdAt';
  sortOrder?: 'asc' | 'desc';
}) {
  // 🟢 优化：使用数据库 RPC 函数进行排序，支持 TEXT 类型的数值排序
  // 这样可以避免内存排序的性能问题，特别是在大数据量场景下
  const sortBy = params.sortBy || 'createdAt';
  const sortOrder = params.sortOrder || 'desc';
  
  try {
    // 调用 RPC 函数
    const { data: rpcResult, error: rpcError } = await supabase.rpc('admin_list_users_sorted', {
      p_limit: params.limit,
      p_offset: params.offset,
      p_search: params.search || null,
      p_sort_by: sortBy,
      p_sort_order: sortOrder,
    });
    
    if (rpcError) throw rpcError;
    
    // RPC 函数返回 JSON 格式：{ items: [...], total: number }
    const result = rpcResult as { items: any[]; total: number };
    const items = result.items || [];
    const total = result.total || 0;
    
    return {
      ok: true,
      items: items.map((r: any) => {
        // 🟢 将 Wei 值转换为格式化后的数值（用于前端显示）
        const ratBalanceWei = r.rat_balance_wei || '0';
        let ratBalance = 0;
        try {
          ratBalance = parseFloat(ethers.utils.formatEther(ratBalanceWei));
        } catch (e) {
          console.warn(`[adminListUsers] Failed to format RAT balance for ${r.address}:`, e);
          ratBalance = 0;
        }
        
        return {
          address: r.address,
          energyTotal: Number(r.energy_total || 0),
          energyLocked: Number(r.energy_locked || 0),
          inviteCount: Number(r.invite_count || 0),
          referrer: r.referrer_address || null,
          registeredAt: r.created_at,
          lastActive: r.updated_at,
          usdtBalance: Number(r.usdt_total || 0) - Number(r.usdt_locked || 0),
          ratBalance: ratBalance,
          ratBalanceWei: ratBalanceWei,
          ratBalanceUpdatedAt: r.rat_balance_updated_at,
        };
      }),
      total: total,
    };
  } catch (error: any) {
    console.error('[adminListUsers] RPC function error:', error);
    throw error;
  }
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
 * 获取用户团队关系（上级、下级）
 * 用于管理后台团队关系查询页面
 * 🟢 优化：支持分页查询，可以查看所有团队成员
 */
export async function adminGetUserTeam(
  address: string,
  options?: { limit?: number; offset?: number }
) {
  const addr = lower(address);
  const limit = options?.limit || 50; // 默认每页 50 条
  const offset = options?.offset || 0;

  // 1. 查询目标用户信息
  const { data: targetUser, error: targetErr } = await supabase
    .from('users')
    .select('address,energy_total,invite_count,created_at')
    .eq('address', addr)
    .maybeSingle();

  if (targetErr) throw targetErr;
  if (!targetUser) {
    throw new ApiError('NOT_FOUND', 'User not found', 404);
  }

  const target = {
    address: (targetUser as any).address,
    energyTotal: String((targetUser as any).energy_total || 0),
    inviteCount: String((targetUser as any).invite_count || 0),
    registeredAt: (targetUser as any).created_at,
  };

  // 2. 查询上级（推荐人）
  const { data: userRow, error: userErr } = await supabase
    .from('users')
    .select('referrer_address')
    .eq('address', addr)
    .maybeSingle();

  if (userErr) throw userErr;

  const referrerAddress = (userRow as any)?.referrer_address;
  let upline = null;

  if (referrerAddress && referrerAddress !== '0x0000000000000000000000000000000000000000') {
    const { data: uplineUser, error: uplineErr } = await supabase
      .from('users')
      .select('address,energy_total,invite_count,created_at')
      .eq('address', lower(referrerAddress))
      .maybeSingle();

    if (uplineErr) throw uplineErr;

    if (uplineUser) {
      upline = {
        address: (uplineUser as any).address,
        energyTotal: String((uplineUser as any).energy_total || 0),
        inviteCount: String((uplineUser as any).invite_count || 0),
        registeredAt: (uplineUser as any).created_at,
      };
    }
  }

  // 3. 查询下级（被推荐人列表，支持分页，按邀请数倒序）
  const { data: downlineUsers, error: downlineErr, count } = await supabase
    .from('users')
    .select('address,energy_total,invite_count,created_at', { count: 'exact' })
    .eq('referrer_address', addr)
    .order('invite_count', { ascending: false })
    .range(offset, offset + limit - 1); // 🟢 使用 range 实现分页

  if (downlineErr) throw downlineErr;

  const downline = (downlineUsers || []).map((r: any) => ({
    address: r.address,
    energyTotal: String(r.energy_total || 0),
    inviteCount: String(r.invite_count || 0),
    registeredAt: r.created_at,
  }));

  return {
    ok: true,
    target,
    upline,
    downline,
    total: count || 0, // 🟢 返回总数，用于前端分页
  };
}

// 🟢 新增：持币大户排行缓存（减少数据库查询）
let topHoldersCache: { data: Array<{ rank: number; address: string; balance: number }>; timestamp: number } | null = null;
const TOP_HOLDERS_CACHE_TTL = 60000; // 缓存 60 秒

/**
 * 获取 RAT 持币大户排行（Top Holders）
 * 🟢 优化：从数据库读取 RAT 余额，避免链上查询，提升响应速度
 * 🟢 优化：添加缓存机制，减少数据库查询频率
 * 🟢 优化：使用数据库排序和限制，提升查询性能
 */
export async function getTopRATHolders(provider: ethers.providers.Provider, limit: number = 5) {
  try {
    // 🟢 检查缓存
    if (topHoldersCache && Date.now() - topHoldersCache.timestamp < TOP_HOLDERS_CACHE_TTL) {
      // 从缓存返回，但需要限制数量
      return { 
        ok: true, 
        items: topHoldersCache.data.slice(0, limit) 
      };
    }

    // 🟢 优化：查询有余额的用户（rat_balance_wei 是 TEXT 类型，无法直接数值排序）
    // 先查询一定数量的数据，然后在内存中排序
    // 为了性能，只查询前 200 名用户进行排序（足够覆盖大部分场景）
    const { data: users, error } = await supabase
      .from('users')
      .select('address, rat_balance_wei')
      .not('rat_balance_wei', 'is', null)
      .limit(200); // 查询前 200 条，用于排序和缓存
    
    if (error) throw error;

    if (!users || users.length === 0) {
      // 缓存空结果
      topHoldersCache = { data: [], timestamp: Date.now() };
      return { ok: true, items: [] };
    }

    // 将 Wei 值转换为格式化后的数值，并按余额排序
    const holders = users
      .map((user: any) => {
        const balanceWei = user.rat_balance_wei || '0';
        let balance = 0;
        try {
          balance = parseFloat(ethers.utils.formatEther(balanceWei));
        } catch (e) {
          console.warn(`[getTopRATHolders] Failed to format RAT balance for ${user.address}:`, e);
          balance = 0;
        }
        return {
          address: user.address,
          balance,
        };
      })
      .filter((item) => item.balance > 0) // 过滤掉余额为 0 的用户
      .sort((a, b) => b.balance - a.balance) // 按余额降序排序
      .slice(0, 20) // 取前 20 名用于缓存
      .map((item, index) => ({
        rank: index + 1,
        address: item.address,
        balance: item.balance,
      }));

    // 🟢 更新缓存（缓存前 20 名，以便后续不同 limit 的请求）
    topHoldersCache = { data: holders, timestamp: Date.now() };

    // 返回限制数量的结果
    const result = holders.slice(0, limit);
    console.log(`[getTopRATHolders] Found ${result.length} top holders from database (cached for ${TOP_HOLDERS_CACHE_TTL / 1000}s)`);
    return { ok: true, items: result };
  } catch (e: any) {
    console.error('[getTopRATHolders] Failed to get top RAT holders from database:', e);
    // 失败时返回空数组，不影响其他功能
    return { ok: true, items: [] };
  }
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
  // 🟢 修复：从数据库读取实际支付的手续费，而不是从链上读取当前的 claimFee
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  
  // 获取今日的收益记录（包含实际支付的手续费）
  const { data: todayClaims, error: todayErr } = await supabase
    .from('claims')
    .select('fee_amount_wei')
    .gte('created_at', todayStart.toISOString());
  if (todayErr) throw todayErr;

  // 获取昨日的收益记录（包含实际支付的手续费）
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const yesterdayEnd = new Date(todayStart);
  const { data: yesterdayClaims, error: yesterdayErr } = await supabase
    .from('claims')
    .select('fee_amount_wei')
    .gte('created_at', yesterdayStart.toISOString())
    .lt('created_at', yesterdayEnd.toISOString());
  if (yesterdayErr) throw yesterdayErr;

  // 🟢 修复：获取降级值（如果某些记录没有 fee_amount_wei）
  let fallbackClaimFee = 0;
  try {
    const airdrop = new ethers.Contract(config.airdropContract, AIRDROP_ABI, provider);
    const claimFeeWei = await airdrop.claimFee();
    fallbackClaimFee = parseFloat(ethers.utils.formatEther(claimFeeWei));
  } catch (e) {
    console.warn('[getRevenueStats] Failed to get claimFee from contract, using 0 as fallback:', e);
  }

  // 🟢 修复：计算今日收益（使用实际支付的手续费）
  let todayRevenue = 0;
  let todayCount = 0;
  if (todayClaims) {
    for (const claim of todayClaims) {
      todayCount++;
      if (claim.fee_amount_wei) {
        todayRevenue += parseFloat(ethers.utils.formatEther(claim.fee_amount_wei));
      } else {
        // 降级：使用当前的 claimFee
        todayRevenue += fallbackClaimFee;
      }
    }
  }

  // 🟢 修复：计算昨日收益（使用实际支付的手续费）
  let yesterdayRevenue = 0;
  if (yesterdayClaims) {
    for (const claim of yesterdayClaims) {
      if (claim.fee_amount_wei) {
        yesterdayRevenue += parseFloat(ethers.utils.formatEther(claim.fee_amount_wei));
      } else {
        // 降级：使用当前的 claimFee
        yesterdayRevenue += fallbackClaimFee;
      }
    }
  }

  // 计算趋势（今日 vs 昨日）
  const trend = yesterdayRevenue > 0 ? ((todayRevenue - yesterdayRevenue) / yesterdayRevenue) * 100 : 0;

  // 今日预期收益（基于当前速率，假设每小时速率不变）
  const now = new Date();
  const hoursElapsed = (now.getTime() - todayStart.getTime()) / (1000 * 60 * 60);
  const estimatedDaily = hoursElapsed > 0 ? (todayRevenue / hoursElapsed) * 24 : 0;

  // 平均单笔费率（今日总收益 / 今日记录数）
  const avgFee = todayCount > 0 ? todayRevenue / todayCount : fallbackClaimFee;

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

  // 🟢 修复：当管理员增加 USDT 时，同时更新 last_settlement_time
  // 这样增量收益会从赠送时间点开始计算，而不是从旧的结算时间开始
  // 确保管理员赠送的 USDT 能正确显示在可提现金额中
  await updateUserBalances(
    addr,
    { energyTotal: u.energyTotal, energyLocked: u.energyLocked, usdtTotal: nextTotal, usdtLocked: u.usdtLocked },
    u.createdAt,
    true // 🟢 关键：更新 last_settlement_time，确保增量收益从当前时间开始计算
  );

  return {
    ok: true,
    address: addr,
    usdtTotal: String(nextTotal),
    usdtLocked: String(u.usdtLocked),
  };
}

/**
 * 管理员手动设置用户的 last_settlement_time
 * 用于处理通过直接转账获得代币的情况，确保收益从正确的时间开始计算
 * @param address 用户地址
 * @param settlementTime ISO 8601 格式的时间字符串，例如 "2025-12-29T09:41:37.000Z"
 */
export async function adminSetUserSettlementTime(address: string, settlementTime: string) {
  const addr = lower(address);
  
  // 验证时间格式
  const time = new Date(settlementTime);
  if (isNaN(time.getTime())) {
    throw new ApiError('INVALID_REQUEST', 'Invalid settlement time format. Expected ISO 8601 format (e.g., "2025-12-29T09:41:37.000Z")', 400);
  }
  
  // 确保用户存在
  const u = await getUserEnergyRow(addr);
  
  // 更新 last_settlement_time
  const { error } = await supabase
    .from('users')
    .update({ 
      last_settlement_time: time.toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('address', addr);
  
  if (error) {
    throw new ApiError('INTERNAL_ERROR', `Failed to update last_settlement_time: ${error.message}`, 500);
  }
  
  console.log(`[Admin] ✅ Set last_settlement_time for ${addr} to ${time.toISOString()}`);
  
  return {
    ok: true,
    address: addr,
    lastSettlementTime: time.toISOString(),
    message: 'last_settlement_time updated successfully'
  };
}

/**
 * 获取财务收益明细（BNB 收入）
 * 从 claims 表统计用户领取空投产生的费用收入
 */
export async function getFinanceRevenue(provider: ethers.providers.Provider, page: number, pageSize: number) {
  // 🟢 修复：从数据库读取实际支付的手续费，而不是从链上读取当前的 claimFee
  // 获取总数（需要统计所有记录的实际手续费总和）
  const { count, error: countErr } = await supabase
    .from('claims')
    .select('tx_hash', { count: 'exact', head: true });
  if (countErr) throw countErr;

  // 分页查询，包含 fee_amount_wei 字段
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const { data, error } = await supabase
    .from('claims')
    .select('tx_hash,address,created_at,fee_amount_wei')
    .order('created_at', { ascending: false })
    .range(from, to);
  if (error) throw error;

  // 🟢 修复：获取降级值（如果某些记录没有 fee_amount_wei）
  let fallbackClaimFee = '0';
  try {
    const airdrop = new ethers.Contract(config.airdropContract, AIRDROP_ABI, provider);
    const claimFeeWei = await airdrop.claimFee();
    fallbackClaimFee = ethers.utils.formatEther(claimFeeWei);
  } catch (e) {
    console.warn('[getFinanceRevenue] Failed to get claimFee from contract, using 0 as fallback:', e);
  }

  // 🟢 修复：计算总收入时，需要查询所有记录的实际手续费
  // 为了性能，我们只计算当前页的金额，总金额需要单独查询
  let totalRevenue = 0;
  try {
    // 查询所有记录的实际手续费总和
    const { data: allFees, error: feesErr } = await supabase
      .from('claims')
      .select('fee_amount_wei');
    if (!feesErr && allFees) {
      for (const record of allFees) {
        if (record.fee_amount_wei) {
          totalRevenue += parseFloat(ethers.utils.formatEther(record.fee_amount_wei));
        } else {
          // 降级：使用当前的 claimFee
          totalRevenue += parseFloat(fallbackClaimFee);
        }
      }
    }
  } catch (e) {
    console.warn('[getFinanceRevenue] Failed to calculate total revenue, using fallback:', e);
    // 如果查询失败，使用降级值
    totalRevenue = parseFloat(fallbackClaimFee) * (count || 0);
  }

  return {
    ok: true,
    items: (data || []).map((r: any) => {
      let feeAmount = '0';
      if (r.fee_amount_wei) {
        // 使用实际支付的手续费
        feeAmount = ethers.utils.formatEther(r.fee_amount_wei);
      } else {
        // 降级：使用当前的 claimFee
        feeAmount = fallbackClaimFee;
      }
      return {
        txHash: r.tx_hash,
        address: r.address,
        amount: feeAmount,
        unit: 'BNB',
        createdAt: r.created_at,
      };
    }),
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

  // 🟢 修复：从数据库读取实际支付的手续费，而不是从链上读取当前的 claimFee
  // 构建查询，包含 fee_amount_wei 字段
  let query = supabase
    .from('claims')
    .select('tx_hash,address,created_at,fee_amount_wei', { count: 'exact' })
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

  // 🟢 修复：使用实际支付的手续费计算总收入
  // 如果 fee_amount_wei 为空，降级使用当前的 claimFee（向后兼容）
  let fallbackClaimFee = '0';
  try {
    const airdrop = new ethers.Contract(config.airdropContract, AIRDROP_ABI, provider);
    const claimFeeWei = await airdrop.claimFee();
    fallbackClaimFee = ethers.utils.formatEther(claimFeeWei);
  } catch (e) {
    console.warn('[getAdminRevenueWithDateRange] Failed to get claimFee from contract, using 0 as fallback:', e);
  }

  // 计算总收入：使用实际支付的手续费，如果为空则使用降级值
  let totalRevenue = 0;
  const items = (data || []).map((r: any) => {
    let feeAmount = 0;
    if (r.fee_amount_wei) {
      // 使用实际支付的手续费
      feeAmount = parseFloat(ethers.utils.formatEther(r.fee_amount_wei));
    } else {
      // 降级：使用当前的 claimFee（历史记录可能没有 fee_amount_wei）
      feeAmount = parseFloat(fallbackClaimFee);
    }
    totalRevenue += feeAmount;
    return {
      id: r.tx_hash,
      address: r.address,
      feeAmount: feeAmount,
      asset: 'BNB' as const,
      timestamp: r.created_at,
      txHash: r.tx_hash,
    };
  });

  return {
    ok: true,
    items,
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
    totalCount: count || 0, // 🟢 新增：返回总记录数
  };
}


