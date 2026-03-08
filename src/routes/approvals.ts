import { FastifyInstance } from 'fastify';
import { getReadPool } from '../db/pool.js';

// Approval(address indexed owner, address indexed spender, uint256 value) — ERC-20 & ERC-721
const APPROVAL_TOPIC0 = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c93090';

// ApprovalForAll(address indexed owner, address indexed operator, bool approved) — ERC-721 / ERC-1155
const APPROVAL_FOR_ALL_TOPIC0 = '0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31';

const MAX_UINT256 = BigInt('0x' + 'f'.repeat(64));

function padAddress(address: string): string {
  return '0x' + address.replace('0x', '').toLowerCase().padStart(64, '0');
}

function extractAddress(topic: string): string {
  return '0x' + topic.slice(-40).toLowerCase();
}

export default async function approvalRoutes(app: FastifyInstance) {
  // GET /approvals/:address — all token approvals for an address
  app.get('/:address', async (request, reply) => {
    const { address } = request.params as { address: string };

    if (!/^0x[a-fA-F0-9]{40}$/i.test(address)) {
      reply.status(400);
      return { ok: false, error: 'Invalid address format' };
    }

    const pool = getReadPool();
    const ownerPadded = padAddress(address);

    // Query both Approval and ApprovalForAll events where owner (topic1) matches
    const result = await pool.query(
      `SELECT e.contract_address AS token_address,
              e.topic0,
              e.topic2 AS spender_topic,
              e.data,
              e.block_height,
              e.tx_hash,
              t.name AS token_name,
              t.symbol AS token_symbol,
              t.decimals AS token_decimals,
              t.token_type
       FROM events e
       LEFT JOIN tokens t ON t.address = e.contract_address
       WHERE e.topic0 IN ($1, $2)
         AND e.topic1 = $3
       ORDER BY e.block_height DESC, e.log_index DESC`,
      [APPROVAL_TOPIC0, APPROVAL_FOR_ALL_TOPIC0, ownerPadded]
    );

    // Deduplicate: keep only the latest event per (token, spender, eventType)
    const latestMap = new Map<string, (typeof result.rows)[0]>();
    for (const row of result.rows) {
      const spender = extractAddress(row.spender_topic as string);
      const key = `${row.token_address}:${spender}:${row.topic0}`;
      if (!latestMap.has(key)) {
        latestMap.set(key, row);
      }
    }

    const approvals = [];
    for (const [, row] of latestMap) {
      const spender = extractAddress(row.spender_topic as string);
      const isApprovalForAll = row.topic0 === APPROVAL_FOR_ALL_TOPIC0;
      const dataHex = row.data ? (row.data as Buffer).toString('hex') : '0';

      let allowance: string;
      let isUnlimited: boolean;
      let approved: boolean | null = null;

      if (isApprovalForAll) {
        // data encodes bool: last byte is 0 or 1
        const boolVal = dataHex.length >= 64
          ? BigInt('0x' + dataHex.slice(0, 64))
          : 0n;
        approved = boolVal !== 0n;
        // Skip revoked ApprovalForAll
        if (!approved) continue;
        allowance = 'all';
        isUnlimited = true;
      } else {
        // ERC-20 / ERC-721 Approval — data encodes uint256 value
        allowance = dataHex.length >= 64
          ? BigInt('0x' + dataHex.slice(0, 64)).toString()
          : '0';
        // Skip zero (revoked) approvals
        if (allowance === '0') continue;
        isUnlimited = BigInt(allowance) === MAX_UINT256;
      }

      // Determine token type label
      let tokenType = row.token_type ?? 'ERC-20';
      if (isApprovalForAll && !row.token_type) {
        tokenType = 'erc721'; // ApprovalForAll is typically ERC-721 or ERC-1155
      }

      approvals.push({
        token: {
          address: row.token_address,
          name: row.token_name ?? null,
          symbol: row.token_symbol ?? null,
          type: tokenType,
          decimals: row.token_decimals ?? null,
        },
        spender,
        allowance,
        isUnlimited,
        approved,
        lastUpdatedBlock: row.block_height,
        lastUpdatedTx: row.tx_hash,
      });
    }

    return { ok: true, data: { address: address.toLowerCase(), approvals } };
  });
}
