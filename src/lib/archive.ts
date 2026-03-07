/**
 * Data archival service — moves old partitions from hot tables to archive schema.
 *
 * Strategy:
 *   1. Copy rows from a partition into archive.* tables
 *   2. Record the operation in archive.archive_log
 *   3. Truncate the source partition (data still queryable from archive schema)
 *
 * The query layer falls back to archive.* when data is not found in hot tables.
 */

import { getPool, getReadPool } from '../db/pool.js';

const PARTITIONED_TABLES = [
  'transactions',
  'events',
  'token_transfers',
  'internal_transactions',
] as const;

type ArchiveResult = {
  table: string;
  partition: string;
  rowCount: number;
  minHeight: number;
  maxHeight: number;
};

/**
 * Archive a specific height range by copying data to archive schema
 * and truncating the source partition.
 */
export async function archivePartition(
  table: typeof PARTITIONED_TABLES[number],
  partitionName: string,
  minHeight: number,
  maxHeight: number,
): Promise<ArchiveResult> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Copy data to archive table
    const copyResult = await client.query(
      `INSERT INTO archive.${table}
       SELECT * FROM ${table}
       WHERE block_height >= $1 AND block_height < $2
       ON CONFLICT DO NOTHING`,
      [minHeight, maxHeight]
    );
    const rowCount = copyResult.rowCount ?? 0;

    // Log the archive operation
    await client.query(
      `INSERT INTO archive.archive_log (table_name, partition_name, min_height, max_height, row_count)
       VALUES ($1, $2, $3, $4, $5)`,
      [table, partitionName, minHeight, maxHeight, rowCount]
    );

    // Truncate the partition (keep structure for future re-use if needed)
    await client.query(`DELETE FROM ${table} WHERE block_height >= $1 AND block_height < $2`, [minHeight, maxHeight]);

    await client.query('COMMIT');

    return { table, partition: partitionName, rowCount, minHeight, maxHeight };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Archive all partitions below the given threshold height.
 * Partitions are 1M blocks each: p0=[0,1M), p1=[1M,2M), etc.
 */
export async function archiveBelow(thresholdHeight: number): Promise<ArchiveResult[]> {
  const results: ArchiveResult[] = [];
  const partitionSize = 1_000_000;

  // Determine which partitions are fully below threshold
  const maxPartitionIndex = Math.floor(thresholdHeight / partitionSize);

  for (let i = 0; i < maxPartitionIndex; i++) {
    const minHeight = i * partitionSize;
    const maxHeight = (i + 1) * partitionSize;

    for (const table of PARTITIONED_TABLES) {
      // Check if already archived
      const pool = getReadPool();
      const existing = await pool.query(
        `SELECT id FROM archive.archive_log
         WHERE table_name = $1 AND min_height = $2 AND max_height = $3 LIMIT 1`,
        [table, minHeight, maxHeight]
      );
      if (existing.rows.length > 0) continue;

      // Check if partition has data
      const countResult = await pool.query(
        `SELECT COUNT(*) AS c FROM ${table} WHERE block_height >= $1 AND block_height < $2`,
        [minHeight, maxHeight]
      );
      if (Number(countResult.rows[0].c) === 0) continue;

      const partitionName = `${table}_p${i}`;
      const result = await archivePartition(table, partitionName, minHeight, maxHeight);
      results.push(result);
    }
  }

  // Update threshold in indexer_state
  const pool = getPool();
  await pool.query(
    `INSERT INTO indexer_state (key, value, updated_at) VALUES ('archive_threshold_height', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [String(thresholdHeight)]
  );

  return results;
}

/** Get archive status and log */
export async function getArchiveStatus() {
  const pool = getReadPool();

  const [log, threshold, stats] = await Promise.all([
    pool.query(
      `SELECT table_name, partition_name, min_height, max_height, row_count, archived_at
       FROM archive.archive_log ORDER BY archived_at DESC LIMIT 50`
    ),
    pool.query(
      `SELECT value FROM indexer_state WHERE key = 'archive_threshold_height' LIMIT 1`
    ),
    pool.query(
      `SELECT table_name, COUNT(*) AS partitions, SUM(row_count) AS total_rows
       FROM archive.archive_log GROUP BY table_name`
    ),
  ]);

  return {
    threshold: threshold.rows[0]?.value ?? '0',
    tables: stats.rows,
    recentOperations: log.rows,
  };
}

/** Query archive tables for old data (fallback) */
export async function queryArchiveTransactionByHash(hash: string) {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT * FROM archive.transactions WHERE hash = $1 LIMIT 1`,
    [hash]
  );
  return result.rows[0] || null;
}

export async function queryArchiveEventsByTxHash(txHash: string) {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT * FROM archive.events WHERE tx_hash = $1 ORDER BY log_index ASC`,
    [txHash]
  );
  return result.rows;
}

export async function queryArchiveInternalTxsByTxHash(txHash: string) {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT tx_hash, block_height, trace_index, call_type, depth,
            from_address, to_address, value, gas, gas_used, error
     FROM archive.internal_transactions WHERE tx_hash = $1
     ORDER BY trace_index ASC`,
    [txHash]
  );
  return result.rows;
}
