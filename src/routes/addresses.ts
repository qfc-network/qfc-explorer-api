import { FastifyInstance } from 'fastify';
import {
  getAddressOverview, getAddressStats, getAddressAnalysis,
  getContractByAddress, getTokenHoldingsByAddress, getNftHoldingsByAddress,
  getAddressTransactions, getTokenTransfersByAddress,
  getInternalTxsByAddress, getAddressLabel,
} from '../db/queries.js';
import { getReadPool } from '../db/pool.js';
import { clamp, parseNumber, parseOrder } from '../lib/pagination.js';

export default async function addressesRoutes(app: FastifyInstance) {
  // GET /address/:address
  app.get('/:address', async (request) => {
    const { address } = request.params as { address: string };
    const q = request.query as Record<string, string>;
    const tab = q.tab || 'transactions';
    const page = parseNumber(q.page, 1);
    const limit = clamp(parseNumber(q.limit, 25), 1, 100);
    const order = parseOrder(q.order);
    const offset = (page - 1) * limit;

    const [overview, stats, analysis, contract, tokenHoldings, nftHoldings, label] = await Promise.all([
      getAddressOverview(address),
      getAddressStats(address),
      getAddressAnalysis(address),
      getContractByAddress(address),
      getTokenHoldingsByAddress(address),
      getNftHoldingsByAddress(address),
      getAddressLabel(address),
    ]);

    let transactions = null;
    let tokenTransfers = null;
    let internalTxs = null;

    if (tab === 'token_transfers') {
      tokenTransfers = await getTokenTransfersByAddress(address, limit, offset, order);
    } else if (tab === 'internal_txs') {
      internalTxs = await getInternalTxsByAddress(address, limit, offset, order);
    } else {
      transactions = await getAddressTransactions(address, limit, offset, order);
    }

    return {
      ok: true,
      data: {
        address, label, overview, stats, analysis, contract,
        tokenHoldings, nftHoldings,
        tab, page, limit, order, transactions, tokenTransfers, internalTxs,
      },
    };
  });

  // GET /address/:address/export — CSV export for address transactions or token transfers
  app.get('/:address/export', async (request, reply) => {
    const { address } = request.params as { address: string };
    const q = request.query as Record<string, string>;
    const type = q.type || 'transactions'; // transactions | token_transfers
    const limit = clamp(parseNumber(q.limit, 5000), 100, 10000);
    const order = parseOrder(q.order);
    const direction = order === 'asc' ? 'ASC' : 'DESC';
    const pool = getReadPool();

    let csv = '';

    if (type === 'token_transfers') {
      const result = await pool.query(
        `SELECT tt.tx_hash, tt.block_height, tt.token_address, tt.from_address, tt.to_address, tt.value,
                t.symbol AS token_symbol, t.decimals AS token_decimals
         FROM token_transfers tt LEFT JOIN tokens t ON t.address = tt.token_address
         WHERE tt.from_address = $1 OR tt.to_address = $1
         ORDER BY tt.block_height ${direction}, tt.log_index ${direction}
         LIMIT $2`,
        [address, limit]
      );
      const headers = ['tx_hash', 'block_height', 'token_address', 'from_address', 'to_address', 'value', 'token_symbol', 'token_decimals'];
      csv = [headers.join(','), ...result.rows.map((r: Record<string, unknown>) =>
        headers.map((h) => String(r[h] ?? '')).join(',')
      )].join('\n');
    } else {
      const result = await pool.query(
        `SELECT hash, block_height, from_address, to_address, value, status, gas_used, gas_price
         FROM transactions WHERE from_address = $1 OR to_address = $1
         ORDER BY block_height ${direction}, tx_index ${direction}
         LIMIT $2`,
        [address, limit]
      );
      const headers = ['hash', 'block_height', 'from_address', 'to_address', 'value', 'status', 'gas_used', 'gas_price'];
      csv = [headers.join(','), ...result.rows.map((r: Record<string, unknown>) =>
        headers.map((h) => String(r[h] ?? '')).join(',')
      )].join('\n');
    }

    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', `attachment; filename=qfc-${address.slice(0, 10)}-${type}.csv`);
    return csv;
  });
}
