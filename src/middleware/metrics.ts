import { FastifyInstance } from 'fastify';
import client from 'prom-client';

const register = new client.Registry();

// Collect default Node.js metrics (GC, event loop, memory)
client.collectDefaultMetrics({ register });

const httpDuration = new client.Histogram({
  name: 'qfc_api_request_duration_seconds',
  help: 'API request duration in seconds',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [register],
});

const httpRequests = new client.Counter({
  name: 'qfc_api_requests_total',
  help: 'Total API requests',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [register],
});

const httpErrors = new client.Counter({
  name: 'qfc_api_errors_total',
  help: 'Total API errors (4xx + 5xx)',
  labelNames: ['route', 'status'] as const,
  registers: [register],
});

// Custom gauges for blockchain metrics
export const indexerLagGauge = new client.Gauge({
  name: 'qfc_indexer_lag_blocks',
  help: 'Blocks behind RPC head',
  registers: [register],
});

export const indexerHeightGauge = new client.Gauge({
  name: 'qfc_indexer_height',
  help: 'Last indexed block height',
  registers: [register],
});

export const rpcHeightGauge = new client.Gauge({
  name: 'qfc_rpc_height',
  help: 'Current RPC block height',
  registers: [register],
});

export const totalBlocksGauge = new client.Gauge({
  name: 'qfc_total_blocks',
  help: 'Total indexed blocks',
  registers: [register],
});

export const totalTransactionsGauge = new client.Gauge({
  name: 'qfc_total_transactions',
  help: 'Total indexed transactions',
  registers: [register],
});

export const totalAccountsGauge = new client.Gauge({
  name: 'qfc_total_accounts',
  help: 'Total known accounts',
  registers: [register],
});

export const dbHealthGauge = new client.Gauge({
  name: 'qfc_db_healthy',
  help: 'Database connectivity (1=ok, 0=down)',
  registers: [register],
});

export const rpcHealthGauge = new client.Gauge({
  name: 'qfc_rpc_healthy',
  help: 'RPC node connectivity (1=ok, 0=down)',
  registers: [register],
});

export async function registerMetrics(app: FastifyInstance): Promise<void> {
  // Request timing hook
  app.addHook('onResponse', (request, reply, done) => {
    const route = request.routeOptions?.url || request.url;
    const status = String(reply.statusCode);
    const method = request.method;

    // Skip /metrics itself to avoid feedback loop
    if (route === '/metrics') {
      done();
      return;
    }

    const elapsed = reply.elapsedTime / 1000; // ms → seconds
    httpDuration.labels(method, route, status).observe(elapsed);
    httpRequests.labels(method, route, status).inc();

    if (reply.statusCode >= 400) {
      httpErrors.labels(route, status).inc();
    }
    done();
  });

  // Metrics endpoint
  app.get('/metrics', async (_request, reply) => {
    reply.type(register.contentType);
    return register.metrics();
  });
}

export { register };
