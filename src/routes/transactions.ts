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
import { identifyTransaction } from '../lib/defi-protocols.js';

// Transfer event topic: keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** Extract the 4-byte method selector from input_data (hex string or Buffer). Returns "0xabcd1234" or null. */
function extractMethodId(inputData: string | Buffer | null | undefined): string | null {
  if (!inputData) return null;
  let hex: string;
  if (Buffer.isBuffer(inputData)) {
    if (inputData.length < 4) return null;
    hex = inputData.subarray(0, 4).toString('hex');
  } else {
    const str = typeof inputData === 'string' ? inputData : '';
    const clean = str.startsWith('0x') ? str.slice(2) : str;
    if (clean.length < 8) return null;
    hex = clean.slice(0, 8);
  }
  return `0x${hex.toLowerCase()}`;
}

export default async function transactionsRoutes(app: FastifyInstance) {
  // GET /txs — paginated list
  app.get('/', async (request) => {
    const q = request.query as Record<string, string>;
    const limit = clamp(parseNumber(q.limit, 25), 1, 100);
    const order = parseOrder(q.order);
    const filters: {
      address?: string; status?: string;
      min_value?: string; max_value?: string;
      method?: string; from_date?: string; to_date?: string;
      tx_type?: string;
    } = {};
    if (q.address) filters.address = q.address;
    if (q.status) filters.status = q.status;
    if (q.min_value) filters.min_value = q.min_value;
    if (q.max_value) filters.max_value = q.max_value;
    if (q.method) filters.method = q.method;
    if (q.from_date) filters.from_date = q.from_date;
    if (q.to_date) filters.to_date = q.to_date;
    if (q.tx_type) filters.tx_type = q.tx_type;

    // Cursor-based pagination (takes priority if provided)
    if (q.cursor) {
      const cur = parseTxCursor(q.cursor);
      if (!cur) {
        return { ok: false, error: 'Invalid cursor' };
      }
      const rawItems = await getTransactionsByCursor(limit, cur.block_height, cur.tx_index, order, filters);
      const items = rawItems.map((item) => {
        const defi_label = identifyTransaction(item.input_data, item.to_address, item.value) || undefined;
        const method_id = extractMethodId(item.input_data) || undefined;
        const { input_data: _input, ...rest } = item as Record<string, unknown>;
        return { ...rest, ...(defi_label ? { defi_label } : {}), ...(method_id ? { method_id } : {}) };
      });
      const next_cursor = items.length === limit
        ? encodeTxCursor(String((items[items.length - 1] as Record<string, unknown>).block_height), String((rawItems[rawItems.length - 1] as Record<string, unknown>).tx_index))
        : null;
      return { ok: true, data: { limit, order, address: q.address, status: q.status, items, next_cursor } };
    }

    // Offset-based pagination (default)
    const page = parseNumber(q.page, 1);
    const offset = (page - 1) * limit;
    const rawItems = await getTransactionsPage(limit, offset, order, filters);
    const items = rawItems.map((item) => {
      const defi_label = identifyTransaction(item.input_data, item.to_address, item.value) || undefined;
      const method_id = extractMethodId(item.input_data) || undefined;
      const { input_data: _input, ...rest } = item as Record<string, unknown>;
      return { ...rest, ...(defi_label ? { defi_label } : {}), ...(method_id ? { method_id } : {}) };
    });
    // Generate a cursor from the last item if we have a full page
    const last = rawItems.length === limit ? rawItems[rawItems.length - 1] as Record<string, unknown> : null;
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
          if (tx.input_data && tx.input_data !== '0x') {
            decodedInput = decodeFunction(tx.input_data, abi);
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

      // Identify DeFi action from input data selector
      const defi_label = identifyTransaction(tx.input_data, tx.to_address, tx.value) || undefined;

      const data = {
        transaction: {
          ...tx,
          gas_used: receipt?.gasUsed ? parseInt(receipt.gasUsed, 16).toString() : null,
          contract_address: receipt?.contractAddress ?? null,
          decoded_input: decodedInput,
        },
        defi_label,
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
        const archiveLabel = identifyTransaction(
          (archiveTx as Record<string, unknown>).input_data as string | null,
          (archiveTx as Record<string, unknown>).to_address as string | null,
          (archiveTx as Record<string, unknown>).value as string || '0',
        ) || undefined;
        const data = { transaction: archiveTx, defi_label: archiveLabel, logs: archiveLogs, decoded_logs: null, source: 'archive' as const };
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
    const rpcInputData = rpcTx.input || null;
    const rpcValue = rpcTx.value ? BigInt(rpcTx.value).toString() : '0';
    const rpcDefiLabel = identifyTransaction(rpcInputData, rpcTx.to, rpcValue) || undefined;
    const data = {
      transaction: {
        hash: rpcTx.hash,
        block_height: rpcTx.blockNumber ? parseInt(rpcTx.blockNumber, 16).toString() : null,
        from_address: rpcTx.from,
        to_address: rpcTx.to,
        value: rpcValue,
        status: rpcReceipt?.status === '0x1' ? '1' : '0',
        gas_limit: rpcTx.gas ? parseInt(rpcTx.gas, 16).toString() : null,
        gas_price: rpcTx.gasPrice ? parseInt(rpcTx.gasPrice, 16).toString() : null,
        gas_used: rpcReceipt?.gasUsed ? parseInt(rpcReceipt.gasUsed, 16).toString() : null,
        nonce: rpcTx.nonce ? parseInt(rpcTx.nonce, 16).toString() : null,
        data: rpcInputData,
        type: rpcTx.type || null,
      },
      defi_label: rpcDefiLabel,
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

  // GET /txs/:hash/flow — fund flow graph for Sankey visualization
  app.get('/:hash/flow', async (request, reply) => {
    const { hash } = request.params as { hash: string };
    const cacheKey = `tx-flow:${hash}`;

    // Check cache
    const hit = await cacheGet<{ nodes: FlowNode[]; links: FlowLink[] }>(cacheKey);
    if (hit) return { ok: true, data: hit };

    // Fetch the main transaction
    const tx = await getTransactionByHash(hash);
    if (!tx) {
      reply.status(404);
      return { ok: false, error: 'Transaction not found' };
    }

    const links: FlowLink[] = [];
    const nodeSet = new Set<string>();

    // Main transaction link
    if (tx.from_address && tx.to_address && tx.value && tx.value !== '0') {
      const from = tx.from_address.toLowerCase();
      const to = tx.to_address.toLowerCase();
      links.push({ source: from, target: to, value: tx.value, type: 'native' });
      nodeSet.add(from);
      nodeSet.add(to);
    } else if (tx.from_address && tx.to_address) {
      // Include even zero-value main tx so we always have at least a from->to
      const from = tx.from_address.toLowerCase();
      const to = tx.to_address.toLowerCase();
      links.push({ source: from, target: to, value: tx.value || '0', type: 'native' });
      nodeSet.add(from);
      nodeSet.add(to);
    }

    // Internal transactions
    let internalTxs = await getInternalTxsByTxHash(hash);
    if (internalTxs.length === 0) {
      try {
        internalTxs = await queryArchiveInternalTxsByTxHash(hash);
      } catch { /* archive may not exist */ }
    }

    for (const itx of internalTxs) {
      if (!itx.from_address || !itx.to_address) continue;
      const from = (itx.from_address as string).toLowerCase();
      const to = (itx.to_address as string).toLowerCase();
      const value = (itx.value as string) || '0';
      links.push({ source: from, target: to, value, type: 'internal' });
      nodeSet.add(from);
      nodeSet.add(to);
    }

    // Token transfers from events (Transfer events)
    const logs = await getReceiptLogsByTxHash(hash);
    const pool = getReadPool();

    for (const log of logs as Array<Record<string, unknown>>) {
      const topic0 = log.topic0 as string | null;
      if (!topic0 || topic0.toLowerCase() !== TRANSFER_TOPIC) continue;

      const topic1 = log.topic1 as string | null;
      const topic2 = log.topic2 as string | null;
      if (!topic1 || !topic2) continue;

      // Decode addresses from topics (padded to 32 bytes)
      const from = '0x' + topic1.slice(-40).toLowerCase();
      const to = '0x' + topic2.slice(-40).toLowerCase();
      const tokenAddr = (log.contract_address as string).toLowerCase();

      // Try to get token name
      let tokenName: string | undefined;
      try {
        const tokenResult = await pool.query(
          `SELECT name, symbol FROM tokens WHERE address = $1 LIMIT 1`,
          [tokenAddr]
        );
        if (tokenResult.rows.length > 0) {
          const row = tokenResult.rows[0] as { name: string | null; symbol: string | null };
          tokenName = row.symbol || row.name || undefined;
        }
      } catch { /* ignore */ }

      // Decode value from log data
      const data = log.data as string | null;
      let value = '0';
      if (data && data !== '0x' && data.length >= 66) {
        try {
          value = BigInt(data.slice(0, 66)).toString();
        } catch {
          value = '0';
        }
      }

      links.push({ source: from, target: to, value, token: tokenName, type: 'erc20' });
      nodeSet.add(from);
      nodeSet.add(to);
    }

    // Cap links at 20 for readability
    const cappedLinks = links.slice(0, 20);

    // Rebuild node set from capped links
    const finalNodeSet = new Set<string>();
    for (const link of cappedLinks) {
      finalNodeSet.add(link.source);
      finalNodeSet.add(link.target);
    }

    // Try to resolve labels for nodes
    const nodes: FlowNode[] = [];
    for (const addr of finalNodeSet) {
      let label: string | undefined;
      try {
        const labelResult = await pool.query(
          `SELECT label FROM address_labels WHERE address = $1 LIMIT 1`,
          [addr]
        );
        if (labelResult.rows.length > 0) {
          label = (labelResult.rows[0] as { label: string }).label;
        }
      } catch { /* ignore */ }
      nodes.push({ address: addr, ...(label ? { label } : {}) });
    }

    const data = { nodes, links: cappedLinks };
    await cacheSet(cacheKey, data, 120);
    return { ok: true, data };
  });
}

interface FlowNode {
  address: string;
  label?: string;
}

interface FlowLink {
  source: string;
  target: string;
  value: string;
  token?: string;
  type: 'native' | 'erc20' | 'internal';
}
