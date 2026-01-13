-- ============================================
-- P1级审计日志：提现记录状态变更审计
-- 日期: 2026-01-13
-- 目的: 记录所有提现记录的状态变更和支付交易信息
-- 风险: 提现是资金流转的关键环节，必须有完整的审计记录
-- ============================================

-- 1. 创建 withdrawal_audit_log 表
CREATE TABLE IF NOT EXISTS withdrawal_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  withdrawal_id uuid NOT NULL REFERENCES withdrawals(id),
  address text NOT NULL,
  old_status text NOT NULL,
  new_status text NOT NULL,
  payout_tx_hash text,
  changed_by text,  -- 管理员地址或 'system'
  change_reason text,  -- 拒绝原因或备注
  created_at timestamptz NOT NULL DEFAULT NOW()
);

-- 2. 创建索引（提高查询性能）
CREATE INDEX IF NOT EXISTS idx_withdrawal_audit_withdrawal_id ON withdrawal_audit_log(withdrawal_id);
CREATE INDEX IF NOT EXISTS idx_withdrawal_audit_address ON withdrawal_audit_log(address);
CREATE INDEX IF NOT EXISTS idx_withdrawal_audit_created_at ON withdrawal_audit_log(created_at DESC);

-- 3. 添加表注释
COMMENT ON TABLE withdrawal_audit_log IS '提现记录审计日志 - 记录所有提现状态变更和支付交易信息';
COMMENT ON COLUMN withdrawal_audit_log.withdrawal_id IS '关联的提现记录 ID';
COMMENT ON COLUMN withdrawal_audit_log.address IS '用户地址';
COMMENT ON COLUMN withdrawal_audit_log.old_status IS '变更前的状态';
COMMENT ON COLUMN withdrawal_audit_log.new_status IS '变更后的状态';
COMMENT ON COLUMN withdrawal_audit_log.payout_tx_hash IS '支付交易哈希（如果适用）';
COMMENT ON COLUMN withdrawal_audit_log.changed_by IS '执行变更的管理员地址或系统标识';
COMMENT ON COLUMN withdrawal_audit_log.change_reason IS '变更原因或备注';

-- 4. 创建触发器函数
CREATE OR REPLACE FUNCTION audit_withdrawal_changes()
RETURNS TRIGGER AS $$
BEGIN
  -- 只记录状态变更或 payout_tx_hash 变更
  IF (OLD.status IS DISTINCT FROM NEW.status) OR 
     (OLD.payout_tx_hash IS DISTINCT FROM NEW.payout_tx_hash) THEN
    
    INSERT INTO withdrawal_audit_log (
      withdrawal_id,
      address,
      old_status,
      new_status,
      payout_tx_hash,
      changed_by,
      created_at
    )
    VALUES (
      NEW.id,
      NEW.address,
      OLD.status,
      NEW.status,
      NEW.payout_tx_hash,
      'system',  -- 可以从上下文获取管理员地址
      NOW()
    );
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 5. 创建触发器
DROP TRIGGER IF EXISTS audit_withdrawal_update ON withdrawals;
CREATE TRIGGER audit_withdrawal_update
AFTER UPDATE ON withdrawals
FOR EACH ROW
EXECUTE FUNCTION audit_withdrawal_changes();

-- 6. 添加触发器注释
COMMENT ON FUNCTION audit_withdrawal_changes() IS '提现记录审计触发器函数 - 自动记录状态变更';

-- 7. 验证创建结果
SELECT 
  'withdrawal_audit_log' AS table_name,
  COUNT(*) AS row_count
FROM withdrawal_audit_log;

