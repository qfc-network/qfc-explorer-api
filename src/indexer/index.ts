import 'dotenv/config';
import { getPool } from '../db/pool.js';
import type { PoolClient } from 'pg';
import { RpcClient } from './rpc.js';
import type { RpcBlock, RpcReceipt, RpcTransaction } from './types.js';
import { decodeString, decodeUint256, decodeUint256Pair, decodeUint256Arrays, hexToBigIntString, hexToBuffer, parseAddressFromTopic, stripHexPrefix } from './utils.js';

const INDEXER_STATE_KEY = 'last_processed_height';
const INDEXER_STATS_KEY = 'last_batch_stats';
const INDEXER_FAILED_KEY = 'failed_blocks';
const INDEXER_ADMIN_RESCAN = 'admin_rescan_from';
const INDEXER_ADMIN_RETRY = 'admin_retry_failed';
const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a7a5c6b6e0f';
// ERC-1155 event topics
const ERC1155_TRANSFER_SINGLE_TOPIC = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
const ERC1155_TRANSFER_BATCH_TOPIC = '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb';
const ERC20_NAME = '0x06fdde03';
const ERC20_SYMBOL = '0x95d89b41';
const ERC20_DECIMALS = '0x313ce567';
const ERC20_TOTAL_SUPPLY = '0x18160ddd';

const tokenMetadataCache = new Map<string, { name: string | null; symbol: string | null; decimals: number | null; totalSupply: string | null }>();

async function getLastProcessedHeight(): Promise<bigint | null> {
  const pool = getPool();
  const result = await pool.query(
    'SELECT value FROM indexer_state WHERE key = $1',
    [INDEXER_STATE_KEY]
  );
  if (result.rowCount === 0) {
    return null;
  }
  try {
    return BigInt(result.rows[0].value);
  } catch {
    return null;
  }
}

async function setLastProcessedHeight(height: bigint): Promise<void> {
  const pool = getPool();
  await pool.query(
    `
    INSERT INTO indexer_state (key, value)
    VALUES ($1, $2)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `,
    [INDEXER_STATE_KEY, height.toString(10)]
  );
}

function parseHeight(hexValue: string): bigint {
  const parsed = hexToBigIntString(hexValue);
  if (!parsed) {
    throw new Error(`Invalid hex height: ${hexValue}`);
  }
  return BigInt(parsed);
}

async function upsertBlock(client: PoolClient, block: RpcBlock): Promise<void> {
  const height = parseHeight(block.number);

  await client.query(
    `
    INSERT INTO blocks (
      hash,
      height,
      parent_hash,
      state_root,
      transactions_root,
      receipts_root,
      producer,
      timestamp_ms,
      gas_limit,
      gas_used,
      extra_data,
      tx_count
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (hash) DO UPDATE SET
      height = EXCLUDED.height,
      parent_hash = EXCLUDED.parent_hash,
      state_root = EXCLUDED.state_root,
      transactions_root = EXCLUDED.transactions_root,
      receipts_root = EXCLUDED.receipts_root,
      producer = EXCLUDED.producer,
      timestamp_ms = EXCLUDED.timestamp_ms,
      gas_limit = EXCLUDED.gas_limit,
      gas_used = EXCLUDED.gas_used,
      extra_data = EXCLUDED.extra_data,
      tx_count = EXCLUDED.tx_count
    `,
    [
      block.hash,
      height.toString(10),
      block.parentHash,
      block.stateRoot,
      block.transactionsRoot,
      block.receiptsRoot,
      block.miner,
      parseHeight(block.timestamp).toString(10),
      parseHeight(block.gasLimit).toString(10),
      parseHeight(block.gasUsed).toString(10),
      hexToBuffer(block.extraData),
      block.transactions?.length ?? block.transactionHashes?.length ?? 0,
    ]
  );
}

