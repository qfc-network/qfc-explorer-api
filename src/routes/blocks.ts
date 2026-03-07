import { FastifyInstance } from 'fastify';
import { getBlocksPage, getBlockByHeight, getTransactionsByBlockHeight } from '../db/queries.js';
import { clamp, parseNumber, parseOrder } from '../lib/pagination.js';
import { cached } from '../lib/cache.js';

export default async function blocksRoutes(app: FastifyInstance) {
  // GET /blocks
  app.get('/', async (request) => {
    const q = request.query as Record<string, string>;
    const page = parseNumber(q.page, 1);
    const limit = clamp(parseNumber(q.limit, 25), 1, 100);
    const order = parseOrder(q.order);
    const producer = q.producer || null;
    const offset = (page - 1) * limit;

    const cacheKey = `blocks:${page}:${limit}:${order}:${producer || ''}`;
    const data = await cached(cacheKey, 5, async () => {
      const blocks = await getBlocksPage(limit, offset, order, producer);
      return { page, limit, order, producer, items: blocks };
    });
    return { ok: true, data };
  });

  // GET /blocks/:height
  app.get('/:height', async (request, reply) => {
    const { height } = request.params as { height: string };
    const q = request.query as Record<string, string>;
    const page = parseNumber(q.page, 1);
    const limit = clamp(parseNumber(q.limit, 25), 1, 100);
    const order = parseOrder(q.order);
    const offset = (page - 1) * limit;

    const cacheKey = `block:${height}:${page}:${limit}:${order}`;
    const data = await cached(cacheKey, 60, async () => {
      const block = await getBlockByHeight(height);
      if (!block) return null;
      const transactions = await getTransactionsByBlockHeight(height, limit, offset, order);
      return { block, page, limit, order, transactions };
    });

    if (!data) {
      reply.status(404);
      return { ok: false, error: 'Block not found' };
    }
    return { ok: true, data };
  });
}
