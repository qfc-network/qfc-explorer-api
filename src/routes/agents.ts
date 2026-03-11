import { FastifyInstance } from 'fastify';
import { rpcCall, rpcCallSafe } from '../lib/rpc.js';
import { clamp, parseNumber, parseOrder } from '../lib/pagination.js';
import { getReadPool } from '../db/pool.js';
import { cached } from '../lib/cache.js';

const AGENT_REGISTRY = '0x7791dfa4d489f3d524708cbc0caa8689b76322b3';

// keccak256("AgentRegistered(string,address,address)")
const AGENT_REGISTERED_TOPIC =
  '0xd1bf50919b349548463604b43b8d3783b23a88dbf02737cb5ef0159d3ebdde4f';

// Function selectors
const GET_AGENT_SELECTOR = '0x794464e9';       // getAgent(string)
const GET_BY_OWNER_SELECTOR = '0x1ab6f888';    // getAgentsByOwner(address)

// ---- ABI helpers ----

function encodeString(s: string): string {
  const hex = Buffer.from(s, 'utf8').toString('hex');
  const len = (s.length).toString(16).padStart(64, '0');
  const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
  return len + padded;
}

function encodeAddress(addr: string): string {
  return addr.replace('0x', '').toLowerCase().padStart(64, '0');
}

function encodeSingleStringArg(s: string): string {
  // offset to string data (32 bytes = 0x20)
  const offset = '0000000000000000000000000000000000000000000000000000000000000020';
  return offset + encodeString(s);
}

function decodeAddress(hex: string): string {
  return '0x' + hex.slice(-40).toLowerCase();
}

function decodeUint256(hex: string): string {
  return BigInt('0x' + hex).toString();
}

function decodeBool(hex: string): boolean {
  return BigInt('0x' + hex) !== 0n;
}

function decodeStringFromData(data: string, wordOffset: number): string {
  // Read the offset pointer at wordOffset
  const offsetHex = data.slice(wordOffset * 64, wordOffset * 64 + 64);
  const byteOffset = Number(BigInt('0x' + offsetHex));
  const startWord = (byteOffset * 2) / 64;
  const len = Number(BigInt('0x' + data.slice(startWord * 64, startWord * 64 + 64)));
  if (len === 0) return '';
  const strHex = data.slice((startWord + 1) * 64, (startWord + 1) * 64 + len * 2);
  return Buffer.from(strHex, 'hex').toString('utf8');
}

function decodeUint8Array(data: string, wordOffset: number): number[] {
  const offsetHex = data.slice(wordOffset * 64, wordOffset * 64 + 64);
  const byteOffset = Number(BigInt('0x' + offsetHex));
  const startWord = (byteOffset * 2) / 64;
  const arrLen = Number(BigInt('0x' + data.slice(startWord * 64, startWord * 64 + 64)));
  const items: number[] = [];
  for (let i = 0; i < arrLen; i++) {
    items.push(Number(BigInt('0x' + data.slice((startWord + 1 + i) * 64, (startWord + 2 + i) * 64))));
  }
  return items;
}

type AgentAccount = {
  agentId: string;
  owner: string;
  agentAddress: string;
  permissions: number[];
  dailyLimit: string;
  maxPerTx: string;
  deposit: string;
  spentToday: string;
  lastSpendDay: string;
  registeredAt: string;
  active: boolean;
};

