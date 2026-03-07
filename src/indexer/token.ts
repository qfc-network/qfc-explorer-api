import type { PoolClient } from 'pg';
import { getPool } from '../db/pool.js';
import { RpcClient } from './rpc.js';
import type { RpcReceipt } from './types.js';
import type { BlockResult } from './block.js';
import { decodeString, decodeUint256, decodeUint256Pair, decodeUint256Arrays, parseAddressFromTopic } from './utils.js';
import { tokenTransfersProcessed } from './metrics.js';

const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a7a5c6b6e0f';
const ERC1155_TRANSFER_SINGLE_TOPIC = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
const ERC1155_TRANSFER_BATCH_TOPIC = '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb';
const ERC20_NAME = '0x06fdde03';
const ERC20_SYMBOL = '0x95d89b41';
const ERC20_DECIMALS = '0x313ce567';
const ERC20_TOTAL_SUPPLY = '0x18160ddd';
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

const tokenMetadataCache = new Map<string, boolean>();

type BalanceUpdate = {
  tokenAddress: string;
  from: string;
  to: string;
  tokenId: string | null;
  value: string;
};

// --- RPC helpers for token metadata ---

async function callString(rpc: RpcClient, to: string, data: string): Promise<string | null> {
  try {
    const result = await rpc.callWithRetry<string>('eth_call', [{ to, data }, 'latest']);
    return decodeString(result);
  } catch {
    return null;
  }
}

async function callUint256(rpc: RpcClient, to: string, data: string): Promise<string | null> {
  try {
    const result = await rpc.callWithRetry<string>('eth_call', [{ to, data }, 'latest']);
    return decodeUint256(result);
  } catch {
    return null;
  }
}

async function callDecimals(rpc: RpcClient, to: string): Promise<number | null> {
  try {
    const result = await rpc.callWithRetry<string>('eth_call', [{ to, data: ERC20_DECIMALS }, 'latest']);
    const value = decodeUint256(result);
    return value ? Number(value) : null;
  } catch {
    return null;
  }
}

async function upsertTokenMetadata(
  client: PoolClient, rpc: RpcClient, tokenAddress: string, blockHeight: bigint
): Promise<void> {
  if (tokenMetadataCache.has(tokenAddress)) return;

  const [name, symbol, decimals, totalSupply] = await Promise.all([
    callString(rpc, tokenAddress, ERC20_NAME),
    callString(rpc, tokenAddress, ERC20_SYMBOL),
    callDecimals(rpc, tokenAddress),
    callUint256(rpc, tokenAddress, ERC20_TOTAL_SUPPLY),
  ]);

  tokenMetadataCache.set(tokenAddress, true);

  await client.query(
    `INSERT INTO tokens (address, name, symbol, decimals, total_supply, last_seen_block)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (address) DO UPDATE SET
       name = EXCLUDED.name, symbol = EXCLUDED.symbol,
       decimals = EXCLUDED.decimals, total_supply = EXCLUDED.total_supply,
       last_seen_block = EXCLUDED.last_seen_block, updated_at = NOW()`,
    [tokenAddress, name, symbol, decimals, totalSupply, blockHeight.toString(10)]
  );
}

// --- Transfer detection ---

function detectTransfers(receipts: RpcReceipt[], blockHeight: bigint) {
  const tokenAddresses = new Set<string>();
  const tokenTypes = new Map<string, string>();
  const transfers: Array<{
    tokenAddress: string; txHash: string; blockHeight: string;
    logIndex: number; from: string; to: string; value: string; tokenId: string | null;
  }> = [];
  const balanceUpdates: BalanceUpdate[] = [];

  for (const receipt of receipts) {
    for (let i = 0; i < receipt.logs.length; i += 1) {
      const log = receipt.logs[i];
      const topic0 = (log.topics[0] ?? '').toLowerCase();
      const tokenAddress = log.address.toLowerCase();

      // ERC-20 / ERC-721 Transfer
      if (topic0 === ERC20_TRANSFER_TOPIC) {
        const from = parseAddressFromTopic(log.topics[1] ?? '');
        const to = parseAddressFromTopic(log.topics[2] ?? '');

        if (log.topics.length === 4 && from && to) {
          // ERC-721
          const tokenId = decodeUint256(log.topics[3] ?? '');
          if (tokenId) {
            tokenAddresses.add(tokenAddress);
            tokenTypes.set(tokenAddress, 'erc721');
            transfers.push({
              tokenAddress, txHash: receipt.transactionHash,
              blockHeight: blockHeight.toString(10), logIndex: i,
              from, to, value: '1', tokenId,
            });
            balanceUpdates.push({ tokenAddress, from, to, tokenId, value: '1' });
          }
        } else if (from && to) {
          // ERC-20
          const value = decodeUint256(log.data ?? '');
          if (value) {
            tokenAddresses.add(tokenAddress);
            if (!tokenTypes.has(tokenAddress)) tokenTypes.set(tokenAddress, 'erc20');
            transfers.push({
              tokenAddress, txHash: receipt.transactionHash,
              blockHeight: blockHeight.toString(10), logIndex: i,
              from, to, value, tokenId: null,
            });
            balanceUpdates.push({ tokenAddress, from, to, tokenId: null, value });
          }
        }
      }

      // ERC-1155 TransferSingle
      if (topic0 === ERC1155_TRANSFER_SINGLE_TOPIC) {
        const from = parseAddressFromTopic(log.topics[2] ?? '');
        const to = parseAddressFromTopic(log.topics[3] ?? '');
        const pair = decodeUint256Pair(log.data ?? '');
        if (from && to && pair) {
          tokenAddresses.add(tokenAddress);
          tokenTypes.set(tokenAddress, 'erc1155');
          transfers.push({
            tokenAddress, txHash: receipt.transactionHash,
            blockHeight: blockHeight.toString(10), logIndex: i,
            from, to, value: pair.value, tokenId: pair.id,
          });
          balanceUpdates.push({ tokenAddress, from, to, tokenId: pair.id, value: pair.value });
        }
      }

      // ERC-1155 TransferBatch
      if (topic0 === ERC1155_TRANSFER_BATCH_TOPIC) {
        const from = parseAddressFromTopic(log.topics[2] ?? '');
        const to = parseAddressFromTopic(log.topics[3] ?? '');
        const items = decodeUint256Arrays(log.data ?? '');
        if (from && to && items && items.length > 0) {
          tokenAddresses.add(tokenAddress);
          tokenTypes.set(tokenAddress, 'erc1155');
          for (let j = 0; j < items.length; j++) {
            const item = items[j];
            transfers.push({
              tokenAddress, txHash: receipt.transactionHash,
              blockHeight: blockHeight.toString(10), logIndex: i * 1000 + j,
              from, to, value: item.value, tokenId: item.id,
            });
            balanceUpdates.push({ tokenAddress, from, to, tokenId: item.id, value: item.value });
          }
        }
      }
    }
  }

  return { tokenAddresses, tokenTypes, transfers, balanceUpdates };
}

