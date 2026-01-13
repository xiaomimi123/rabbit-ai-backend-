-- ============================================
-- P2级审计日志：系统配置变更审计
-- 日期: 2026-01-13
-- 目的: 记录所有系统配置的变更历史
-- 风险: 系统配置影响全局行为，需要完整的变更记录
-- ============================================

-- 1. 创建 system_config_audit_log 表
CREATE TABLE IF NOT EXISTS system_config_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_key text NOT NULL,
  old_value jsonb,
  new_value jsonb NOT NULL,
  changed_by text,  -- 管理员地址
  change_reason text,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

-- 2. 创建索引（提高查询性能）
CREATE INDEX IF NOT EXISTS idx_system_config_audit_key ON system_config_audit_log(config_key);
CREATE INDEX IF NOT EXISTS idx_system_config_audit_created_at ON system_config_audit_log(created_at DESC);

-- 3. 添加表注释
COMMENT ON TABLE system_config_audit_log IS '系统配置审计日志 - 记录所有系统配置变更';
COMMENT ON COLUMN system_config_audit_log.config_key IS '配置键名';
COMMENT ON COLUMN system_config_audit_log.old_value IS '变更前的值（JSONB 格式）';
COMMENT ON COLUMN system_config_audit_log.new_value IS '变更后的值（JSONB 格式）';
COMMENT ON COLUMN system_config_audit_log.changed_by IS '执行变更的管理员地址';
COMMENT ON COLUMN system_config_audit_log.change_reason IS '变更原因或备注';

-- 4. 创建触发器函数
CREATE OR REPLACE FUNCTION audit_system_config_changes()
RETURNS TRIGGER AS $$
BEGIN
  -- 只记录 value 变更
  IF OLD.value IS DISTINCT FROM NEW.value THEN
    INSERT INTO system_config_audit_log (
      config_key,
      old_value,
      new_value,
      changed_by,
      created_at
    )
    VALUES (
      NEW.key,
      OLD.value,
      NEW.value,
      'system',  -- 可以从上下文获取管理员地址
      NOW()
    );
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 5. 创建触发器
DROP TRIGGER IF EXISTS audit_system_config_update ON system_config;
CREATE TRIGGER audit_system_config_update
AFTER UPDATE ON system_config
FOR EACH ROW
EXECUTE FUNCTION audit_system_config_changes();

-- 6. 添加触发器注释
COMMENT ON FUNCTION audit_system_config_changes() IS '系统配置审计触发器函数 - 自动记录配置变更';

-- 7. 验证创建结果
SELECT 
  'system_config_audit_log' AS table_name,
  COUNT(*) AS row_count
FROM system_config_audit_log;

