import { FastifyInstance } from 'fastify';
import {
  getAddressOverview, getAddressStats, getAddressAnalysis,
  getContractByAddress, getTokenHoldingsByAddress, getNftHoldingsByAddress,
  getAddressTransactions, getTokenTransfersByAddress,
  getInternalTxsByAddress, getAddressLabel,
} from '../db/queries.js';
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
}
