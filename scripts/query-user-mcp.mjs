// 查询用户领取代币情况的脚本
// 用户地址: 0x591325a8fe68e3abbae1867097ac44a9fdc47fd5
// 使用 MCP 配置

const userAddress = '0x591325a8fe68e3abbae1867097ac44a9fdc47fd5';
const PROJECT_REF = 'ejbdlxhphonydibcenrv';
const BEARER_TOKEN = 'sbp_ca7b52ecbbbcf842ec5d9b6e233e833e882f3f12';

async function queryDatabase(sql) {
  const response = await fetch(`https://${PROJECT_REF}.supabase.co/rest/v1/rpc/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${BEARER_TOKEN}`,
      'Content-Type': 'application/json',
      'apikey': BEARER_TOKEN,
    },
    body: JSON.stringify({ query: sql })
  });
  
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status} - ${await response.text()}`);
  }
  
  return await response.json();
}

async function queryTable(tableName, filter = {}) {
  let url = `https://${PROJECT_REF}.supabase.co/rest/v1/${tableName}`;
  const params = new URLSearchParams();
  
  Object.entries(filter).forEach(([key, value]) => {
    params.append(key, value);
  });
  
  if (params.toString()) {
    url += '?' + params.toString();
  }
  
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${BEARER_TOKEN}`,
      'apikey': BEARER_TOKEN,
      'Content-Type': 'application/json',
    }
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP error! status: ${response.status} - ${errorText}`);
  }
  
  return await response.json();
}