function decodeAgentAccount(resultHex: string): AgentAccount {
  // getAgent returns a tuple (struct). The outer result starts with an offset
  // to the tuple data, then the tuple fields follow.
  const data = resultHex.startsWith('0x') ? resultHex.slice(2) : resultHex;

  // First word is offset to tuple data
  const tupleOffset = Number(BigInt('0x' + data.slice(0, 64)));
  const t = data.slice(tupleOffset * 2); // tuple data

  // Word layout of the tuple:
  //  0: offset to agentId (string)
  //  1: owner (address)
  //  2: agentAddress (address)
  //  3: offset to permissions (uint8[])
  //  4: dailyLimit
  //  5: maxPerTx
  //  6: deposit
  //  7: spentToday
  //  8: lastSpendDay
  //  9: registeredAt
  // 10: active (bool)

  return {
    agentId: decodeStringFromData(t, 0),
    owner: decodeAddress(t.slice(1 * 64, 2 * 64)),
    agentAddress: decodeAddress(t.slice(2 * 64, 3 * 64)),
    permissions: decodeUint8Array(t, 3),
    dailyLimit: decodeUint256(t.slice(4 * 64, 5 * 64)),
    maxPerTx: decodeUint256(t.slice(5 * 64, 6 * 64)),
    deposit: decodeUint256(t.slice(6 * 64, 7 * 64)),
    spentToday: decodeUint256(t.slice(7 * 64, 8 * 64)),
    lastSpendDay: decodeUint256(t.slice(8 * 64, 9 * 64)),
    registeredAt: decodeUint256(t.slice(9 * 64, 10 * 64)),
    active: decodeBool(t.slice(10 * 64, 11 * 64)),
  };
}

function decodeStringArray(resultHex: string): string[] {
  const data = resultHex.startsWith('0x') ? resultHex.slice(2) : resultHex;
  if (data.length < 128) return [];

  // First word: offset to array data
  const arrOffset = Number(BigInt('0x' + data.slice(0, 64)));
  const arrData = data.slice(arrOffset * 2);

  // First word of array data: length
  const len = Number(BigInt('0x' + arrData.slice(0, 64)));
  const result: string[] = [];

  for (let i = 0; i < len; i++) {
    // Each element has an offset pointer (relative to array data start + 32 bytes for length)
    const elemOffsetHex = arrData.slice((1 + i) * 64, (2 + i) * 64);
    const elemByteOffset = Number(BigInt('0x' + elemOffsetHex));
    // Offset is relative to the start of the offsets section (after length word)
    const strStart = (1 * 64) + elemByteOffset * 2;
    const strLen = Number(BigInt('0x' + arrData.slice(strStart, strStart + 64)));
    if (strLen === 0) {
      result.push('');
      continue;
    }
    const strHex = arrData.slice(strStart + 64, strStart + 64 + strLen * 2);
    result.push(Buffer.from(strHex, 'hex').toString('utf8'));
  }

  return result;
}

