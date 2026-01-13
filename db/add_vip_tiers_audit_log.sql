-- ============================================
-- P1级审计日志：VIP等级配置变更审计
-- 日期: 2026-01-13
-- 目的: 记录所有VIP等级配置的变更历史
-- 风险: VIP等级是收益计算的核心参数，配置错误会导致收益纠纷
-- ============================================

-- 1. 创建 vip_tiers_audit_log 表
CREATE TABLE IF NOT EXISTS vip_tiers_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vip_level integer NOT NULL,
  field_name text NOT NULL,  -- 'daily_rate', 'min_balance', 'max_balance', 'is_active' 等
  old_value text,
  new_value text NOT NULL,
  changed_by text,  -- 管理员地址
  change_reason text,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

-- 2. 创建索引（提高查询性能）
CREATE INDEX IF NOT EXISTS idx_vip_audit_level ON vip_tiers_audit_log(vip_level);
CREATE INDEX IF NOT EXISTS idx_vip_audit_created_at ON vip_tiers_audit_log(created_at DESC);

-- 3. 添加表注释
COMMENT ON TABLE vip_tiers_audit_log IS 'VIP 等级配置审计日志 - 记录所有 VIP 配置变更';
COMMENT ON COLUMN vip_tiers_audit_log.vip_level IS 'VIP 等级（1-4）';
COMMENT ON COLUMN vip_tiers_audit_log.field_name IS '变更的字段名';
COMMENT ON COLUMN vip_tiers_audit_log.old_value IS '变更前的值';
COMMENT ON COLUMN vip_tiers_audit_log.new_value IS '变更后的值';
COMMENT ON COLUMN vip_tiers_audit_log.changed_by IS '执行变更的管理员地址';
COMMENT ON COLUMN vip_tiers_audit_log.change_reason IS '变更原因或备注';

-- 4. 创建触发器函数
CREATE OR REPLACE FUNCTION audit_vip_tiers_changes()
RETURNS TRIGGER AS $$
BEGIN
  -- 记录 daily_rate 变更
  IF OLD.daily_rate IS DISTINCT FROM NEW.daily_rate THEN
    INSERT INTO vip_tiers_audit_log (vip_level, field_name, old_value, new_value, created_at)
    VALUES (NEW.level, 'daily_rate', OLD.daily_rate::text, NEW.daily_rate::text, NOW());
  END IF;
  
  -- 记录 min_balance 变更
  IF OLD.min_balance IS DISTINCT FROM NEW.min_balance THEN
    INSERT INTO vip_tiers_audit_log (vip_level, field_name, old_value, new_value, created_at)
    VALUES (NEW.level, 'min_balance', OLD.min_balance::text, NEW.min_balance::text, NOW());
  END IF;
  
  -- 记录 max_balance 变更
  IF OLD.max_balance IS DISTINCT FROM NEW.max_balance THEN
    INSERT INTO vip_tiers_audit_log (vip_level, field_name, old_value, new_value, created_at)
    VALUES (NEW.level, 'max_balance', OLD.max_balance::text, NEW.max_balance::text, NOW());
  END IF;
  
  -- 记录 is_active 变更
  IF OLD.is_active IS DISTINCT FROM NEW.is_active THEN
    INSERT INTO vip_tiers_audit_log (vip_level, field_name, old_value, new_value, created_at)
    VALUES (NEW.level, 'is_active', OLD.is_active::text, NEW.is_active::text, NOW());
  END IF;
  
  -- 记录 name 变更
  IF OLD.name IS DISTINCT FROM NEW.name THEN
    INSERT INTO vip_tiers_audit_log (vip_level, field_name, old_value, new_value, created_at)
    VALUES (NEW.level, 'name', OLD.name, NEW.name, NOW());
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 5. 创建触发器
DROP TRIGGER IF EXISTS audit_vip_tiers_update ON vip_tiers;
CREATE TRIGGER audit_vip_tiers_update
AFTER UPDATE ON vip_tiers
FOR EACH ROW
EXECUTE FUNCTION audit_vip_tiers_changes();

-- 6. 添加触发器注释
COMMENT ON FUNCTION audit_vip_tiers_changes() IS 'VIP 等级配置审计触发器函数 - 自动记录配置变更';

-- 7. 验证创建结果
SELECT 
  'vip_tiers_audit_log' AS table_name,
  COUNT(*) AS row_count
FROM vip_tiers_audit_log;

