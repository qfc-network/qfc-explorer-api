import { getPool } from '../db/pool.js';
import type { BlockResult } from './block.js';
import { parseAddressFromTopic, hexToBigIntString } from './utils.js';

const AGENT_REGISTRY = '0x7791dfa4d489f3d524708cbc0caa8689b76322b3';

// Event topic hashes (keccak256)
// AgentRegistered(string agentId, address indexed owner, address agentAddress)
const AGENT_REGISTERED =
  '0xd1bf50919b349548463604b43b8d3783b23a88dbf02737cb5ef0159d3ebdde4f';
// AgentRevoked(string agentId, address indexed owner)
const AGENT_REVOKED =
  '0x3a3f387499c8b0bde40db7b1c33d04cacb5677b1964c5f0baa8ab450c1d4de05';
// AgentFunded(string agentId, address indexed funder, uint256 amount)
const AGENT_FUNDED =
  '0x0e3727596461ef354755ab0d45f429e6e3a87756bf81f0e8a0d6d6e082b2d4e2';
// SessionKeyIssued(string agentId, address indexed keyAddress, address indexed owner, uint256 expiresAt)
const SESSION_KEY_ISSUED =
  '0x5c6e3f1a25c687f8d7f68d3e3e3fb09b28a43da66c1c0e1bb8e1c9fb7aa6b47d';
// SessionKeyRevoked(string agentId, address indexed keyAddress, address indexed owner)
const SESSION_KEY_REVOKED =
  '0xa36d12e3be5a35ce5db5c9c3f7a4c5f8b50d0d7a3f4e28a0c12b4e4e7d6a19c3';

/**
 * Decode a dynamic string from ABI-encoded event data.
 * Assumes the string is the first dynamic param starting at the given byte offset.
 */
function decodeStringFromEventData(data: string, wordIndex: number): string {
  const d = data.startsWith('0x') ? data.slice(2) : data;
  // Read offset pointer at wordIndex
  const offsetHex = d.slice(wordIndex * 64, (wordIndex + 1) * 64);
  const byteOffset = Number(BigInt('0x' + offsetHex));
  // String length
  const lenStart = byteOffset * 2;
  const strLen = Number(BigInt('0x' + d.slice(lenStart, lenStart + 64)));
  if (strLen === 0) return '';
  const strHex = d.slice(lenStart + 64, lenStart + 64 + strLen * 2);
  return Buffer.from(strHex, 'hex').toString('utf8');
}

function decodeUint256FromWord(data: string, wordIndex: number): string {
  const d = data.startsWith('0x') ? data.slice(2) : data;
  return BigInt('0x' + d.slice(wordIndex * 64, (wordIndex + 1) * 64)).toString();
}

function decodeAddressFromWord(data: string, wordIndex: number): string {
  const d = data.startsWith('0x') ? data.slice(2) : data;
  return '0x' + d.slice(wordIndex * 64 + 24, (wordIndex + 1) * 64).toLowerCase();
}

/**
 * Process agent-related events from block receipts and sync to DB.
 */
