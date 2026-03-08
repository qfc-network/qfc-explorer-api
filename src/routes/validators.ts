import { FastifyInstance } from 'fastify';
import { getReadPool } from '../db/pool.js';
import { cached } from '../lib/cache.js';
import { parseNumber, clamp } from '../lib/pagination.js';

export default async function validatorRoutes(app: FastifyInstance) {
  // GET /validators — list all validators with block production stats
  app.get('/', async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const page = clamp(parseNumber(query.page, 1), 1, 10000);
    const limit = clamp(parseNumber(query.limit, 25), 1, 100);
    const offset = (page - 1) * limit;
    const sort = query.sort === 'last_active' ? 'last_block' : 'blocks_produced';

    const data = await cached(`validators:list:${page}:${limit}:${sort}`, 30, async () => {
      const pool = getReadPool();

      // Get total blocks for percentage calculation
      const totalResult = await pool.query(
        `SELECT COUNT(*)::int AS total FROM blocks WHERE producer IS NOT NULL`
      );
      const totalBlocks = totalResult.rows[0]?.total ?? 0;

      // Get validators with stats
      const validatorsResult = await pool.query(
        `SELECT
           producer AS address,
           COUNT(*)::int AS blocks_produced,
           MIN(height)::text AS first_block,
           MAX(height)::text AS last_block,
           MAX(timestamp_ms)::text AS last_active_ms,
           COALESCE(SUM(gas_used::numeric), 0)::text AS total_gas_used
         FROM blocks
         WHERE producer IS NOT NULL
         GROUP BY producer
         ORDER BY ${sort === 'last_block' ? 'last_block DESC' : 'blocks_produced DESC'}
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      );

      const validators = validatorsResult.rows;

      // Enrich with address labels
      if (validators.length > 0) {
        const addresses = validators.map((v: Record<string, unknown>) =>
          (v.address as string).toLowerCase()
        );
        const placeholders = addresses.map((_: string, i: number) => `$${i + 1}`).join(',');
        const labelsResult = await pool.query(
          `SELECT address, label, category FROM address_labels WHERE address IN (${placeholders})`,
          addresses
        );
        const labelMap: Record<string, { label: string; category: string | null }> = {};
        for (const row of labelsResult.rows) {
          labelMap[(row as Record<string, string>).address] = {
            label: (row as Record<string, string>).label,
            category: (row as Record<string, string | null>).category,
          };
        }
        for (const v of validators) {
          const addr = ((v as Record<string, unknown>).address as string).toLowerCase();
          (v as Record<string, unknown>).label = labelMap[addr]?.label ?? null;
          (v as Record<string, unknown>).category = labelMap[addr]?.category ?? null;
        }
      }

      // Count distinct validators
      const countResult = await pool.query(
        `SELECT COUNT(DISTINCT producer)::int AS total FROM blocks WHERE producer IS NOT NULL`
      );
      const totalValidators = countResult.rows[0]?.total ?? 0;

      return {
        page,
        limit,
        sort,
        total_validators: totalValidators,
        total_blocks: totalBlocks,
        items: validators,
      };
    });

    return { ok: true, data };
  });

  // GET /validators/:address — individual validator profile
  app.get('/:address', async (request, reply) => {
    const { address } = request.params as { address: string };

    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return reply.status(400).send({ ok: false, error: 'Invalid address format' });
    }

    const data = await cached(`validators:${address.toLowerCase()}`, 30, async () => {
      const pool = getReadPool();

      // Get validator stats
      const statsResult = await pool.query(
        `SELECT
           producer AS address,
           COUNT(*)::int AS blocks_produced,
           MIN(height)::text AS first_block,
           MAX(height)::text AS last_block,
           MAX(timestamp_ms)::text AS last_active_ms,
           COALESCE(SUM(gas_used::numeric), 0)::text AS total_gas_used,
           COALESCE(AVG(gas_used::numeric), 0)::text AS avg_gas_used
         FROM blocks
         WHERE producer = $1
         GROUP BY producer`,
        [address.toLowerCase()]
      );

      if (statsResult.rows.length === 0) {
        return null;
      }

      const stats = statsResult.rows[0] as Record<string, unknown>;

      // Get total blocks for percentage
      const totalResult = await pool.query(
        `SELECT COUNT(*)::int AS total FROM blocks WHERE producer IS NOT NULL`
      );
      stats.total_blocks = totalResult.rows[0]?.total ?? 0;

      // Compute avg block time for this validator's blocks
      const avgBlockTimeResult = await pool.query(
        `WITH ordered AS (
           SELECT height, timestamp_ms,
             LAG(timestamp_ms) OVER (ORDER BY height) AS prev_ts
           FROM blocks WHERE producer = $1 AND height > 0
           ORDER BY height DESC LIMIT 100
         )
         SELECT AVG(timestamp_ms - prev_ts)::text AS avg_block_time_ms
         FROM ordered WHERE prev_ts IS NOT NULL`,
        [address.toLowerCase()]
      );
      stats.avg_block_time_ms = avgBlockTimeResult.rows[0]?.avg_block_time_ms ?? null;

      // Address label
      const labelResult = await pool.query(
        `SELECT label, category, description FROM address_labels WHERE address = $1 LIMIT 1`,
        [address.toLowerCase()]
      );
      stats.label = labelResult.rows[0]?.label ?? null;
      stats.category = labelResult.rows[0]?.category ?? null;

      // Recent blocks (last 20)
      const recentBlocksResult = await pool.query(
        `SELECT hash, height, timestamp_ms, tx_count, gas_used
         FROM blocks WHERE producer = $1
         ORDER BY height DESC LIMIT 20`,
        [address.toLowerCase()]
      );

      // Block production timeline (blocks per day, last 30 days)
      const timelineResult = await pool.query(
        `SELECT
           (to_timestamp(timestamp_ms::bigint / 1000) AT TIME ZONE 'UTC')::date::text AS date,
           COUNT(*)::int AS block_count
         FROM blocks
         WHERE producer = $1
           AND timestamp_ms::bigint > (EXTRACT(EPOCH FROM NOW() - INTERVAL '30 days') * 1000)::bigint
         GROUP BY date
         ORDER BY date ASC`,
        [address.toLowerCase()]
      );

      return {
        stats,
        recent_blocks: recentBlocksResult.rows,
        timeline: timelineResult.rows,
      };
    });

    if (!data) {
      return reply.status(404).send({ ok: false, error: 'Validator not found' });
    }

    return { ok: true, data };
  });
}
