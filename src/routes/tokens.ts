import { FastifyInstance } from 'fastify';
import {
  getTokensPage, getTokenByAddress, getTokenTransfers,
  getTokenHolders, getNftHoldersByToken,
} from '../db/queries.js';
import { clamp, parseNumber, parseOrder } from '../lib/pagination.js';

export default async function tokensRoutes(app: FastifyInstance) {
  // GET /tokens
  app.get('/', async (request) => {
    const q = request.query as Record<string, string>;
    const page = parseNumber(q.page, 1);
    const limit = clamp(parseNumber(q.limit, 25), 1, 100);
    const order = parseOrder(q.order);
    const offset = (page - 1) * limit;
    const items = await getTokensPage(limit, offset, order);
    return { ok: true, data: { page, limit, order, items } };
  });

  // GET /tokens/:address
  app.get('/:address', async (request, reply) => {
    const { address } = request.params as { address: string };
    const q = request.query as Record<string, string>;
    const page = parseNumber(q.page, 1);
    const limit = clamp(parseNumber(q.limit, 25), 1, 100);
    const order = parseOrder(q.order);
    const offset = (page - 1) * limit;

    const token = await getTokenByAddress(address);
    if (!token) {
      reply.status(404);
      return { ok: false, error: 'Token not found' };
    }

    const transfers = await getTokenTransfers(address, limit, offset, order);
    return { ok: true, data: { token, page, limit, order, transfers } };
  });

  // GET /tokens/:address/holders
  app.get('/:address/holders', async (request, reply) => {
    const { address } = request.params as { address: string };
    const q = request.query as Record<string, string>;
    const limit = clamp(parseNumber(q.limit, 25), 1, 200);

    const token = await getTokenByAddress(address);
    if (!token) {
      reply.status(404);
      return { ok: false, error: 'Token not found' };
    }

    const [holders, nftHolders] = await Promise.all([
      getTokenHolders(address, limit),
      getNftHoldersByToken(address, limit),
    ]);

    return { ok: true, data: { token, holders, nftHolders } };
  });
}
