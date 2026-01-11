/**
 * 代币价格配置
 * 
 * ⚠️ 重要说明：
 * - RAT_TOKEN_PRICE 是核心不可变配置，固定为 0.01 USDT
 * - 如需修改价格，必须经过完整的财务评估和系统测试
 * - 修改价格会影响所有用户的收益计算
 */

/**
 * RAT 代币价格（USDT）
 * 
 * 🔒 核心不可变配置
 * 
 * @constant
 * @type {number}
 * @default 0.01
 * 
 * @example
 * // 计算收益示例
 * const earnings = ratBalance * RAT_TOKEN_PRICE * dailyRate * days;
 * // 100,000 RAT * 0.01 * 0.04 * 1 = 40 USDT
 */
export const RAT_TOKEN_PRICE = 0.01; // 1 RAT = 0.01 USDT

/**
 * 验证RAT价格是否正确
 * @throws {Error} 如果价格不是0.01
 */
export function validateRatPrice(): void {
  if (RAT_TOKEN_PRICE !== 0.01) {
    throw new Error(
      `🚨 严重错误：RAT价格配置错误！ ` +
      `当前值：${RAT_TOKEN_PRICE}，应该是：0.01`
    );
  }
}

/**
 * 获取RAT价格（带验证）
 * @returns {number} RAT价格（USDT）
 */
export function getRatPrice(): number {
  validateRatPrice();
  return RAT_TOKEN_PRICE;
}

