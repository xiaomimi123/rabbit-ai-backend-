-- ============================================================================
-- 用户领取代币情况查询 SQL
-- 用户地址: 0x591325a8fe68e3abbae1867097ac44a9fdc47fd5
-- 
-- 使用方法：
-- 1. 登录 Supabase Dashboard: https://app.supabase.com/
-- 2. 选择项目: ejbdlxhphonydibcenrv
-- 3. 点击左侧菜单 "SQL Editor"
-- 4. 复制并运行下面的 SQL 语句
-- ============================================================================

-- 1. 查询用户基本信息
SELECT 
    '📊 1. 用户基本信息' as section;

SELECT 
    address as "用户地址",
    referrer_address as "推荐人",
    energy_total as "总能量",
    energy_locked as "锁定能量",
    (energy_total - energy_locked) as "可用能量",
    CAST(rat_balance_wei AS NUMERIC) / 1000000000000000000 as "RAT余额",
    usdt_total as "USDT余额",
    invite_count as "邀请人数",
    created_at as "注册时间",
    updated_at as "最后更新"
FROM users
WHERE address = '0x591325a8fe68e3abbae1867097ac44a9fdc47fd5';

-- 如果上面的查询没有返回结果，说明用户不存在数据库中
-- 可能原因：1. 用户从未领取过空投 2. 地址输入错误 3. Indexer 还未扫描到该用户的交易


-- ============================================================================
-- 2. 查询领取空投记录
SELECT 
    '📊 2. 领取空投记录' as section;

SELECT 
    block_time as "领取时间",
    tx_hash as "交易哈希",
    CAST(amount_wei AS NUMERIC) / 1000000000000000000 as "领取数量(RAT)",
    block_number as "区块高度",
    CASE WHEN energy_awarded THEN '✅ 是' ELSE '❌ 否' END as "能量已奖励",
    COALESCE(referrer, '无') as "推荐人"
FROM claims
WHERE address = '0x591325a8fe68e3abbae1867097ac44a9fdc47fd5'
ORDER BY block_time DESC;

-- 统计
SELECT 
    COUNT(*) as "总领取次数",
    SUM(CAST(amount_wei AS NUMERIC) / 1000000000000000000) as "总领取数量(RAT)",
    SUM(CASE WHEN energy_awarded THEN 1 ELSE 0 END) as "能量已奖励次数",
    COUNT(*) - SUM(CASE WHEN energy_awarded THEN 1 ELSE 0 END) as "能量未奖励次数"
FROM claims
WHERE address = '0x591325a8fe68e3abbae1867097ac44a9fdc47fd5';


-- ============================================================================
-- 3. 查询推荐奖励记录
SELECT 
    '📊 3. 推荐奖励记录' as section;

SELECT 
    block_time as "奖励时间",
    tx_hash as "交易哈希",
    CAST(amount_wei AS NUMERIC) / 1000000000000000000 as "奖励数量(RAT)",
    COALESCE(claimer_address, '未知') as "被推荐人"
FROM referral_rewards
WHERE referrer_address = '0x591325a8fe68e3abbae1867097ac44a9fdc47fd5'
ORDER BY block_time DESC
LIMIT 10;

-- 统计
SELECT 
    COUNT(*) as "总推荐次数",
    SUM(CAST(amount_wei AS NUMERIC) / 1000000000000000000) as "总推荐奖励(RAT)"
FROM referral_rewards
WHERE referrer_address = '0x591325a8fe68e3abbae1867097ac44a9fdc47fd5';


-- ============================================================================
-- 4. 查询提现记录
SELECT 
    '📊 4. 提现记录' as section;

SELECT 
    created_at as "提现时间",
    amount as "提现金额(USDT)",
    status as "状态",
    COALESCE(tx_hash, '待处理') as "交易哈希"
FROM withdrawals
WHERE address = '0x591325a8fe68e3abbae1867097ac44a9fdc47fd5'
ORDER BY created_at DESC;

-- 统计
SELECT 
    COUNT(*) as "总提现次数",
    SUM(CAST(amount AS NUMERIC)) as "总提现金额(USDT)",
    SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as "已完成次数",
    SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as "待处理次数"
FROM withdrawals
WHERE address = '0x591325a8fe68e3abbae1867097ac44a9fdc47fd5';


-- ============================================================================
-- 5. 综合数据对比（检查数据一致性）
SELECT 
    '📊 5. 数据一致性检查' as section;

WITH user_data AS (
    SELECT 
        energy_total,
        invite_count,
        usdt_total
    FROM users
    WHERE address = '0x591325a8fe68e3abbae1867097ac44a9fdc47fd5'
),
claims_data AS (
    SELECT 
        SUM(CASE WHEN energy_awarded THEN 1 ELSE 0 END) as claims_energy_count
    FROM claims
    WHERE address = '0x591325a8fe68e3abbae1867097ac44a9fdc47fd5'
),
referral_data AS (
    SELECT 
        COUNT(*) as referral_count
    FROM referral_rewards
    WHERE referrer_address = '0x591325a8fe68e3abbae1867097ac44a9fdc47fd5'
)
SELECT 
    u.energy_total as "用户表能量",
    c.claims_energy_count as "领取记录能量次数",
    CASE 
        WHEN u.energy_total = c.claims_energy_count THEN '✅ 一致' 
        ELSE '❌ 不一致！' 
    END as "能量数据一致性",
    u.invite_count as "用户表邀请人数",
    r.referral_count as "推荐奖励记录数",
    CASE 
        WHEN u.invite_count = r.referral_count THEN '✅ 一致' 
        ELSE '❌ 不一致！' 
    END as "邀请数据一致性"
FROM user_data u, claims_data c, referral_data r;

-- ============================================================================
-- 查询完成！
-- ============================================================================

