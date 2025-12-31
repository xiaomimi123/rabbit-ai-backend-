function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function optionalInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function optionalStr(name: string, fallback = ''): string {
  const v = process.env[name];
  return (v ?? fallback).trim();
}

function getPort(): number {
  const portStr = process.env.PORT;
  if (!portStr || !portStr.trim()) {
    // Render will auto-inject PORT, but if missing, use default
    return 8080;
  }
  const port = Number.parseInt(portStr.trim(), 10);
  // If PORT is not a valid number, fallback to default (Render will override anyway)
  if (!Number.isFinite(port) || port <= 0 || port >= 65536) {
    // Log warning but don't crash - Render will inject correct PORT at runtime
    console.warn(`[WARN] Invalid PORT environment variable "${portStr}", using default 8080. Render will override this.`);
    return 8080;
  }
  return port;
}

export const config = {
  port: getPort(),
  nodeEnv: process.env.NODE_ENV || 'development',

  supabaseUrl: required('SUPABASE_URL'),
  supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),

  rpcUrls: required('BSC_RPC_URLS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Optional: 专门用于后台管理的 RPC URL（用于查询用户 RAT 持仓）
  // 如果未配置，则使用默认的 rpcUrls
  adminRpcUrl: optionalStr('ADMIN_RPC_URL'),

  airdropContract: required('AIRDROP_CONTRACT').toLowerCase(),

  confirmations: optionalInt('CONFIRMATIONS', 12),
  batchBlocks: optionalInt('BATCH_BLOCKS', 2000),
  pollIntervalMs: optionalInt('POLL_INTERVAL_MS', 5000),
  chainSyncId: process.env.CHAIN_SYNC_ID || 'bsc_airdrop',

  // ⚠️ Required: for Earnings calculation / RAT balance queries
  // 如果未配置此变量，服务启动时会直接失败（Fail Fast），避免运行时错误
  // 使用场景：
  // - 收益计算引擎（earnings.ts）：读取链上 RAT 余额
  // - 资产查询 API（asset.ts）：获取用户 RAT 余额
  // - 管理员后台（admin.ts）：显示用户 RAT 持仓
  ratTokenContract: required('RAT_TOKEN_CONTRACT').toLowerCase(),

  // Optional: for Admin Panel / finance ops / KPIs
  // stakingContract: optionalStr('STAKING_CONTRACT').toLowerCase(), // 已移除：不再使用质押合约，改为持币生息模式
  usdtContract: optionalStr('USDT_CONTRACT').toLowerCase(),
  adminPayoutAddress: optionalStr('ADMIN_PAYOUT_ADDRESS').toLowerCase(),
  withdrawAlertThreshold: Number(process.env.WITHDRAW_ALERT_THRESHOLD || 1000),

  corsOrigins: optionalStr('CORS_ORIGINS', '*'),

  jwtSecret: optionalStr('JWT_SECRET'),
  adminApiKey: optionalStr('ADMIN_API_KEY'),
};

if (config.rpcUrls.length === 0) {
  throw new Error('BSC_RPC_URLS is empty');
}