async function upsertTransaction(
  client: PoolClient,
  tx: RpcTransaction,
  blockHash: string,
  blockHeight: bigint,
  txIndex: number,
  status: string | null
): Promise<void> {
  await client.query(
    `
    INSERT INTO transactions (
      hash,
      block_hash,
      block_height,
      tx_index,
      type,
      from_address,
      to_address,
      value,
      nonce,
      gas_limit,
      gas_price,
      status,
      data
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (hash) DO UPDATE SET
      block_hash = EXCLUDED.block_hash,
      block_height = EXCLUDED.block_height,
      tx_index = EXCLUDED.tx_index,
      from_address = EXCLUDED.from_address,
      to_address = EXCLUDED.to_address,
      value = EXCLUDED.value,
      nonce = EXCLUDED.nonce,
      gas_limit = EXCLUDED.gas_limit,
      gas_price = EXCLUDED.gas_price,
      status = EXCLUDED.status,
      data = EXCLUDED.data
    `,
    [
      tx.hash,
      blockHash,
      blockHeight.toString(10),
      txIndex,
      'unknown',
      tx.from,
      tx.to ?? null,
      hexToBigIntString(tx.value) ?? '0',
      parseHeight(tx.nonce).toString(10),
      parseHeight(tx.gas).toString(10),
      hexToBigIntString(tx.gasPrice) ?? '0',
      status ?? 'unknown',
      hexToBuffer(tx.input),
    ]
  );
}

async function bulkUpsertTransactions(
  client: PoolClient,
  txs: RpcTransaction[],
  blockHash: string,
  blockHeight: bigint
): Promise<void> {
  if (txs.length === 0) {
    return;
  }

  const values: string[] = [];
  const params: Array<string | number | Buffer | null> = [];
  let idx = 1;

  for (let i = 0; i < txs.length; i += 1) {
    const tx = txs[i];
    values.push(
      `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`
    );
    params.push(
      tx.hash,
      blockHash,
      blockHeight.toString(10),
      i,
      'unknown',
      tx.from,
      tx.to ?? null,
      hexToBigIntString(tx.value) ?? '0',
      parseHeight(tx.nonce).toString(10),
      parseHeight(tx.gas).toString(10),
      hexToBigIntString(tx.gasPrice) ?? '0',
      'unknown',
      hexToBuffer(tx.input)
    );
  }

  await client.query(
    `
    INSERT INTO transactions (
      hash,
      block_hash,
      block_height,
      tx_index,
      type,
      from_address,
      to_address,
      value,
      nonce,
      gas_limit,
      gas_price,
      status,
      data
    ) VALUES ${values.join(',')}
    ON CONFLICT (hash) DO UPDATE SET
      block_hash = EXCLUDED.block_hash,
      block_height = EXCLUDED.block_height,
      tx_index = EXCLUDED.tx_index,
      from_address = EXCLUDED.from_address,
      to_address = EXCLUDED.to_address,
      value = EXCLUDED.value,
      nonce = EXCLUDED.nonce,
      gas_limit = EXCLUDED.gas_limit,
      gas_price = EXCLUDED.gas_price,
      status = EXCLUDED.status,
      data = EXCLUDED.data
    `,
    params
  );
}

async function upsertAccounts(client: PoolClient, addresses: string[], blockHeight: bigint): Promise<void> {
  if (addresses.length === 0) {
    return;
  }

  const values: string[] = [];
  const params: Array<string> = [];
  let idx = 1;
  for (const address of addresses) {
    values.push(`($${idx++}, $${idx++}, $${idx++})`);
    params.push(address, blockHeight.toString(10), blockHeight.toString(10));
  }

  await client.query(
    `
    INSERT INTO accounts (address, first_seen_block, last_seen_block)
    VALUES ${values.join(',')}
    ON CONFLICT (address) DO UPDATE SET
      last_seen_block = EXCLUDED.last_seen_block,
      updated_at = NOW()
    `,
    params
  );
}

async function refreshAccountState(
  client: PoolClient,
  rpc: RpcClient,
  address: string,
  blockHex: string,
  blockHeight: bigint
): Promise<void> {
  const balanceHex = await rpc.callWithRetry<string>('eth_getBalance', [address, blockHex]);
  const nonceHex = await rpc.callWithRetry<string>('eth_getTransactionCount', [address, blockHex]);
  const balance = hexToBigIntString(balanceHex) ?? '0';
  const nonce = parseHeight(nonceHex).toString(10);

  await client.query(
    `
    INSERT INTO accounts (address, balance, nonce, first_seen_block, last_seen_block)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (address) DO UPDATE SET
      balance = EXCLUDED.balance,
      nonce = EXCLUDED.nonce,
      last_seen_block = EXCLUDED.last_seen_block,
      updated_at = NOW()
    `,
    [address, balance, nonce, blockHeight.toString(10), blockHeight.toString(10)]
  );
}

