import type { FastifyInstance } from 'fastify';
import { config } from '../../config.js';
import { supabase } from '../../infra/supabase.js';

export function registerDebugRoutes(app: FastifyInstance) {
  // 注意：仅用于排查“环境变量/链配置不一致”问题，不返回任何敏感信息
  app.get('/api/debug/config', async () => {
    return {
      ok: true,
      airdropContract: config.airdropContract,
      rpcUrlsCount: config.rpcUrls.length,
      chainSyncId: config.chainSyncId,
      nodeEnv: config.nodeEnv,
    };
  });

  // 核对当前后端实际写入的是哪个 Supabase Project（防止“看错库/看错项目”）
  app.get('/api/debug/supabase', async () => {
    let host = '';
    try {
      host = new URL(config.supabaseUrl).host;
    } catch {
      host = String(config.supabaseUrl || '');
    }
    return { ok: true, supabaseHost: host };
  });

  // 用 txHash 验证该笔 claim 是否已写入数据库（返回最小必要信息）
  app.get('/api/debug/claim', async (req: any, reply: any) => {
    const txHash = String(req?.query?.txHash || '').trim().toLowerCase();
    if (!txHash || !txHash.startsWith('0x') || txHash.length < 10) {
      return reply.status(400).send({ ok: false, code: 'INVALID_REQUEST', message: 'Missing txHash' });
    }

    const { data: claim, error: cErr } = await supabase
      .from('claims')
      .select('tx_hash,address,amount_wei,created_at')
      .eq('tx_hash', txHash)
      .maybeSingle();
    if (cErr) return reply.status(500).send({ ok: false, code: 'DB_ERROR', message: cErr.message });

    if (!claim) {
      return { ok: true, exists: false };
    }

    const addr = String((claim as any).address || '').toLowerCase();
    const { data: user, error: uErr } = await supabase
      .from('users')
      .select('address,energy_total,energy_locked,created_at,updated_at')
      .eq('address', addr)
      .maybeSingle();
    if (uErr) return reply.status(500).send({ ok: false, code: 'DB_ERROR', message: uErr.message });

    return {
      ok: true,
      exists: true,
      claim: { txHash: (claim as any).tx_hash, address: addr, createdAt: (claim as any).created_at },
      user: user
        ? {
            address: (user as any).address,
            energyTotal: Number((user as any).energy_total || 0),
            energyLocked: Number((user as any).energy_locked || 0),
            updatedAt: (user as any).updated_at,
          }
        : null,
    };
  });
}


