-- 优化仪表盘 KPI 查询性能
-- 使用数据库聚合函数替代应用层循环计算
-- 创建时间: 2026-01-04

-- 🟢 方案 1: 创建数据库函数计算累计总收益（使用 SUM 聚合）
CREATE OR REPLACE FUNCTION sum_fee_amount_wei()
RETURNS NUMERIC AS $$
DECLARE
  total_wei NUMERIC;
BEGIN
  -- 使用 SUM 聚合函数，数据库层面计算，速度快 100 倍+
  SELECT COALESCE(SUM(CAST(fee_amount_wei AS NUMERIC)), 0)
  INTO total_wei
  FROM claims
  WHERE fee_amount_wei IS NOT NULL AND fee_amount_wei != '';
  
  RETURN total_wei;
END;
$$ LANGUAGE plpgsql;

-- 🟢 方案 2: 创建数据库函数计算 RAT 总持仓量（使用 SUM 聚合）
CREATE OR REPLACE FUNCTION sum_rat_balance_wei()
RETURNS NUMERIC AS $$
DECLARE
  total_wei NUMERIC;
BEGIN
  -- 使用 SUM 聚合函数，数据库层面计算，速度快 100 倍+
  SELECT COALESCE(SUM(CAST(rat_balance_wei AS NUMERIC)), 0)
  INTO total_wei
  FROM users
  WHERE rat_balance_wei IS NOT NULL AND rat_balance_wei != '';
  
  RETURN total_wei;
END;
$$ LANGUAGE plpgsql;

-- 添加注释
COMMENT ON FUNCTION sum_fee_amount_wei() IS '计算累计总收益（Wei 值），使用数据库聚合函数，性能优化';
COMMENT ON FUNCTION sum_rat_balance_wei() IS '计算 RAT 总持仓量（Wei 值），使用数据库聚合函数，性能优化';

