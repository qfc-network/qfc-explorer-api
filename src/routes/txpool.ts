import { FastifyInstance } from 'fastify';
import { rpcCallSafe } from '../lib/rpc.js';
import { parseNumber, clamp, parseSort, parseOrder } from '../lib/pagination.js';

type RawTx = {
  hash: string;
  from: string;
  to: string | null;
  value: string;
  gasPrice: string;
  nonce: string;
  gas?: string;
  input?: string;
};

type TxPoolContent = {
  pending: Record<string, Record<string, RawTx>>;
  queued: Record<string, Record<string, RawTx>>;
};

type TxPoolStatus = {
  pending: string;
  queued: string;
};

type NormalizedTx = {
  hash: string;
  from: string;
  to: string | null;
  value: string;
  gasPrice: string;
  nonce: number;
  gas: string | null;
};

/**
 * Flatten the nested txpool_content structure into a flat array of transactions.
 */
function flattenTxPoolContent(content: TxPoolContent): NormalizedTx[] {
  const txs: NormalizedTx[] = [];

  for (const section of [content.pending, content.queued]) {
    if (!section) continue;
    for (const address of Object.keys(section)) {
      const nonces = section[address];
      for (const nonce of Object.keys(nonces)) {
        const tx = nonces[nonce];
        txs.push({
          hash: tx.hash,
          from: tx.from,
          to: tx.to ?? null,
          value: tx.value ?? '0x0',
          gasPrice: tx.gasPrice ?? '0x0',
          nonce: parseInt(tx.nonce, 16) || parseInt(nonce, 10) || 0,
          gas: tx.gas ?? null,
        });
      }
    }
  }

  return txs;
}

/**
 * Normalize raw pending transactions (from eth_pendingTransactions or similar).
 */
function normalizeRawTxs(raw: RawTx[]): NormalizedTx[] {
  return raw.map((tx) => ({
    hash: tx.hash,
    from: tx.from,
    to: tx.to ?? null,
    value: tx.value ?? '0x0',
    gasPrice: tx.gasPrice ?? '0x0',
    nonce: typeof tx.nonce === 'string' ? (parseInt(tx.nonce, 16) || 0) : Number(tx.nonce) || 0,
    gas: tx.gas ?? null,
  }));
}

function hexToNumber(hex: string): number {
  if (!hex) return 0;
  return parseInt(hex, 16) || 0;
}

function sortTxs(txs: NormalizedTx[], sort: string, order: 'asc' | 'desc'): NormalizedTx[] {
  const sorted = [...txs];
  const mul = order === 'asc' ? 1 : -1;

  sorted.sort((a, b) => {
    switch (sort) {
      case 'gas_price':
        return mul * (hexToNumber(a.gasPrice) - hexToNumber(b.gasPrice));
      case 'nonce':
        return mul * (a.nonce - b.nonce);
      case 'value':
        return mul * (hexToNumber(a.value) - hexToNumber(b.value));
      default:
        return 0;
    }
  });

  return sorted;
}

/**
 * Fetch pending transactions from the node using txpool_content,
 * with fallbacks to qfc_getPendingTransactions and eth_pendingTransactions.
 */
async function fetchPendingTxs(): Promise<{ pending: NormalizedTx[]; queued: number }> {
  // Strategy 1: txpool_content (Geth-style)
  const content = await rpcCallSafe<TxPoolContent>('txpool_content', []);
  if (content && content.pending) {
    const pending = flattenTxPoolContent({ pending: content.pending, queued: {} });
    const queued = flattenTxPoolContent({ pending: {}, queued: content.queued ?? {} });
    return { pending, queued: queued.length };
  }

  // Strategy 2: qfc_getPendingTransactions (QFC custom)
  const qfcPending = await rpcCallSafe<RawTx[]>('qfc_getPendingTransactions', []);
  if (qfcPending && Array.isArray(qfcPending)) {
    return { pending: normalizeRawTxs(qfcPending), queued: 0 };
  }

  // Strategy 3: eth_pendingTransactions (some clients)
  const ethPending = await rpcCallSafe<RawTx[]>('eth_pendingTransactions', []);
  if (ethPending && Array.isArray(ethPending)) {
    return { pending: normalizeRawTxs(ethPending), queued: 0 };
  }

  // No txpool support — return empty
  return { pending: [], queued: 0 };
}

export default async function txpoolRoutes(app: FastifyInstance) {
  // GET /txpool — list pending transactions
  app.get('/', async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const sort = parseSort(query.sort, ['gas_price', 'nonce', 'value'], 'nonce');
    const order = parseOrder(query.order);
    const limit = clamp(parseNumber(query.limit, 50), 1, 200);

    const { pending, queued } = await fetchPendingTxs();
    const sorted = sortTxs(pending, sort, order);
    const limited = sorted.slice(0, limit);

    return {
      ok: true,
      data: {
        pending: limited,
        count: pending.length,
        queued,
        sort,
        order,
        limit,
      },
    };
  });

  // GET /txpool/status — pending/queued counts
  app.get('/status', async () => {
    // Strategy 1: txpool_status (Geth-style, returns hex counts)
    const status = await rpcCallSafe<TxPoolStatus>('txpool_status', []);
    if (status && status.pending !== undefined) {
      return {
        ok: true,
        data: {
          pending: hexToNumber(status.pending),
          queued: hexToNumber(status.queued),
        },
      };
    }

    // Fallback: derive from content
    const { pending, queued } = await fetchPendingTxs();
    return {
      ok: true,
      data: {
        pending: pending.length,
        queued,
      },
    };
  });
}
