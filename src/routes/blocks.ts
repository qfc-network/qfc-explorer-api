import { FastifyInstance } from 'fastify';
import { getBlocksPage, getBlockByHeight, getTransactionsByBlockHeight } from '../db/queries.js';
import { clamp, parseNumber, parseOrder } from '../lib/pagination.js';

export default async function blocksRoutes(app: FastifyInstance) {
  // GET /blocks
  app.get('/', async (request) => {
    const q = request.query as Record<string, string>;
    const page = parseNumber(q.page, 1);
    const limit = clamp(parseNumber(q.limit, 25), 1, 100);
    const order = parseOrder(q.order);
    const producer = q.producer || null;
    const offset = (page - 1) * limit;
    const blocks = await getBlocksPage(limit, offset, order, producer);
    return { ok: true, data: { page, limit, order, producer, items: blocks } };
  });

  // GET /blocks/:height
  app.get('/:height', async (request, reply) => {
    const { height } = request.params as { height: string };
    const q = request.query as Record<string, string>;
    const page = parseNumber(q.page, 1);
    const limit = clamp(parseNumber(q.limit, 25), 1, 100);
    const order = parseOrder(q.order);
    const offset = (page - 1) * limit;

    const block = await getBlockByHeight(height);
    if (!block) {
      reply.status(404);
      return { ok: false, error: 'Block not found' };
    }

    const transactions = await getTransactionsByBlockHeight(height, limit, offset, order);
    return { ok: true, data: { block, page, limit, order, transactions } };
  });
}
