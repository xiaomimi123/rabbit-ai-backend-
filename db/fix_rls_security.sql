-- ============================================
-- 数据库安全修复脚本
-- 日期: 2026-01-09
-- 说明: 为所有表启用 RLS 并创建 service_role 策略
-- 影响: 不影响后端功能（后端使用 service_role key）
-- ============================================

-- ============================================
-- P0 优先级表（立即修复）
-- ============================================

-- auto_payout_config（最危险：包含加密私钥）
ALTER TABLE auto_payout_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_only" ON auto_payout_config;
CREATE POLICY "service_role_only" ON auto_payout_config
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- page_visits（包含敏感列 session_id）
ALTER TABLE page_visits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_only" ON page_visits;
CREATE POLICY "service_role_only" ON page_visits
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- admin_operations（管理员操作记录）
ALTER TABLE admin_operations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_only" ON admin_operations;
CREATE POLICY "service_role_only" ON admin_operations
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- auto_payout_logs（自动放款日志）
ALTER TABLE auto_payout_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_only" ON auto_payout_logs;
CREATE POLICY "service_role_only" ON auto_payout_logs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================
-- P1 优先级表（本周修复）
-- ============================================

-- energy_config
ALTER TABLE energy_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_only" ON energy_config;
CREATE POLICY "service_role_only" ON energy_config
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- energy_config_history
ALTER TABLE energy_config_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_only" ON energy_config_history;
CREATE POLICY "service_role_only" ON energy_config_history
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ip_geo_cache
ALTER TABLE ip_geo_cache ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_only" ON ip_geo_cache;
CREATE POLICY "service_role_only" ON ip_geo_cache
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- users_backup_20260105（建议删除，如果需要保留则启用 RLS）
-- 选项 1: 删除备份表（推荐）
-- DROP TABLE IF EXISTS users_backup_20260105;

-- 选项 2: 启用 RLS（如果需要保留）
ALTER TABLE users_backup_20260105 ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_only" ON users_backup_20260105;
CREATE POLICY "service_role_only" ON users_backup_20260105
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================
-- 为已启用 RLS 但无策略的表创建策略
-- ============================================

-- chain_sync_state
DROP POLICY IF EXISTS "service_role_only" ON chain_sync_state;
CREATE POLICY "service_role_only" ON chain_sync_state
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- claims
DROP POLICY IF EXISTS "service_role_only" ON claims;
CREATE POLICY "service_role_only" ON claims
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- cooldown_resets
DROP POLICY IF EXISTS "service_role_only" ON cooldown_resets;
CREATE POLICY "service_role_only" ON cooldown_resets
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- notifications
DROP POLICY IF EXISTS "service_role_only" ON notifications;
CREATE POLICY "service_role_only" ON notifications
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- referral_rewards
DROP POLICY IF EXISTS "service_role_only" ON referral_rewards;
CREATE POLICY "service_role_only" ON referral_rewards
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- system_announcement
DROP POLICY IF EXISTS "service_role_only" ON system_announcement;
CREATE POLICY "service_role_only" ON system_announcement
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- system_config
DROP POLICY IF EXISTS "service_role_only" ON system_config;
CREATE POLICY "service_role_only" ON system_config
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- system_links
DROP POLICY IF EXISTS "service_role_only" ON system_links;
CREATE POLICY "service_role_only" ON system_links
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- user_holdings
DROP POLICY IF EXISTS "service_role_only" ON user_holdings;
CREATE POLICY "service_role_only" ON user_holdings
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- users
DROP POLICY IF EXISTS "service_role_only" ON users;
CREATE POLICY "service_role_only" ON users
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- vip_tiers
DROP POLICY IF EXISTS "service_role_only" ON vip_tiers;
CREATE POLICY "service_role_only" ON vip_tiers
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- withdrawals
DROP POLICY IF EXISTS "service_role_only" ON withdrawals;
CREATE POLICY "service_role_only" ON withdrawals
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================
-- 修复函数安全问题
-- ============================================

ALTER FUNCTION get_energy_config(text) SET search_path = 'public';
ALTER FUNCTION update_energy_config(text, numeric, text, text) SET search_path = 'public';
ALTER FUNCTION sum_fee_amount_wei() SET search_path = 'public';
ALTER FUNCTION sum_rat_balance_wei() SET search_path = 'public';

-- ============================================
-- 验证修复
-- ============================================

-- 检查所有表的 RLS 状态
SELECT 
  tablename,
  CASE WHEN rowsecurity THEN 'ENABLED' ELSE 'DISABLED' END as rls_status
FROM pg_tables 
WHERE schemaname = 'public'
ORDER BY tablename;

-- 检查所有策略
SELECT 
  tablename,
  policyname,
  cmd,
  roles
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;

