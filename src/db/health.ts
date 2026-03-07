import { getPool } from './pool.js';
import { rpcCall } from '../lib/rpc.js';

export async function checkDatabaseHealth(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    const pool = getPool();
    await pool.query('SELECT 1');
    return { ok: true, latencyMs: Date.now() - start };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - start, error: error instanceof Error ? error.message : 'unknown error' };
  }
}

export async function checkRpcHealth(): Promise<{ ok: boolean; latencyMs: number; blockNumber?: string; error?: string }> {
  const start = Date.now();
  try {
    const result = await rpcCall<string>('eth_blockNumber', []);
    const blockNumber = result ? parseInt(result, 16).toString() : undefined;
    return { ok: true, latencyMs: Date.now() - start, blockNumber };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - start, error: error instanceof Error ? error.message : 'unknown error' };
  }
}

export async function checkIndexerLag(): Promise<{ ok: boolean; indexedHeight: string | null; rpcHeight: string | null; lag: number | null; error?: string }> {
  try {
    const pool = getPool();
    const indexerResult = await pool.query(
      `SELECT value FROM indexer_state WHERE key = 'last_processed_height' LIMIT 1`
    );
    const indexedHeight = indexerResult.rows[0]?.value ?? null;

    const rpcResult = await rpcCall<string>('eth_blockNumber', []);
    const rpcHeight = rpcResult ? parseInt(rpcResult, 16).toString() : null;

    const lag = indexedHeight && rpcHeight
      ? Number(rpcHeight) - Number(indexedHeight)
      : null;

    return {
      ok: lag !== null && lag < 100,
      indexedHeight,
      rpcHeight,
      lag,
    };
  } catch (error) {
    return {
      ok: false,
      indexedHeight: null,
      rpcHeight: null,
      lag: null,
      error: error instanceof Error ? error.message : 'unknown error',
    };
  }
}
