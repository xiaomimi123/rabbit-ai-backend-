-- ============================================
-- P2级审计日志：自动放款配置变更审计
-- 日期: 2026-01-13
-- 目的: 记录所有自动放款配置的变更历史
-- 风险: 自动放款配置影响资金安全，需要完整的变更记录
-- ============================================

-- 1. 创建 auto_payout_config_audit_log 表
CREATE TABLE IF NOT EXISTS auto_payout_config_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  field_name text NOT NULL,  -- 'threshold_usdt', 'enabled', 'min_balance_usdt', 'daily_limit_usdt' 等
  old_value text,
  new_value text NOT NULL,
  changed_by text,  -- 管理员地址
  change_reason text,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

-- 2. 创建索引（提高查询性能）
CREATE INDEX IF NOT EXISTS idx_auto_payout_audit_field ON auto_payout_config_audit_log(field_name);
CREATE INDEX IF NOT EXISTS idx_auto_payout_audit_created_at ON auto_payout_config_audit_log(created_at DESC);

-- 3. 添加表注释
COMMENT ON TABLE auto_payout_config_audit_log IS '自动放款配置审计日志 - 记录所有自动放款配置变更';
COMMENT ON COLUMN auto_payout_config_audit_log.field_name IS '变更的字段名';
COMMENT ON COLUMN auto_payout_config_audit_log.old_value IS '变更前的值';
COMMENT ON COLUMN auto_payout_config_audit_log.new_value IS '变更后的值';
COMMENT ON COLUMN auto_payout_config_audit_log.changed_by IS '执行变更的管理员地址';
COMMENT ON COLUMN auto_payout_config_audit_log.change_reason IS '变更原因或备注';

-- 4. 创建触发器函数
CREATE OR REPLACE FUNCTION audit_auto_payout_config_changes()
RETURNS TRIGGER AS $$
BEGIN
  -- 记录 threshold_usdt 变更
  IF OLD.threshold_usdt IS DISTINCT FROM NEW.threshold_usdt THEN
    INSERT INTO auto_payout_config_audit_log (field_name, old_value, new_value, changed_by, created_at)
    VALUES ('threshold_usdt', OLD.threshold_usdt::text, NEW.threshold_usdt::text, NEW.updated_by, NOW());
  END IF;
  
  -- 记录 enabled 变更
  IF OLD.enabled IS DISTINCT FROM NEW.enabled THEN
    INSERT INTO auto_payout_config_audit_log (field_name, old_value, new_value, changed_by, created_at)
    VALUES ('enabled', OLD.enabled::text, NEW.enabled::text, NEW.updated_by, NOW());
  END IF;
  
  -- 记录 min_balance_usdt 变更
  IF OLD.min_balance_usdt IS DISTINCT FROM NEW.min_balance_usdt THEN
    INSERT INTO auto_payout_config_audit_log (field_name, old_value, new_value, changed_by, created_at)
    VALUES ('min_balance_usdt', OLD.min_balance_usdt::text, NEW.min_balance_usdt::text, NEW.updated_by, NOW());
  END IF;
  
  -- 记录 daily_limit_usdt 变更
  IF OLD.daily_limit_usdt IS DISTINCT FROM NEW.daily_limit_usdt THEN
    INSERT INTO auto_payout_config_audit_log (field_name, old_value, new_value, changed_by, created_at)
    VALUES ('daily_limit_usdt', OLD.daily_limit_usdt::text, NEW.daily_limit_usdt::text, NEW.updated_by, NOW());
  END IF;
  
  -- 记录 wallet_address 变更（安全关键）
  IF OLD.wallet_address IS DISTINCT FROM NEW.wallet_address THEN
    INSERT INTO auto_payout_config_audit_log (field_name, old_value, new_value, changed_by, created_at)
    VALUES ('wallet_address', OLD.wallet_address, NEW.wallet_address, NEW.updated_by, NOW());
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 5. 创建触发器
DROP TRIGGER IF EXISTS audit_auto_payout_config_update ON auto_payout_config;
CREATE TRIGGER audit_auto_payout_config_update
AFTER UPDATE ON auto_payout_config
FOR EACH ROW
EXECUTE FUNCTION audit_auto_payout_config_changes();

-- 6. 添加触发器注释
COMMENT ON FUNCTION audit_auto_payout_config_changes() IS '自动放款配置审计触发器函数 - 自动记录配置变更';

-- 7. 验证创建结果
SELECT 
  'auto_payout_config_audit_log' AS table_name,
  COUNT(*) AS row_count
FROM auto_payout_config_audit_log;

