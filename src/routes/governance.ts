import { FastifyInstance } from 'fastify';
import { rpcCallSafe } from '../lib/rpc.js';

export default async function governanceRoutes(app: FastifyInstance) {
  // GET /governance/models
  app.get('/models', async () => {
    const [models, proposals] = await Promise.all([
      rpcCallSafe<Array<Record<string, unknown>>>('qfc_getSupportedModels', []),
      rpcCallSafe<Array<Record<string, unknown>>>('qfc_getModelProposals', []),
    ]);
    return { ok: true, data: { models, proposals } };
  });
}
