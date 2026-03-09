/**
 * Miner API routes — list, earnings, vesting, contribution score.
 *
 * GET /miners — list all registered miners (paginated)
 * GET /miners/:address — full miner detail (earnings + vesting + score)
 * GET /miners/:address/earnings — earnings history with period filter
 * GET /miners/:address/vesting — vesting schedule
 */

import { FastifyInstance } from 'fastify';
import { rpcCall, rpcCallSafe } from '../lib/rpc.js';
import { cached } from '../lib/cache.js';

type RpcRegisteredMiner = {
  address: string;
  gpuModel: string;
  benchmarkScore: number;
  tier: number;
  vramMb: number;
  backend: string;
  registeredAt: string;
};

type RpcMinerEarning = {
  blockHeight: string;
  reward: string;
  taskType: string;
  flops: string;
  timestamp: string;
};

type RpcMinerVesting = {
  totalEarned: string;
  locked: string;
  available: string;
  activeTranches: number;
  tranches: Array<{
    blockHeight: string;
    amount: string;
    vested: string;
    startTime: string;
    cliffEnd: string;
    endTime: string;
    percentVested: number;
  }>;
};

type RpcContributionScore = {
  score: string;
};

function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

export default async function minersRoutes(app: FastifyInstance) {
  // GET /miners — list all registered miners
  app.get('/', async (request, reply) => {
    const query = request.query as { page?: string; limit?: string };
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 25));

    const data = await cached('miners:list', 30, async () => {
      const miners = await rpcCallSafe<RpcRegisteredMiner[]>('qfc_getRegisteredMiners', []);
      if (!miners) return { total: 0, items: [] as Array<RpcRegisteredMiner & { contributionScore: string }> };

      // Enrich with contribution scores in parallel
      const enriched = await Promise.all(
        miners.map(async (m) => {
          const score = await rpcCallSafe<{ score: string }>('qfc_getContributionScore', [m.address]);
          return {
            ...m,
            contributionScore: score?.score ?? '0',
          };
        })
      );

      return { total: enriched.length, items: enriched };
    });

    const start = (page - 1) * limit;
    const items = data.items.slice(start, start + limit);

    return {
      ok: true,
      data: {
        page,
        limit,
        total: data.total,
        items,
      },
    };
  });

  // GET /miners/:address — full miner detail
  app.get('/:address', async (request, reply) => {
    const { address } = request.params as { address: string };
    if (!isValidAddress(address)) {
      reply.status(400);
      return { ok: false, error: 'Invalid miner address' };
    }

    const data = await cached(`miners:${address}`, 15, async () => {
      const [earnings, vesting, contribution] = await Promise.all([
        rpcCallSafe<RpcMinerEarning[]>('qfc_getMinerEarnings', [address, 'all']),
        rpcCallSafe<RpcMinerVesting>('qfc_getMinerVesting', [address]),
        rpcCallSafe<RpcContributionScore>('qfc_getContributionScore', [address]),
      ]);

      return {
        address,
        totalEarned: vesting?.totalEarned ?? '0x0',
        locked: vesting?.locked ?? '0x0',
        available: vesting?.available ?? '0x0',
        activeTranches: vesting?.activeTranches ?? 0,
        contributionScore: contribution?.score ?? '0',
        earnings: earnings ?? [],
        tranches: vesting?.tranches ?? [],
      };
    });

    return { ok: true, data };
  });

  // GET /miners/:address/earnings?period=day|week|month|all
  app.get('/:address/earnings', async (request, reply) => {
    const { address } = request.params as { address: string };
    const query = request.query as { period?: string };
    if (!isValidAddress(address)) {
      reply.status(400);
      return { ok: false, error: 'Invalid miner address' };
    }

    const period = ['day', 'week', 'month', 'all'].includes(query.period ?? '')
      ? query.period!
      : 'all';

    const data = await cached(`miners:${address}:earnings:${period}`, 15, async () => {
      const earnings = await rpcCall<RpcMinerEarning[]>('qfc_getMinerEarnings', [address, period]);
      return { address, period, earnings };
    });

    return { ok: true, data };
  });

  // GET /miners/:address/vesting
  app.get('/:address/vesting', async (request, reply) => {
    const { address } = request.params as { address: string };
    if (!isValidAddress(address)) {
      reply.status(400);
      return { ok: false, error: 'Invalid miner address' };
    }

    const data = await cached(`miners:${address}:vesting`, 15, async () => {
      const vesting = await rpcCall<RpcMinerVesting>('qfc_getMinerVesting', [address]);
      return { address, ...vesting };
    });

    return { ok: true, data };
  });
}
