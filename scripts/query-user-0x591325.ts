// 查询用户领取代币情况的脚本
// 用户地址: 0x591325a8fe68e3abbae1867097ac44a9fdc47fd5

import { supabase } from '../src/infra/supabase.js';

const userAddress = '0x591325a8fe68e3abbae1867097ac44a9fdc47fd5';

async function queryUserClaims() {
  console.log(`\n🔍 查询用户领取代币情况`);
  console.log(`📍 用户地址: ${userAddress}\n`);
  console.log('='.repeat(80));

  try {
    // 1. 查询用户基本信息
    console.log('\n📊 1. 用户基本信息\n');
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('address', userAddress.toLowerCase())
      .maybeSingle();

    if (userError) {
      console.error('❌ 查询用户信息失败:', userError);
    } else if (!user) {
      console.log('⚠️ 用户不存在于数据库中');
      console.log('\n可能原因：');
      console.log('1. 用户从未领取过空投');
      console.log('2. 用户地址输入错误');
      return;
    } else {
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
    }

    // 2. 查询领取记录
    console.log('\n📊 2. 领取空投记录\n');
    const { data: claims, error: claimsError } = await supabase
      .from('claims')
      .select('*')
      .eq('address', userAddress.toLowerCase())
      .order('block_time', { ascending: false });

    if (claimsError) {
      console.error('❌ 查询领取记录失败:', claimsError);
    } else if (!claims || claims.length === 0) {
      console.log('⚠️ 用户没有领取记录');
    } else {
      console.log(`✅ 找到 ${claims.length} 条领取记录：\n`);
      claims.forEach((claim, index) => {
        const amount = (BigInt(claim.amount_wei) / BigInt(10**18)).toString();
        console.log(`   [${index + 1}] ${claim.block_time}`);
        console.log(`       交易哈希: ${claim.tx_hash}`);
        console.log(`       领取数量: ${amount} RAT`);
        console.log(`       区块高度: ${claim.block_number}`);
        console.log(`       能量已奖励: ${claim.energy_awarded ? '是' : '否'}`);
        console.log(`       推荐人: ${claim.referrer || '无'}`);
        console.log('');
      });

      // 统计
      const totalAmount = claims.reduce((sum, claim) => {
        return sum + BigInt(claim.amount_wei);
      }, 0n);
      const awardedCount = claims.filter((c: any) => c.energy_awarded).length;
      
      console.log('   统计：');
      console.log(`   总领取次数: ${claims.length}`);
      console.log(`   总领取数量: ${(totalAmount / BigInt(10**18)).toString()} RAT`);
      console.log(`   能量已奖励: ${awardedCount}/${claims.length}`);
    }

    // 3. 查询推荐奖励记录
    console.log('\n📊 3. 推荐奖励记录\n');
    const { data: referralRewards, error: referralError } = await supabase
      .from('referral_rewards')
      .select('*')
      .eq('referrer_address', userAddress.toLowerCase())
      .order('block_time', { ascending: false });

    if (referralError) {
      console.error('❌ 查询推荐奖励失败:', referralError);
    } else if (!referralRewards || referralRewards.length === 0) {
      console.log('⚠️ 用户没有推荐奖励记录');
    } else {
      console.log(`✅ 找到 ${referralRewards.length} 条推荐奖励记录：\n`);
      referralRewards.slice(0, 5).forEach((reward, index) => {
        const amount = (BigInt(reward.amount_wei) / BigInt(10**18)).toString();
        console.log(`   [${index + 1}] ${reward.block_time}`);
        console.log(`       交易哈希: ${reward.tx_hash}`);
        console.log(`       奖励数量: ${amount} RAT`);
        console.log(`       被推荐人: ${reward.claimer_address || '未知'}`);
        console.log('');
      });

      if (referralRewards.length > 5) {
        console.log(`   ... 还有 ${referralRewards.length - 5} 条记录\n`);
      }

      // 统计
      const totalReward = referralRewards.reduce((sum, reward) => {
        return sum + BigInt(reward.amount_wei);
      }, 0n);
      
      console.log('   统计：');
      console.log(`   总推荐次数: ${referralRewards.length}`);
      console.log(`   总推荐奖励: ${(totalReward / BigInt(10**18)).toString()} RAT`);
    }

    // 4. 查询提现记录
    console.log('\n📊 4. 提现记录\n');
    const { data: withdrawals, error: withdrawalError } = await supabase
      .from('withdrawals')
      .select('*')
      .eq('address', userAddress.toLowerCase())
      .order('created_at', { ascending: false });

    if (withdrawalError) {
      console.error('❌ 查询提现记录失败:', withdrawalError);
    } else if (!withdrawals || withdrawals.length === 0) {
      console.log('⚠️ 用户没有提现记录');
    } else {
      console.log(`✅ 找到 ${withdrawals.length} 条提现记录：\n`);
      withdrawals.forEach((w, index) => {
        console.log(`   [${index + 1}] ${w.created_at}`);
        console.log(`       提现金额: ${w.amount} USDT`);
        console.log(`       状态: ${w.status}`);
        console.log(`       交易哈希: ${w.tx_hash || '待处理'}`);
        console.log('');
      });

      // 统计
      const totalWithdrawal = withdrawals.reduce((sum, w) => sum + parseFloat(w.amount), 0);
      const completedCount = withdrawals.filter((w: any) => w.status === 'completed').length;
      
      console.log('   统计：');
      console.log(`   总提现次数: ${withdrawals.length}`);
      console.log(`   总提现金额: ${totalWithdrawal.toFixed(2)} USDT`);
      console.log(`   已完成: ${completedCount}/${withdrawals.length}`);
    }

    console.log('\n' + '='.repeat(80));
    console.log('\n✅ 查询完成！\n');

  } catch (error) {
    console.error('\n❌ 查询失败:', error);
  }
}

queryUserClaims();

