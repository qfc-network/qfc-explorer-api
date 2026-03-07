import { createServer, type Server } from 'node:http';
import client from 'prom-client';

const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'qfc_indexer_' });

// --- Block processing ---

export const blocksProcessed = new client.Counter({
  name: 'qfc_indexer_blocks_processed_total',
  help: 'Total blocks processed by the indexer',
  registers: [register],
});

export const blocksSkipped = new client.Counter({
  name: 'qfc_indexer_blocks_skipped_total',
  help: 'Total blocks skipped due to errors',
  registers: [register],
});

export const blockProcessDuration = new client.Histogram({
  name: 'qfc_indexer_block_process_duration_seconds',
  help: 'Time to process a single block through the full pipeline',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [register],
});

export const pipelineStageDuration = new client.Histogram({
  name: 'qfc_indexer_pipeline_stage_duration_seconds',
  help: 'Duration of each pipeline stage',
  labelNames: ['stage'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [register],
});

export const txsProcessed = new client.Counter({
  name: 'qfc_indexer_txs_processed_total',
  help: 'Total transactions processed',
  registers: [register],
});

// --- Height & lag ---

export const indexerHeight = new client.Gauge({
  name: 'qfc_indexer_current_height',
  help: 'Current indexer block height',
  registers: [register],
});

export const chainHeight = new client.Gauge({
  name: 'qfc_indexer_chain_height',
  help: 'Latest chain height from RPC',
  registers: [register],
});

export const indexerLag = new client.Gauge({
  name: 'qfc_indexer_lag_blocks',
  help: 'Blocks behind chain head',
  registers: [register],
});

// --- RPC ---

export const rpcCallDuration = new client.Histogram({
  name: 'qfc_indexer_rpc_duration_seconds',
  help: 'RPC call duration by method',
  labelNames: ['method', 'node'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [register],
});

export const rpcCallErrors = new client.Counter({
  name: 'qfc_indexer_rpc_errors_total',
  help: 'Total RPC call errors by method and node',
  labelNames: ['method', 'node'] as const,
  registers: [register],
});

// --- Pipeline counters ---

export const tokenTransfersProcessed = new client.Counter({
  name: 'qfc_indexer_token_transfers_total',
  help: 'Total token transfers detected',
  registers: [register],
});

export const contractsDetected = new client.Counter({
  name: 'qfc_indexer_contracts_detected_total',
  help: 'Total contract creations detected',
  registers: [register],
});

export const internalTxsProcessed = new client.Counter({
  name: 'qfc_indexer_internal_txs_total',
  help: 'Total internal transactions traced',
  registers: [register],
});

// --- Batch ---

export const batchDuration = new client.Histogram({
  name: 'qfc_indexer_batch_duration_seconds',
  help: 'Duration of a full indexing batch',
  buckets: [1, 5, 10, 30, 60, 120, 300],
  registers: [register],
});

export const batchSize = new client.Gauge({
  name: 'qfc_indexer_batch_size_blocks',
  help: 'Number of blocks in the last batch',
  registers: [register],
});

// --- Metrics HTTP server ---

let server: Server | null = null;

export function startMetricsServer(port = 9090): void {
  server = createServer(async (req, res) => {
    if (req.url === '/metrics') {
      try {
        const metrics = await register.metrics();
        res.writeHead(200, { 'Content-Type': register.contentType });
        res.end(metrics);
      } catch {
        res.writeHead(500);
        res.end('Error collecting metrics');
      }
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`Indexer metrics server listening on :${port}/metrics`);
  });
}

export function stopMetricsServer(): void {
  if (server) {
    server.close();
    server = null;
  }
}
