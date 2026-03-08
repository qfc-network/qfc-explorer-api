import { FastifyInstance } from 'fastify';
import {
  getTokensPage, getTokenByAddress, getTokenTransfers,
  getTokenHolders, getNftHoldersByToken, getRecentTokenTransfers,
} from '../db/queries.js';
import { clamp, parseNumber, parseOrder, parseSort } from '../lib/pagination.js';
import { getTokenPrice, getTokenPrices, getTokenSparkline } from '../lib/price-service.js';
import { getReadPool } from '../db/pool.js';

const SORT_FIELDS = ['market_cap', 'holders', 'volume', 'price', 'name', 'transfers'] as const;
const TOKEN_TYPES = ['erc20', 'erc721', 'erc1155', 'all'] as const;

export default async function tokensRoutes(app: FastifyInstance) {
  // GET /tokens
  app.get('/', async (request) => {
    const q = request.query as Record<string, string>;
    const page = parseNumber(q.page, 1);
    const limit = clamp(parseNumber(q.limit, 25), 1, 100);
    const order = parseOrder(q.order);
    const sort = parseSort(q.sort, [...SORT_FIELDS], 'market_cap');
    const type = TOKEN_TYPES.includes(q.type as any) ? q.type : 'all';
    const offset = (page - 1) * limit;

    const pool = getReadPool();
    const direction = order === 'asc' ? 'ASC' : 'DESC';

    // Build WHERE clause for type filter
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (type !== 'all') {
      conditions.push(`t.token_type = $${paramIndex}`);
      params.push(type);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Build ORDER BY clause based on sort
    let orderByClause: string;
    switch (sort) {
      case 'holders':
        orderByClause = `holder_count ${direction} NULLS LAST`;
        break;
      case 'volume':
        orderByClause = `tp.volume_24h ${direction} NULLS LAST`;
        break;
      case 'price':
        orderByClause = `tp.price_usd ${direction} NULLS LAST`;
        break;
      case 'name':
        orderByClause = `t.name ${direction} NULLS LAST`;
        break;
      case 'transfers':
        orderByClause = `transfer_count ${direction} NULLS LAST`;
        break;
      case 'market_cap':
      default:
        orderByClause = `tp.market_cap_usd ${direction} NULLS LAST`;
        break;
    }

    params.push(limit, offset);
    const limitParam = `$${paramIndex}`;
    const offsetParam = `$${paramIndex + 1}`;

    const sql = `
      SELECT
        t.address, t.name, t.symbol, t.decimals, t.total_supply, t.last_seen_block, t.token_type,
        tp.price_usd, tp.market_cap_usd, tp.change_24h, tp.volume_24h,
        (SELECT COUNT(*)::int FROM token_balances tb WHERE tb.token_address = t.address AND tb.balance != '0') AS holder_count,
        (SELECT COUNT(*)::int FROM token_transfers tt WHERE tt.token_address = t.address) AS transfer_count
      FROM tokens t
      LEFT JOIN token_prices tp ON tp.token_address = t.address
      ${whereClause}
      ORDER BY ${orderByClause}
      LIMIT ${limitParam} OFFSET ${offsetParam}
    `;

    const result = await pool.query(sql, params);
    const items = result.rows.map((row: any) => ({
      address: row.address,
      name: row.name,
      symbol: row.symbol,
      decimals: row.decimals,
      total_supply: row.total_supply,
      last_seen_block: row.last_seen_block,
      token_type: row.token_type,
      price_usd: row.price_usd != null ? Number(row.price_usd) : null,
      market_cap_usd: row.market_cap_usd != null ? Number(row.market_cap_usd) : null,
      change_24h: row.change_24h != null ? Number(row.change_24h) : null,
      volume_24h: row.volume_24h != null ? Number(row.volume_24h) : null,
      holder_count: row.holder_count ?? 0,
      transfer_count: row.transfer_count ?? 0,
    }));

    // Get total count for pagination
    const countSql = `
      SELECT COUNT(*)::int AS total
      FROM tokens t
      LEFT JOIN token_prices tp ON tp.token_address = t.address
      ${whereClause}
    `;
    const countResult = await pool.query(countSql, params.slice(0, paramIndex - 1));
    const total = countResult.rows[0]?.total ?? 0;

    return { ok: true, data: { page, limit, order, sort, type, total, items } };
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
