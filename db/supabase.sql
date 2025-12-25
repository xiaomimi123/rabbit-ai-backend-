-- Rabbit AI Backend - Supabase schema
-- Copy/paste into Supabase SQL Editor.
-- 更新时间: 2024-12-25

create extension if not exists "pgcrypto";

-- ============================================================================
-- 1. 用户表 (users)
-- ============================================================================
create table if not exists public.users (
  address text primary key,
  referrer_address text null,
  invite_count bigint not null default 0,
  energy_total numeric not null default 0,
  energy_locked numeric not null default 0,
  usdt_total numeric not null default 0,  -- 累计 USDT 收益总额
  usdt_locked numeric not null default 0,  -- 已锁定 USDT（提现中）
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_users_referrer on public.users(referrer_address);

-- ============================================================================
-- 2. 空投领取记录表 (claims)
-- ============================================================================
create table if not exists public.claims (
  tx_hash text primary key,
  address text not null,
  referrer text not null,
  amount_wei text not null,
  block_number bigint null,
  block_time timestamptz null,
  status text not null default 'SUCCESS',
  energy_awarded boolean not null default false,  -- 能量是否已奖励（幂等性保证）
  created_at timestamptz not null default now()
);

create index if not exists idx_claims_address_time on public.claims(address, created_at desc);
create index if not exists idx_claims_address_energy_awarded on public.claims(address, energy_awarded) where energy_awarded = false;
create index if not exists idx_claims_referrer on public.claims(referrer, created_at desc);

-- ============================================================================
-- 3. 推荐奖励记录表 (referral_rewards)
-- ============================================================================
create table if not exists public.referral_rewards (
  id uuid primary key default gen_random_uuid(),
  referrer_address text not null,
  amount_wei text not null,
  tx_hash text not null unique,
  block_number bigint null,
  block_time timestamptz null,
  created_at timestamptz not null default now()
);

create index if not exists idx_ref_rewards_referrer_time on public.referral_rewards(referrer_address, created_at desc);

-- ============================================================================
-- 4. 冷却重置记录表 (cooldown_resets)
-- ============================================================================
create table if not exists public.cooldown_resets (
  tx_hash text primary key,
  referrer_address text not null,
  block_number bigint null,
  block_time timestamptz null,
  created_at timestamptz not null default now()
);

create index if not exists idx_cd_resets_referrer_time on public.cooldown_resets(referrer_address, created_at desc);

-- ============================================================================
-- 5. 提现记录表 (withdrawals)
-- ============================================================================
create table if not exists public.withdrawals (
  id uuid primary key default gen_random_uuid(),
  address text not null,
  amount numeric not null,
  status text not null default 'Pending',  -- Pending | Completed | Rejected
  energy_locked_amount numeric not null default 0,  -- 锁定的能量数量（1 USDT = 10 Energy）
  payout_tx_hash text null,  -- 提现交易哈希（完成时填写）
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_withdrawals_address_time on public.withdrawals(address, created_at desc);
create index if not exists idx_withdrawals_status_time on public.withdrawals(status, created_at desc);
-- 防止 payout tx 重放攻击（一个 tx hash 只能使用一次）
create unique index if not exists uq_withdrawals_payout_tx_hash_not_null on public.withdrawals(payout_tx_hash) where payout_tx_hash is not null;

-- ============================================================================
-- 6. 链同步状态表 (chain_sync_state)
-- ============================================================================
create table if not exists public.chain_sync_state (
  id text primary key,
  last_block bigint not null default 0,
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- 7. 系统配置表 (system_config)
-- ============================================================================
create table if not exists public.system_config (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- 8. 用户通知表 (notifications)
-- ============================================================================
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  address text not null,
  type text not null default 'SYSTEM',  -- SYSTEM | REWARD | NETWORK
  title text not null,
  content text not null,
  read boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_notifications_address_read on public.notifications(address, read, created_at desc);
create index if not exists idx_notifications_address_time on public.notifications(address, created_at desc);

-- ============================================================================
-- 9. 系统公告表 (system_announcement)
-- ============================================================================
create table if not exists public.system_announcement (
  id text primary key default 'latest',  -- 固定值 'latest'，只保留一条最新记录
  content text not null,
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- 10. 系统链接配置表 (system_links)
-- ============================================================================
create table if not exists public.system_links (
  key text primary key,  -- 'whitepaper' | 'audits' | 'support'
  url text not null,
  updated_at timestamptz not null default now()
);

-- 初始化默认链接
insert into public.system_links (key, url) values
  ('whitepaper', 'https://example.com/whitepaper'),
  ('audits', 'https://example.com/audits'),
  ('support', 'https://example.com/support')
on conflict (key) do nothing;

-- ============================================================================
-- 11. 用户持币记录表 (user_holdings) - 可选，用于缓存和优化
-- ============================================================================
create table if not exists public.user_holdings (
  address text primary key,
  rat_balance numeric not null default 0,  -- 当前 RAT 余额（缓存）
  first_hold_time timestamptz null,  -- 首次持币时间
  last_updated timestamptz not null default now(),
  current_tier_level integer null,  -- 当前达到的VIP等级（1-4），null表示未达到任何等级
  tier_reached_at timestamptz null  -- 达到当前VIP等级的时间，用于计算收益起始时间
);

create index if not exists idx_user_holdings_updated on public.user_holdings(last_updated);
create index if not exists idx_user_holdings_tier on public.user_holdings(current_tier_level, tier_reached_at);

-- ============================================================================
-- 12. VIP等级配置表 (vip_tiers) - 管理员可动态管理利率
-- ============================================================================
create table if not exists public.vip_tiers (
  level integer primary key,  -- 等级（1-4）
  name text not null,  -- 等级名称（如：🌱 新手）
  min_balance numeric not null,  -- 最低持币要求（RAT）
  max_balance numeric null,  -- 最高持币要求（null 表示无上限）
  daily_rate numeric not null,  -- 日利率（百分比，如 2.0 表示 2%）
  is_active boolean not null default true,  -- 是否启用
  display_order integer not null,  -- 显示顺序
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 初始化默认VIP等级配置
insert into public.vip_tiers (level, name, min_balance, max_balance, daily_rate, is_active, display_order) values
  (1, '🌱 新手', 10000, 49999, 2.0, true, 1),
  (2, '🌿 进阶', 50000, 99999, 4.0, true, 2),
  (3, '🌳 资深', 100000, 199999, 6.0, true, 3),
  (4, '💎 核心', 200000, null, 10.0, true, 4)
on conflict (level) do nothing;

create index if not exists idx_vip_tiers_active_order on public.vip_tiers(is_active, display_order);

-- ============================================================================
-- RLS (Row Level Security) - 推荐启用，即使 service role 可绕过
-- ============================================================================
alter table public.users enable row level security;
alter table public.claims enable row level security;
alter table public.referral_rewards enable row level security;
alter table public.cooldown_resets enable row level security;
alter table public.withdrawals enable row level security;
alter table public.chain_sync_state enable row level security;
alter table public.system_config enable row level security;
alter table public.notifications enable row level security;
alter table public.system_announcement enable row level security;
alter table public.system_links enable row level security;
alter table public.user_holdings enable row level security;
alter table public.vip_tiers enable row level security;

-- ============================================================================
-- 数据完整性约束（可选，根据业务需求添加）
-- ============================================================================

-- 确保 users 表的能量和 USDT 锁定值不超过总额
-- 注意：这些约束可能会影响性能，建议在应用层处理
-- alter table public.users add constraint chk_energy_locked check (energy_locked <= energy_total);
-- alter table public.users add constraint chk_usdt_locked check (usdt_locked <= usdt_total);

-- 确保 withdrawals 表的 status 值有效
-- alter table public.withdrawals add constraint chk_withdrawal_status check (status IN ('Pending', 'Completed', 'Rejected'));

-- ============================================================================
-- 注释说明
-- ============================================================================

comment on table public.users is '用户表：存储用户基本信息、能量、USDT余额等';
comment on table public.claims is '空投领取记录表：记录用户每次领取空投的交易';
comment on table public.referral_rewards is '推荐奖励记录表：记录推荐人获得的RAT奖励';
comment on table public.cooldown_resets is '冷却重置记录表：记录推荐人因邀请而重置冷却时间的事件';
comment on table public.withdrawals is '提现记录表：记录用户提现USDT的申请和处理状态';
comment on table public.chain_sync_state is '链同步状态表：记录Indexer同步的区块高度';
comment on table public.system_config is '系统配置表：存储系统级配置（key-value格式）';
comment on table public.notifications is '用户通知表：存储站内信通知';
comment on table public.system_announcement is '系统公告表：存储全局公告（只保留一条最新记录）';
comment on table public.system_links is '系统链接配置表：存储白皮书、审计报告、客服等链接';
comment on table public.user_holdings is '用户持币记录表：缓存用户RAT余额和VIP等级（可选，用于优化查询）';
comment on table public.vip_tiers is 'VIP等级配置表：存储VIP等级配置，管理员可动态修改利率';

comment on column public.users.usdt_total is '累计USDT收益总额（由收益计算引擎实时计算，或定时任务更新）';
comment on column public.users.usdt_locked is '已锁定USDT（提现申请中，防止重复提现）';
comment on column public.claims.energy_awarded is '能量是否已奖励（幂等性保证，防止重复奖励）';
comment on column public.withdrawals.energy_locked_amount is '锁定的能量数量（1 USDT = 10 Energy）';
comment on column public.user_holdings.current_tier_level is '当前达到的VIP等级（1-4），null表示未达到任何等级';
comment on column public.user_holdings.tier_reached_at is '达到当前VIP等级的时间，用于计算收益起始时间';
