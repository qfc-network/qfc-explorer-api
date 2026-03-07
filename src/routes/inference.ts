import { FastifyInstance } from 'fastify';
import { rpcCallSafe } from '../lib/rpc.js';

export default async function inferenceRoutes(app: FastifyInstance) {
  // GET /inference
  app.get('/', async () => {
    const [stats, computeInfo, validators, models] = await Promise.all([
      rpcCallSafe<Record<string, unknown>>('qfc_getInferenceStats', []),
      rpcCallSafe<Record<string, unknown>>('qfc_getComputeInfo', []),
      rpcCallSafe<Array<Record<string, unknown>>>('qfc_getValidators', []),
      rpcCallSafe<Array<Record<string, unknown>>>('qfc_getSupportedModels', []),
    ]);
    return { ok: true, data: { stats, computeInfo, validators, models } };
  });

  // GET /inference/task
  app.get('/task', async (request, reply) => {
    const q = request.query as Record<string, string>;
    if (!q.id) {
      reply.status(400);
      return { ok: false, error: 'Missing task id' };
    }
    const task = await rpcCallSafe<Record<string, unknown>>('qfc_getPublicTaskStatus', [q.id]);
    if (!task) {
      reply.status(404);
      return { ok: false, error: 'Task not found' };
    }
    return { ok: true, data: task };
  });
}
