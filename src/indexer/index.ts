import 'dotenv/config';
import { RpcClient } from './rpc.js';
import { parseHeight, processBlock } from './block.js';
import { processTokenTransfers } from './token.js';
import { processContracts } from './contract.js';
import { processInternalTxs } from './internal-tx.js';
import {
  getLastProcessedHeight, setLastProcessedHeight, setLastBatchStats,
  getFailedBlockHeight, recordFailedBlock, readAndClearIndexerKey,
  resolveFinalizedHeight, refreshDailyStats,
  INDEXER_ADMIN_RESCAN, INDEXER_ADMIN_RETRY,
} from './state.js';
import {
  startMetricsServer, stopMetricsServer,
  blocksProcessed, blocksSkipped, blockProcessDuration, pipelineStageDuration,
  txsProcessed, indexerHeight, chainHeight, indexerLag,
  batchDuration, batchSize,
} from './metrics.js';
import { WsSubscriber } from './ws-subscriber.js';

/* ------------------------------------------------------------------ */
/*  Dynamic batch size controller                                      */
/* ------------------------------------------------------------------ */

const BATCH_SIZE_MIN = 1;
const BATCH_SIZE_MAX = 50;
const SPEED_THRESHOLD_FAST = 10; // blocks/sec → increase batch size
const SPEED_THRESHOLD_SLOW = 2;  // blocks/sec → decrease batch size

class DynamicBatchSize {
  private current: number;

  constructor(initial: number) {
    this.current = Math.max(BATCH_SIZE_MIN, Math.min(BATCH_SIZE_MAX, initial));
  }

  get value(): number {
    return this.current;
  }

