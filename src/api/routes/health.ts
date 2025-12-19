import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export function registerHealthRoutes(app: FastifyInstance) {
  app.get('/api/health', async (_req: FastifyRequest, _reply: FastifyReply) => {
    return { ok: true, time: new Date().toISOString() };
  });

  // Liveness for indexer (optional): shows current chain_sync_state row if exists.
  app.get('/api/health/indexer', async (_req: FastifyRequest, _reply: FastifyReply) => {
    try {
      // dynamic import to avoid circular deps in some bundlers
      const { supabase } = await import('../../infra/supabase.js');
      const { config } = await import('../../config.js');
      const { data, error } = await supabase.from('chain_sync_state').select('id,last_block,updated_at').eq('id', config.chainSyncId).maybeSingle();
      if (error) return { ok: false, code: 'DB_ERROR', message: error.message };
      return { ok: true, chainSync: data || null, time: new Date().toISOString() };
    } catch (e: any) {
      return { ok: false, code: 'INTERNAL_ERROR', message: e?.message || String(e) };
    }
  });
}


