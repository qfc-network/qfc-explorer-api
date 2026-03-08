import { FastifyInstance } from 'fastify';
import { getReadPool } from '../db/pool.js';
import { cached } from '../lib/cache.js';
import { parseNumber, clamp } from '../lib/pagination.js';

export default async function richlistRoutes(app: FastifyInstance) {
  // GET /richlist
  app.get('/', async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const page = clamp(parseNumber(query.page, 1), 1, 10000);
    const limit = clamp(parseNumber(query.limit, 50), 1, 100);
    const type = ['all', 'eoa', 'contract'].includes(query.type ?? '')
      ? (query.type as string)
      : 'all';
    const offset = (page - 1) * limit;

    const cacheKey = `richlist:${type}:${page}:${limit}`;
    const data = await cached(cacheKey, 30, async () => {
      const pool = getReadPool();

      // Build WHERE clause based on type filter
      let whereClause = '';
      if (type === 'eoa') {
        whereClause = 'WHERE a.address NOT IN (SELECT address FROM contracts)';
      } else if (type === 'contract') {
        whereClause = 'WHERE a.address IN (SELECT address FROM contracts)';
      }

      // Get total count
      const countResult = await pool.query(
        `SELECT COUNT(*)::int AS total FROM accounts a ${whereClause}`
      );
      const total: number = countResult.rows[0]?.total ?? 0;

      // Get total supply (sum of all balances)
      const supplyResult = await pool.query(
        `SELECT COALESCE(SUM(balance::numeric), 0)::text AS total_supply FROM accounts`
      );
      const totalSupply: string = supplyResult.rows[0]?.total_supply ?? '0';

      // Get paginated accounts with is_contract flag and label
      const accountsResult = await pool.query(
        `SELECT
          a.address,
          a.balance,
          a.nonce,
          (EXISTS (SELECT 1 FROM contracts c WHERE c.address = a.address)) AS is_contract,
          (SELECT COUNT(*)::int FROM transactions WHERE from_address = a.address OR to_address = a.address) AS tx_count,
          al.label,
          al.category AS label_category
        FROM accounts a
        LEFT JOIN address_labels al ON al.address = a.address
        ${whereClause}
        ORDER BY a.balance::numeric DESC
        LIMIT $1 OFFSET $2`,
        [limit, offset]
      );

      // Get top 10 holders share for stats
      const top10Result = await pool.query(
        `SELECT COALESCE(SUM(balance::numeric), 0)::text AS top10_balance
         FROM (SELECT balance FROM accounts ORDER BY balance::numeric DESC LIMIT 10) sub`
      );
      const top10Balance: string = top10Result.rows[0]?.top10_balance ?? '0';

      const items = accountsResult.rows.map((row: Record<string, unknown>) => ({
        address: row.address as string,
        balance: row.balance as string,
        nonce: row.nonce as string,
        is_contract: row.is_contract as boolean,
        tx_count: row.tx_count as number,
        label: (row.label as string | null) ?? null,
        label_category: (row.label_category as string | null) ?? null,
      }));

      return {
        page,
        limit,
        type,
        total,
        total_supply: totalSupply,
        top10_balance: top10Balance,
        items,
      };
    });

    return { ok: true, data };
  });
}
