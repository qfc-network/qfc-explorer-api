import { FastifyInstance } from 'fastify';
import { getPool } from '../db/pool.js';

export default async function leaderboardRoutes(app: FastifyInstance) {
  // GET /leaderboard
  app.get('/', async () => {
    const pool = getPool();
    const [topBalances, mostActive, topValidators, topContracts] = await Promise.all([
      pool.query(`
        SELECT address, balance, nonce, last_seen_block
        FROM accounts ORDER BY balance::numeric DESC LIMIT 25
      `),
      pool.query(`
        SELECT a.address,
          (SELECT COUNT(*) FROM transactions WHERE from_address = a.address)::int AS sent,
          (SELECT COUNT(*) FROM transactions WHERE to_address = a.address)::int AS received,
          (SELECT COUNT(*) FROM transactions WHERE from_address = a.address OR to_address = a.address)::int AS total,
          a.balance
        FROM accounts a ORDER BY
          (SELECT COUNT(*) FROM transactions WHERE from_address = a.address OR to_address = a.address) DESC
        LIMIT 25
      `),
      pool.query(`
        SELECT producer AS address, COUNT(*)::int AS blocks_produced,
          MIN(height)::text AS first_block, MAX(height)::text AS last_block
        FROM blocks WHERE producer IS NOT NULL
        GROUP BY producer ORDER BY blocks_produced DESC LIMIT 25
      `),
      pool.query(`
        SELECT c.address, COALESCE(c.is_verified, false) AS is_verified,
          t.name AS token_name,
          (SELECT COUNT(*) FROM transactions WHERE to_address = c.address)::int AS tx_count
        FROM contracts c LEFT JOIN tokens t ON t.address = c.address
        ORDER BY tx_count DESC LIMIT 25
      `),
    ]);

    return {
      ok: true,
      data: {
        topBalances: topBalances.rows,
        mostActive: mostActive.rows,
        topValidators: topValidators.rows,
        topContracts: topContracts.rows,
      },
    };
  });
}
