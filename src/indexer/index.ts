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

/**
 * Index a single block through the full pipeline:
 *   1. Block processor  — blocks, txs, accounts, events, balances
 *   2. Token processor  — ERC-20/721/1155 transfers, metadata, balances
 *   3. Contract processor — contract creation, code_hash, account upsert
 *   4. Internal tx processor — debug_traceTransaction → internal_transactions
 */
async function indexBlock(rpc: RpcClient, height: bigint): Promise<number> {
  // Step 1: Block + Transactions + Receipts + Events + Accounts
  const result = await processBlock(rpc, height);
  if (!result) return 0;

  // Step 2 & 3: Token + Contract (independent, run in parallel)
  await Promise.all([
    processTokenTransfers(rpc, result),
    processContracts(rpc, result),
  ]);

  // Step 4: Internal transactions (requires trace API, may not be available)
  await processInternalTxs(rpc, result).catch((e) =>
    console.warn(`Internal tx tracing failed for block ${height}:`, e.message)
  );

  await setLastProcessedHeight(height);
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
  maxHeight: bigint | null = null
): Promise<bigint> {
  const latestHex = await rpc.callWithRetry<string>('eth_blockNumber');
  const latest = parseHeight(latestHex);
  const target = useFinalized ? await resolveFinalizedHeight(rpc, latest) : latest;
  const effectiveTarget = maxHeight !== null && maxHeight < target ? maxHeight : target;
  const startedAt = Date.now();
  let totalTxs = 0;
  let totalReceipts = 0;
  let indexedBlocks = 0;
  let skippedBlocks = 0;

  if (startHeight > effectiveTarget) {
    console.log(`Indexer up to date at height ${effectiveTarget}`);
    return effectiveTarget;
  }

  console.log(`Indexing from ${startHeight} to ${effectiveTarget}`);
  for (let height = startHeight; height <= effectiveTarget; height += 1n) {
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

  console.log('Indexing complete');
  const durationMs = Date.now() - startedAt;
  const tps = durationMs > 0 ? (totalTxs / (durationMs / 1000)).toFixed(2) : '0';
  console.log(
    `Batch stats: blocks=${indexedBlocks}, skipped=${skippedBlocks}, txs=${totalTxs}, receipts=${totalReceipts}, duration=${durationMs}ms, tps=${tps}`
  );
  await setLastBatchStats({
    height: effectiveTarget,
    blocks: indexedBlocks,
    txs: totalTxs,
    receipts: totalReceipts,
    durationMs,
  });

  await refreshDailyStats().catch((e) =>
    console.warn('Failed to refresh daily stats:', e)
  );

  return effectiveTarget;
}

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

  const rpc = new RpcClient(rpcUrl);

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

  if (endHeight !== null) {
    await runOnce(rpc, current, useFinalized, blockRetries, skipOnError, endHeight);
    return;
  }

  await runOnce(rpc, current, useFinalized, blockRetries, skipOnError);

  // Continuous polling mode
  while (pollIntervalMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    const last = await getLastProcessedHeight();
    current = last !== null ? last + 1n : startHeight;
    await applyAdminCommands();
    await runOnce(rpc, current, useFinalized, blockRetries, skipOnError);
  }
}

run().catch((error) => {
  console.error('Indexer failed:', error);
  process.exit(1);
});
