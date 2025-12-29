-- 修复 process_claim_energy 函数中的 block_time 类型转换问题
-- 问题：p_block_time 参数是 text 类型，但 claims.block_time 列是 timestamptz 类型
-- 解决：在函数内部添加显式类型转换，将 text 转换为 timestamptz
-- 日期：2025-01-XX

CREATE OR REPLACE FUNCTION public.process_claim_energy(
  p_tx_hash text, 
  p_address text, 
  p_referrer text, 
  p_amount_wei text, 
  p_block_number bigint, 
  p_block_time text
)
RETURNS jsonb
LANGUAGE plpgsql
AS $function$
declare
  v_ref_exists boolean;
  v_is_first_claim boolean;
  v_ref_address text;
  v_result jsonb;
  v_inserted boolean := false;
  v_claim_count_before integer;
  v_block_time_tz timestamptz;  -- ✅ 新增：用于存储转换后的 timestamptz 值
begin
  -- 1. 标准化地址
  p_address := lower(p_address);
  v_ref_address := lower(p_referrer);

  -- 2. 转换 block_time 从 text 到 timestamptz
  -- ✅ 修复：显式类型转换，处理 null 或空字符串的情况
  if p_block_time is null or trim(p_block_time) = '' then
    v_block_time_tz := now();
  else
    v_block_time_tz := p_block_time::timestamptz;
  end if;

  -- 3. 在插入之前检查该用户是否已有 claim 记录（用于判断 isFirstClaim）
  select count(*) into v_claim_count_before
  from claims
  where address = p_address;

  -- 4. 插入 claim 记录 (如果已存在则不做任何事 - 幂等性)
  -- ✅ 修复：使用转换后的 timestamptz 值
  insert into claims (tx_hash, address, referrer, amount_wei, block_number, block_time, status, created_at, energy_awarded)
  values (p_tx_hash, p_address, v_ref_address, p_amount_wei, p_block_number, v_block_time_tz, 'SUCCESS', now(), true)
  on conflict (tx_hash) do nothing;
  
  -- 检查是否成功插入（通过查询确认）
  select exists(select 1 from claims where tx_hash = p_tx_hash and address = p_address) into v_inserted;
  
  -- 如果交易已存在，直接返回
  if not v_inserted then
    return jsonb_build_object('status', 'skipped', 'reason', 'tx_exists');
  end if;

  -- 5. 判断是否是首次领取（在插入之前检查，所以 count = 0 表示首次）
  v_is_first_claim := (v_claim_count_before = 0);

  -- 6. 给用户自己加能量 (+1)
  -- 使用原子递增，不再需要读取旧值
  insert into users (address, energy_total, created_at, updated_at)
  values (p_address, 1, now(), now())
  on conflict (address) do update
  set energy_total = users.energy_total + 1,
      updated_at = now();

  -- 7. 处理推荐人逻辑
  if v_ref_address is not null and v_ref_address != '0x0000000000000000000000000000000000000000' then
    
    -- 7.1 计算推荐人本次应得奖励
    -- 基础管道收益: +1
    -- 首次邀请奖励: +2 (仅当 is_first_claim 为真)
    
    -- 原子更新推荐人数据
    insert into users (address, invite_count, energy_total, created_at, updated_at)
    values (
      v_ref_address, 
      case when v_is_first_claim then 1 else 0 end, 
      case when v_is_first_claim then 3 else 1 end, -- 3 = 1(管道) + 2(首邀), 1 = 管道
      now(), 
      now()
    )
    on conflict (address) do update
    set 
      -- 如果是首单，invite_count + 1，否则不变
      invite_count = users.invite_count + (case when v_is_first_claim then 1 else 0 end),
      -- 能量累加
      energy_total = users.energy_total + (case when v_is_first_claim then 3 else 1 end),
      updated_at = now();
      
  end if;

  return jsonb_build_object('status', 'success', 'is_first_claim', v_is_first_claim);
end;
$function$;