async function queryUserClaims() {
  console.log(`\n🔍 查询用户领取代币情况`);
  console.log(`📍 用户地址: ${userAddress}\n`);
  console.log('='.repeat(80));

  try {
    // 1. 查询用户基本信息
    console.log('\n📊 1. 用户基本信息\n');
    
    const users = await queryTable('users', {
      address: `eq.${userAddress.toLowerCase()}`,
      select: '*'
    });

    if (!users || users.length === 0) {
      console.log('⚠️ 用户不存在于数据库中');
      console.log('\n可能原因：');
      console.log('1. 用户从未领取过空投');
      console.log('2. 用户地址输入错误');
      console.log('3. Indexer 还未扫描到该用户的交易');
      return;
    }
    
    const user = users[0];
    console.log('✅ 用户信息：');
    console.log(`   地址: ${user.address}`);
    console.log(`   推荐人: ${user.referrer_address || '无'}`);
    console.log(`   总能量: ${user.energy_total}`);
    console.log(`   锁定能量: ${user.energy_locked}`);
    console.log(`   可用能量: ${user.energy_total - user.energy_locked}`);
    console.log(`   RAT 余额: ${(BigInt(user.rat_balance_wei || '0') / BigInt(10**18)).toString()} RAT`);
    console.log(`   USDT 余额: ${user.usdt_total || 0} USDT`);
    console.log(`   邀请人数: ${user.invite_count || 0}`);
    console.log(`   注册时间: ${user.created_at}`);
    console.log(`   最后更新: ${user.updated_at}`);

    // 2. 查询领取记录
    console.log('\n📊 2. 领取空投记录\n');
    
    const claims = await queryTable('claims', {
      address: `eq.${userAddress.toLowerCase()}`,
      select: '*',
      order: 'block_time.desc'
    });

    if (!claims || claims.length === 0) {
      console.log('⚠️ 用户没有领取记录');
      console.log('   这可能意味着：');
      console.log('   1. 用户注册了但从未领取空投');
      console.log('   2. Indexer 还未同步该用户的领取记录');
    } else {
      console.log(`✅ 找到 ${claims.length} 条领取记录：\n`);
      claims.forEach((claim, index) => {
        const amount = (BigInt(claim.amount_wei) / BigInt(10**18)).toString();
        console.log(`   [${index + 1}] ${claim.block_time}`);
        console.log(`       交易哈希: ${claim.tx_hash}`);
        console.log(`       领取数量: ${amount} RAT`);
        console.log(`       区块高度: ${claim.block_number}`);
        console.log(`       能量已奖励: ${claim.energy_awarded ? '✅ 是' : '❌ 否'}`);
        console.log(`       推荐人: ${claim.referrer || '无'}`);
        console.log('');
      });

      // 统计
      const totalAmount = claims.reduce((sum, claim) => {
        return sum + BigInt(claim.amount_wei);
      }, 0n);
      const awardedCount = claims.filter(c => c.energy_awarded).length;
      
      console.log('   📈 统计：');
      console.log(`      总领取次数: ${claims.length}`);
      console.log(`      总领取数量: ${(totalAmount / BigInt(10**18)).toString()} RAT`);
      console.log(`      能量已奖励: ${awardedCount}/${claims.length}`);
      
      if (awardedCount < claims.length) {
        console.log(`      ⚠️ 警告: 有 ${claims.length - awardedCount} 次领取未获得能量奖励！`);
      }
    }

    // 3. 查询推荐奖励记录
    console.log('\n📊 3. 推荐奖励记录\n');
    
    const referralRewards = await queryTable('referral_rewards', {
      referrer_address: `eq.${userAddress.toLowerCase()}`,
      select: '*',
      order: 'block_time.desc',
      limit: '10'
    });

    if (!referralRewards || referralRewards.length === 0) {
      console.log('⚠️ 用户没有推荐奖励记录（还没有成功推荐过其他用户）');
    } else {
      console.log(`✅ 找到推荐奖励记录（显示最近10条）：\n`);
      referralRewards.forEach((reward, index) => {
        const amount = (BigInt(reward.amount_wei) / BigInt(10**18)).toString();
        console.log(`   [${index + 1}] ${reward.block_time}`);
        console.log(`       交易哈希: ${reward.tx_hash}`);
        console.log(`       奖励数量: ${amount} RAT`);
        console.log(`       被推荐人: ${reward.claimer_address || '未知'}`);
        console.log('');
      });

      // 统计（只统计显示的记录）
      const totalReward = referralRewards.reduce((sum, reward) => {
        return sum + BigInt(reward.amount_wei);
      }, 0n);
      
      console.log('   📈 统计（最近10条）：');
      console.log(`      显示记录数: ${referralRewards.length}`);
      console.log(`      显示奖励总计: ${(totalReward / BigInt(10**18)).toString()} RAT`);
    }

    // 4. 查询提现记录
    console.log('\n📊 4. 提现记录\n');
    
    const withdrawals = await queryTable('withdrawals', {
      address: `eq.${userAddress.toLowerCase()}`,
      select: '*',
      order: 'created_at.desc'
    });

    if (!withdrawals || withdrawals.length === 0) {
      console.log('⚠️ 用户没有提现记录（还未发起过提现）');
    } else {
      console.log(`✅ 找到 ${withdrawals.length} 条提现记录：\n`);
      withdrawals.forEach((w, index) => {
        const statusEmoji = w.status === 'completed' ? '✅' : 
                           w.status === 'pending' ? '⏳' : 
                           w.status === 'processing' ? '🔄' : '❌';
        console.log(`   [${index + 1}] ${w.created_at}`);
        console.log(`       提现金额: ${w.amount} USDT`);
        console.log(`       状态: ${statusEmoji} ${w.status}`);
        console.log(`       交易哈希: ${w.tx_hash || '待处理'}`);
        console.log('');
      });

      // 统计
      const totalWithdrawal = withdrawals.reduce((sum, w) => sum + parseFloat(w.amount), 0);
      const completedCount = withdrawals.filter(w => w.status === 'completed').length;
      const pendingCount = withdrawals.filter(w => w.status === 'pending').length;
      
      console.log('   📈 统计：');
      console.log(`      总提现次数: ${withdrawals.length}`);
      console.log(`      总提现金额: ${totalWithdrawal.toFixed(2)} USDT`);
      console.log(`      已完成: ${completedCount}/${withdrawals.length}`);
      if (pendingCount > 0) {
        console.log(`      待处理: ${pendingCount}`);
      }
    }

    console.log('\n' + '='.repeat(80));
    console.log('\n✅ 查询完成！\n');

  } catch (error) {
    console.error('\n❌ 查询失败:', error);
    console.error('\n详细错误:', error.message);
  }
}

queryUserClaims();

