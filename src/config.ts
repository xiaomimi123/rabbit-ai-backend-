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

  airdropContract: required('AIRDROP_CONTRACT').toLowerCase(),

  confirmations: optionalInt('CONFIRMATIONS', 12),
  batchBlocks: optionalInt('BATCH_BLOCKS', 2000),
  pollIntervalMs: optionalInt('POLL_INTERVAL_MS', 5000),
  chainSyncId: process.env.CHAIN_SYNC_ID || 'bsc_airdrop',

  // Optional: for Admin Panel / finance ops / KPIs
  ratTokenContract: optionalStr('RAT_TOKEN_CONTRACT').toLowerCase(),
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


