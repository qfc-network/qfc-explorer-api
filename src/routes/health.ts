import { FastifyInstance } from 'fastify';
import { checkDatabaseHealth, checkRpcHealth, checkIndexerLag } from '../db/health.js';
import { cached } from '../lib/cache.js';
import { getRedis } from '../lib/cache.js';

export default async function healthRoutes(app: FastifyInstance) {
  // GET /health
  // Returns 200 if core services (DB + RPC) are up.
  // Returns 503 only if the API cannot serve requests (DB or RPC down).
  // Indexer lag and Redis cache are informational — they don't affect HTTP status.
  app.get('/health', async (_request, reply) => {
    const data = await cached('health', 10, async () => {
      const [db, rpc, indexer] = await Promise.all([
        checkDatabaseHealth(),
        checkRpcHealth(),
        checkIndexerLag(),
      ]);
      // Core services: DB + RPC must be up for API to function
      const coreHealthy = db.ok && rpc.ok;
      const redis = getRedis();
      const redisConnected = redis?.status === 'ready';

      let status: 'healthy' | 'degraded' | 'unavailable';
      if (!coreHealthy) {
        status = 'unavailable';
      } else if (!indexer.ok || !redisConnected) {
        status = 'degraded';
      } else {
        status = 'healthy';
      }

      return {
        status,
        db,
        rpc,
        indexer,
        redis: { connected: redisConnected },
        timestamp: new Date().toISOString(),
      };
    });

    // 503 only when core services are down (API cannot serve requests)
    reply.status(data.status === 'unavailable' ? 503 : 200);
    return { ok: true, data };
  });
}