  /**
   * Adjust batch size based on observed processing speed.
   * Called after each batch completes.
   */
  adjust(blocksProcessed: number, durationMs: number): void {
    if (blocksProcessed === 0 || durationMs === 0) return;

    const blocksPerSec = blocksProcessed / (durationMs / 1000);
    const prev = this.current;

    if (blocksPerSec > SPEED_THRESHOLD_FAST) {
      // Processing is fast — increase batch size
      this.current = Math.min(BATCH_SIZE_MAX, Math.ceil(this.current * 1.5));
    } else if (blocksPerSec < SPEED_THRESHOLD_SLOW) {
      // Processing is slow — decrease batch size
      this.current = Math.max(BATCH_SIZE_MIN, Math.floor(this.current * 0.5));
    }

    if (this.current !== prev) {
      console.log(
        `[Batch] Size adjusted: ${prev} → ${this.current} (speed: ${blocksPerSec.toFixed(2)} blocks/sec)`
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Block indexing pipeline                                            */
/* ------------------------------------------------------------------ */

/**
 * Index a single block through the full pipeline:
 *   1. Block processor  — blocks, txs, accounts, events, balances
 *   2. Token processor  — ERC-20/721/1155 transfers, metadata, balances
 *   3. Contract processor — contract creation, code_hash, account upsert
 *   4. Internal tx processor — debug_traceTransaction → internal_transactions
 */
async function indexBlock(rpc: RpcClient, height: bigint): Promise<number> {
  const endBlock = blockProcessDuration.startTimer();

  // Step 1: Block + Transactions + Receipts + Events + Accounts
  const endStage1 = pipelineStageDuration.startTimer({ stage: 'block' });
  const result = await processBlock(rpc, height);
  endStage1();
  if (!result) { endBlock(); return 0; }

  // Step 2 & 3: Token + Contract (independent, run in parallel)
  const endStage2 = pipelineStageDuration.startTimer({ stage: 'token_contract' });
  await Promise.all([
    processTokenTransfers(rpc, result),
    processContracts(rpc, result),
  ]);
  endStage2();

  // Step 4: Internal transactions (requires trace API, may not be available)
  const endStage3 = pipelineStageDuration.startTimer({ stage: 'internal_tx' });
  await processInternalTxs(rpc, result).catch((e) =>
    console.warn(`Internal tx tracing failed for block ${height}:`, e.message)
  );
  endStage3();

  await setLastProcessedHeight(height);
  endBlock();

  // Update counters
  blocksProcessed.inc();
  txsProcessed.inc(result.txs.length);
  indexerHeight.set(Number(height));

  return result.txs.length;
}

async function indexBlockWithRetry(
  rpc: RpcClient, height: bigint, attempts: number, skipOnError: boolean
): Promise<number | null> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await indexBlock(rpc, height);
    } catch (error) {
      lastError = error;
      console.error(`Failed to index block ${height} (attempt ${attempt}/${attempts})`, error);
    }
  }

  if (skipOnError) {
    console.warn(`Skipping block ${height} after ${attempts} failed attempts`);
    await recordFailedBlock(height, lastError);
    blocksSkipped.inc();
    return null;
  }

  throw lastError instanceof Error ? lastError : new Error('Failed to index block');
}

async function runOnce(
  rpc: RpcClient,
  startHeight: bigint,
  useFinalized: boolean,
  blockRetries: number,
  skipOnError: boolean,
  dynamicBatch: DynamicBatchSize,
  maxHeight: bigint | null = null
): Promise<bigint> {
  const latestHex = await rpc.callWithRetry<string>('eth_blockNumber');
  const latest = parseHeight(latestHex);
  chainHeight.set(Number(latest));
  const target = useFinalized ? await resolveFinalizedHeight(rpc, latest) : latest;
  const effectiveTarget = maxHeight !== null && maxHeight < target ? maxHeight : target;

  if (startHeight > effectiveTarget) {
    console.log(`Indexer up to date at height ${effectiveTarget}`);
    return effectiveTarget;
  }

  // Limit how many blocks we process in this batch via dynamic batch size
  const batchLimit = BigInt(dynamicBatch.value);
  const batchEnd = startHeight + batchLimit - 1n < effectiveTarget
    ? startHeight + batchLimit - 1n
    : effectiveTarget;

  const startedAt = Date.now();
  const endBatch = batchDuration.startTimer();
  let totalTxs = 0;
  let totalReceipts = 0;
  let indexedBlocks = 0;
  let skippedBlocks = 0;

  console.log(`Indexing from ${startHeight} to ${batchEnd} (batch size: ${dynamicBatch.value}, chain head: ${effectiveTarget})`);
  for (let height = startHeight; height <= batchEnd; height += 1n) {
    console.log(`Indexing block ${height}`);
    const txCount = await indexBlockWithRetry(rpc, height, blockRetries, skipOnError);
    if (txCount === null && skipOnError) {
      skippedBlocks += 1;
      continue;
    }
    indexedBlocks += 1;
    const count = txCount ?? 0;
    totalTxs += count;
    totalReceipts += count;
  }

  endBatch();
  const durationMs = Date.now() - startedAt;
  batchSize.set(indexedBlocks);
  indexerLag.set(Number(latest) - Number(batchEnd));
  const tps = durationMs > 0 ? (totalTxs / (durationMs / 1000)).toFixed(2) : '0';
  console.log(
    `Batch stats: blocks=${indexedBlocks}, skipped=${skippedBlocks}, txs=${totalTxs}, receipts=${totalReceipts}, duration=${durationMs}ms, tps=${tps}`
  );

  // Adjust dynamic batch size based on processing speed
  dynamicBatch.adjust(indexedBlocks, durationMs);

  await setLastBatchStats({
    height: batchEnd,
    blocks: indexedBlocks,
    txs: totalTxs,
    receipts: totalReceipts,
    durationMs,
  });

  await refreshDailyStats().catch((e) =>
    console.warn('Failed to refresh daily stats:', e)
  );

  return batchEnd;
}

/* ------------------------------------------------------------------ */
/*  Main run loop                                                      */
/* ------------------------------------------------------------------ */

async function run(): Promise<void> {
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) {
    throw new Error('RPC_URL is not set');
  }

  const startHeightEnv = process.env.INDEXER_START_HEIGHT;
  const startHeight = startHeightEnv ? BigInt(startHeightEnv) : 0n;
  const endHeightEnv = process.env.INDEXER_END_HEIGHT;
  const endHeight = endHeightEnv ? BigInt(endHeightEnv) : null;
  const pollIntervalMs = process.env.INDEXER_POLL_INTERVAL_MS
    ? Number(process.env.INDEXER_POLL_INTERVAL_MS)
    : 10_000;
  const useFinalized = process.env.INDEXER_USE_FINALIZED !== 'false';
  const blockRetries = process.env.INDEXER_BLOCK_RETRIES
    ? Number(process.env.INDEXER_BLOCK_RETRIES)
    : 3;
  const skipOnError = process.env.INDEXER_SKIP_ON_ERROR === 'true';
  const retryFailed = process.env.INDEXER_RETRY_FAILED === 'true';

