import { getPool } from '../db/pool.js';
import { RpcClient } from './rpc.js';
import type { BlockResult } from './block.js';
import { refreshAccountState } from './block.js';
import { contractsDetected } from './metrics.js';

/**
 * Process contract creations from block receipts: upsert contracts table,
 * compute code_hash, register contract addresses as accounts.
 */
export async function processContracts(rpc: RpcClient, result: BlockResult): Promise<void> {
  const { receipts, height, blockHex } = result;

  // Collect newly created contract addresses
  const contractAddresses = new Set<string>();
  const contractRecords: Array<{ address: string; txHash: string }> = [];

  for (const receipt of receipts) {
    if (receipt.contractAddress) {
      const addr = receipt.contractAddress.toLowerCase();
      contractAddresses.add(addr);
      contractRecords.push({ address: addr, txHash: receipt.transactionHash });
    }
  }

  if (contractAddresses.size === 0) return;

  const pool = getPool();

  // Upsert contracts with code_hash
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Bulk upsert contract records
    const values: string[] = [];
    const params: Array<string | number> = [];
    let idx = 1;
    for (const rec of contractRecords) {
      values.push(`($${idx++}, $${idx++}, $${idx++})`);
      params.push(rec.address, rec.txHash, height.toString(10));
    }
    await client.query(
      `INSERT INTO contracts (address, creator_tx_hash, created_at_block)
       VALUES ${values.join(',')}
       ON CONFLICT (address) DO UPDATE SET
         creator_tx_hash = EXCLUDED.creator_tx_hash,
         created_at_block = EXCLUDED.created_at_block,
         updated_at = NOW()`,
      params
    );

    // Compute code_hash for each new contract
    for (const addr of contractAddresses) {
      try {
        const code = await rpc.callWithRetry<string>('eth_getCode', [addr, blockHex]);
        if (code && code !== '0x' && code !== '0x0') {
          // SHA-256 hash of bytecode for similarity matching
          const hashBuffer = await crypto.subtle.digest('SHA-256', Buffer.from(code.slice(2), 'hex'));
          const codeHash = '0x' + Buffer.from(hashBuffer).toString('hex');
          await client.query(
            `UPDATE contracts SET code_hash = $1 WHERE address = $2`,
            [codeHash, addr]
          );
        }
      } catch {
        // code_hash is optional, skip on failure
      }
    }

    // Register contract addresses in accounts table
    const acctValues: string[] = [];
    const acctParams: Array<string> = [];
    let acctIdx = 1;
    for (const addr of contractAddresses) {
      acctValues.push(`($${acctIdx++}, $${acctIdx++}, $${acctIdx++})`);
      acctParams.push(addr, height.toString(10), height.toString(10));
    }
    await client.query(
      `INSERT INTO accounts (address, first_seen_block, last_seen_block)
       VALUES ${acctValues.join(',')}
       ON CONFLICT (address) DO UPDATE SET
         last_seen_block = EXCLUDED.last_seen_block, updated_at = NOW()`,
      acctParams
    );

    // Refresh contract account balances
    for (const addr of contractAddresses) {
      await refreshAccountState(client, rpc, addr, blockHex, height);
    }

    await client.query('COMMIT');
    contractsDetected.inc(contractAddresses.size);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
