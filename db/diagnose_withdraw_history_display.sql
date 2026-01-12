-- ===================================================================
-- 活动记录提现数据显示问题诊断 SQL
-- 问题：前端活动记录页面显示的提现记录都是 1月9号的，但今天是 1月10号
-- 目的：检查数据库中的实际数据情况，判断是数据库问题还是前端问题
-- ===================================================================

-- ⚠️ 请将下面的 'YOUR_USER_ADDRESS_HERE' 替换为实际的用户地址（小写）
\set user_address 'YOUR_USER_ADDRESS_HERE'

-- ===================================================================
-- 1. 数据库时区和当前时间检查
-- ===================================================================
SELECT 
  '数据库时区和时间' as check_type,
  CURRENT_SETTING('TIMEZONE') as database_timezone,
  NOW() as utc_time,
  NOW() AT TIME ZONE 'Asia/Shanghai' as beijing_time,
  CURRENT_DATE as current_date_utc,
  (NOW() AT TIME ZONE 'Asia/Shanghai')::date as current_date_beijing;

-- ===================================================================
-- 2. 检查指定用户的最近提现记录
-- ===================================================================
SELECT 
  '指定用户最近提现记录' as check_type,
  id,
  address,
  amount,
  status,
  energy_locked_amount,
  created_at,
  updated_at,
  -- 计算距离现在多久
  EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600 as hours_ago,
  -- 显示日期
  DATE(created_at) as created_date,
  DATE(updated_at) as updated_date,
  -- 判断是今天、昨天还是更早
  CASE 
    WHEN DATE(created_at) = CURRENT_DATE THEN '今天（UTC）'
    WHEN DATE(created_at) = CURRENT_DATE - INTERVAL '1 day' THEN '昨天（UTC）'
    WHEN DATE(created_at) = CURRENT_DATE - INTERVAL '2 days' THEN '前天（UTC）'
    ELSE created_at::text
  END as date_label_utc,
  CASE 
    WHEN DATE(created_at AT TIME ZONE 'Asia/Shanghai') = (NOW() AT TIME ZONE 'Asia/Shanghai')::date THEN '今天（北京）'
    WHEN DATE(created_at AT TIME ZONE 'Asia/Shanghai') = (NOW() AT TIME ZONE 'Asia/Shanghai')::date - INTERVAL '1 day' THEN '昨天（北京）'
    WHEN DATE(created_at AT TIME ZONE 'Asia/Shanghai') = (NOW() AT TIME ZONE 'Asia/Shanghai')::date - INTERVAL '2 days' THEN '前天（北京）'
    ELSE (created_at AT TIME ZONE 'Asia/Shanghai')::text
  END as date_label_beijing
FROM withdrawals
WHERE address = :'user_address'  -- 使用变量
ORDER BY created_at DESC
LIMIT 10;

-- ===================================================================
-- 3. 统计该用户各日期的提现记录数
-- ===================================================================
SELECT 
  '按日期统计提现记录' as check_type,
  DATE(created_at) as date_utc,
  DATE(created_at AT TIME ZONE 'Asia/Shanghai') as date_beijing,
  COUNT(*) as count,
  SUM(amount) as total_amount,
  STRING_AGG(status, ', ') as statuses
FROM withdrawals
WHERE address = :'user_address'
GROUP BY DATE(created_at), DATE(created_at AT TIME ZONE 'Asia/Shanghai')
ORDER BY DATE(created_at) DESC
LIMIT 10;

-- ===================================================================
-- 4. 检查所有用户最近24小时的提现记录
-- ===================================================================
SELECT 
  '最近24小时所有提现记录' as check_type,
  id,
  address,
  amount,
  status,
  created_at,
  EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600 as hours_ago
FROM withdrawals
WHERE created_at >= NOW() - INTERVAL '24 hours'
ORDER BY created_at DESC
LIMIT 20;

-- ===================================================================
-- 5. 检查该用户提现记录的日期分布
-- ===================================================================
SELECT 
  '提现记录日期分布' as check_type,
  DATE(created_at) as date,
  COUNT(*) as count,
  MIN(created_at) as first_withdraw,
  MAX(created_at) as last_withdraw
FROM withdrawals
WHERE address = :'user_address'
GROUP BY DATE(created_at)
ORDER BY DATE(created_at) DESC
LIMIT 30;

