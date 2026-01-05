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
}): Promise<void> {
  if (!bot || !config.telegram.enabled) {
    console.log('[Telegram] 跳过通知发送（Bot 未初始化或功能已禁用）');
    return;
  }

  try {
    const message = `
🔔 <b>新提现申请</b>

👤 用户地址: <code>${data.address}</code>
💰 提现金额: <b>${data.amount} USDT</b>
⚡ 消耗能量: <b>${data.energyCost}</b>
🆔 提现ID: <code>${data.withdrawalId}</code>
🕒 申请时间: ${new Date(data.timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}

📌 状态: <b>待审核</b>

请登录后台管理系统进行审核 👇
https://bnsi55.net/
    `.trim();

    await bot.sendMessage(config.telegram.adminChatId, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

    console.log(`[Telegram] ✅ 提现申请通知已发送: ${data.withdrawalId}`);
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

