import { getPool } from '../db/pool.js';
import type { PoolClient } from 'pg';
import { RpcClient } from './rpc.js';
import type { RpcBlock, RpcReceipt, RpcTransaction } from './types.js';
import { hexToBigIntString, hexToBuffer } from './utils.js';

function isHistoricalStateError(error: unknown): boolean {
  return error instanceof Error
    && /Storage error|state|archive|histor/i.test(error.message);
}

export function parseHeight(hexValue: string): bigint {
  const parsed = hexToBigIntString(hexValue);
  if (!parsed) {
    throw new Error(`Invalid hex height: ${hexValue}`);
  }
  return BigInt(parsed);
}

/** Result passed to downstream processors (token, contract, internal-tx). */
export type BlockResult = {
  block: RpcBlock;
  height: bigint;
  blockHex: string;
  txs: RpcTransaction[];
  receipts: RpcReceipt[];
  addressSet: Set<string>;
};

async function upsertBlock(client: PoolClient, block: RpcBlock): Promise<void> {
  const height = parseHeight(block.number);
  await client.query(
    `INSERT INTO blocks (
       hash, height, parent_hash, state_root, transactions_root, receipts_root,
       producer, timestamp_ms, gas_limit, gas_used, extra_data, tx_count
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (hash) DO UPDATE SET
       height = EXCLUDED.height, parent_hash = EXCLUDED.parent_hash,
       state_root = EXCLUDED.state_root, transactions_root = EXCLUDED.transactions_root,
       receipts_root = EXCLUDED.receipts_root, producer = EXCLUDED.producer,
       timestamp_ms = EXCLUDED.timestamp_ms, gas_limit = EXCLUDED.gas_limit,
       gas_used = EXCLUDED.gas_used, extra_data = EXCLUDED.extra_data,
       tx_count = EXCLUDED.tx_count`,
    // blocks table is NOT partitioned — PK remains (hash)
    [
      block.hash, height.toString(10), block.parentHash, block.stateRoot,
      block.transactionsRoot, block.receiptsRoot, block.miner?.toLowerCase() ?? null,
      parseHeight(block.timestamp).toString(10),
      parseHeight(block.gasLimit).toString(10),
      parseHeight(block.gasUsed).toString(10),
      hexToBuffer(block.extraData),
      block.transactions?.length ?? block.transactionHashes?.length ?? 0,
    ]
  );
}

async function bulkUpsertTransactions(
  client: PoolClient, txs: RpcTransaction[], blockHash: string, blockHeight: bigint
): Promise<void> {
  if (txs.length === 0) return;

  const values: string[] = [];
  const params: Array<string | number | Buffer | null> = [];
  let idx = 1;

  for (let i = 0; i < txs.length; i += 1) {
    const tx = txs[i];
    values.push(
      `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`
    );
    params.push(
      tx.hash, blockHash, blockHeight.toString(10), i, 'unknown',
      tx.from?.toLowerCase() ?? null, tx.to?.toLowerCase() ?? null, hexToBigIntString(tx.value) ?? '0',
      parseHeight(tx.nonce).toString(10), parseHeight(tx.gas).toString(10),
      hexToBigIntString(tx.gasPrice) ?? '0', 'unknown', hexToBuffer(tx.input)
    );
  }

  await client.query(
    `INSERT INTO transactions (
       hash, block_hash, block_height, tx_index, type,
       from_address, to_address, value, nonce, gas_limit, gas_price, status, input_data
     ) VALUES ${values.join(',')}
     ON CONFLICT (hash, block_height) DO UPDATE SET
       block_hash = EXCLUDED.block_hash,
       tx_index = EXCLUDED.tx_index, from_address = EXCLUDED.from_address,
       to_address = EXCLUDED.to_address, value = EXCLUDED.value,
       nonce = EXCLUDED.nonce, gas_limit = EXCLUDED.gas_limit,
       gas_price = EXCLUDED.gas_price, status = EXCLUDED.status,
       input_data = EXCLUDED.input_data`,
    params
  );
}

async function upsertAccounts(client: PoolClient, addresses: string[], blockHeight: bigint): Promise<void> {
  if (addresses.length === 0) return;

  const values: string[] = [];
  const params: Array<string> = [];
  let idx = 1;
  for (const address of addresses) {
    values.push(`($${idx++}, $${idx++}, $${idx++})`);
    params.push(address, blockHeight.toString(10), blockHeight.toString(10));
  }

  await client.query(
    `INSERT INTO accounts (address, first_seen_block, last_seen_block)
     VALUES ${values.join(',')}
     ON CONFLICT (address) DO UPDATE SET
       last_seen_block = EXCLUDED.last_seen_block, updated_at = NOW()`,
    params
  );
}

export async function refreshAccountState(
  client: PoolClient, rpc: RpcClient, address: string, blockHex: string, blockHeight: bigint
): Promise<void> {
  let balanceHex: string;
  let nonceHex: string;

  try {
    balanceHex = await rpc.callWithRetry<string>('eth_getBalance', [address, blockHex]);
    nonceHex = await rpc.callWithRetry<string>('eth_getTransactionCount', [address, blockHex]);
  } catch (error) {
    if (!isHistoricalStateError(error)) {
      throw error;
    }

    console.warn(
      `Historical state unavailable for ${address} at block ${blockHeight}; falling back to latest state`
    );
    balanceHex = await rpc.callWithRetry<string>('eth_getBalance', [address, 'latest']);
    nonceHex = await rpc.callWithRetry<string>('eth_getTransactionCount', [address, 'latest']);
  }

  const balance = hexToBigIntString(balanceHex) ?? '0';
  const nonce = parseHeight(nonceHex).toString(10);

  await client.query(
    `INSERT INTO accounts (address, balance, nonce, first_seen_block, last_seen_block)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (address) DO UPDATE SET
       balance = EXCLUDED.balance, nonce = EXCLUDED.nonce,
       last_seen_block = EXCLUDED.last_seen_block, updated_at = NOW()`,
    [address, balance, nonce, blockHeight.toString(10), blockHeight.toString(10)]
  );
}

