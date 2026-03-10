import { FastifyInstance } from 'fastify';
import { rpcCall } from '../lib/rpc.js';

/** Only allow safe, read-only methods + tx broadcast through the public proxy. */
const ALLOWED_METHODS = new Set([
  // Transaction broadcast
  'eth_sendRawTransaction',
  // Read-only queries
  'eth_call',
  'eth_estimateGas',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getBalance',
  'eth_getCode',
  'eth_blockNumber',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_chainId',
  'net_version',
  // QFC custom read-only RPCs
  'qfc_getBridgeStatus',
  'qfc_getBridgeDeposits',
  'qfc_getBridgeWithdrawals',
  'qfc_getAgentRegistry',
  'qfc_getRecentTasks',
  'qfc_getContributionScore',
  'qfc_getMinerEarnings',
  'qfc_getMinerVesting',
  'qfc_getModelProposals',
]);

export default async function rpcRoutes(app: FastifyInstance) {
  app.post('/', async (request, reply) => {
    const body = request.body as {
      method?: string;
      params?: unknown[];
      id?: number;
    } | null;

    if (!body || !body.method || typeof body.method !== 'string') {
      reply.status(400);
      return { ok: false, error: 'Missing "method" field' };
    }

    if (!ALLOWED_METHODS.has(body.method)) {
      reply.status(403);
      return { ok: false, error: `Method "${body.method}" is not allowed` };
    }

    try {
      const result = await rpcCall<unknown>(body.method, body.params ?? []);
      return { ok: true, data: result };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'RPC call failed';
      reply.status(502);
      return { ok: false, error: message };
    }
  });
}