async function upsertReceipt(
  client: PoolClient,
  receipt: RpcReceipt,
  blockHeight: bigint
): Promise<void> {
  const status = receipt.status === '0x1' ? 'success' : 'failure';

  for (let i = 0; i < receipt.logs.length; i += 1) {
    const log = receipt.logs[i];
    await client.query(
      `
      INSERT INTO events (
        tx_hash,
        block_height,
        log_index,
        contract_address,
        topic0,
        topic1,
        topic2,
        topic3,
        data
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (tx_hash, log_index) DO UPDATE SET
        block_height = EXCLUDED.block_height,
        contract_address = EXCLUDED.contract_address,
        topic0 = EXCLUDED.topic0,
        topic1 = EXCLUDED.topic1,
        topic2 = EXCLUDED.topic2,
        topic3 = EXCLUDED.topic3,
        data = EXCLUDED.data
      `,
      [
        receipt.transactionHash,
        blockHeight.toString(10),
        i,
        log.address,
        log.topics[0] ?? null,
        log.topics[1] ?? null,
        log.topics[2] ?? null,
        log.topics[3] ?? null,
        hexToBuffer(log.data),
      ]
    );
  }

  if (receipt.contractAddress) {
    await client.query(
      `
      INSERT INTO contracts (address, creator_tx_hash, created_at_block)
      VALUES ($1, $2, $3)
      ON CONFLICT (address) DO UPDATE SET
        creator_tx_hash = EXCLUDED.creator_tx_hash,
        created_at_block = EXCLUDED.created_at_block,
        updated_at = NOW()
      `,
      [receipt.contractAddress, receipt.transactionHash, blockHeight.toString(10)]
    );
  }

  await client.query(
    `
    UPDATE transactions
    SET status = $1
    WHERE hash = $2
    `,
    [status, receipt.transactionHash]
  );
}

