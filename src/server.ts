import Fastify from 'fastify';
import cors from '@fastify/cors';
import { registerMetrics } from './middleware/metrics.js';
import { closePool } from './db/pool.js';
import { startMetricsUpdater } from './middleware/metrics-updater.js';

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
import adminRoutes from './routes/admin.js';
import healthRoutes from './routes/health.js';
import toolsRoutes from './routes/tools.js';

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

// CORS — allow explorer frontend
await app.register(cors, {
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST'],
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
await app.register(adminRoutes, { prefix: '/admin' });
await app.register(healthRoutes);
await app.register(toolsRoutes, { prefix: '/tools' });

// Graceful shutdown
const shutdown = async () => {
  app.log.info('Shutting down...');
  await app.close();
  await closePool();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start
try {
  await app.listen({ port: PORT, host: HOST });
  startMetricsUpdater();
  app.log.info(`QFC Explorer API listening on ${HOST}:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
