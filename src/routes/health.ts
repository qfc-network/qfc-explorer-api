import { FastifyInstance } from 'fastify';
import { checkDatabaseHealth, checkRpcHealth, checkIndexerLag } from '../db/health.js';

export default async function healthRoutes(app: FastifyInstance) {
  // GET /health
  app.get('/health', async (_request, reply) => {
    const [db, rpc, indexer] = await Promise.all([
      checkDatabaseHealth(),
      checkRpcHealth(),
      checkIndexerLag(),
    ]);

    const healthy = db.ok && rpc.ok && indexer.ok;
    reply.status(healthy ? 200 : 503);
    return {
      ok: true,
      data: {
        status: healthy ? 'healthy' : 'degraded',
        db,
        rpc,
        indexer,
        timestamp: new Date().toISOString(),
      },
    };
  });
}
