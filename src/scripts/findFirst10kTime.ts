/**
 * 查询用户首次达到 10,000 RAT 的时间
 * 
 * 用途：
 * - 当用户通过外部转账获得代币时，系统无法自动检测达到 10k 的时间
 * - 此脚本通过查询链上 ERC20 Transfer 事件，计算历史余额
 * - 找到首次余额 >= 10,000 RAT 的区块和时间
 * 
 * 使用方法：
 *   npx tsx src/scripts/findFirst10kTime.ts <用户地址>
 * 
 * 示例：
 *   npx tsx src/scripts/findFirst10kTime.ts 0x22d7f55275ce0cf84e073d6971e7aefb3ba910b2
 */

import { ethers } from 'ethers';
import { config } from '../config.js';
import { ERC20_ABI } from '../infra/abis.js';
import { supabase } from '../infra/supabase.js';

const TARGET_BALANCE = 10000; // 目标余额：10,000 RAT
const BATCH_SIZE = 1000; // 每次查询的区块范围

interface TransferEvent {
  from: string;
  to: string;
  value: ethers.BigNumber;
  blockNumber: number;
  blockTime: Date;
  txHash: string;
}

/**
 * 查询用户地址的所有 RAT 代币转账记录
 */
async function getTransferEvents(
  provider: ethers.providers.Provider,
  userAddress: string,
  fromBlock: number,
  toBlock: number
): Promise<TransferEvent[]> {
  const ratContract = new ethers.Contract(config.ratTokenContract, ERC20_ABI, provider);
  const iface = new ethers.utils.Interface(ERC20_ABI);
  const transferTopic = iface.getEventTopic('Transfer');

  console.log(`[findFirst10kTime] 查询区块范围: ${fromBlock} - ${toBlock}`);

  const events: TransferEvent[] = [];
  let currentFrom = fromBlock;

  while (currentFrom <= toBlock) {
    const currentTo = Math.min(currentFrom + BATCH_SIZE - 1, toBlock);
    
    try {
      // 查询所有 Transfer 事件（from 或 to 是用户地址）
      const logs = await provider.getLogs({
        address: config.ratTokenContract,
        topics: [
          transferTopic,
          null, // from (任意地址)
          ethers.utils.hexZeroPad(userAddress, 32), // to (用户地址)
        ],
        fromBlock: currentFrom,
        toBlock: currentTo,
      });

      // 也查询 from 是用户地址的事件（转出）
      const logsFrom = await provider.getLogs({
        address: config.ratTokenContract,
        topics: [
          transferTopic,
          ethers.utils.hexZeroPad(userAddress, 32), // from (用户地址)
          null, // to (任意地址)
        ],
        fromBlock: currentFrom,
        toBlock: currentTo,
      });

      // 合并并解析事件
      const allLogs = [...logs, ...logsFrom];
      
      for (const log of allLogs) {
        try {
          const parsed = iface.parseLog(log);
          if (parsed && parsed.name === 'Transfer') {
            const from = parsed.args.from.toLowerCase();
            const to = parsed.args.to.toLowerCase();
            const value = parsed.args.value;
            const userAddr = userAddress.toLowerCase();

            // 只处理与用户相关的转账
            if (from === userAddr || to === userAddr) {
              const block = await provider.getBlock(log.blockNumber);
              events.push({
                from,
                to,
                value,
                blockNumber: log.blockNumber,
                blockTime: new Date(block.timestamp * 1000),
                txHash: log.transactionHash,
              });
            }
          }
        } catch (parseError) {
          console.warn(`[findFirst10kTime] 解析事件失败:`, parseError);
        }
      }

      console.log(`[findFirst10kTime] 区块 ${currentFrom}-${currentTo}: 找到 ${allLogs.length} 个事件`);
      currentFrom = currentTo + 1;
    } catch (error: any) {
      if (error?.code === 'UNPREDICTABLE_GAS_LIMIT' || error?.message?.includes('query returned more than')) {
        // 区块范围太大，缩小范围重试
        const midBlock = Math.floor((currentFrom + currentTo) / 2);
        console.warn(`[findFirst10kTime] 区块范围太大，缩小范围: ${currentFrom}-${midBlock} 和 ${midBlock + 1}-${currentTo}`);
        const firstHalf = await getTransferEvents(provider, userAddress, currentFrom, midBlock);
        const secondHalf = await getTransferEvents(provider, userAddress, midBlock + 1, currentTo);
        events.push(...firstHalf, ...secondHalf);
        currentFrom = currentTo + 1;
      } else {
        console.error(`[findFirst10kTime] 查询失败:`, error);
        throw error;
      }
    }
  }

  return events;
}

/**
 * 计算历史余额，找到首次达到目标余额的时间
 */
