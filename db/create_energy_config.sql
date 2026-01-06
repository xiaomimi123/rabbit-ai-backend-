-- 创建能量配置表
-- 目的：动态配置能量消耗和奖励规则
-- 执行时间：2026-01-06
-- 优先级：中 - 增强系统灵活性

-- 1. 创建配置表
CREATE TABLE IF NOT EXISTS energy_config (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  config_key            TEXT NOT NULL UNIQUE,  -- 配置键（唯一）
  config_value          NUMERIC NOT NULL,      -- 配置值
  description           TEXT,                  -- 配置说明
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- 2. 插入默认配置
INSERT INTO energy_config (config_key, config_value, description) VALUES
  -- 提现能量消耗
  ('withdraw_energy_ratio', 10, '提现能量消耗比例：1 USDT = N Energy'),
  
  -- 领取空投能量奖励
  ('claim_self_reward', 1, '用户领取空投自己获得的能量'),
  ('claim_referrer_first', 3, '推荐人首次邀请获得的能量（1管道+2首邀）'),
  ('claim_referrer_repeat', 1, '推荐人非首次邀请获得的能量（仅管道）'),
  
  -- 高级配置（可选）
  ('min_withdraw_energy', 0, '最低提现能量要求（0表示无限制）'),
  ('energy_lock_enabled', 1, '是否启用能量锁定机制（1=启用，0=禁用）')
ON CONFLICT (config_key) DO NOTHING;

-- 3. 创建配置历史表（用于审计）
CREATE TABLE IF NOT EXISTS energy_config_history (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  config_key            TEXT NOT NULL,
  old_value             NUMERIC,
  new_value             NUMERIC NOT NULL,
  changed_by            TEXT,                  -- 操作管理员（可选）
  change_reason         TEXT,                  -- 变更原因
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

-- 4. 创建索引
CREATE INDEX IF NOT EXISTS idx_energy_config_key ON energy_config(config_key);
CREATE INDEX IF NOT EXISTS idx_energy_config_history_key ON energy_config_history(config_key);
CREATE INDEX IF NOT EXISTS idx_energy_config_history_created_at ON energy_config_history(created_at DESC);

-- 5. 创建获取配置的辅助函数
CREATE OR REPLACE FUNCTION get_energy_config(p_key TEXT)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
  v_value NUMERIC;
BEGIN
  SELECT config_value INTO v_value
  FROM energy_config
  WHERE config_key = p_key;
  
  -- 如果配置不存在，返回默认值
  IF v_value IS NULL THEN
    CASE p_key
      WHEN 'withdraw_energy_ratio' THEN v_value := 10;
      WHEN 'claim_self_reward' THEN v_value := 1;
      WHEN 'claim_referrer_first' THEN v_value := 3;
      WHEN 'claim_referrer_repeat' THEN v_value := 1;
      WHEN 'min_withdraw_energy' THEN v_value := 0;
      WHEN 'energy_lock_enabled' THEN v_value := 1;
      ELSE v_value := 0;
    END CASE;
  END IF;
  
  RETURN v_value;
END;
$function$;

-- 6. 创建更新配置的函数（带历史记录）
CREATE OR REPLACE FUNCTION update_energy_config(
  p_key TEXT,
  p_new_value NUMERIC,
  p_changed_by TEXT DEFAULT NULL,
  p_reason TEXT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
  v_old_value NUMERIC;
BEGIN
  -- 获取旧值
  SELECT config_value INTO v_old_value
  FROM energy_config
  WHERE config_key = p_key;
  
  -- 更新配置
  UPDATE energy_config
  SET config_value = p_new_value,
      updated_at = NOW()
  WHERE config_key = p_key;
  
  -- 记录历史
  INSERT INTO energy_config_history (config_key, old_value, new_value, changed_by, change_reason)
  VALUES (p_key, v_old_value, p_new_value, p_changed_by, p_reason);
  
  RETURN jsonb_build_object(
    'ok', true,
    'key', p_key,
    'old_value', v_old_value,
    'new_value', p_new_value
  );
END;
$function$;

-- 7. 添加注释
COMMENT ON TABLE energy_config IS '能量配置表：存储所有能量相关的动态配置';
COMMENT ON TABLE energy_config_history IS '能量配置历史表：记录所有配置变更，用于审计';
COMMENT ON FUNCTION get_energy_config(TEXT) IS '获取能量配置值，如果不存在则返回默认值';
COMMENT ON FUNCTION update_energy_config(TEXT, NUMERIC, TEXT, TEXT) IS '更新能量配置并记录历史';

-- 8. 查看当前配置
SELECT 
  config_key,
  config_value,
  description,
  updated_at
FROM energy_config
ORDER BY 
  CASE config_key
    WHEN 'withdraw_energy_ratio' THEN 1
    WHEN 'claim_self_reward' THEN 2
    WHEN 'claim_referrer_first' THEN 3
    WHEN 'claim_referrer_repeat' THEN 4
    WHEN 'min_withdraw_energy' THEN 5
    WHEN 'energy_lock_enabled' THEN 6
  END;

