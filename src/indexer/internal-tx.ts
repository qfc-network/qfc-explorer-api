import { getPool } from '../db/pool.js';
import { RpcClient } from './rpc.js';
import type { TraceCall } from './types.js';
import type { BlockResult } from './block.js';
import { hexToBigIntString } from './utils.js';

type InternalTx = {
  txHash: string;
  traceIndex: number;
  callType: string;
  from: string;
  to: string;
  value: string;
  gas: string;
  gasUsed: string;
  input: string | null;
  output: string | null;
  error: string | null;
  depth: number;
};

/**
 * Flatten nested trace calls into a linear list of internal transactions.
 * Skips the root call (depth 0) since that's the external transaction itself.
 */
function flattenTrace(txHash: string, trace: TraceCall, depth = 0): InternalTx[] {
  const results: InternalTx[] = [];

  // Only include depth > 0 (internal calls, not the outer tx)
  if (depth > 0 && trace.to) {
    results.push({
      txHash,
      traceIndex: 0, // will be assigned later
      callType: trace.type,
      from: trace.from,
      to: trace.to,
      value: hexToBigIntString(trace.value ?? '0x0') ?? '0',
      gas: hexToBigIntString(trace.gas ?? '0x0') ?? '0',
      gasUsed: hexToBigIntString(trace.gasUsed ?? '0x0') ?? '0',
      input: trace.input && trace.input !== '0x' ? trace.input : null,
      output: trace.output && trace.output !== '0x' ? trace.output : null,
      error: trace.error ?? null,
      depth,
    });
  }

  if (trace.calls) {
    for (const child of trace.calls) {
      results.push(...flattenTrace(txHash, child, depth + 1));
    }
  }

  return results;
}

/**
 * Process internal transactions for a block using debug_traceTransaction.
 * Only traces transactions that have input data (contract interactions)
 * or create contracts (to is null).
 */
export async function processInternalTxs(rpc: RpcClient, result: BlockResult): Promise<void> {
  const { txs, height } = result;

  // Only trace contract interactions and contract creations
  const traceable = txs.filter((tx) =>
    (tx.input && tx.input !== '0x') || !tx.to
  );
  if (traceable.length === 0) return;

  const allInternals: InternalTx[] = [];

  // Trace transactions with concurrency limit
  const concurrency = 4;
  for (let i = 0; i < traceable.length; i += concurrency) {
    const batch = traceable.slice(i, i + concurrency);
    const traces = await Promise.all(
      batch.map(async (tx) => {
        try {
          const trace = await rpc.callWithRetry<TraceCall>(
            'debug_traceTransaction',
            [tx.hash, { tracer: 'callTracer', tracerConfig: { onlyTopCall: false } }]
          );
          return { txHash: tx.hash, trace };
        } catch {
          // debug_traceTransaction may not be available, skip silently
          return null;
        }
      })
    );

    for (const result of traces) {
      if (!result?.trace) continue;
      const internals = flattenTrace(result.txHash, result.trace);
      allInternals.push(...internals);
    }
  }

  if (allInternals.length === 0) return;

  // Assign sequential trace indices
  for (let i = 0; i < allInternals.length; i++) {
    allInternals[i].traceIndex = i;
  }

  // Bulk insert
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const values: string[] = [];
    const params: Array<string | number | null> = [];
    let idx = 1;

    for (const itx of allInternals) {
      values.push(
        `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`
      );
      params.push(
        itx.txHash, height.toString(10), itx.traceIndex, itx.callType,
        itx.depth, itx.from, itx.to, itx.value,
        itx.gas, itx.gasUsed, itx.input, itx.output, itx.error
      );
    }

    await client.query(
      `INSERT INTO internal_transactions (
         tx_hash, block_height, trace_index, call_type,
         depth, from_address, to_address, value,
         gas, gas_used, input, output, error
       ) VALUES ${values.join(',')}
       ON CONFLICT (tx_hash, trace_index) DO UPDATE SET
         block_height = EXCLUDED.block_height, call_type = EXCLUDED.call_type,
         depth = EXCLUDED.depth, from_address = EXCLUDED.from_address,
         to_address = EXCLUDED.to_address, value = EXCLUDED.value,
         gas = EXCLUDED.gas, gas_used = EXCLUDED.gas_used,
         input = EXCLUDED.input, output = EXCLUDED.output,
         error = EXCLUDED.error`,
      params
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
