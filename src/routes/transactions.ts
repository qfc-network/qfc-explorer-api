import { FastifyInstance } from 'fastify';
import {
  getTransactionsPage, getTransactionsByCursor, getTransactionByHash, getReceiptLogsByTxHash,
  getInternalTxsByTxHash,
} from '../db/queries.js';
import { rpcCallSafe } from '../lib/rpc.js';
import { clamp, parseNumber, parseOrder, parseTxCursor, encodeTxCursor } from '../lib/pagination.js';
import { cacheGet, cacheSet } from '../lib/cache.js';
import { getReadPool } from '../db/pool.js';
import { decodeFunction, decodeEvent, getContractAbi } from '../lib/abi-decoder.js';
import { queryArchiveTransactionByHash, queryArchiveEventsByTxHash, queryArchiveInternalTxsByTxHash } from '../lib/archive.js';

export default async function transactionsRoutes(app: FastifyInstance) {
  // GET /txs — paginated list
  app.get('/', async (request) => {
    const q = request.query as Record<string, string>;
    const limit = clamp(parseNumber(q.limit, 25), 1, 100);
    const order = parseOrder(q.order);
    const filters: { address?: string; status?: string } = {};
    if (q.address) filters.address = q.address;
    if (q.status) filters.status = q.status;

    // Cursor-based pagination (takes priority if provided)
    if (q.cursor) {
      const cur = parseTxCursor(q.cursor);
      if (!cur) {
        return { ok: false, error: 'Invalid cursor' };
      }
      const items = await getTransactionsByCursor(limit, cur.block_height, cur.tx_index, order, filters);
      const next_cursor = items.length === limit
        ? encodeTxCursor(items[items.length - 1].block_height, String(items[items.length - 1].tx_index))
        : null;
      return { ok: true, data: { limit, order, address: q.address, status: q.status, items, next_cursor } };
    }

    // Offset-based pagination (default)
    const page = parseNumber(q.page, 1);
    const offset = (page - 1) * limit;
    const items = await getTransactionsPage(limit, offset, order, filters);
    // Generate a cursor from the last item if we have a full page
    const last = items.length === limit ? items[items.length - 1] as Record<string, unknown> : null;
    const next_cursor = last
      ? encodeTxCursor(String(last.block_height), String(last.tx_index ?? '0'))
      : null;
    return { ok: true, data: { page, limit, order, address: q.address, status: q.status, items, next_cursor } };
  });

  // GET /txs/:hash
  app.get('/:hash', async (request, reply) => {
    const { hash } = request.params as { hash: string };
    const cacheKey = `tx:${hash}`;

    // Check cache
    const hit = await cacheGet<{ transaction: unknown; logs: unknown; source: string }>(cacheKey);
    if (hit) return { ok: true, data: hit };

    // Try DB first
    const tx = await getTransactionByHash(hash);
    if (tx) {
      const logs = await getReceiptLogsByTxHash(hash);
      const receipt = await rpcCallSafe<{
        gasUsed?: string;
        status?: string;
        contractAddress?: string;
      }>('eth_getTransactionReceipt', [hash]);

      // Auto-decode input data + logs if contract is verified
      let decodedInput = null;
      let decodedLogs = null;
      const toAddr = tx.to_address;
      if (toAddr) {
        const pool = getReadPool();
        const abi = await getContractAbi(pool, toAddr.toLowerCase());
        if (abi) {
          if (tx.data && tx.data !== '0x') {
            decodedInput = decodeFunction(tx.data, abi);
          }
          decodedLogs = (logs as Array<Record<string, unknown>>)
            .map((log) => {
              const topics = [log.topic0, log.topic1, log.topic2, log.topic3].filter((t): t is string => !!t);
              if (topics.length === 0) return null;
              return decodeEvent(topics, (log.data as string) || '0x', abi!);
            })
            .filter(Boolean);
        }
      }

      const data = {
        transaction: {
          ...tx,
          gas_used: receipt?.gasUsed ? parseInt(receipt.gasUsed, 16).toString() : null,
          contract_address: receipt?.contractAddress ?? null,
          decoded_input: decodedInput,
        },
        logs,
        decoded_logs: decodedLogs,
        source: 'indexed',
      };
      await cacheSet(cacheKey, data, 60);
      return { ok: true, data };
    }

    // Fallback to archive (cold storage)
    try {
      const archiveTx = await queryArchiveTransactionByHash(hash);
      if (archiveTx) {
        const archiveLogs = await queryArchiveEventsByTxHash(hash);
        const data = { transaction: archiveTx, logs: archiveLogs, decoded_logs: null, source: 'archive' as const };
        await cacheSet(cacheKey, data, 300); // longer TTL for archived data
        return { ok: true, data };
      }
    } catch {
      // archive schema may not exist yet, skip
    }

    // Fallback to RPC
    const rpcTx = await rpcCallSafe<Record<string, string>>('eth_getTransactionByHash', [hash]);
    if (!rpcTx) {
      reply.status(404);
      return { ok: false, error: 'Transaction not found' };
    }

    const rpcReceipt = await rpcCallSafe<Record<string, string>>('eth_getTransactionReceipt', [hash]);
    const data = {
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
    };
    // Cache RPC results for shorter TTL (may get indexed later)
    await cacheSet(cacheKey, data, 15);
    return { ok: true, data };
  });

  // GET /txs/:hash/internal — internal transactions (from debug_traceTransaction)
  app.get('/:hash/internal', async (request, reply) => {
    const { hash } = request.params as { hash: string };
    let items = await getInternalTxsByTxHash(hash);

    // Fallback to archive if not found in hot tables
    if (items.length === 0) {
      try {
        items = await queryArchiveInternalTxsByTxHash(hash);
      } catch { /* archive schema may not exist */ }
    }

    if (items.length === 0) {
      const tx = await getTransactionByHash(hash);
      if (!tx) {
        reply.status(404);
        return { ok: false, error: 'Transaction not found' };
      }
    }
    return { ok: true, data: { tx_hash: hash, items, total: items.length } };
  });
}