function findFirstReached10k(
  events: TransferEvent[],
  userAddress: string
): { blockNumber: number; blockTime: Date; balance: number } | null {
  const userAddr = userAddress.toLowerCase();
  
  // 按区块号和时间排序
  events.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) {
      return a.blockNumber - b.blockNumber;
    }
    return a.blockTime.getTime() - b.blockTime.getTime();
  });

  let balance = ethers.BigNumber.from(0);
  const decimals = 18; // RAT 代币精度

  for (const event of events) {
    if (event.to === userAddr) {
      // 转入：增加余额
      balance = balance.add(event.value);
    } else if (event.from === userAddr) {
      // 转出：减少余额
      balance = balance.sub(event.value);
    }

    const balanceFormatted = parseFloat(ethers.utils.formatUnits(balance, decimals));

    if (balanceFormatted >= TARGET_BALANCE) {
      console.log(`[findFirst10kTime] ✅ 找到首次达到 10k 的时间:`);
      console.log(`  区块号: ${event.blockNumber}`);
      console.log(`  时间: ${event.blockTime.toISOString()}`);
      console.log(`  余额: ${balanceFormatted.toFixed(2)} RAT`);
      return {
        blockNumber: event.blockNumber,
        blockTime: event.blockTime,
        balance: balanceFormatted,
      };
    }
  }

  return null;
}

/**
 * 更新用户的 last_settlement_time
 */
async function updateLastSettlementTime(
  userAddress: string,
  settlementTime: Date
): Promise<void> {
  const addr = userAddress.toLowerCase();
  const timeIso = settlementTime.toISOString();

  console.log(`[findFirst10kTime] 更新用户 ${addr} 的 last_settlement_time 为: ${timeIso}`);

  const { error } = await supabase
    .from('users')
    .update({ last_settlement_time: timeIso })
    .eq('address', addr);

  if (error) {
    throw new Error(`更新失败: ${error.message}`);
  }

  console.log(`[findFirst10kTime] ✅ 更新成功`);
}

async function main() {
  const userAddress = process.argv[2];

  if (!userAddress || !userAddress.startsWith('0x')) {
    console.error('❌ 请提供有效的用户地址');
    console.error('使用方法: npx tsx src/scripts/findFirst10kTime.ts <用户地址>');
    process.exit(1);
  }

  console.log(`[findFirst10kTime] 开始查询用户 ${userAddress} 首次达到 10,000 RAT 的时间...`);

  // 1. 创建 RPC Provider
  const rpcUrls = config.rpcUrls;
  if (rpcUrls.length === 0) {
    throw new Error('BSC_RPC_URLS 未配置');
  }

  const provider = new ethers.providers.JsonRpcProvider({
    url: rpcUrls[0],
    timeout: 30000,
  });

  // 2. 获取当前区块号
  const currentBlock = await provider.getBlockNumber();
  console.log(`[findFirst10kTime] 当前区块号: ${currentBlock}`);

  // 3. 确定查询起始区块（从代币合约部署开始，或从用户账户创建前 7 天开始）
  // 为了简化，我们从当前区块往前查询 100,000 个区块（约 7 天）
  const lookbackBlocks = 100000;
  const fromBlock = Math.max(0, currentBlock - lookbackBlocks);
  const toBlock = currentBlock;

  console.log(`[findFirst10kTime] 查询区块范围: ${fromBlock} - ${toBlock} (约 ${lookbackBlocks} 个区块)`);

  // 4. 查询所有转账事件
  const events = await getTransferEvents(provider, userAddress, fromBlock, toBlock);
  console.log(`[findFirst10kTime] 总共找到 ${events.length} 个转账事件`);

  if (events.length === 0) {
    console.warn(`[findFirst10kTime] ⚠️ 未找到任何转账事件，可能用户地址错误或查询范围太小`);
    process.exit(1);
  }

  // 5. 计算历史余额，找到首次达到 10k 的时间
  const result = findFirstReached10k(events, userAddress);

  if (!result) {
    console.warn(`[findFirst10kTime] ⚠️ 未找到首次达到 10,000 RAT 的时间`);
    console.warn(`   可能原因：`);
    console.warn(`   1. 用户余额从未达到 10,000 RAT`);
    console.warn(`   2. 查询范围太小（当前查询 ${lookbackBlocks} 个区块）`);
    console.warn(`   3. 用户通过其他方式获得代币（不在查询范围内）`);
    process.exit(1);
  }

  // 6. 询问是否更新数据库
  console.log(`\n[findFirst10kTime] 📊 查询结果:`);
  console.log(`   首次达到 10k 的区块号: ${result.blockNumber}`);
  console.log(`   首次达到 10k 的时间: ${result.blockTime.toISOString()}`);
  console.log(`   当时余额: ${result.balance.toFixed(2)} RAT`);

  // 7. 更新数据库
  try {
    await updateLastSettlementTime(userAddress, result.blockTime);
    console.log(`\n[findFirst10kTime] ✅ 完成！`);
  } catch (error: any) {
    console.error(`[findFirst10kTime] ❌ 更新失败:`, error.message);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('[findFirst10kTime] 致命错误:', error);
  process.exit(1);
});

