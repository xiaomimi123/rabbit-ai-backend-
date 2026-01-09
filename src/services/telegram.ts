/**
 * Telegram 通知服务
 * 用于向管理员发送实时提现通知
 */

import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config.js';

// 全局 Bot 实例
let bot: TelegramBot | null = null;

/**
 * 初始化 Telegram Bot
 * 在服务启动时调用一次
 */
export function initTelegramBot(): void {
  if (!config.telegram.enabled) {
    console.log('[Telegram] 通知功能已禁用（TELEGRAM_NOTIFICATIONS_ENABLED=false）');
    return;
  }

  if (!config.telegram.botToken) {
    console.warn('[Telegram] ⚠️ Bot Token 未配置，无法初始化');
    return;
  }

  if (!config.telegram.adminChatId) {
    console.warn('[Telegram] ⚠️ Admin Chat ID 未配置，无法初始化');
    return;
  }

  try {
    bot = new TelegramBot(config.telegram.botToken, { polling: false });
    console.log('[Telegram] ✅ Bot 初始化成功');
  } catch (error) {
    console.error('[Telegram] ❌ Bot 初始化失败:', error);
    bot = null;
  }
}

/**
 * 发送提现申请通知（用户申请提现时）
 * @param data 提现信息
 */
export async function sendWithdrawalPendingNotification(data: {
  address: string;
  amount: string;
  energyCost: number;
  withdrawalId: string;
  timestamp: string;
  isLargeWithdrawal?: boolean;
  userStats?: {
    ratBalance: number;
    energyAvailable: number;
    totalEarnings: number;
    vipLevel: number;
  };
}): Promise<void> {
  if (!bot || !config.telegram.enabled) {
    console.log('[Telegram] 跳过通知发送（Bot 未初始化或功能已禁用）');
    return;
  }

  try {
    const isLarge = data.isLargeWithdrawal || false;
    const title = isLarge ? '🚨 <b>大额提现告警</b>' : '🔔 <b>新提现申请</b>';
    const amountDisplay = isLarge ? `<b>${data.amount} USDT</b> ⚠️` : `<b>${data.amount} USDT</b>`;
    
    let userProfileSection = '';
    if (isLarge && data.userStats) {
      const stats = data.userStats;
      userProfileSection = `

📊 <b>用户画像</b>
💰 持仓: ${stats.ratBalance.toFixed(2)} RAT
⚡ 能量: ${stats.energyAvailable} (剩余)
📈 收益: $${stats.totalEarnings.toFixed(2)} USDT
👑 等级: VIP ${stats.vipLevel}
`;
    }
    
    const message = `
${title}

👤 用户地址: <code>${data.address}</code>
💰 提现金额: ${amountDisplay}
⚡ 消耗能量: <b>${data.energyCost}</b>
🆔 提现ID: <code>${data.withdrawalId}</code>
🕒 申请时间: ${new Date(data.timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}${userProfileSection}

📌 状态: <b>待审核</b>
${isLarge ? '⚠️ 金额超过自动放款阈值，需要手动审核' : ''}

请登录后台管理系统进行审核 👇
https://bnsi55.net/
    `.trim();

    await bot.sendMessage(config.telegram.adminChatId, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

    console.log(`[Telegram] ✅ 提现申请通知已发送: ${data.withdrawalId}${isLarge ? ' (大额告警)' : ''}`);
  } catch (error) {
    console.error('[Telegram] ❌ 发送提现申请通知失败:', error);
  }
}

/**
 * 发送提现完成通知（管理员完成提现后）
 * @param data 提现完成信息
 */
export async function sendWithdrawalCompletedNotification(data: {
  address: string;
  amount: string;
  txHash: string;
  withdrawalId: string;
  timestamp: string;
}): Promise<void> {
  if (!bot || !config.telegram.enabled) {
    console.log('[Telegram] 跳过通知发送（Bot 未初始化或功能已禁用）');
    return;
  }

  try {
    const message = `
✅ <b>提现已完成</b>

👤 用户地址: <code>${data.address}</code>
💰 提现金额: <b>${data.amount} USDT</b>
🆔 提现ID: <code>${data.withdrawalId}</code>
📝 交易哈希: <code>${data.txHash}</code>
🕒 完成时间: ${new Date(data.timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}

📌 状态: <b>已完成</b>

查看交易详情 👇
https://bscscan.com/tx/${data.txHash}
    `.trim();

    await bot.sendMessage(config.telegram.adminChatId, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

    console.log(`[Telegram] ✅ 提现完成通知已发送: ${data.withdrawalId}`);
  } catch (error) {
    console.error('[Telegram] ❌ 发送提现完成通知失败:', error);
  }
}

/**
 * 发送自动放款成功通知
 * @param data 自动放款成功信息
 */
export async function sendAutoPayoutSuccessNotification(data: {
  address: string;
  amount: number;
  txHash: string;
  withdrawalId: string;
  timestamp: string;
}): Promise<void> {
  if (!bot || !config.telegram.enabled) {
    console.log('[Telegram] 跳过通知发送（Bot 未初始化或功能已禁用）');
    return;
  }

  try {
    const message = `
🤖 <b>自动放款成功</b>

👤 用户地址: <code>${data.address}</code>
💰 提现金额: <b>${data.amount.toFixed(2)} USDT</b>
📝 交易哈希: <code>${data.txHash}</code>
🆔 提现ID: <code>${data.withdrawalId}</code>
🕒 处理时间: ${new Date(data.timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}

📌 状态: <b>自动放款成功</b>

查看交易详情 👇
https://bscscan.com/tx/${data.txHash}
    `.trim();

    await bot.sendMessage(config.telegram.adminChatId, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

    console.log(`[Telegram] ✅ 自动放款成功通知已发送: ${data.withdrawalId}`);
  } catch (error) {
    console.error('[Telegram] ❌ 发送自动放款成功通知失败:', error);
  }
}

/**
 * 发送自动放款失败通知
 * @param data 自动放款失败信息
 */
export async function sendAutoPayoutFailedNotification(data: {
  address: string;
  amount: number;
  withdrawalId: string;
  errorMessage: string;
  timestamp: string;
}): Promise<void> {
  if (!bot || !config.telegram.enabled) {
    console.log('[Telegram] 跳过通知发送（Bot 未初始化或功能已禁用）');
    return;
  }

  try {
    const message = `
❌ <b>自动放款失败</b>

👤 用户地址: <code>${data.address}</code>
💰 提现金额: <b>${data.amount.toFixed(2)} USDT</b>
🆔 提现ID: <code>${data.withdrawalId}</code>
⚠️ 失败原因: <b>${data.errorMessage}</b>
🕒 失败时间: ${new Date(data.timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}

📌 状态: <b>需要手动处理</b>

请登录后台管理系统查看详情 👇
https://bnsi55.net/
    `.trim();

    await bot.sendMessage(config.telegram.adminChatId, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

    console.log(`[Telegram] ✅ 自动放款失败通知已发送: ${data.withdrawalId}`);
  } catch (error) {
    console.error('[Telegram] ❌ 发送自动放款失败通知失败:', error);
  }
}

/**
 * 发送自动放款余额不足告警
 * @param data 余额信息
 */
export async function sendAutoPayoutLowBalanceAlert(data: {
  currentBalance: number;
  minBalance: number;
  timestamp: string;
}): Promise<void> {
  if (!bot || !config.telegram.enabled) {
    console.log('[Telegram] 跳过通知发送（Bot 未初始化或功能已禁用）');
    return;
  }

  try {
    const deficit = data.minBalance - data.currentBalance;
    const message = `
⚠️ <b>自动放款余额不足</b>

💰 当前余额: <b>${data.currentBalance.toFixed(2)} USDT</b>
💰 最小余额阈值: <b>${data.minBalance.toFixed(2)} USDT</b>
📉 差额: <b>-${deficit.toFixed(2)} USDT</b>
🕒 告警时间: ${new Date(data.timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}

⚠️ <b>自动放款已暂停</b>
请及时充值以恢复自动放款功能
    `.trim();

    await bot.sendMessage(config.telegram.adminChatId, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

    console.log(`[Telegram] ✅ 自动放款余额不足告警已发送`);
  } catch (error) {
    console.error('[Telegram] ❌ 发送余额不足告警失败:', error);
  }
}

/**
 * 发送自动放款达到每日限额告警
 * @param data 限额信息
 */
export async function sendAutoPayoutLimitReachedAlert(data: {
  todayTotal: number;
  dailyLimit: number;
  timestamp: string;
}): Promise<void> {
  if (!bot || !config.telegram.enabled) {
    console.log('[Telegram] 跳过通知发送（Bot 未初始化或功能已禁用）');
    return;
  }

  try {
    const usagePercent = (data.todayTotal / data.dailyLimit) * 100;
    const remaining = data.dailyLimit - data.todayTotal;
    const message = `
📊 <b>自动放款限额告警</b>

💰 今日已放款总额: <b>${data.todayTotal.toFixed(2)} USDT</b>
💰 每日限额: <b>${data.dailyLimit.toFixed(2)} USDT</b>
📈 使用率: <b>${usagePercent.toFixed(1)}%</b>
📉 剩余额度: <b>${remaining.toFixed(2)} USDT</b>
🕒 告警时间: ${new Date(data.timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}

${usagePercent >= 100 ? '⚠️ <b>已达到限额，自动放款已暂停</b>' : '⚠️ <b>接近限额，请注意</b>'}
    `.trim();

    await bot.sendMessage(config.telegram.adminChatId, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

    console.log(`[Telegram] ✅ 自动放款限额告警已发送`);
  } catch (error) {
    console.error('[Telegram] ❌ 发送限额告警失败:', error);
  }
}

/**
 * 发送提现被拒绝通知
 * @param data 提现拒绝信息
 */
export async function sendWithdrawalRejectedNotification(data: {
  address: string;
  amount: string;
  withdrawalId: string;
  reason?: string;
  timestamp: string;
}): Promise<void> {
  if (!bot || !config.telegram.enabled) {
    console.log('[Telegram] 跳过通知发送（Bot 未初始化或功能已禁用）');
    return;
  }

  try {
    const message = `
❌ <b>提现被拒绝</b>

👤 用户地址: <code>${data.address}</code>
💰 提现金额: <b>${data.amount} USDT</b>
🆔 提现ID: <code>${data.withdrawalId}</code>
${data.reason ? `📝 拒绝原因: ${data.reason}` : ''}
🕒 拒绝时间: ${new Date(data.timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}

📌 状态: <b>已拒绝</b>
    `.trim();

    await bot.sendMessage(config.telegram.adminChatId, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

    console.log(`[Telegram] ✅ 提现拒绝通知已发送: ${data.withdrawalId}`);
  } catch (error) {
    console.error('[Telegram] ❌ 发送提现拒绝通知失败:', error);
  }
}

/**
 * 发送测试消息
 * 用于验证 Telegram Bot 是否正常工作
 */
export async function sendTestMessage(): Promise<{ ok: boolean; message?: string; error?: string }> {
  if (!bot || !config.telegram.enabled) {
    return {
      ok: false,
      error: 'Telegram Bot 未初始化或功能已禁用',
    };
  }

  try {
    const testMessage = `
🧪 <b>Telegram Bot 测试</b>

✅ Bot 运行正常
🕒 测试时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}

配置信息:
• Bot Token: ${config.telegram.botToken ? '✅ 已配置' : '❌ 未配置'}
• Admin Chat ID: ${config.telegram.adminChatId ? '✅ 已配置' : '❌ 未配置'}
• 通知状态: ${config.telegram.enabled ? '✅ 已启用' : '❌ 已禁用'}

🎉 测试成功！您将收到提现申请的实时通知。
    `.trim();

    await bot.sendMessage(config.telegram.adminChatId, testMessage, {
      parse_mode: 'HTML',
    });

    return {
      ok: true,
      message: 'Telegram 测试消息发送成功',
    };
  } catch (error: any) {
    console.error('[Telegram] 测试消息发送失败:', error);
    return {
      ok: false,
      error: error?.message || '未知错误',
    };
  }
}

