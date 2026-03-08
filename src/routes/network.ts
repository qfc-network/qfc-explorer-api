import { FastifyInstance } from 'fastify';
import { rpcCallSafe } from '../lib/rpc.js';

export default async function networkRoutes(app: FastifyInstance) {
  // GET /network
  app.get('/', async () => {
    const [epoch, nodeInfo, validators] = await Promise.all([
      rpcCallSafe<Record<string, unknown>>('qfc_getEpoch', []),
      rpcCallSafe<Record<string, unknown>>('qfc_nodeInfo', []),
      rpcCallSafe<Array<Record<string, unknown>>>('qfc_getValidators', []),
    ]);

    let totalHashrate = 0;
    if (validators) {
      for (const v of validators) {
        if (v.providesCompute) {
          totalHashrate += Number(v.hashrate || 0);
        }
      }
    }

    return { ok: true, data: { epoch, nodeInfo, validators, totalHashrate } };
  });
}
