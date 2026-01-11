import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { VerifyClaimBodySchema } from '../schemas.js';
import { toErrorResponse } from '../errors.js';
import { verifyClaim } from '../../services/verifyClaim.js';
import type { ethers } from 'ethers';
import { Reader } from '@maxmind/geoip2-node'; // 🟢 新增：GeoIP2
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 🟢 新增：获取用户IP地址
function getClientIp(req: FastifyRequest): string {
  // 优先从 X-Forwarded-For 获取（经过代理/负载均衡器）
  const forwardedFor = req.headers['x-forwarded-for'];
  if (forwardedFor) {
    const ips = typeof forwardedFor === 'string' ? forwardedFor.split(',') : forwardedFor;
    return ips[0].trim();
  }
  
  // 其他可能的头部
  const realIp = req.headers['x-real-ip'];
  if (realIp && typeof realIp === 'string') {
    return realIp.trim();
  }
  
  // 最后使用 req.ip（Fastify 自带）
  return req.ip || 'unknown';
}

// 🟢 新增：根据IP获取国家信息
async function getCountryFromIp(ip: string): Promise<string | undefined> {
  try {
    // 跳过本地IP
    if (ip === 'unknown' || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
      return undefined;
    }
    
    const dbPath = path.join(__dirname, '../../../data/GeoLite2-City.mmdb');
    const reader = await Reader.open(dbPath);
    const response = reader.city(ip);
    
    // 优先使用中文名称，否则使用英文名称
    const country = response.country?.names?.['zh-CN'] || response.country?.names?.en;
    return country || undefined;
  } catch (error) {
    console.warn(`[getCountryFromIp] 无法获取IP ${ip} 的国家信息:`, error);
    return undefined;
  }
}

export function registerMiningRoutes(app: FastifyInstance, deps: { getProvider: () => ethers.providers.Provider }) {
  app.post('/api/mining/verify-claim', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = VerifyClaimBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: parsed.error.message });

    try {
      // 🟢 新增：获取用户IP和国家信息
      const ipAddress = getClientIp(req);
      const country = await getCountryFromIp(ipAddress);
      
      const res = await verifyClaim({
        provider: deps.getProvider(),
        address: parsed.data.address,
        txHash: parsed.data.txHash,
        referrer: parsed.data.referrer,
        ipAddress,    // 🟢 新增：传递IP地址
        country,      // 🟢 新增：传递国家信息
      });
      return res;
    } catch (e) {
      const err = toErrorResponse(e);
      return reply.status(400).send(err);
    }
  });
}


