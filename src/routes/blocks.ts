import { FastifyInstance } from 'fastify';
import { getBlocksPage, getBlocksByCursor, getBlockByHeight, getTransactionsByBlockHeight, getInternalTxsByBlock } from '../db/queries.js';
import { clamp, parseNumber, parseOrder, parseCursor, encodeCursor } from '../lib/pagination.js';
import { cached } from '../lib/cache.js';

export default async function blocksRoutes(app: FastifyInstance) {
  // GET /blocks
  app.get('/', async (request) => {
    const q = request.query as Record<string, string>;
    const limit = clamp(parseNumber(q.limit, 25), 1, 100);
    const order = parseOrder(q.order);
    const producer = q.producer || null;

    // Cursor-based pagination (takes priority if provided)
    if (q.cursor) {
      const cur = parseCursor(q.cursor);
      if (!cur || cur.field !== 'height') {
        return { ok: false, error: 'Invalid cursor' };
      }
      const cacheKey = `blocks:cur:${q.cursor}:${limit}:${order}:${producer || ''}`;
      const data = await cached(cacheKey, 5, async () => {
        const blocks = await getBlocksByCursor(limit, cur.value, order, producer);
        const next_cursor = blocks.length === limit
          ? encodeCursor('height', blocks[blocks.length - 1].height)
          : null;
        return { limit, order, producer, items: blocks, next_cursor };
      });
      return { ok: true, data };
    }

    // Offset-based pagination (default)
    const page = parseNumber(q.page, 1);
    const offset = (page - 1) * limit;

    const cacheKey = `blocks:${page}:${limit}:${order}:${producer || ''}`;
    const data = await cached(cacheKey, 5, async () => {
      const blocks = await getBlocksPage(limit, offset, order, producer);
      const next_cursor = blocks.length === limit
        ? encodeCursor('height', blocks[blocks.length - 1].height)
        : null;
      return { page, limit, order, producer, items: blocks, next_cursor };
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

  // GET /blocks/:height/internal — internal transactions in a block
  app.get('/:height/internal', async (request, reply) => {
    const { height } = request.params as { height: string };
    const q = request.query as Record<string, string>;
    const page = parseNumber(q.page, 1);
    const limit = clamp(parseNumber(q.limit, 25), 1, 100);
    const offset = (page - 1) * limit;

    const block = await getBlockByHeight(height);
    if (!block) {
      reply.status(404);
      return { ok: false, error: 'Block not found' };
    }

    const items = await getInternalTxsByBlock(height, limit, offset);
    return { ok: true, data: { block_height: height, page, limit, items, total: items.length } };
  });
}