-- ===================================================================
-- 6. 检查 API 返回的数据格式
-- ===================================================================
-- 模拟 getWithdrawHistory 函数返回的数据格式
SELECT 
  'API返回数据格式模拟' as check_type,
  id,
  amount::text as amount,
  COALESCE(status, 'Pending') as status,
  -- 模拟 time 字段的格式化逻辑
  REPLACE(SUBSTRING(created_at::text, 1, 19), 'T', ' ') as time,
  created_at as "createdAt",
  CASE 
    WHEN energy_locked_amount IS NOT NULL THEN energy_locked_amount::numeric
    ELSE NULL
  END as "energyCost"
FROM withdrawals
WHERE address = :'user_address'
ORDER BY created_at DESC
LIMIT 10;

-- ===================================================================
-- 7. 检查是否存在时间格式化问题
-- ===================================================================
SELECT 
  '时间格式化检查' as check_type,
  created_at as original_created_at,
  created_at::text as created_at_text,
  SUBSTRING(created_at::text, 1, 19) as substring_19,
  REPLACE(SUBSTRING(created_at::text, 1, 19), 'T', ' ') as formatted_time,
  -- 提取日期部分
  SUBSTRING(REPLACE(SUBSTRING(created_at::text, 1, 19), 'T', ' '), 1, 10) as date_part
FROM withdrawals
WHERE address = :'user_address'
ORDER BY created_at DESC
LIMIT 5;

-- ===================================================================
-- 8. 检查特定日期的记录（可选）
-- ===================================================================
-- 检查1月9号和1月10号的记录
SELECT 
  '特定日期记录检查' as check_type,
  DATE(created_at) as date,
  COUNT(*) as count,
  ARRAY_AGG(id ORDER BY created_at DESC) as record_ids
FROM withdrawals
WHERE address = :'user_address'
  AND DATE(created_at) IN ('2026-01-09', '2026-01-10')
GROUP BY DATE(created_at)
ORDER BY DATE(created_at) DESC;

-- ===================================================================
-- 9. 综合诊断摘要
-- ===================================================================
WITH user_stats AS (
  SELECT 
    COUNT(*) as total_records,
    MIN(created_at) as first_record,
    MAX(created_at) as last_record,
    COUNT(CASE WHEN DATE(created_at) = CURRENT_DATE THEN 1 END) as today_records_utc,
    COUNT(CASE WHEN DATE(created_at) = CURRENT_DATE - INTERVAL '1 day' THEN 1 END) as yesterday_records_utc,
    COUNT(CASE WHEN DATE(created_at AT TIME ZONE 'Asia/Shanghai') = (NOW() AT TIME ZONE 'Asia/Shanghai')::date THEN 1 END) as today_records_beijing,
    COUNT(CASE WHEN DATE(created_at AT TIME ZONE 'Asia/Shanghai') = (NOW() AT TIME ZONE 'Asia/Shanghai')::date - INTERVAL '1 day' THEN 1 END) as yesterday_records_beijing
  FROM withdrawals
  WHERE address = :'user_address'
)
SELECT 
  '综合诊断摘要' as check_type,
  total_records as "总提现记录数",
  first_record as "第一次提现时间",
  last_record as "最后一次提现时间",
  EXTRACT(EPOCH FROM (NOW() - last_record)) / 3600 as "最后提现距离现在(小时)",
  today_records_utc as "今天记录数(UTC时区)",
  yesterday_records_utc as "昨天记录数(UTC时区)",
  today_records_beijing as "今天记录数(北京时区)",
  yesterday_records_beijing as "昨天记录数(北京时区)",
  NOW() as "当前数据库时间(UTC)",
  NOW() AT TIME ZONE 'Asia/Shanghai' as "当前数据库时间(北京)",
  CURRENT_SETTING('TIMEZONE') as "数据库时区设置"
FROM user_stats;

-- ===================================================================
-- 使用说明
-- ===================================================================
-- 1. 将第9行的 'YOUR_USER_ADDRESS_HERE' 替换为实际用户地址（小写）
--    例如：\set user_address '0x1234567890abcdef1234567890abcdef12345678'
-- 
-- 2. 在 Supabase SQL Editor 中执行此脚本
-- 
-- 3. 查看结果，重点关注：
--    - "综合诊断摘要"：查看是否有今天的记录
--    - "指定用户最近提现记录"：查看最新记录的时间
--    - "按日期统计提现记录"：查看各日期的记录分布
--    - "数据库时区和时间"：确认数据库时间是否正确
-- 
-- 4. 如果数据库中确实有今天的记录但前端没显示，问题在前端
--    如果数据库中没有今天的记录，问题在后端或用户确实没有操作
-- ===================================================================

