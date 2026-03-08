import pg from 'pg';

const { Pool } = pg;

/** Threshold in milliseconds — queries slower than this get logged. */
const SLOW_QUERY_THRESHOLD_MS = 500;

/**
 * PostgreSQL connection pool with read/write split.
 *
 * Environment variables:
 *   DATABASE_URL          — primary (read-write) connection string (required)
 *   DATABASE_REPLICA_URL  — read replica connection string (optional)
 *
 * When DATABASE_REPLICA_URL is set:
 *   - getPool()       → primary (for writes, or when no replica)
 *   - getReadPool()   → replica (for read-only queries from API routes)
 *
 * When not set, getReadPool() returns the primary pool (single-node mode).
 */

let writePool: pg.Pool | null = null;
let readPool: pg.Pool | null = null;

/** Primary pool — used by indexer (writes) and API routes that need writes. */
export function getPool(): pg.Pool {
  if (!writePool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }
    writePool = new Pool({
      connectionString,
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return writePool;
}

/** Read replica pool — used by API routes for read-only queries. */
export function getReadPool(): pg.Pool {
  if (!readPool) {
    const replicaUrl = process.env.DATABASE_REPLICA_URL;
    if (replicaUrl) {
      readPool = new Pool({
        connectionString: replicaUrl,
        max: 30,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
      });
    } else {
      // No replica configured — fall back to primary
      readPool = getPool();
    }
  }
  return readPool;
}

export async function closePool(): Promise<void> {
  // Close read pool first (if it's a separate pool)
  if (readPool && readPool !== writePool) {
    await readPool.end();
  }
  readPool = null;

  if (writePool) {
    await writePool.end();
    writePool = null;
  }
}

/** Get info about configured pools (for health/admin). */
export function getPoolConfig() {
  return {
    hasReplica: !!process.env.DATABASE_REPLICA_URL,
    writePoolSize: writePool?.totalCount ?? 0,
    readPoolSize: readPool?.totalCount ?? 0,
  };
}

/* ------------------------------------------------------------------ */
/*  Slow query monitoring                                              */
/* ------------------------------------------------------------------ */

/**
 * Execute a query with timing. Logs a warning for queries exceeding
 * SLOW_QUERY_THRESHOLD_MS (default 500ms).
 *
 * Drop-in replacement for `pool.query(...)` — accepts the same arguments.
 *
 * Usage:
 *   import { timedQuery, getPool } from '../db/pool.js';
 *   const result = await timedQuery(getPool(), 'SELECT ...', [params]);
 */
export async function timedQuery<T extends pg.QueryResultRow = any>(
  pool: pg.Pool,
  textOrConfig: string | pg.QueryConfig,
  values?: unknown[],
): Promise<pg.QueryResult<T>> {
  const start = performance.now();
  try {
    const result = values !== undefined
      ? await pool.query<T>(textOrConfig as string, values as any[])
      : await pool.query<T>(textOrConfig);
    return result;
  } finally {
    const durationMs = performance.now() - start;
    if (durationMs >= SLOW_QUERY_THRESHOLD_MS) {
      const queryText = typeof textOrConfig === 'string'
        ? textOrConfig
        : textOrConfig.text;
      // Truncate very long query text for readability
      const truncated = queryText.length > 200
        ? queryText.slice(0, 200) + '...'
        : queryText;
      console.warn(
        `[Slow Query] ${durationMs.toFixed(1)}ms — ${truncated}`
      );
    }
  }
}
