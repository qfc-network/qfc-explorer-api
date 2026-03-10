import { gzipSync } from 'node:zlib';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { registerMetrics } from './middleware/metrics.js';
import { closePool } from './db/pool.js';
import { closeRedis } from './lib/cache.js';
import { startMetricsUpdater } from './middleware/metrics-updater.js';
import { startPriceUpdater } from './lib/price-updater.js';

import blocksRoutes from './routes/blocks.js';
import transactionsRoutes from './routes/transactions.js';
import addressesRoutes from './routes/addresses.js';
import contractsRoutes from './routes/contracts.js';
import tokensRoutes from './routes/tokens.js';
import searchRoutes from './routes/search.js';
import analyticsRoutes from './routes/analytics.js';
import networkRoutes from './routes/network.js';
import inferenceRoutes from './routes/inference.js';
import governanceRoutes from './routes/governance.js';
import leaderboardRoutes from './routes/leaderboard.js';
import streamRoutes from './routes/stream.js';
import wsRoutes from './routes/ws.js';
import adminRoutes from './routes/admin.js';
import healthRoutes from './routes/health.js';
import toolsRoutes from './routes/tools.js';
import etherscanRoutes from './routes/etherscan.js';
import txpoolRoutes from './routes/txpool.js';
import authRoutes from './routes/auth.js';
import watchlistRoutes from './routes/watchlist.js';
import apikeysRoutes from './routes/apikeys.js';
import approvalRoutes from './routes/approvals.js';
import notesRoutes from './routes/notes.js';
import commentsRoutes from './routes/comments.js';
import labelsRoutes from './routes/labels.js';
import minersRoutes from './routes/miners.js';
import validatorsRoutes from './routes/validators.js';
import statsRoutes from './routes/stats.js';
import gasOracleRoutes from './routes/gas-oracle.js';
import batchRoutes from './routes/batch.js';
import richlistRoutes from './routes/richlist.js';
import agentsRoutes from './routes/agents.js';
import { apiKeyAuth } from './middleware/apikey-auth.js';

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '0.0.0.0';

const app = Fastify({
  logger: {
    level: 'info',
    transport: {
      target: 'pino-pretty',
      options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
    },
  },
});

// Cookie support (must be registered before routes)
await app.register(import('@fastify/cookie'), {
  secret: process.env.COOKIE_SECRET || 'qfc-explorer-cookie-secret',
});

// CORS — allow explorer frontend
await app.register(cors, {
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  credentials: true,
});

// Response compression (gzip) for payloads > 1 KB
const COMPRESSION_THRESHOLD = 1024;
app.addHook('onSend', async (request, reply, payload) => {
  if (payload == null) return payload;

  const accept = request.headers['accept-encoding'];
  if (!accept || !accept.includes('gzip')) return payload;

  // Only compress string/Buffer payloads (skip streams)
  const raw = typeof payload === 'string' ? payload : payload instanceof Buffer ? payload : null;
  if (!raw) return payload;

  const size = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.length;
  if (size < COMPRESSION_THRESHOLD) return payload;

  const compressed = gzipSync(raw);
  void reply.header('Content-Encoding', 'gzip');
  void reply.header('Content-Length', compressed.length);
  return compressed;
});

// Prometheus metrics
await registerMetrics(app);

// Register routes
await app.register(blocksRoutes, { prefix: '/blocks' });
await app.register(transactionsRoutes, { prefix: '/txs' });
await app.register(addressesRoutes, { prefix: '/address' });
await app.register(contractsRoutes, { prefix: '/contract' });
await app.register(tokensRoutes, { prefix: '/tokens' });
await app.register(searchRoutes, { prefix: '/search' });
await app.register(analyticsRoutes, { prefix: '/analytics' });
await app.register(networkRoutes, { prefix: '/network' });
await app.register(inferenceRoutes, { prefix: '/inference' });
await app.register(governanceRoutes, { prefix: '/governance' });
await app.register(leaderboardRoutes, { prefix: '/leaderboard' });
await app.register(streamRoutes, { prefix: '/stream' });
await app.register(wsRoutes);
await app.register(adminRoutes, { prefix: '/admin' });
await app.register(healthRoutes);
await app.register(toolsRoutes, { prefix: '/tools' });
await app.register(etherscanRoutes, { prefix: '/etherscan' });
// Mount etherscan-compat routes at root too — hardhat-verify posts to /api directly
await app.register(etherscanRoutes, { prefix: '/' });
await app.register(txpoolRoutes, { prefix: '/txpool' });
await app.register(authRoutes, { prefix: '/auth' });
await app.register(watchlistRoutes, { prefix: '/watchlist' });
await app.register(apikeysRoutes, { prefix: '/api-keys' });
await app.register(approvalRoutes, { prefix: '/approvals' });
await app.register(notesRoutes, { prefix: '/notes' });
await app.register(commentsRoutes, { prefix: '/comments' });
await app.register(labelsRoutes, { prefix: '/labels' });
await app.register(minersRoutes, { prefix: '/miners' });
await app.register(validatorsRoutes, { prefix: '/validators' });
await app.register(statsRoutes, { prefix: '/stats' });
await app.register(gasOracleRoutes, { prefix: '/gas-oracle' });
await app.register(batchRoutes, { prefix: '/batch' });
await app.register(richlistRoutes, { prefix: '/richlist' });
await app.register(agentsRoutes, { prefix: '/agents' });

// Global API key authentication hook
app.addHook('onRequest', apiKeyAuth);

// Graceful shutdown
const shutdown = async () => {
  app.log.info('Shutting down...');
  await app.close();
  await closeRedis();
  await closePool();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start
try {
  await app.listen({ port: PORT, host: HOST });
  startMetricsUpdater();
  startPriceUpdater();
  app.log.info(`QFC Explorer API listening on ${HOST}:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
