/**
 * 自动放款服务
 * 
 * 功能：
 * - 自动处理金额低于阈值的提现申请
 * - 使用配置的私钥发送 USDT 转账交易
 * - 记录所有操作日志
 * - 提供余额保护和交易限制
 */

import { ethers } from 'ethers';
import { supabase } from '../infra/supabase.js';
import { config } from '../config.js';
import { ERC20_ABI } from '../infra/abis.js';
import { completeWithdrawal } from './admin.js';
import * as crypto from 'crypto';

// 私钥加密/解密密钥（从环境变量读取）
const ENCRYPTION_KEY = process.env.AUTO_PAYOUT_ENCRYPTION_KEY || 'default-key-change-me-in-production';
const ALGORITHM = 'aes-256-cbc';

/**
 * 加密私钥
 */
function encryptPrivateKey(privateKey: string): string {
  try {
    const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    
    let encrypted = cipher.update(privateKey, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    // 返回 iv + encrypted（用于解密）
    return iv.toString('hex') + ':' + encrypted;
  } catch (error: any) {
    console.error('[AutoPayout] 加密私钥失败:', error);
    throw new Error('Failed to encrypt private key');
  }
}

/**
 * 解密私钥
 */
function decryptPrivateKey(encryptedKey: string): string {
  try {
    const parts = encryptedKey.split(':');
    if (parts.length !== 2) {
      throw new Error('Invalid encrypted key format');
    }
    
    const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error: any) {
    console.error('[AutoPayout] 解密私钥失败:', error);
    throw new Error('Failed to decrypt private key');
  }
}

export interface AutoPayoutConfig {
  privateKey: string;
  threshold: number;
  enabled: boolean;
  minBalance?: number;
  dailyLimit?: number;
}

export class AutoPayoutService {
  private wallet: ethers.Wallet | null = null;
  private threshold: number = 10.0;
  private enabled: boolean = false;
  private minBalance: number = 100.0;
  private dailyLimit: number | null = null;
  private provider: ethers.providers.Provider;
  private usdtContract: ethers.Contract | null = null;
  private walletAddress: string | null = null;
  private isProcessing: boolean = false;

  constructor(provider: ethers.providers.Provider) {
    this.provider = provider;
  }

  /**
   * 初始化：从数据库加载配置
   */
  async initialize(): Promise<void> {
    try {
      const { data, error } = await supabase
        .from('auto_payout_config')
        .select('*')
        .limit(1)
        .maybeSingle();

      if (error) {
        console.error('[AutoPayout] 加载配置失败:', error);
        return;
      }

      if (!data || !data.enabled) {
        console.log('[AutoPayout] 自动放款未启用或配置不存在');
        return;
      }

      // 解密私钥
      const privateKey = decryptPrivateKey(data.private_key_encrypted);
      
      // 验证私钥
      const wallet = new ethers.Wallet(privateKey);
      const address = wallet.address.toLowerCase();
      
      if (address !== data.wallet_address.toLowerCase()) {
        console.error('[AutoPayout] 私钥与配置的钱包地址不匹配');
        return;
      }

      // 初始化钱包和合约
      this.wallet = wallet.connect(this.provider);
      this.walletAddress = address;
      this.threshold = parseFloat(data.threshold_usdt);
      this.enabled = data.enabled;
      this.minBalance = parseFloat(data.min_balance_usdt);
      this.dailyLimit = data.daily_limit_usdt ? parseFloat(data.daily_limit_usdt) : null;

      // 初始化 USDT 合约
      if (config.usdtContract) {
        this.usdtContract = new ethers.Contract(config.usdtContract, ERC20_ABI, this.provider);
      }

      console.log(`[AutoPayout] ✅ 初始化成功: 钱包地址=${address}, 阈值=${this.threshold} USDT, 启用=${this.enabled}`);
    } catch (error: any) {
      console.error('[AutoPayout] 初始化失败:', error);
    }
  }

  /**
   * 配置自动放款
   */
  async configure(params: AutoPayoutConfig, updatedBy?: string): Promise<void> {
    // 1. 检查是否已有配置
    const { data: existing } = await supabase
      .from('auto_payout_config')
      .select('*')
      .limit(1)
      .maybeSingle();

    let wallet: ethers.Wallet;
    let address: string;
    let encryptedKey: string;

    // 2. 如果提供了私钥，验证并加密
    if (params.privateKey && params.privateKey !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
      wallet = new ethers.Wallet(params.privateKey);
      address = wallet.address.toLowerCase();
      encryptedKey = encryptPrivateKey(params.privateKey);
    } else if (existing && existing.private_key_encrypted) {
      // 如果没有提供私钥，但已有配置，使用现有私钥
      const decryptedKey = decryptPrivateKey(existing.private_key_encrypted);
      wallet = new ethers.Wallet(decryptedKey);
      address = wallet.address.toLowerCase();
      encryptedKey = existing.private_key_encrypted; // 保持现有加密私钥
    } else {
      throw new Error('首次配置必须提供私钥');
    }

    // 3. 保存配置到数据库
    const { error } = await supabase
      .from('auto_payout_config')
      .upsert({
        private_key_encrypted: encryptedKey,
        wallet_address: address,
        threshold_usdt: params.threshold,
        enabled: params.enabled,
        min_balance_usdt: params.minBalance || 100.0,
        daily_limit_usdt: params.dailyLimit || null,
        updated_at: new Date().toISOString(),
        updated_by: updatedBy || null,
      }, {
        onConflict: 'id', // 假设 id 是主键，如果不存在则插入
      });

    if (error) {
      console.error('[AutoPayout] 保存配置失败:', error);
      throw new Error(`Failed to save config: ${error.message}`);
    }

    // 4. 更新内存状态
    this.wallet = wallet.connect(this.provider);
    this.walletAddress = address;
    this.threshold = params.threshold;
    this.enabled = params.enabled;
    this.minBalance = params.minBalance || 100.0;
    this.dailyLimit = params.dailyLimit || null;

    // 5. 初始化 USDT 合约
    if (config.usdtContract) {
      this.usdtContract = new ethers.Contract(config.usdtContract, ERC20_ABI, this.provider);
    }

    console.log(`[AutoPayout] ✅ 配置已更新: 钱包地址=${address}, 阈值=${params.threshold} USDT, 启用=${params.enabled}`);
  }

  /**
   * 获取配置
   */
  async getConfig(): Promise<{
    walletAddress: string | null;
    threshold: number;
    enabled: boolean;
    minBalance: number;
    dailyLimit: number | null;
    currentBalance: string;
  }> {
    const { data } = await supabase
      .from('auto_payout_config')
      .select('*')
      .limit(1)
      .maybeSingle();

    let currentBalance = '0';
    if (data && data.enabled && this.walletAddress && this.usdtContract) {
      try {
        const balanceWei = await this.usdtContract.balanceOf(this.walletAddress);
        const decimals = await this.usdtContract.decimals();
        currentBalance = ethers.utils.formatUnits(balanceWei, decimals);
      } catch (error) {
        console.error('[AutoPayout] 获取余额失败:', error);
      }
    }

    return {
      walletAddress: data?.wallet_address || null,
      threshold: data ? parseFloat(data.threshold_usdt) : 10.0,
      enabled: data?.enabled || false,
      minBalance: data ? parseFloat(data.min_balance_usdt) : 100.0,
      dailyLimit: data?.daily_limit_usdt ? parseFloat(data.daily_limit_usdt) : null,
      currentBalance,
    };
  }

  /**
   * 检查是否启用
   */
  isEnabled(): boolean {
    return this.enabled && this.wallet !== null && this.usdtContract !== null;
  }

  /**
   * 处理待审批提现
   */
  async processPendingWithdrawals(): Promise<void> {
    if (!this.isEnabled() || this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    try {
      // 1. 检查钱包余额
      const balance = await this.getUsdtBalance();
      if (balance < this.minBalance) {
        console.warn(`[AutoPayout] ⚠️ 钱包余额不足，停止自动放款。当前余额: ${balance.toFixed(2)} USDT，最小余额: ${this.minBalance.toFixed(2)} USDT`);
        this.isProcessing = false;
        return;
      }

      // 2. 检查今日已放款总额（如果有每日限制）
      if (this.dailyLimit) {
        const todayTotal = await this.getTodayTotalPayout();
        if (todayTotal >= this.dailyLimit) {
          console.warn(`[AutoPayout] ⚠️ 今日自动放款总额已达上限: ${todayTotal.toFixed(2)} / ${this.dailyLimit.toFixed(2)} USDT`);
          this.isProcessing = false;
          return;
        }
      }

      // 3. 获取待审批提现（金额 < threshold）
      const { data: withdrawals, error } = await supabase
        .from('withdrawals')
        .select('id, address, amount, status')
        .eq('status', 'Pending')
        .lt('amount', this.threshold)
        .order('created_at', { ascending: true })
        .limit(10); // 每次处理最多 10 笔

      if (error) {
        console.error('[AutoPayout] 获取待审批提现失败:', error);
        this.isProcessing = false;
        return;
      }

      if (!withdrawals || withdrawals.length === 0) {
        this.isProcessing = false;
        return; // 没有符合条件的提现
      }

      console.log(`[AutoPayout] 📋 找到 ${withdrawals.length} 笔符合条件的提现，开始处理...`);

      // 4. 处理每笔提现
      for (const withdrawal of withdrawals) {
        await this.processWithdrawal(withdrawal);
      }
    } catch (error: any) {
      console.error('[AutoPayout] 处理待审批提现失败:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * 处理单笔提现
   */
  private async processWithdrawal(withdrawal: any): Promise<void> {
    const withdrawalId = withdrawal.id;
    const userAddress = withdrawal.address.toLowerCase();
    const amount = parseFloat(withdrawal.amount);

    try {
      // 1. 检查余额
      const balance = await this.getUsdtBalance();
      if (balance < amount) {
        await this.logFailure(withdrawalId, amount, '余额不足');
        console.warn(`[AutoPayout] ⚠️ 余额不足，跳过提现 ${withdrawalId}: 需要 ${amount.toFixed(2)} USDT，当前余额 ${balance.toFixed(2)} USDT`);
        return;
      }

      // 2. 检查今日总额限制
      if (this.dailyLimit) {
        const todayTotal = await this.getTodayTotalPayout();
        if (todayTotal + amount > this.dailyLimit) {
          await this.logFailure(withdrawalId, amount, `超过每日限额: ${todayTotal.toFixed(2)} + ${amount.toFixed(2)} > ${this.dailyLimit.toFixed(2)} USDT`);
          console.warn(`[AutoPayout] ⚠️ 超过每日限额，跳过提现 ${withdrawalId}`);
          return;
        }
      }

      // 3. 发送 USDT 转账交易
      console.log(`[AutoPayout] 🚀 开始处理提现 ${withdrawalId}: ${amount.toFixed(2)} USDT -> ${userAddress.substring(0, 6)}...${userAddress.substring(38)}`);
      const tx = await this.sendUsdtTransfer(userAddress, amount);
      console.log(`[AutoPayout] ✅ 交易已发送: ${tx.hash}`);

      // 4. 记录日志（pending）
      await this.logPending(withdrawalId, amount, tx.hash);

      // 5. 等待交易确认
      const receipt = await tx.wait();
      console.log(`[AutoPayout] ✅ 交易已确认: ${receipt.transactionHash}`);

      // 6. 调用 completeWithdrawal
      await completeWithdrawal({
        provider: this.provider,
        withdrawalId: withdrawalId,
        payoutTxHash: receipt.transactionHash,
      });

      // 7. 记录成功日志
      await this.logSuccess(withdrawalId, amount, receipt.transactionHash);
      console.log(`[AutoPayout] ✅ 提现 ${withdrawalId} 处理完成`);
    } catch (error: any) {
      console.error(`[AutoPayout] ❌ 处理提现失败 (${withdrawalId}):`, error);
      const errorMessage = error.message || '未知错误';
      await this.logFailure(withdrawalId, amount, errorMessage);
    }
  }

  /**
   * 发送 USDT 转账
   */
  private async sendUsdtTransfer(to: string, amount: number): Promise<ethers.ContractTransaction> {
    if (!this.usdtContract || !this.wallet) {
      throw new Error('Wallet or USDT contract not initialized');
    }

    const decimals = await this.usdtContract.decimals();
    const amountWei = ethers.utils.parseUnits(amount.toFixed(6), decimals);

    return await this.usdtContract.connect(this.wallet).transfer(to, amountWei);
  }

  /**
   * 获取 USDT 余额
   */
  private async getUsdtBalance(): Promise<number> {
    if (!this.usdtContract || !this.walletAddress) {
      return 0;
    }

    try {
      const balanceWei = await this.usdtContract.balanceOf(this.walletAddress);
      const decimals = await this.usdtContract.decimals();
      return parseFloat(ethers.utils.formatUnits(balanceWei, decimals));
    } catch (error) {
      console.error('[AutoPayout] 获取余额失败:', error);
      return 0;
    }
  }

  /**
   * 获取今日已放款总额
   */
  private async getTodayTotalPayout(): Promise<number> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStart = today.toISOString();

    const { data, error } = await supabase
      .from('auto_payout_logs')
      .select('amount')
      .eq('status', 'success')
      .gte('created_at', todayStart);

    if (error || !data) {
      return 0;
    }

    return data.reduce((sum, log) => sum + parseFloat(log.amount), 0);
  }

  /**
   * 日志记录方法
   */
  private async logPending(withdrawalId: string, amount: number, txHash: string): Promise<void> {
    await supabase.from('auto_payout_logs').insert({
      withdrawal_id: withdrawalId,
      amount,
      tx_hash: txHash,
      status: 'pending',
    });
  }

  private async logSuccess(withdrawalId: string, amount: number, txHash: string): Promise<void> {
    await supabase.from('auto_payout_logs')
      .update({ status: 'success' })
      .eq('withdrawal_id', withdrawalId);
  }

  private async logFailure(withdrawalId: string, amount: number, errorMessage: string): Promise<void> {
    // 检查是否已有 pending 记录
    const { data: existing } = await supabase
      .from('auto_payout_logs')
      .select('id')
      .eq('withdrawal_id', withdrawalId)
      .eq('status', 'pending')
      .limit(1)
      .maybeSingle();

    if (existing) {
      // 更新现有记录
      await supabase.from('auto_payout_logs')
        .update({ status: 'failed', error_message: errorMessage })
        .eq('id', existing.id);
    } else {
      // 创建新记录
      await supabase.from('auto_payout_logs').insert({
        withdrawal_id: withdrawalId,
        amount,
        status: 'failed',
        error_message: errorMessage,
      });
    }
  }

  /**
   * 获取自动放款日志
   */
  async getLogs(limit: number = 50, offset: number = 0): Promise<{
    items: Array<{
      id: number;
      withdrawalId: string;
      amount: number;
      txHash: string | null;
      status: 'success' | 'failed' | 'pending';
      errorMessage: string | null;
      createdAt: string;
    }>;
    total: number;
  }> {
    const { data, error, count } = await supabase
      .from('auto_payout_logs')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error('[AutoPayout] 获取日志失败:', error);
      return { items: [], total: 0 };
    }

    return {
      items: (data || []).map((log: any) => ({
        id: log.id,
        withdrawalId: log.withdrawal_id,
        amount: parseFloat(log.amount),
        txHash: log.tx_hash,
        status: log.status as 'success' | 'failed' | 'pending',
        errorMessage: log.error_message,
        createdAt: log.created_at,
      })),
      total: count || 0,
    };
  }
}