async function bulkUpsertReceipts(
  client: PoolClient,
  receipts: RpcReceipt[],
  blockHeight: bigint
): Promise<void> {
  if (receipts.length === 0) {
    return;
  }

  const logValues: string[] = [];
  const logParams: Array<string | number | Buffer | null> = [];
  const tokenTransferValues: string[] = [];
  const tokenTransferParams: Array<string | number | null> = [];
  const tokenInsertValues: string[] = [];
  const tokenInsertParams: Array<string | number> = [];
  const tokenAddresses = new Set<string>();
  const tokenTypes = new Map<string, string>();
  const balanceUpdates: Array<{ tokenAddress: string; from: string; to: string; tokenId: string | null; value: string }> = [];
  const contractValues: string[] = [];
  const contractParams: Array<string | number> = [];
  const statusValues: string[] = [];
  const statusParams: Array<string> = [];
  let logIdx = 1;
  let transferIdx = 1;
  let contractIdx = 1;
  let statusIdx = 1;

  for (const receipt of receipts) {
    const status = receipt.status === '0x1' ? 'success' : 'failure';
    statusValues.push(`($${statusIdx++}, $${statusIdx++})`);
    statusParams.push(receipt.transactionHash, status);

    if (receipt.contractAddress) {
      contractValues.push(`($${contractIdx++}, $${contractIdx++}, $${contractIdx++})`);
      contractParams.push(receipt.contractAddress, receipt.transactionHash, blockHeight.toString(10));
    }

    for (let i = 0; i < receipt.logs.length; i += 1) {
      const log = receipt.logs[i];
      logValues.push(
        `($${logIdx++}, $${logIdx++}, $${logIdx++}, $${logIdx++}, $${logIdx++}, $${logIdx++}, $${logIdx++}, $${logIdx++}, $${logIdx++})`
      );
      logParams.push(
        receipt.transactionHash,
        blockHeight.toString(10),
        i,
        log.address,
        log.topics[0] ?? null,
        log.topics[1] ?? null,
        log.topics[2] ?? null,
        log.topics[3] ?? null,
        hexToBuffer(log.data)
      );

      const topic0 = (log.topics[0] ?? '').toLowerCase();

      // ERC-20 Transfer (2 indexed: from, to; value in data)
      // ERC-721 Transfer (3 indexed: from, to, tokenId; no data value)
      if (topic0 === ERC20_TRANSFER_TOPIC) {
        const from = parseAddressFromTopic(log.topics[1] ?? '');
        const to = parseAddressFromTopic(log.topics[2] ?? '');
        const tokenAddress = log.address.toLowerCase();

        if (log.topics.length === 4 && from && to) {
          // ERC-721: tokenId is topic3
          const tokenId = decodeUint256(log.topics[3] ?? '');
          if (tokenId) {
            tokenAddresses.add(tokenAddress);
            tokenTypes.set(tokenAddress, 'erc721');
            tokenTransferValues.push(
              `($${transferIdx++}, $${transferIdx++}, $${transferIdx++}, $${transferIdx++}, $${transferIdx++}, $${transferIdx++}, $${transferIdx++}, $${transferIdx++})`
            );
            tokenTransferParams.push(tokenAddress, receipt.transactionHash, blockHeight.toString(10), i, from, to, '1', tokenId);
            balanceUpdates.push({ tokenAddress, from, to, tokenId, value: '1' });
          }
        } else if (from && to) {
          // ERC-20: value in data
          const value = decodeUint256(log.data ?? '');
          if (value) {
            tokenAddresses.add(tokenAddress);
            if (!tokenTypes.has(tokenAddress)) tokenTypes.set(tokenAddress, 'erc20');
            tokenTransferValues.push(
              `($${transferIdx++}, $${transferIdx++}, $${transferIdx++}, $${transferIdx++}, $${transferIdx++}, $${transferIdx++}, $${transferIdx++}, $${transferIdx++})`
            );
            tokenTransferParams.push(tokenAddress, receipt.transactionHash, blockHeight.toString(10), i, from, to, value, null);
            balanceUpdates.push({ tokenAddress, from, to, tokenId: null, value });
          }
        }
      }

      // ERC-1155 TransferSingle(operator, from, to, id, value)
      if (topic0 === ERC1155_TRANSFER_SINGLE_TOPIC) {
        const from = parseAddressFromTopic(log.topics[2] ?? '');
        const to = parseAddressFromTopic(log.topics[3] ?? '');
        const pair = decodeUint256Pair(log.data ?? '');
        const tokenAddress = log.address.toLowerCase();
        if (from && to && pair) {
          tokenAddresses.add(tokenAddress);
          tokenTypes.set(tokenAddress, 'erc1155');
          tokenTransferValues.push(
            `($${transferIdx++}, $${transferIdx++}, $${transferIdx++}, $${transferIdx++}, $${transferIdx++}, $${transferIdx++}, $${transferIdx++}, $${transferIdx++})`
          );
          tokenTransferParams.push(tokenAddress, receipt.transactionHash, blockHeight.toString(10), i, from, to, pair.value, pair.id);
          balanceUpdates.push({ tokenAddress, from, to, tokenId: pair.id, value: pair.value });
        }
      }

      // ERC-1155 TransferBatch(operator, from, to, ids[], values[])
      if (topic0 === ERC1155_TRANSFER_BATCH_TOPIC) {
        const from = parseAddressFromTopic(log.topics[2] ?? '');
        const to = parseAddressFromTopic(log.topics[3] ?? '');
        const items = decodeUint256Arrays(log.data ?? '');
        const tokenAddress = log.address.toLowerCase();
        if (from && to && items && items.length > 0) {
          tokenAddresses.add(tokenAddress);
          tokenTypes.set(tokenAddress, 'erc1155');
          for (let j = 0; j < items.length; j++) {
            const item = items[j];
            tokenTransferValues.push(
              `($${transferIdx++}, $${transferIdx++}, $${transferIdx++}, $${transferIdx++}, $${transferIdx++}, $${transferIdx++}, $${transferIdx++}, $${transferIdx++})`
            );
            // Use log_index * 1000 + j to make unique within tx for batch items
            tokenTransferParams.push(tokenAddress, receipt.transactionHash, blockHeight.toString(10), i * 1000 + j, from, to, item.value, item.id);
            balanceUpdates.push({ tokenAddress, from, to, tokenId: item.id, value: item.value });
          }
        }
      }
    }
  }

  if (logValues.length > 0) {
    await client.query(
      `
      INSERT INTO events (
        tx_hash,
        block_height,
        log_index,
        contract_address,
        topic0,
        topic1,
        topic2,
        topic3,
        data
      ) VALUES ${logValues.join(',')}
      ON CONFLICT (tx_hash, log_index) DO UPDATE SET
        block_height = EXCLUDED.block_height,
        contract_address = EXCLUDED.contract_address,
        topic0 = EXCLUDED.topic0,
        topic1 = EXCLUDED.topic1,
        topic2 = EXCLUDED.topic2,
        topic3 = EXCLUDED.topic3,
        data = EXCLUDED.data
      `,
      logParams
    );
  }

  if (tokenAddresses.size > 0) {
    let tokenIdx = 1;
    for (const address of tokenAddresses) {
      const ttype = tokenTypes.get(address) ?? 'erc20';
      tokenInsertValues.push(`($${tokenIdx++}, $${tokenIdx++})`);
      tokenInsertParams.push(address, ttype);
    }
    await client.query(
      `
      INSERT INTO tokens (address, token_type)
      VALUES ${tokenInsertValues.join(',')}
      ON CONFLICT (address) DO UPDATE SET
        token_type = CASE
          WHEN tokens.token_type = 'erc20' AND EXCLUDED.token_type != 'erc20' THEN EXCLUDED.token_type
          ELSE tokens.token_type
        END
      `,
      tokenInsertParams
    );
  }

  if (tokenTransferValues.length > 0) {
    await client.query(
      `
      INSERT INTO token_transfers (
        token_address,
        tx_hash,
        block_height,
        log_index,
        from_address,
        to_address,
        value,
        token_id
      ) VALUES ${tokenTransferValues.join(',')}
      ON CONFLICT (tx_hash, log_index) DO UPDATE SET
        token_address = EXCLUDED.token_address,
        block_height = EXCLUDED.block_height,
        from_address = EXCLUDED.from_address,
        to_address = EXCLUDED.to_address,
        value = EXCLUDED.value,
        token_id = EXCLUDED.token_id
      `,
      tokenTransferParams
    );
  }

  // Update token_balances
  if (balanceUpdates.length > 0) {
    const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
    for (const upd of balanceUpdates) {
      const tokenIdKey = upd.tokenId ?? '';
      // Decrease sender balance (skip mint from zero address)
      if (upd.from !== ZERO_ADDR) {
        await client.query(
          `
          INSERT INTO token_balances (token_address, holder_address, token_id, balance, last_updated_block)
          VALUES ($1, $2, NULLIF($3, ''), '0', $4)
          ON CONFLICT (token_address, holder_address, COALESCE(token_id, '')) DO UPDATE SET
            balance = (COALESCE(token_balances.balance, '0')::numeric - $5::numeric)::text,
            last_updated_block = $4,
            updated_at = NOW()
          `,
          [upd.tokenAddress, upd.from, tokenIdKey, blockHeight.toString(10), upd.value]
        );
      }
      // Increase receiver balance (skip burn to zero address)
      if (upd.to !== ZERO_ADDR) {
        await client.query(
          `
          INSERT INTO token_balances (token_address, holder_address, token_id, balance, last_updated_block)
          VALUES ($1, $2, NULLIF($3, ''), $5, $4)
          ON CONFLICT (token_address, holder_address, COALESCE(token_id, '')) DO UPDATE SET
            balance = (COALESCE(token_balances.balance, '0')::numeric + $5::numeric)::text,
            last_updated_block = $4,
            updated_at = NOW()
          `,
          [upd.tokenAddress, upd.to, tokenIdKey, blockHeight.toString(10), upd.value]
        );
      }
    }
  }

  if (contractValues.length > 0) {
    await client.query(
      `
      INSERT INTO contracts (address, creator_tx_hash, created_at_block)
      VALUES ${contractValues.join(',')}
      ON CONFLICT (address) DO UPDATE SET
        creator_tx_hash = EXCLUDED.creator_tx_hash,
        created_at_block = EXCLUDED.created_at_block,
        updated_at = NOW()
      `,
      contractParams
    );
  }

  if (statusValues.length > 0) {
    await client.query(
      `
      UPDATE transactions AS t
      SET status = v.status
      FROM (VALUES ${statusValues.join(',')}) AS v(hash, status)
      WHERE t.hash = v.hash
      `,
      statusParams
    );
  }
}

