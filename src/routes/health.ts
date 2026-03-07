import { FastifyInstance } from 'fastify';
import { checkDatabaseHealth, checkRpcHealth, checkIndexerLag } from '../db/health.js';
import { cached } from '../lib/cache.js';
import { getRedis } from '../lib/cache.js';

export default async function healthRoutes(app: FastifyInstance) {
  // GET /health
  app.get('/health', async (_request, reply) => {
    const data = await cached('health', 10, async () => {
      const [db, rpc, indexer] = await Promise.all([
        checkDatabaseHealth(),
        checkRpcHealth(),
        checkIndexerLag(),
      ]);
      const healthy = db.ok && rpc.ok && indexer.ok;
      const redis = getRedis();
      return {
        status: healthy ? 'healthy' as const : 'degraded' as const,
        db,
        rpc,
        indexer,
        redis: { connected: redis?.status === 'ready' },
        timestamp: new Date().toISOString(),
      };
    });

    reply.status(data.status === 'healthy' ? 200 : 503);
    return { ok: true, data };
  });
}
