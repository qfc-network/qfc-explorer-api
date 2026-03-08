import { FastifyInstance } from 'fastify';
import { getPool, getReadPool } from '../db/pool.js';
import { getRateLimitStats, getConfig } from '../lib/rate-limit.js';
import { upsertAddressLabel, listAddressLabels, searchAddressLabels } from '../db/queries.js';
import { archiveBelow, getArchiveStatus } from '../lib/archive.js';
import { getWsStats } from './ws.js';
import { getRedisConfig } from '../lib/cache.js';
import { setManualPrice, listPrices, deletePrice } from '../lib/price-service.js';

export default async function adminRoutes(app: FastifyInstance) {
  // GET /admin/db
  app.get('/db', async () => {
    const pool = getReadPool();
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
    const pool = getReadPool();
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

  // POST /admin/labels — upsert address label
  app.post('/labels', async (request, reply) => {
    const body = request.body as {
      address: string;
      label: string;
      category?: string;
      description?: string;
      website?: string;
    };
    if (!body.address || !body.label) {
      reply.status(400);
      return { ok: false, error: 'Missing address or label' };
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(body.address)) {
      reply.status(400);
      return { ok: false, error: 'Invalid address format' };
    }
    await upsertAddressLabel(body.address, body.label, body.category, body.description, body.website);
    return { ok: true, data: { address: body.address.toLowerCase(), label: body.label } };
  });

  // POST /admin/labels/batch — bulk upsert address labels
  app.post('/labels/batch', async (request, reply) => {
    const body = request.body as Array<{
      address: string; label: string; category?: string;
    }>;
    if (!Array.isArray(body) || body.length === 0) {
      reply.status(400);
      return { ok: false, error: 'Expected non-empty array of labels' };
    }
    for (const item of body) {
      await upsertAddressLabel(item.address, item.label, item.category);
    }
    return { ok: true, data: { count: body.length } };
  });

  // GET /admin/archive — archive status
  app.get('/archive', async () => {
    try {
      const status = await getArchiveStatus();
      return { ok: true, data: status };
    } catch (error) {
      return { ok: true, data: { threshold: '0', tables: [], recentOperations: [], note: 'Archive schema not yet created — run migration 004_archive.sql' } };
    }
  });

  // POST /admin/archive — trigger archival of old data
  app.post('/archive', async (request, reply) => {
    const body = request.body as { belowHeight: number };
    if (!body.belowHeight || !Number.isFinite(body.belowHeight) || body.belowHeight < 1_000_000) {
      reply.status(400);
      return { ok: false, error: 'belowHeight must be >= 1000000 (one full partition)' };
    }

    const results = await archiveBelow(body.belowHeight);
    const totalRows = results.reduce((sum, r) => sum + r.rowCount, 0);
    return {
      ok: true,
      data: {
        belowHeight: body.belowHeight,
        partitionsArchived: results.length,
        totalRowsMoved: totalRows,
        details: results,
      },
    };
  });

  // GET /admin/labels — list address labels
  app.get('/labels', async (request) => {
    const { q, limit } = request.query as { q?: string; limit?: string };
    const max = Math.min(Number(limit) || 50, 200);
    if (q) {
      const labels = await searchAddressLabels(q, max);
      return { ok: true, data: { labels } };
    }
    const labels = await listAddressLabels(max);
    return { ok: true, data: { labels } };
  });

  // GET /admin/ws — WebSocket connection stats
  app.get('/ws', async () => {
    return { ok: true, data: getWsStats() };
  });

  // GET /admin/redis — Redis config and status
  app.get('/redis', async () => {
    return { ok: true, data: getRedisConfig() };
  });

  // POST /admin/prices — set manual price for a token
  app.post('/prices', async (request, reply) => {
    const body = request.body as {
      tokenAddress: string;
      priceUsd: number;
      marketCapUsd?: number;
      change24h?: number;
      volume24h?: number;
    };
    if (!body.tokenAddress || typeof body.priceUsd !== 'number') {
      reply.status(400);
      return { ok: false, error: 'Missing tokenAddress or priceUsd' };
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(body.tokenAddress)) {
      reply.status(400);
      return { ok: false, error: 'Invalid address format' };
    }
    await setManualPrice(body.tokenAddress, body.priceUsd, body.marketCapUsd, body.change24h, body.volume24h);
    return { ok: true, data: { tokenAddress: body.tokenAddress.toLowerCase(), priceUsd: body.priceUsd } };
  });

  // GET /admin/prices — list all configured prices
  app.get('/prices', async () => {
    const prices = await listPrices();
    return { ok: true, data: { prices } };
  });

  // DELETE /admin/prices/:address — remove price entry
  app.delete('/prices/:address', async (request, reply) => {
    const { address } = request.params as { address: string };
    const deleted = await deletePrice(address);
    if (!deleted) {
      reply.status(404);
      return { ok: false, error: 'Price entry not found' };
    }
    return { ok: true, data: { address: address.toLowerCase(), deleted: true } };
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
