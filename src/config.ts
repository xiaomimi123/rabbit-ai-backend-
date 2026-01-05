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

// 🟢 修复：显式定义 config 类型，确保 TypeScript 能正确识别所有属性
export const config: {
  port: number;
  nodeEnv: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  rpcUrls: string[];
  adminRpcUrl: string;
  airdropContract: string;
  confirmations: number;
  batchBlocks: number;
  pollIntervalMs: number;
  chainSyncId: string;
  ratTokenContract: string;
  usdtContract: string;
  adminPayoutAddress: string;
  withdrawAlertThreshold: number;
  corsOrigins: string;
  jwtSecret: string;
  adminApiKey: string;
  analyticsCleanupDays: number;
  analyticsCleanupEnabled: boolean;
  analyticsCleanupIntervalHours: number;
  maxmindLicenseKey: string;
  maxmindDbPath: string;
  maxmindAutoUpdate: boolean;
  sentryDsn: string;
  sentryEnvironment: string;
  sentryEnabled: boolean;
  telegram: {
    botToken: string;
    adminChatId: string;
    enabled: boolean;
  };
} = {
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

  // 🟢 新增：访问统计数据清理配置
  analyticsCleanupDays: optionalInt('ANALYTICS_CLEANUP_DAYS', 90), // 默认保留 90 天
  analyticsCleanupEnabled: process.env.ANALYTICS_CLEANUP_ENABLED === 'true', // 默认关闭，需要手动启用
  analyticsCleanupIntervalHours: optionalInt('ANALYTICS_CLEANUP_INTERVAL_HOURS', 24), // 默认每 24 小时执行一次

  // 🟢 新增：MaxMind GeoLite2 配置
  maxmindLicenseKey: optionalStr('MAXMIND_LICENSE_KEY'), // MaxMind License Key（用于自动下载数据库）
  maxmindDbPath: optionalStr('MAXMIND_DB_PATH', './data/GeoLite2-City.mmdb'), // 数据库文件路径
  maxmindAutoUpdate: process.env.MAXMIND_AUTO_UPDATE === 'true', // 是否启用自动更新

  // 🟢 新增：Sentry 错误监控配置（可选）
  sentryDsn: optionalStr('SENTRY_DSN'), // Sentry DSN（用于错误监控）
  sentryEnvironment: optionalStr('SENTRY_ENVIRONMENT', process.env.NODE_ENV || 'development'), // Sentry 环境标识
  sentryEnabled: process.env.SENTRY_ENABLED !== 'false', // 是否启用 Sentry（默认启用，如果配置了 DSN）

  // 🟢 新增：Telegram 通知配置
  telegram: {
    botToken: optionalStr('TELEGRAM_BOT_TOKEN'),
    adminChatId: optionalStr('TELEGRAM_ADMIN_CHAT_ID'),
    enabled: process.env.TELEGRAM_NOTIFICATIONS_ENABLED === 'true',
  },
};

if (config.rpcUrls.length === 0) {
  throw new Error('BSC_RPC_URLS is empty');
}