async function callString(client: RpcClient, to: string, data: string): Promise<string | null> {
  try {
    const result = await client.callWithRetry<string>('eth_call', [{ to, data }, 'latest']);
    return decodeString(result);
  } catch {
    return null;
  }
}

async function callUint256(client: RpcClient, to: string, data: string): Promise<string | null> {
  try {
    const result = await client.callWithRetry<string>('eth_call', [{ to, data }, 'latest']);
    return decodeUint256(result);
  } catch {
    return null;
  }
}

async function callDecimals(client: RpcClient, to: string): Promise<number | null> {
  try {
    const result = await client.callWithRetry<string>('eth_call', [{ to, data: ERC20_DECIMALS }, 'latest']);
    const value = decodeUint256(result);
    return value ? Number(value) : null;
  } catch {
    return null;
  }
}

async function upsertTokenMetadata(client: PoolClient, rpc: RpcClient, tokenAddress: string, blockHeight: bigint): Promise<void> {
  if (tokenMetadataCache.has(tokenAddress)) {
    return;
  }

  const [name, symbol, decimals, totalSupply] = await Promise.all([
    callString(rpc, tokenAddress, ERC20_NAME),
    callString(rpc, tokenAddress, ERC20_SYMBOL),
    callDecimals(rpc, tokenAddress),
    callUint256(rpc, tokenAddress, ERC20_TOTAL_SUPPLY),
  ]);

  tokenMetadataCache.set(tokenAddress, { name, symbol, decimals, totalSupply });

  await client.query(
    `
    INSERT INTO tokens (address, name, symbol, decimals, total_supply, last_seen_block)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (address) DO UPDATE SET
      name = EXCLUDED.name,
      symbol = EXCLUDED.symbol,
      decimals = EXCLUDED.decimals,
      total_supply = EXCLUDED.total_supply,
      last_seen_block = EXCLUDED.last_seen_block,
      updated_at = NOW()
    `,
    [tokenAddress, name, symbol, decimals, totalSupply, blockHeight.toString(10)]
  );
}

