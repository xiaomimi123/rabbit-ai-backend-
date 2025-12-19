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

export const config = {
  port: Number(process.env.PORT || 8080),
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

  jwtSecret: process.env.JWT_SECRET || '',
  adminApiKey: process.env.ADMIN_API_KEY || '',
};

if (config.rpcUrls.length === 0) {
  throw new Error('BSC_RPC_URLS is empty');
}


