import { FastifyInstance } from 'fastify';
import { getPool } from '../db/pool.js';
import { getDailyStats } from '../db/queries.js';
import { clamp, parseNumber } from '../lib/pagination.js';
import { cached } from '../lib/cache.js';

export default async function analyticsRoutes(app: FastifyInstance) {
  // GET /analytics — network overview
  app.get('/', async () => {
    const data = await cached('analytics:overview', 30, async () => {
    const pool = getPool();

    const [totals, blockSeries, validatorStats] = await Promise.all([
      pool.query(`
        SELECT
          (SELECT COUNT(*) FROM blocks) AS total_blocks,
          (SELECT COUNT(*) FROM transactions) AS total_transactions,
          (SELECT COUNT(*) FROM accounts) AS total_addresses,
          (SELECT COALESCE(SUM(gas_used::numeric), 0) FROM blocks) AS total_gas_used
      `),
      pool.query(`
        WITH recent AS (
          SELECT height, timestamp_ms, gas_used, tx_count
          FROM blocks WHERE height > 0 ORDER BY height DESC LIMIT 100
        )
        SELECT height, timestamp_ms, gas_used, tx_count,
          COALESCE(timestamp_ms - LAG(timestamp_ms) OVER (ORDER BY height), 0) AS block_time_ms
        FROM recent ORDER BY height ASC
      `),
      pool.query(`
        SELECT producer AS address,
          COUNT(*)::int AS blocks_produced,
          ROUND(COUNT(*)::numeric / (SELECT COUNT(*) FROM blocks WHERE producer IS NOT NULL) * 100, 2) AS contribution_score
        FROM blocks WHERE producer IS NOT NULL
        GROUP BY producer ORDER BY blocks_produced DESC LIMIT 20
      `),
    ]);

    const overview = totals.rows[0];
    const rows = blockSeries.rows as Array<Record<string, string | number>>;

    const series = {
      tps: rows.map((r) => ({
        label: String(r.height),
        value: Number(r.tx_count ?? 0),
        timestamp: Number(r.timestamp_ms),
      })),
      gas_used: rows.map((r) => ({
        label: String(r.height),
        value: Number(r.gas_used ?? 0),
        timestamp: Number(r.timestamp_ms),
      })),
      block_time: rows.map((r) => ({
        label: String(r.height),
        value: Number(r.block_time_ms ?? 0),
        timestamp: Number(r.timestamp_ms),
      })),
      tx_count: rows.map((r) => ({
        label: String(r.height),
        value: Number(r.tx_count ?? 0),
        timestamp: Number(r.timestamp_ms),
      })),
    };

    return { overview, series, validators: validatorStats.rows };
    });
    return { ok: true, data };
  });

  // GET /analytics/daily
  app.get('/daily', async (request) => {
    const q = request.query as Record<string, string>;
    const days = clamp(parseNumber(q.days, 30), 1, 365);
    const data = await cached(`analytics:daily:${days}`, 60, async () => {
      const stats = await getDailyStats(days);
      return { days, stats };
    });
    return { ok: true, data };
  });

  // GET /analytics/export
  app.get('/export', async (request, reply) => {
    const q = request.query as Record<string, string>;
    const type = q.type || 'tps';
    const format = q.format || 'json';
    const pool = getPool();

    let rows: Record<string, unknown>[] = [];
    let headers: string[] = [];

    if (type === 'tps' || type === 'gas' || type === 'block_time') {
      const result = await pool.query(`
        WITH recent AS (
          SELECT height, timestamp_ms, gas_used, gas_limit, tx_count
          FROM blocks WHERE height > 0 ORDER BY height DESC LIMIT 1000
        )
        SELECT height, timestamp_ms, gas_used, gas_limit, tx_count,
          COALESCE(timestamp_ms - LAG(timestamp_ms) OVER (ORDER BY height), 0) AS block_time_ms
        FROM recent ORDER BY height ASC
      `);
      rows = result.rows;
      headers = ['height', 'timestamp_ms', 'gas_used', 'gas_limit', 'tx_count', 'block_time_ms'];
    } else if (type === 'validators') {
      const result = await pool.query(`
        SELECT producer AS address, COUNT(*)::int AS blocks_produced,
          (SELECT COUNT(*) FROM transactions WHERE block_height IN (
            SELECT height FROM blocks WHERE producer = b.producer
          ))::int AS tx_count,
          COALESCE(SUM(gas_used::numeric), 0) AS total_gas
        FROM blocks b WHERE producer IS NOT NULL
        GROUP BY producer ORDER BY blocks_produced DESC
      `);
      rows = result.rows;
      headers = ['address', 'blocks_produced', 'tx_count', 'total_gas'];
    } else if (type === 'blocks') {
      const limit = clamp(parseNumber(q.limit, 1000), 100, 10000);
      const result = await pool.query(
        `SELECT hash, height, producer, timestamp_ms, gas_used, gas_limit, tx_count
         FROM blocks ORDER BY height DESC LIMIT $1`,
        [limit]
      );
      rows = result.rows;
      headers = ['hash', 'height', 'producer', 'timestamp_ms', 'gas_used', 'gas_limit', 'tx_count'];
    } else if (type === 'transactions') {
      const limit = clamp(parseNumber(q.limit, 1000), 100, 10000);
      const params: (string | number)[] = [limit];
      let where = '';
      if (q.address) {
        where = 'WHERE from_address = $2 OR to_address = $2';
        params.push(q.address);
      }
      const result = await pool.query(
        `SELECT hash, block_height, from_address, to_address, value, status, gas_limit, gas_price
         FROM transactions ${where} ORDER BY block_height DESC LIMIT $1`,
        params
      );
      rows = result.rows;
      headers = ['hash', 'block_height', 'from_address', 'to_address', 'value', 'status', 'gas_limit', 'gas_price'];
    }

    if (format === 'csv') {
      const csv = [headers.join(','), ...rows.map((r) => headers.map((h) => r[h] ?? '').join(','))].join('\n');
      reply.header('Content-Type', 'text/csv');
      reply.header('Content-Disposition', `attachment; filename=qfc-${type}-export.csv`);
      return csv;
    }

    return { ok: true, data: { type, rows } };
  });
}
