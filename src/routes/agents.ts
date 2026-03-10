import { FastifyInstance } from 'fastify';
import { rpcCall, rpcCallSafe } from '../lib/rpc.js';
import { clamp, parseNumber } from '../lib/pagination.js';

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
}
