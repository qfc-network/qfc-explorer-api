import { getPool } from '../db/pool.js';
import { RpcClient } from './rpc.js';
import { hexToBigIntString } from './utils.js';

const INDEXER_STATE_KEY = 'last_processed_height';
const INDEXER_STATS_KEY = 'last_batch_stats';
const INDEXER_FAILED_KEY = 'failed_blocks';
export const INDEXER_ADMIN_RESCAN = 'admin_rescan_from';
export const INDEXER_ADMIN_RETRY = 'admin_retry_failed';

function parseHeight(hexValue: string): bigint {
  const parsed = hexToBigIntString(hexValue);
  if (!parsed) {
    throw new Error(`Invalid hex height: ${hexValue}`);
  }
  return BigInt(parsed);
}

export async function getLastProcessedHeight(): Promise<bigint | null> {
  const pool = getPool();
  const result = await pool.query(
    'SELECT value FROM indexer_state WHERE key = $1',
    [INDEXER_STATE_KEY]
  );
  if (result.rowCount === 0) return null;
  try {
    return BigInt(result.rows[0].value);
  } catch {
    return null;
  }
}

export async function setLastProcessedHeight(height: bigint): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO indexer_state (key, value)
     VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [INDEXER_STATE_KEY, height.toString(10)]
  );
}

export async function setLastBatchStats(stats: {
  height: bigint;
  blocks: number;
  txs: number;
  receipts: number;
  durationMs: number;
}): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO indexer_state (key, value)
     VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [
      INDEXER_STATS_KEY,
      JSON.stringify({
        height: stats.height.toString(10),
        blocks: stats.blocks,
        txs: stats.txs,
        receipts: stats.receipts,
        durationMs: stats.durationMs,
      }),
    ]
  );
}

export async function getFailedBlockHeight(): Promise<bigint | null> {
  const pool = getPool();
  const result = await pool.query(
    'SELECT value FROM indexer_state WHERE key = $1',
    [INDEXER_FAILED_KEY]
  );
  if (result.rowCount === 0) return null;
  try {
    const data = JSON.parse(result.rows[0].value);
    return data?.height ? BigInt(data.height) : null;
  } catch {
    return null;
  }
}

export async function recordFailedBlock(height: bigint, error: unknown): Promise<void> {
  const pool = getPool();
  const message = error instanceof Error ? error.message : String(error);
  await pool.query(
    `INSERT INTO indexer_state (key, value)
     VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [
      INDEXER_FAILED_KEY,
      JSON.stringify({
        height: height.toString(10),
        error: message,
        at: new Date().toISOString(),
      }),
    ]
  );
}

export async function readAndClearIndexerKey(key: string): Promise<string | null> {
  const pool = getPool();
  const result = await pool.query('SELECT value FROM indexer_state WHERE key = $1', [key]);
  if (result.rowCount === 0) return null;
  const value = result.rows[0].value as string;
  await pool.query('DELETE FROM indexer_state WHERE key = $1', [key]);
  return value;
}

export async function resolveFinalizedHeight(client: RpcClient, latest: bigint): Promise<bigint> {
  try {
    const finalizedHex = await client.callWithRetry<string>('qfc_getFinalizedBlock');
    const finalized = parseHeight(finalizedHex);
    return finalized <= latest ? finalized : latest;
  } catch (error) {
    console.warn('Failed to fetch finalized block, falling back to latest', error);
    return latest;
  }
}

export async function refreshDailyStats(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    INSERT INTO daily_stats (date, tx_count, block_count, total_gas_used, avg_block_time_ms, active_addresses, avg_gas_price, new_contracts)
    SELECT
      (TO_TIMESTAMP(timestamp_ms / 1000.0) AT TIME ZONE 'UTC')::date AS date,
      COALESCE(SUM(tx_count), 0),
      COUNT(*)::int,
      COALESCE(SUM(gas_used::numeric), 0),
      CASE WHEN COUNT(*) > 1 THEN (MAX(timestamp_ms) - MIN(timestamp_ms))::numeric / NULLIF(COUNT(*) - 1, 0) ELSE 0 END,
      0, 0, 0
    FROM blocks
    WHERE height > 0
      AND (TO_TIMESTAMP(timestamp_ms / 1000.0) AT TIME ZONE 'UTC')::date = CURRENT_DATE
    GROUP BY (TO_TIMESTAMP(timestamp_ms / 1000.0) AT TIME ZONE 'UTC')::date
    ON CONFLICT (date) DO UPDATE SET
      tx_count = EXCLUDED.tx_count,
      block_count = EXCLUDED.block_count,
      total_gas_used = EXCLUDED.total_gas_used,
      avg_block_time_ms = EXCLUDED.avg_block_time_ms
  `);

  await pool.query(`
    UPDATE daily_stats SET active_addresses = sub.cnt
    FROM (
      SELECT COUNT(DISTINCT addr)::int AS cnt
      FROM transactions t
      JOIN blocks b ON b.height = t.block_height
      CROSS JOIN LATERAL (VALUES (t.from_address), (t.to_address)) v(addr)
      WHERE addr IS NOT NULL
        AND (TO_TIMESTAMP(b.timestamp_ms / 1000.0) AT TIME ZONE 'UTC')::date = CURRENT_DATE
    ) sub
    WHERE date = CURRENT_DATE
  `);

  await pool.query(`
    UPDATE daily_stats SET avg_gas_price = sub.avg_gp
    FROM (
      SELECT AVG(t.gas_price::numeric) AS avg_gp
      FROM transactions t
      JOIN blocks b ON b.height = t.block_height
      WHERE (TO_TIMESTAMP(b.timestamp_ms / 1000.0) AT TIME ZONE 'UTC')::date = CURRENT_DATE
    ) sub
    WHERE date = CURRENT_DATE AND sub.avg_gp IS NOT NULL
  `);

  await pool.query(`
    UPDATE daily_stats SET new_contracts = sub.cnt
    FROM (
      SELECT COUNT(*)::int AS cnt
      FROM contracts c
      JOIN blocks b ON b.height = c.created_at_block
      WHERE (TO_TIMESTAMP(b.timestamp_ms / 1000.0) AT TIME ZONE 'UTC')::date = CURRENT_DATE
    ) sub
    WHERE date = CURRENT_DATE
  `);
}
