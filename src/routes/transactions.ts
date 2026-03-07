import { FastifyInstance } from 'fastify';
import {
  getTransactionsPage, getTransactionByHash, getReceiptLogsByTxHash,
} from '../db/queries.js';
import { rpcCallSafe } from '../lib/rpc.js';
import { clamp, parseNumber, parseOrder } from '../lib/pagination.js';

export default async function transactionsRoutes(app: FastifyInstance) {
  // GET /txs — paginated list
  app.get('/', async (request) => {
    const q = request.query as Record<string, string>;
    const page = parseNumber(q.page, 1);
    const limit = clamp(parseNumber(q.limit, 25), 1, 100);
    const order = parseOrder(q.order);
    const offset = (page - 1) * limit;
    const filters: { address?: string; status?: string } = {};
    if (q.address) filters.address = q.address;
    if (q.status) filters.status = q.status;
    const items = await getTransactionsPage(limit, offset, order, filters);
    return { ok: true, data: { page, limit, order, address: q.address, status: q.status, items } };
  });

  // GET /txs/:hash
  app.get('/:hash', async (request, reply) => {
    const { hash } = request.params as { hash: string };

    // Try DB first
    const tx = await getTransactionByHash(hash);
    if (tx) {
      const logs = await getReceiptLogsByTxHash(hash);

      // Fetch gasUsed from RPC receipt
      const receipt = await rpcCallSafe<{
        gasUsed?: string;
        status?: string;
        contractAddress?: string;
      }>('eth_getTransactionReceipt', [hash]);

      return {
        ok: true,
        data: {
          transaction: {
            ...tx,
            gas_used: receipt?.gasUsed ? parseInt(receipt.gasUsed, 16).toString() : null,
            contract_address: receipt?.contractAddress ?? null,
          },
          logs,
          source: 'indexed',
        },
      };
    }

    // Fallback to RPC
    const rpcTx = await rpcCallSafe<Record<string, string>>('eth_getTransactionByHash', [hash]);
    if (!rpcTx) {
      reply.status(404);
      return { ok: false, error: 'Transaction not found' };
    }

    const rpcReceipt = await rpcCallSafe<Record<string, string>>('eth_getTransactionReceipt', [hash]);
    return {
      ok: true,
      data: {
        transaction: {
          hash: rpcTx.hash,
          block_height: rpcTx.blockNumber ? parseInt(rpcTx.blockNumber, 16).toString() : null,
          from_address: rpcTx.from,
          to_address: rpcTx.to,
          value: rpcTx.value ? BigInt(rpcTx.value).toString() : '0',
          status: rpcReceipt?.status === '0x1' ? '1' : '0',
          gas_limit: rpcTx.gas ? parseInt(rpcTx.gas, 16).toString() : null,
          gas_price: rpcTx.gasPrice ? parseInt(rpcTx.gasPrice, 16).toString() : null,
          gas_used: rpcReceipt?.gasUsed ? parseInt(rpcReceipt.gasUsed, 16).toString() : null,
          nonce: rpcTx.nonce ? parseInt(rpcTx.nonce, 16).toString() : null,
          data: rpcTx.input || null,
          type: rpcTx.type || null,
        },
        logs: [],
        source: 'rpc',
      },
    };
  });
}