export default async function agentsRoutes(app: FastifyInstance) {
  // GET /agents — list recent agent registrations via eth_getLogs
  app.get('/', async (request, reply) => {
    const q = request.query as Record<string, string>;
    const page = parseNumber(q.page, 1);
    const limit = clamp(parseNumber(q.limit, 50), 1, 100);

    type LogEntry = {
      topics: string[];
      data: string;
      blockNumber: string;
      transactionHash: string;
      logIndex: string;
    };

    const logs = await rpcCallSafe<LogEntry[]>('eth_getLogs', [{
      address: AGENT_REGISTRY,
      topics: [AGENT_REGISTERED_TOPIC],
      fromBlock: '0x0',
      toBlock: 'latest',
    }]);

    if (!logs) {
      reply.status(502);
      return { ok: false, error: 'Failed to fetch logs from RPC' };
    }

    // Most recent first
    const sorted = [...logs].reverse();
    const start = (page - 1) * limit;
    const paged = sorted.slice(start, start + limit);

    // Fetch block timestamps for the page
    const blockNumbers = [...new Set(paged.map((l) => l.blockNumber))];
    const blockTimestamps = new Map<string, number>();

    type BlockResult = { timestamp: string };
    await Promise.all(
      blockNumbers.map(async (bn) => {
        const block = await rpcCallSafe<BlockResult>('eth_getBlockByNumber', [bn, false]);
        if (block?.timestamp) {
          blockTimestamps.set(bn, Number(BigInt(block.timestamp)));
        }
      }),
    );

    const items = paged.map((log) => ({
      owner: decodeAddress(log.topics[2]),
      agentAddress: decodeAddress(log.data),
      blockNumber: Number(BigInt(log.blockNumber)),
      transactionHash: log.transactionHash,
      registeredAt: blockTimestamps.get(log.blockNumber) ?? null,
    }));

    return { ok: true, data: { page, limit, total: logs.length, items } };
  });

  // GET /agents/:agentId — get agent details via eth_call
  app.get('/:agentId', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };

    const calldata = GET_AGENT_SELECTOR + encodeSingleStringArg(agentId);

    const result = await rpcCallSafe<string>('eth_call', [
      { to: AGENT_REGISTRY, data: calldata },
      'latest',
    ]);

    if (!result || result === '0x') {
      reply.status(404);
      return { ok: false, error: 'Agent not found' };
    }

    try {
      const agent = decodeAgentAccount(result);
      if (!agent.agentId) {
        reply.status(404);
        return { ok: false, error: 'Agent not found' };
      }
      return { ok: true, data: agent };
    } catch {
      reply.status(502);
      return { ok: false, error: 'Failed to decode agent data' };
    }
  });

  // GET /agents/stats — aggregate stats
  app.get('/stats', async () => {
    const data = await cached('agents:stats', 30, async () => {
      const pool = getReadPool();
      const result = await pool.query(`
        SELECT
          COUNT(*)::int AS total_agents,
          COUNT(*) FILTER (WHERE active)::int AS active_agents,
          COALESCE(SUM(CAST(deposit AS NUMERIC)), 0)::text AS total_deposit,
          COALESCE(SUM(CAST(spent_today AS NUMERIC)), 0)::text AS total_spent_today
        FROM agents
      `);
      const row = result.rows[0];
      return {
        totalAgents: row?.total_agents ?? 0,
        activeAgents: row?.active_agents ?? 0,
        totalDeposit: row?.total_deposit ?? '0',
        totalSpentToday: row?.total_spent_today ?? '0',
      };
    });
    return { ok: true, data };
  });

  // GET /agents/dashboard — operator dashboard with alerts and spending trend
  app.get('/dashboard', async (request) => {
    const q = request.query as Record<string, string>;
    const ownerFilter = q.owner?.toLowerCase();

    const data = await cached(`agents:dashboard:${ownerFilter ?? 'all'}`, 15, async () => {
      const pool = getReadPool();

      // Agents
      const agentsQuery = ownerFilter
        ? pool.query('SELECT * FROM agents WHERE owner = $1 ORDER BY registered_at DESC', [ownerFilter])
        : pool.query('SELECT * FROM agents ORDER BY registered_at DESC LIMIT 100');
      const agentsResult = await agentsQuery;
      const agents = agentsResult.rows.map(formatAgentRow);

      // Stats
      let totalDeposit = 0n;
      let totalSpentToday = 0n;
      let activeCount = 0;
      for (const a of agents) {
        try { totalDeposit += BigInt(a.deposit); } catch { /* skip */ }
        try { totalSpentToday += BigInt(a.spentToday); } catch { /* skip */ }
        if (a.active) activeCount++;
      }

      // Alerts — agents at risk
      const alerts: Array<{ agentId: string; type: string; message: string; timestamp: string }> = [];
      for (const a of agents) {
        const spent = BigInt(a.spentToday || '0');
        const limit = BigInt(a.dailyLimit || '0');
        if (limit > 0n && spent >= limit) {
          alerts.push({ agentId: a.agentId, type: 'limit_reached', message: 'Daily spending limit reached', timestamp: a.registeredAt });
        } else if (limit > 0n && spent * 100n / limit >= 90n) {
          alerts.push({ agentId: a.agentId, type: 'high_spend', message: `Spent ${(Number(spent * 100n / limit))}% of daily limit`, timestamp: a.registeredAt });
        }
        if (!a.active) {
          alerts.push({ agentId: a.agentId, type: 'revoked', message: 'Agent has been revoked', timestamp: a.registeredAt });
        }
      }

      // Expiring session keys
      const now = Math.floor(Date.now() / 1000);
      const soonExpiry = now + 3600; // 1 hour
      const expiringKeys = await pool.query(
        `SELECT agent_id, expires_at FROM session_keys
         WHERE NOT revoked AND CAST(expires_at AS BIGINT) > $1 AND CAST(expires_at AS BIGINT) < $2`,
        [now.toString(), soonExpiry.toString()]
      );
      for (const k of expiringKeys.rows) {
        alerts.push({
          agentId: k.agent_id,
          type: 'key_expiring',
          message: 'Session key expiring within 1 hour',
          timestamp: k.expires_at,
        });
      }

      // Spending trend (last 7 days)
      const spendingResult = await pool.query(
        `SELECT date, SUM(CAST(amount AS NUMERIC))::text AS amount
         FROM agent_spending
         WHERE date >= (CURRENT_DATE - INTERVAL '7 days')::text
         ${ownerFilter ? 'AND agent_id IN (SELECT agent_id FROM agents WHERE owner = $1)' : ''}
         GROUP BY date ORDER BY date ASC`,
        ownerFilter ? [ownerFilter] : []
      );
      const spendingTrend = spendingResult.rows.map((r: { date: string; amount: string }) => ({
        date: r.date,
        amount: r.amount,
      }));

      return {
        stats: {
          totalAgents: agents.length,
          activeAgents: activeCount,
          totalDeposit: totalDeposit.toString(),
          totalSpentToday: totalSpentToday.toString(),
        },
        agents,
        alerts,
        spendingTrend,
      };
    });

    return { ok: true, data };
  });

  // GET /agents/owner/:address — list agents by owner
  app.get('/owner/:address', async (request, reply) => {
    const { address } = request.params as { address: string };

    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      reply.status(400);
      return { ok: false, error: 'Invalid address' };
    }

    const calldata = GET_BY_OWNER_SELECTOR + encodeAddress(address);

    const result = await rpcCallSafe<string>('eth_call', [
      { to: AGENT_REGISTRY, data: calldata },
      'latest',
    ]);

    if (!result || result === '0x') {
      return { ok: true, data: { owner: address.toLowerCase(), agentIds: [] } };
    }

    try {
      const agentIds = decodeStringArray(result);
      return { ok: true, data: { owner: address.toLowerCase(), agentIds } };
    } catch {
      reply.status(502);
      return { ok: false, error: 'Failed to decode agent list' };
    }
  });

  // GET /agents/:agentId/transactions — agent transaction history
  app.get('/:agentId/transactions', async (request) => {
    const { agentId } = request.params as { agentId: string };
    const q = request.query as Record<string, string>;
    const page = parseNumber(q.page, 1);
    const limit = clamp(parseNumber(q.limit, 25), 1, 100);
    const offset = (page - 1) * limit;

    const data = await cached(`agents:txs:${agentId}:${page}:${limit}`, 15, async () => {
      const pool = getReadPool();
      const countResult = await pool.query(
        'SELECT COUNT(*)::int AS total FROM agent_transactions WHERE agent_id = $1',
        [agentId]
      );
      const total = countResult.rows[0]?.total ?? 0;

      const txResult = await pool.query(
        `SELECT tx_hash, from_addr, to_addr, value, status, timestamp, method
         FROM agent_transactions WHERE agent_id = $1
         ORDER BY timestamp DESC LIMIT $2 OFFSET $3`,
        [agentId, limit, offset]
      );

      return {
        total,
        items: txResult.rows.map((r: Record<string, string | number>) => ({
          hash: r.tx_hash,
          from: r.from_addr,
          to: r.to_addr,
          value: r.value,
          status: r.status,
          timestamp: r.timestamp,
          method: r.method,
        })),
      };
    });

    return { ok: true, data };
  });

  // GET /agents/:agentId/session-keys — session keys for a specific agent
  app.get('/:agentId/session-keys', async (request) => {
    const { agentId } = request.params as { agentId: string };

    const data = await cached(`agents:keys:${agentId}`, 15, async () => {
      const pool = getReadPool();
      const result = await pool.query(
        `SELECT key_address, agent_id, owner, expires_at, revoked, permissions, last_activity_at, created_at
         FROM session_keys WHERE agent_id = $1
         ORDER BY created_at DESC`,
        [agentId]
      );

      const now = Math.floor(Date.now() / 1000);
      const items = result.rows.map((r: Record<string, unknown>) => {
        const expiresAt = Number(r.expires_at) || 0;
        const revoked = r.revoked as boolean;
        let status: string;
        if (revoked) status = 'revoked';
        else if (expiresAt > 0 && expiresAt < now) status = 'expired';
        else status = 'valid';

        const perms = (r.permissions as number[]) || [];
        return {
          keyAddress: r.key_address as string,
          agentId: r.agent_id as string,
          owner: r.owner as string,
          status,
          permissions: perms,
          permissionLabels: perms.map(permissionLabel),
          createdAt: String(Math.floor(new Date(r.created_at as string).getTime() / 1000)),
          expiresAt: String(expiresAt),
          lastActivityAt: r.last_activity_at ? String(r.last_activity_at) : null,
        };
      });

      return { total: items.length, items };
    });

    return { ok: true, data };
  });

  // GET /agents/:agentId/spending — spending analytics
  app.get('/:agentId/spending', async (request) => {
    const { agentId } = request.params as { agentId: string };
    const q = request.query as Record<string, string>;
    const days = clamp(parseNumber(q.days, 30), 1, 365);

    const data = await cached(`agents:spending:${agentId}:${days}`, 60, async () => {
      const pool = getReadPool();
      const result = await pool.query(
        `SELECT date, amount, tx_count
         FROM agent_spending WHERE agent_id = $1
           AND date >= (CURRENT_DATE - $2 * INTERVAL '1 day')::text
         ORDER BY date ASC`,
        [agentId, days]
      );

      let totalSpent = 0n;
      let totalTxs = 0;
      const daily = result.rows.map((r: Record<string, string | number>) => {
        try { totalSpent += BigInt(r.amount as string); } catch { /* skip */ }
        totalTxs += Number(r.tx_count) || 0;
        return { date: r.date, amount: String(r.amount), txCount: Number(r.tx_count) };
      });

      return {
        agentId,
        period: `${days}d`,
        totalSpent: totalSpent.toString(),
        totalTransactions: totalTxs,
        daily,
      };
    });

    return { ok: true, data };
  });
}

// ---- Helpers ----

const PERMISSION_LABELS: Record<number, string> = {
  0: 'InferenceSubmit',
  1: 'Transfer',
  2: 'StakeDelegate',
  3: 'QueryOnly',
};

function permissionLabel(perm: number): string {
  return PERMISSION_LABELS[perm] ?? `Permission(${perm})`;
}

function formatAgentRow(row: Record<string, unknown>): AgentAccount & { permissionLabels: string[] } {
  const perms = (row.permissions as number[]) || [];
  return {
    agentId: row.agent_id as string,
    owner: row.owner as string,
    agentAddress: row.agent_address as string,
    permissions: perms,
    permissionLabels: perms.map(permissionLabel),
    dailyLimit: String(row.daily_limit ?? '0'),
    maxPerTx: String(row.max_per_tx ?? '0'),
    deposit: String(row.deposit ?? '0'),
    spentToday: String(row.spent_today ?? '0'),
    lastSpendDay: String(row.last_spend_day ?? '0'),
    registeredAt: String(row.registered_at ?? '0'),
    active: row.active as boolean,
  };
}