// --- DB writes ---

async function bulkInsertTokens(
  client: PoolClient, tokenAddresses: Set<string>, tokenTypes: Map<string, string>
): Promise<void> {
  if (tokenAddresses.size === 0) return;
  const values: string[] = [];
  const params: Array<string> = [];
  let idx = 1;
  for (const address of tokenAddresses) {
    const ttype = tokenTypes.get(address) ?? 'erc20';
    values.push(`($${idx++}, $${idx++})`);
    params.push(address, ttype);
  }
  await client.query(
    `INSERT INTO tokens (address, token_type)
     VALUES ${values.join(',')}
     ON CONFLICT (address) DO UPDATE SET
       token_type = CASE
         WHEN tokens.token_type = 'erc20' AND EXCLUDED.token_type != 'erc20' THEN EXCLUDED.token_type
         ELSE tokens.token_type
       END`,
    params
  );
}

async function bulkInsertTransfers(
  client: PoolClient,
  transfers: Array<{
    tokenAddress: string; txHash: string; blockHeight: string;
    logIndex: number; from: string; to: string; value: string; tokenId: string | null;
  }>
): Promise<void> {
  if (transfers.length === 0) return;
  const values: string[] = [];
  const params: Array<string | number | null> = [];
  let idx = 1;
  for (const t of transfers) {
    values.push(
      `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`
    );
    params.push(t.tokenAddress, t.txHash, t.blockHeight, t.logIndex, t.from, t.to, t.value, t.tokenId);
  }
  await client.query(
    `INSERT INTO token_transfers (
       token_address, tx_hash, block_height, log_index, from_address, to_address, value, token_id
     ) VALUES ${values.join(',')}
     ON CONFLICT (tx_hash, log_index, block_height) DO UPDATE SET
       token_address = EXCLUDED.token_address,
       from_address = EXCLUDED.from_address, to_address = EXCLUDED.to_address,
       value = EXCLUDED.value, token_id = EXCLUDED.token_id`,
    params
  );
}

async function updateBalances(
  client: PoolClient, updates: BalanceUpdate[], blockHeight: bigint
): Promise<void> {
  for (const upd of updates) {
    const tokenIdKey = upd.tokenId ?? '';
    if (upd.from !== ZERO_ADDR) {
      await client.query(
        `INSERT INTO token_balances (token_address, holder_address, token_id, balance, last_updated_block)
         VALUES ($1, $2, NULLIF($3, ''), '0', $4)
         ON CONFLICT (token_address, holder_address, COALESCE(token_id, '')) DO UPDATE SET
           balance = (COALESCE(token_balances.balance, '0')::numeric - $5::numeric)::text,
           last_updated_block = $4, updated_at = NOW()`,
        [upd.tokenAddress, upd.from, tokenIdKey, blockHeight.toString(10), upd.value]
      );
    }
    if (upd.to !== ZERO_ADDR) {
      await client.query(
        `INSERT INTO token_balances (token_address, holder_address, token_id, balance, last_updated_block)
         VALUES ($1, $2, NULLIF($3, ''), $5, $4)
         ON CONFLICT (token_address, holder_address, COALESCE(token_id, '')) DO UPDATE SET
           balance = (COALESCE(token_balances.balance, '0')::numeric + $5::numeric)::text,
           last_updated_block = $4, updated_at = NOW()`,
        [upd.tokenAddress, upd.to, tokenIdKey, blockHeight.toString(10), upd.value]
      );
    }
  }
}

/**
 * Process token transfers from block receipts: detect ERC-20/721/1155 transfers,
 * upsert tokens + transfers + balances, fetch metadata for new tokens.
 */
export async function processTokenTransfers(rpc: RpcClient, result: BlockResult): Promise<void> {
  const { receipts, height } = result;
  const { tokenAddresses, tokenTypes, transfers, balanceUpdates } = detectTransfers(receipts, height);

  if (transfers.length === 0) return;

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await bulkInsertTokens(client, tokenAddresses, tokenTypes);
    await bulkInsertTransfers(client, transfers);
    await updateBalances(client, balanceUpdates, height);

    // Fetch metadata for newly seen tokens
    for (const tokenAddress of tokenAddresses) {
      await upsertTokenMetadata(client, rpc, tokenAddress, height);
    }

    await client.query('COMMIT');
    tokenTransfersProcessed.inc(transfers.length);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