async function bulkUpsertEvents(
  client: PoolClient, receipts: RpcReceipt[], blockHeight: bigint
): Promise<void> {
  const logValues: string[] = [];
  const logParams: Array<string | number | Buffer | null> = [];
  const statusValues: string[] = [];
  const statusParams: Array<string> = [];
  let logIdx = 1;
  let statusIdx = 1;

  for (const receipt of receipts) {
    const status = receipt.status === '0x1' ? 'success' : 'failure';
    statusValues.push(`($${statusIdx++}, $${statusIdx++})`);
    statusParams.push(receipt.transactionHash, status);

    for (let i = 0; i < receipt.logs.length; i += 1) {
      const log = receipt.logs[i];
      logValues.push(
        `($${logIdx++}, $${logIdx++}, $${logIdx++}, $${logIdx++}, $${logIdx++}, $${logIdx++}, $${logIdx++}, $${logIdx++}, $${logIdx++})`
      );
      logParams.push(
        receipt.transactionHash, blockHeight.toString(10), i, log.address,
        log.topics[0] ?? null, log.topics[1] ?? null,
        log.topics[2] ?? null, log.topics[3] ?? null,
        hexToBuffer(log.data)
      );
    }
  }

  if (logValues.length > 0) {
    await client.query(
      `INSERT INTO events (
         tx_hash, block_height, log_index, contract_address,
         topic0, topic1, topic2, topic3, data
       ) VALUES ${logValues.join(',')}
       ON CONFLICT (tx_hash, log_index, block_height) DO UPDATE SET
         contract_address = EXCLUDED.contract_address,
         topic0 = EXCLUDED.topic0, topic1 = EXCLUDED.topic1,
         topic2 = EXCLUDED.topic2, topic3 = EXCLUDED.topic3,
         data = EXCLUDED.data`,
      logParams
    );
  }

  if (statusValues.length > 0) {
    await client.query(
      `UPDATE transactions AS t
       SET status = v.status
       FROM (VALUES ${statusValues.join(',')}) AS v(hash, status)
       WHERE t.hash = v.hash`,
      statusParams
    );
  }
}

/**
 * Process a single block: fetch from RPC, upsert block + txs + accounts + events,
 * refresh account balances. Returns BlockResult for downstream processors.
 */
export async function processBlock(rpc: RpcClient, height: bigint): Promise<BlockResult | null> {
  const blockHex = `0x${height.toString(16)}`;
  const block = await rpc.callWithRetry<RpcBlock>('eth_getBlockByNumber', [blockHex, true]);
  if (!block) return null;

  const txs = block.transactions ?? [];
  const addressSet = new Set<string>();

  // Phase 1: upsert block + transactions + accounts
  const pool = getPool();
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    await upsertBlock(dbClient, block);
    await bulkUpsertTransactions(dbClient, txs, block.hash, height);
    for (const tx of txs) {
      if (tx.from) addressSet.add(tx.from.toLowerCase());
      if (tx.to) addressSet.add(tx.to.toLowerCase());
    }
    await upsertAccounts(dbClient, Array.from(addressSet), height);
    await dbClient.query('COMMIT');
  } catch (error) {
    await dbClient.query('ROLLBACK');
    throw error;
  } finally {
    dbClient.release();
  }

  // Phase 2: refresh account balances via RPC
  if (addressSet.size > 0) {
    const accountClient = await pool.connect();
    try {
      await accountClient.query('BEGIN');
      const addresses = Array.from(addressSet);
      const concurrency = 5;
      for (let i = 0; i < addresses.length; i += concurrency) {
        const batch = addresses.slice(i, i + concurrency);
        await Promise.all(
          batch.map((address) => refreshAccountState(accountClient, rpc, address, blockHex, height))
        );
      }
      await accountClient.query('COMMIT');
    } catch (error) {
      await accountClient.query('ROLLBACK');
      throw error;
    } finally {
      accountClient.release();
    }
  }

  // Phase 3: fetch receipts and upsert events + tx status
  const allReceipts: RpcReceipt[] = [];
  const receiptClient = await pool.connect();
  try {
    await receiptClient.query('BEGIN');
    const concurrency = 8;
    for (let i = 0; i < txs.length; i += concurrency) {
      const batch = txs.slice(i, i + concurrency);
      const receipts = await Promise.all(
        batch.map((tx) => rpc.callWithRetry<RpcReceipt>('eth_getTransactionReceipt', [tx.hash]))
      );
      const filtered = receipts.filter(Boolean) as RpcReceipt[];
      await bulkUpsertEvents(receiptClient, filtered, height);
      allReceipts.push(...filtered);
    }
    await receiptClient.query('COMMIT');
  } catch (error) {
    await receiptClient.query('ROLLBACK');
    throw error;
  } finally {
    receiptClient.release();
  }

  return { block, height, blockHex, txs, receipts: allReceipts, addressSet };
}