export async function processAgentEvents(result: BlockResult): Promise<void> {
  const { receipts, height, block } = result;
  const registryAddr = AGENT_REGISTRY.toLowerCase();
  const blockHeight = height.toString(10);
  const blockTimestamp = hexToBigIntString(block.timestamp) ?? '0';

  // Collect agent events from receipts
  type AgentEvent = {
    topic: string;
    data: string;
    topics: string[];
    txHash: string;
    from: string;
    to: string | null | undefined;
    value: string;
    status: string;
  };

  const events: AgentEvent[] = [];

  for (const receipt of receipts) {
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== registryAddr) continue;
      const topic0 = (log.topics[0] ?? '').toLowerCase();
      if (
        topic0 === AGENT_REGISTERED ||
        topic0 === AGENT_REVOKED ||
        topic0 === AGENT_FUNDED ||
        topic0 === SESSION_KEY_ISSUED ||
        topic0 === SESSION_KEY_REVOKED
      ) {
        events.push({
          topic: topic0,
          data: log.data,
          topics: log.topics,
          txHash: receipt.transactionHash,
          from: receipt.from,
          to: receipt.to,
          value: hexToBigIntString(
            // Get value from the matching transaction
            result.txs.find((tx) => tx.hash === receipt.transactionHash)?.value ?? '0x0'
          ) ?? '0',
          status: receipt.status,
        });
      }
    }
  }

  if (events.length === 0) return;

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const ev of events) {
      if (ev.topic === AGENT_REGISTERED) {
        // data: (string agentId, address agentAddress) — agentId is dynamic, agentAddress at word 1
        const agentId = decodeStringFromEventData(ev.data, 0);
        const agentAddress = decodeAddressFromWord(ev.data, 1);
        const owner = parseAddressFromTopic(ev.topics[1] ?? '') ?? '';

        await client.query(
          `INSERT INTO agents (agent_id, owner, agent_address, registered_at, active)
           VALUES ($1, $2, $3, $4, true)
           ON CONFLICT (agent_id) DO UPDATE SET
             owner = EXCLUDED.owner,
             agent_address = EXCLUDED.agent_address,
             registered_at = EXCLUDED.registered_at,
             active = true,
             updated_at = NOW()`,
          [agentId, owner.toLowerCase(), agentAddress, blockTimestamp]
        );

        // Record the registration transaction
        await client.query(
          `INSERT INTO agent_transactions (agent_id, tx_hash, block_height, from_addr, to_addr, value, method, status, timestamp)
           VALUES ($1, $2, $3, $4, $5, $6, 'registerAgent', $7, $8)
           ON CONFLICT DO NOTHING`,
          [agentId, ev.txHash, blockHeight, ev.from.toLowerCase(), ev.to?.toLowerCase() ?? null, ev.value, parseInt(ev.status, 16), blockTimestamp]
        );
      }

      if (ev.topic === AGENT_REVOKED) {
        const agentId = decodeStringFromEventData(ev.data, 0);

        await client.query(
          `UPDATE agents SET active = false, updated_at = NOW() WHERE agent_id = $1`,
          [agentId]
        );

        await client.query(
          `INSERT INTO agent_transactions (agent_id, tx_hash, block_height, from_addr, to_addr, value, method, status, timestamp)
           VALUES ($1, $2, $3, $4, $5, '0', 'revokeAgent', $6, $7)
           ON CONFLICT DO NOTHING`,
          [agentId, ev.txHash, blockHeight, ev.from.toLowerCase(), ev.to?.toLowerCase() ?? null, parseInt(ev.status, 16), blockTimestamp]
        );
      }

      if (ev.topic === AGENT_FUNDED) {
        const agentId = decodeStringFromEventData(ev.data, 0);
        // amount is at word index after the string offset — need to figure layout
        // AgentFunded(string agentId, address indexed funder, uint256 amount)
        // data = (string agentId, uint256 amount) — funder is indexed (in topics[1])
        const amount = decodeUint256FromWord(ev.data, 1);

        // Update agent deposit
        await client.query(
          `UPDATE agents SET
             deposit = (CAST(deposit AS NUMERIC) + $2::NUMERIC)::TEXT,
             updated_at = NOW()
           WHERE agent_id = $1`,
          [agentId, amount]
        );

        await client.query(
          `INSERT INTO agent_transactions (agent_id, tx_hash, block_height, from_addr, to_addr, value, method, status, timestamp)
           VALUES ($1, $2, $3, $4, $5, $6, 'fundAgent', $7, $8)
           ON CONFLICT DO NOTHING`,
          [agentId, ev.txHash, blockHeight, ev.from.toLowerCase(), ev.to?.toLowerCase() ?? null, amount, parseInt(ev.status, 16), blockTimestamp]
        );

        // Update daily spending record
        const day = new Date(Number(blockTimestamp) * 1000).toISOString().slice(0, 10);
        await client.query(
          `INSERT INTO agent_spending (agent_id, date, amount, tx_count)
           VALUES ($1, $2, $3, 1)
           ON CONFLICT (agent_id, date) DO UPDATE SET
             amount = (CAST(agent_spending.amount AS NUMERIC) + $3::NUMERIC)::TEXT,
             tx_count = agent_spending.tx_count + 1`,
          [agentId, day, amount]
        );
      }

      if (ev.topic === SESSION_KEY_ISSUED) {
        // SessionKeyIssued(string agentId, address indexed keyAddress, address indexed owner, uint256 expiresAt)
        // data = (string agentId, uint256 expiresAt)
        const agentId = decodeStringFromEventData(ev.data, 0);
        const expiresAt = decodeUint256FromWord(ev.data, 1);
        const keyAddress = parseAddressFromTopic(ev.topics[1] ?? '') ?? '';
        const owner = parseAddressFromTopic(ev.topics[2] ?? '') ?? '';

        await client.query(
          `INSERT INTO session_keys (key_address, agent_id, owner, expires_at, revoked)
           VALUES ($1, $2, $3, $4, false)
           ON CONFLICT (key_address) DO UPDATE SET
             agent_id = EXCLUDED.agent_id,
             owner = EXCLUDED.owner,
             expires_at = EXCLUDED.expires_at,
             revoked = false`,
          [keyAddress.toLowerCase(), agentId, owner.toLowerCase(), expiresAt]
        );

        await client.query(
          `INSERT INTO agent_transactions (agent_id, tx_hash, block_height, from_addr, to_addr, value, method, status, timestamp)
           VALUES ($1, $2, $3, $4, $5, '0', 'issueSessionKey', $6, $7)
           ON CONFLICT DO NOTHING`,
          [agentId, ev.txHash, blockHeight, ev.from.toLowerCase(), ev.to?.toLowerCase() ?? null, parseInt(ev.status, 16), blockTimestamp]
        );
      }

      if (ev.topic === SESSION_KEY_REVOKED) {
        // SessionKeyRevoked(string agentId, address indexed keyAddress, address indexed owner)
        // data = (string agentId)
        const agentId = decodeStringFromEventData(ev.data, 0);
        const keyAddress = parseAddressFromTopic(ev.topics[1] ?? '') ?? '';

        await client.query(
          `UPDATE session_keys SET revoked = true WHERE key_address = $1`,
          [keyAddress.toLowerCase()]
        );

        await client.query(
          `INSERT INTO agent_transactions (agent_id, tx_hash, block_height, from_addr, to_addr, value, method, status, timestamp)
           VALUES ($1, $2, $3, $4, $5, '0', 'revokeSessionKey', $6, $7)
           ON CONFLICT DO NOTHING`,
          [agentId, ev.txHash, blockHeight, ev.from.toLowerCase(), ev.to?.toLowerCase() ?? null, parseInt(ev.status, 16), blockTimestamp]
        );
      }
    }

    await client.query('COMMIT');
    console.log(`[Agent] Processed ${events.length} agent events at block ${blockHeight}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