  const initialBatchSize = process.env.INDEXER_BATCH_SIZE
    ? Number(process.env.INDEXER_BATCH_SIZE)
    : 10;
  const dynamicBatch = new DynamicBatchSize(initialBatchSize);

  const metricsPort = process.env.INDEXER_METRICS_PORT
    ? Number(process.env.INDEXER_METRICS_PORT)
    : 9090;
  startMetricsServer(metricsPort);

  const archiveUrl = process.env.RPC_ARCHIVE_URL || undefined;
  const rpc = new RpcClient(rpcUrl, archiveUrl);

  // --- WebSocket newHeads subscription (optional) ---
  const wsUrl = process.env.INDEXER_WS_URL;
  let wsSubscriber: WsSubscriber | null = null;
  if (wsUrl) {
    console.log(`[WS] Enabling WebSocket newHeads subscription: ${wsUrl}`);
    wsSubscriber = new WsSubscriber(wsUrl);
    wsSubscriber.start();
  } else {
    console.log('[WS] No INDEXER_WS_URL set — using polling only');
  }

  const lastProcessed = await getLastProcessedHeight();
  let current = lastProcessed !== null ? lastProcessed + 1n : startHeight;

  const applyAdminCommands = async () => {
    const rescan = await readAndClearIndexerKey(INDEXER_ADMIN_RESCAN);
    if (rescan) {
      try {
        current = BigInt(rescan);
        console.log(`Admin rescan requested from height ${current}`);
      } catch {
        console.warn(`Invalid admin rescan height: ${rescan}`);
      }
    }

    const retry = await readAndClearIndexerKey(INDEXER_ADMIN_RETRY);
    if (retry) {
      const failed = await getFailedBlockHeight();
      if (failed !== null) {
        console.log(`Admin retry failed block ${failed}`);
        await indexBlockWithRetry(rpc, failed, blockRetries, false);
      }
    }
  };

  await applyAdminCommands();

  if (retryFailed) {
    const failed = await getFailedBlockHeight();
    if (failed !== null) {
      console.log(`Retrying failed block ${failed}`);
      await indexBlockWithRetry(rpc, failed, blockRetries, false);
    }
  }

  // One-shot mode: index up to endHeight and exit
  if (endHeight !== null) {
    // In one-shot mode, process all blocks up to endHeight without dynamic batching
    let pos = current;
    while (pos <= endHeight) {
      const reached = await runOnce(rpc, pos, useFinalized, blockRetries, skipOnError, dynamicBatch, endHeight);
      pos = reached + 1n;
      if (reached >= endHeight) break;
    }
    wsSubscriber?.stop();
    return;
  }

  // Initial catch-up: process all pending blocks in batches
  let catching = true;
  while (catching) {
    const last = await getLastProcessedHeight();
    current = last !== null ? last + 1n : startHeight;
    const reached = await runOnce(rpc, current, useFinalized, blockRetries, skipOnError, dynamicBatch);
    // If we processed fewer blocks than the batch size, we've caught up
    const processed = Number(reached - current) + 1;
    if (reached >= current && processed < dynamicBatch.value) {
      catching = false;
    }
    // Check if we're already at the tip
    if (reached <= current) {
      catching = false;
    }
  }

  // Continuous mode: poll or wait for WS notifications
  while (pollIntervalMs > 0) {
    if (wsSubscriber) {
      // Wait for a new head notification or fall back to polling interval
      const gotNewHead = await wsSubscriber.waitForNewHead(pollIntervalMs);
      if (gotNewHead) {
        console.log('[WS] New head received, processing immediately');
      }
      // Whether we got a WS notification or timed out, check for new blocks
    } else {
      // Pure polling mode
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    const last = await getLastProcessedHeight();
    current = last !== null ? last + 1n : startHeight;
    await applyAdminCommands();
    await runOnce(rpc, current, useFinalized, blockRetries, skipOnError, dynamicBatch);
  }

  wsSubscriber?.stop();
}

run().catch((error) => {
  console.error('Indexer failed:', error);
  stopMetricsServer();
  process.exit(1);
});