async function setLastBatchStats(stats: {
  height: bigint;
  blocks: number;
  txs: number;
  receipts: number;
  durationMs: number;
}): Promise<void> {
  const pool = getPool();
  await pool.query(
    `
    INSERT INTO indexer_state (key, value)
    VALUES ($1, $2)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `,
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

async function getFailedBlockHeight(): Promise<bigint | null> {
  const pool = getPool();
  const result = await pool.query(
    'SELECT value FROM indexer_state WHERE key = $1',
    [INDEXER_FAILED_KEY]
  );
  if (result.rowCount === 0) {
    return null;
  }
  try {
    const data = JSON.parse(result.rows[0].value);
    return data?.height ? BigInt(data.height) : null;
  } catch {
    return null;
  }
}

async function readAndClearIndexerKey(key: string): Promise<string | null> {
  const pool = getPool();
  const result = await pool.query('SELECT value FROM indexer_state WHERE key = $1', [key]);
  if (result.rowCount === 0) {
    return null;
  }
  const value = result.rows[0].value as string;
  await pool.query('DELETE FROM indexer_state WHERE key = $1', [key]);
  return value;
}

async function recordFailedBlock(height: bigint, error: unknown): Promise<void> {
  const pool = getPool();
  const message = error instanceof Error ? error.message : String(error);
  await pool.query(
    `
    INSERT INTO indexer_state (key, value)
    VALUES ($1, $2)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `,
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

async function indexBlock(client: RpcClient, height: bigint): Promise<number> {
  const blockHex = `0x${height.toString(16)}`;
  const block = await client.callWithRetry<RpcBlock>('eth_getBlockByNumber', [blockHex, true]);

  if (!block) {
    return 0;
  }

  const txs = block.transactions ?? [];
  const addressSet = new Set<string>();

  const pool = getPool();
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    await upsertBlock(dbClient, block);

    await bulkUpsertTransactions(dbClient, txs, block.hash, height);

    for (const tx of txs) {
      if (tx.from) {
        addressSet.add(tx.from);
      }
      if (tx.to) {
        addressSet.add(tx.to);
      }
    }
    await upsertAccounts(dbClient, Array.from(addressSet), height);

    await dbClient.query('COMMIT');
  } catch (error) {
    await dbClient.query('ROLLBACK');
    throw error;
  } finally {
    dbClient.release();
  }

  if (addressSet.size > 0) {
    const accountClient = await pool.connect();
    try {
      await accountClient.query('BEGIN');
      const addresses = Array.from(addressSet);
      const concurrency = 5;
      for (let i = 0; i < addresses.length; i += concurrency) {
        const batch = addresses.slice(i, i + concurrency);
        await Promise.all(
          batch.map((address) => refreshAccountState(accountClient, client, address, blockHex, height))
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

  const contractAddresses = new Set<string>();
  const receiptClient = await pool.connect();
  try {
    await receiptClient.query('BEGIN');
    const concurrency = 8;
    for (let i = 0; i < txs.length; i += concurrency) {
      const batch = txs.slice(i, i + concurrency);
      const receipts = await Promise.all(
        batch.map((tx) =>
          client.callWithRetry<RpcReceipt>('eth_getTransactionReceipt', [tx.hash])
        )
      );
      const filtered = receipts.filter(Boolean) as RpcReceipt[];
      await bulkUpsertReceipts(receiptClient, filtered, height);

      for (const receipt of filtered) {
        if (receipt.contractAddress) {
          contractAddresses.add(receipt.contractAddress.toLowerCase());
        }
      }

      const batchTokenAddresses = new Set<string>();
      for (const receipt of filtered) {
        for (const log of receipt.logs) {
          const t0 = (log.topics[0] ?? '').toLowerCase();
          if (t0 === ERC20_TRANSFER_TOPIC || t0 === ERC1155_TRANSFER_SINGLE_TOPIC || t0 === ERC1155_TRANSFER_BATCH_TOPIC) {
            batchTokenAddresses.add(log.address.toLowerCase());
          }
        }
      }

      for (const tokenAddress of batchTokenAddresses) {
        await upsertTokenMetadata(receiptClient, client, tokenAddress, height);
      }
    }
    await receiptClient.query('COMMIT');
  } catch (error) {
    await receiptClient.query('ROLLBACK');
    throw error;
  } finally {
    receiptClient.release();
  }

  // Upsert contract addresses into accounts table (not captured from tx.to which is null for deploys)
  if (contractAddresses.size > 0) {
    const caClient = await pool.connect();
    try {
      await caClient.query('BEGIN');
      const addrs = Array.from(contractAddresses);
      await upsertAccounts(caClient, addrs, height);
      for (const addr of addrs) {
        await refreshAccountState(caClient, client, addr, blockHex, height);
      }
      await caClient.query('COMMIT');
    } catch (error) {
      await caClient.query('ROLLBACK');
      throw error;
    } finally {
      caClient.release();
    }
  }

  await setLastProcessedHeight(height);
  return txs.length;
}

async function indexBlockWithRetry(
  client: RpcClient,
  height: bigint,
  attempts: number,
  skipOnError: boolean
): Promise<number | null> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const txCount = await indexBlock(client, height);
      return txCount;
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

async function resolveFinalizedHeight(client: RpcClient, latest: bigint): Promise<bigint> {
  try {
    const finalizedHex = await client.callWithRetry<string>('qfc_getFinalizedBlock');
    const finalized = parseHeight(finalizedHex);
    return finalized <= latest ? finalized : latest;
  } catch (error) {
    console.warn('Failed to fetch finalized block, falling back to latest', error);
    return latest;
  }
}

async function refreshDailyStats(): Promise<void> {
  const pool = getPool();
  // Refresh today's daily_stats row from blocks/transactions
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

  // Update active addresses for today
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

  // Update avg gas price for today
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

  // Update new contracts for today
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

async function runOnce(
  client: RpcClient,
  startHeight: bigint,
  useFinalized: boolean,
  blockRetries: number,
  skipOnError: boolean,
  maxHeight: bigint | null = null
): Promise<bigint> {
  const latestHex = await client.callWithRetry<string>('eth_blockNumber');
  const latest = parseHeight(latestHex);
  const target = useFinalized ? await resolveFinalizedHeight(client, latest) : latest;
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
    const txCount = await indexBlockWithRetry(client, height, blockRetries, skipOnError);
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

  // Update daily_stats for today
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

  const client = new RpcClient(rpcUrl);

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
        await indexBlockWithRetry(client, failed, blockRetries, false);
      }
    }
  };

  await applyAdminCommands();

  if (retryFailed) {
    const failed = await getFailedBlockHeight();
    if (failed !== null) {
      console.log(`Retrying failed block ${failed}`);
      await indexBlockWithRetry(client, failed, blockRetries, false);
    }
  }

  if (endHeight !== null) {
    await runOnce(client, current, useFinalized, blockRetries, skipOnError, endHeight);
    return;
  }

  await runOnce(client, current, useFinalized, blockRetries, skipOnError);

  // Continuous polling mode
  while (pollIntervalMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    const last = await getLastProcessedHeight();
    current = last !== null ? last + 1n : startHeight;
    await applyAdminCommands();
    await runOnce(client, current, useFinalized, blockRetries, skipOnError);
  }
}

run().catch((error) => {
  console.error('Indexer failed:', error);
  process.exit(1);
});
