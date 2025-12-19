-- Rabbit AI Backend - Supabase schema
-- Copy/paste into Supabase SQL Editor.

create extension if not exists "pgcrypto";

create table if not exists public.users (
  address text primary key,
  referrer_address text null,
  invite_count bigint not null default 0,
  energy_total numeric not null default 0,
  energy_locked numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_users_referrer on public.users(referrer_address);

create table if not exists public.claims (
  tx_hash text primary key,
  address text not null,
  referrer text not null,
  amount_wei text not null,
  block_number bigint null,
  block_time timestamptz null,
  status text not null default 'SUCCESS',
  created_at timestamptz not null default now()
);

create index if not exists idx_claims_address_time on public.claims(address, created_at desc);

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

create table if not exists public.cooldown_resets (
  tx_hash text primary key,
  referrer_address text not null,
  block_number bigint null,
  block_time timestamptz null,
  created_at timestamptz not null default now()
);

create index if not exists idx_cd_resets_referrer_time on public.cooldown_resets(referrer_address, created_at desc);

create table if not exists public.withdrawals (
  id uuid primary key default gen_random_uuid(),
  address text not null,
  amount numeric not null,
  status text not null default 'Pending',
  energy_locked_amount numeric not null default 0,
  payout_tx_hash text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_withdrawals_address_time on public.withdrawals(address, created_at desc);
create index if not exists idx_withdrawals_status_time on public.withdrawals(status, created_at desc);
-- Prevent payout tx replay (a tx hash can only be used once)
create unique index if not exists uq_withdrawals_payout_tx_hash_not_null on public.withdrawals(payout_tx_hash) where payout_tx_hash is not null;

create table if not exists public.chain_sync_state (
  id text primary key,
  last_block bigint not null default 0,
  updated_at timestamptz not null default now()
);

-- Simple key-value config store for Admin Panel (optional)
create table if not exists public.system_config (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- RLS (recommended even if service role bypasses it)
alter table public.users enable row level security;
alter table public.claims enable row level security;
alter table public.referral_rewards enable row level security;
alter table public.cooldown_resets enable row level security;
alter table public.withdrawals enable row level security;
alter table public.chain_sync_state enable row level security;
alter table public.system_config enable row level security;


