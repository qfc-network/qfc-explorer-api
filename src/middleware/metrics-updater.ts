import { checkDatabaseHealth, checkRpcHealth, checkIndexerLag } from '../db/health.js';
import { getReadPool } from '../db/pool.js';
import {
  indexerLagGauge, indexerHeightGauge, rpcHeightGauge,
  totalBlocksGauge, totalTransactionsGauge, totalAccountsGauge,
  dbHealthGauge, rpcHealthGauge,
} from './metrics.js';

async function updateMetrics() {
  try {
    const [db, rpc, indexer] = await Promise.all([
      checkDatabaseHealth(),
      checkRpcHealth(),
      checkIndexerLag(),
    ]);

    dbHealthGauge.set(db.ok ? 1 : 0);
    rpcHealthGauge.set(rpc.ok ? 1 : 0);

    if (indexer.lag !== null) indexerLagGauge.set(indexer.lag);
    if (indexer.indexedHeight) indexerHeightGauge.set(Number(indexer.indexedHeight));
    if (indexer.rpcHeight) rpcHeightGauge.set(Number(indexer.rpcHeight));

    // DB counts
    const pool = getReadPool();
    const [blocks, txs, accounts] = await Promise.all([
      pool.query('SELECT COUNT(*) AS c FROM blocks'),
      pool.query('SELECT COUNT(*) AS c FROM transactions'),
      pool.query('SELECT COUNT(*) AS c FROM accounts'),
    ]);
    totalBlocksGauge.set(Number(blocks.rows[0].c));
    totalTransactionsGauge.set(Number(txs.rows[0].c));
    totalAccountsGauge.set(Number(accounts.rows[0].c));
  } catch {
    // Metrics update failure should not crash the server
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startMetricsUpdater(intervalMs = 15000) {
  updateMetrics(); // Initial update
  timer = setInterval(updateMetrics, intervalMs);
}

export function stopMetricsUpdater() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
