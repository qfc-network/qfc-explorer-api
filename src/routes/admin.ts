import { FastifyInstance } from 'fastify';
import { getPool } from '../db/pool.js';
import { getRateLimitStats, getConfig } from '../lib/rate-limit.js';

export default async function adminRoutes(app: FastifyInstance) {
  // GET /admin/db
  app.get('/db', async () => {
    const pool = getPool();
    return {
      ok: true,
      data: {
        pool: {
          total: pool.totalCount,
          idle: pool.idleCount,
          waiting: pool.waitingCount,
        },
      },
    };
  });

  // GET /admin/indexer
  app.get('/indexer', async () => {
    const pool = getPool();
    const result = await pool.query(
      `SELECT key, value, updated_at FROM indexer_state ORDER BY updated_at DESC LIMIT 10`
    );

    let lastBatch = null;
    let failed = null;
    for (const row of result.rows) {
      if (row.key === 'last_batch_stats') {
        try { lastBatch = JSON.parse(row.value); } catch { /* ignore */ }
      }
      if (row.key === 'failed_blocks') {
        try { failed = JSON.parse(row.value); } catch { /* ignore */ }
      }
    }

    return { ok: true, data: { items: result.rows, lastBatch, failed } };
  });

  // POST /admin/indexer/rescan
  app.post('/indexer/rescan', async (request, reply) => {
    const body = request.body as { from?: number };
    if (!body.from || !Number.isFinite(body.from) || body.from < 0) {
      reply.status(400);
      return { ok: false, error: 'Invalid "from" parameter — must be a non-negative integer' };
    }

    const pool = getPool();
    await pool.query(
      `INSERT INTO indexer_state (key, value, updated_at) VALUES ('admin_rescan_from', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [String(body.from)]
    );

    return { ok: true, data: { accepted: true, from: body.from } };
  });

  // POST /admin/indexer/retry-failed
  app.post('/indexer/retry-failed', async () => {
    const pool = getPool();
    await pool.query(
      `INSERT INTO indexer_state (key, value, updated_at) VALUES ('admin_retry_failed', 'true', NOW())
       ON CONFLICT (key) DO UPDATE SET value = 'true', updated_at = NOW()`
    );
    return { ok: true, data: { accepted: true } };
  });

  // GET /admin/rate-limit
  app.get('/rate-limit', async () => {
    const stats = getRateLimitStats();
    const config = getConfig();
    return {
      ok: true,
      data: {
        config: { ...config, windowSeconds: config.windowMs / 1000 },
        stats: {
          activeIps: stats.activeIps,
          totalRequests: stats.totalRequests,
          limitedRequests: stats.limitedRequests,
          limitedPercentage: stats.totalRequests > 0
            ? ((stats.limitedRequests / stats.totalRequests) * 100).toFixed(1)
            : '0.0',
        },
        topIps: stats.topIps,
        recentRequests: stats.recentRequests,
      },
    };
  });
}
