import { FastifyInstance } from 'fastify';
import {
  getTokensPage, getTokenByAddress, getTokenTransfers,
  getTokenHolders, getNftHoldersByToken, getRecentTokenTransfers,
} from '../db/queries.js';
import { clamp, parseNumber, parseOrder } from '../lib/pagination.js';
import { getTokenPrice, getTokenPrices, getTokenSparkline } from '../lib/price-service.js';
import { getReadPool } from '../db/pool.js';

export default async function tokensRoutes(app: FastifyInstance) {
  // GET /tokens
  app.get('/', async (request) => {
    const q = request.query as Record<string, string>;
    const page = parseNumber(q.page, 1);
    const limit = clamp(parseNumber(q.limit, 25), 1, 100);
    const order = parseOrder(q.order);
    const offset = (page - 1) * limit;
    const items = await getTokensPage(limit, offset, order);

    // Enrich with price data via LEFT JOIN lookup
    const addresses = items.map((t: any) => t.address);
    const priceMap = await getTokenPrices(addresses);
    const enriched = items.map((t: any) => {
      const p = priceMap.get(t.address);
      return {
        ...t,
        price_usd: p?.priceUsd ?? null,
        market_cap_usd: p?.marketCapUsd ?? null,
        change_24h: p?.change24h ?? null,
      };
    });

    return { ok: true, data: { page, limit, order, items: enriched } };
  });

  // GET /tokens/transfers — recent token transfers (all tokens)
  app.get('/transfers', async (request) => {
    const q = request.query as Record<string, string>;
    const page = parseNumber(q.page, 1);
    const limit = clamp(parseNumber(q.limit, 25), 1, 100);
    const order = parseOrder(q.order);
    const offset = (page - 1) * limit;
    const type = q.type; // optional: 'ERC-20', 'ERC-721', 'ERC-1155'
    const items = await getRecentTokenTransfers(limit, offset, order, type);
    return { ok: true, data: { page, limit, order, type: type ?? null, items } };
  });

  // GET /tokens/:address
  app.get('/:address', async (request, reply) => {
    const { address } = request.params as { address: string };
    const q = request.query as Record<string, string>;
    const page = parseNumber(q.page, 1);
    const limit = clamp(parseNumber(q.limit, 25), 1, 100);
    const order = parseOrder(q.order);
    const offset = (page - 1) * limit;

    const token = await getTokenByAddress(address);
    if (!token) {
      reply.status(404);
      return { ok: false, error: 'Token not found' };
    }

    const [transfers, price] = await Promise.all([
      getTokenTransfers(address, limit, offset, order),
      getTokenPrice(address),
    ]);
    return { ok: true, data: { token, price, page, limit, order, transfers } };
  });

  // GET /tokens/:address/holders
  app.get('/:address/holders', async (request, reply) => {
    const { address } = request.params as { address: string };
    const q = request.query as Record<string, string>;
    const limit = clamp(parseNumber(q.limit, 25), 1, 200);

    const token = await getTokenByAddress(address);
    if (!token) {
      reply.status(404);
      return { ok: false, error: 'Token not found' };
    }

    const [holders, nftHolders] = await Promise.all([
      getTokenHolders(address, limit),
      getNftHoldersByToken(address, limit),
    ]);

    return { ok: true, data: { token, holders, nftHolders } };
  });

  // GET /tokens/:address/sparkline — 7-day price history
  app.get('/:address/sparkline', async (request, reply) => {
    const { address } = request.params as { address: string };

    const token = await getTokenByAddress(address);
    if (!token) {
      reply.status(404);
      return { ok: false, error: 'Token not found' };
    }

    const sparkline = await getTokenSparkline(address);
    return { ok: true, data: { tokenAddress: address.toLowerCase(), sparkline } };
  });
}
