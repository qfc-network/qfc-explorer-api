import { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import {
  addToWatchlist,
  removeFromWatchlist,
  getWatchlist,
  getWatchlistItem,
  updateWatchlistItem,
  getWatchlistCount,
} from '../db/watchlist-queries.js';
import { getAddressOverview, getAddressStats } from '../db/queries.js';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const MAX_WATCHLIST = 50;

export default async function watchlistRoutes(app: FastifyInstance) {
  // All routes require auth
  app.addHook('preHandler', requireAuth);

  // GET /watchlist — list user's watched addresses with current balances
  app.get('/', async (request, reply) => {
    const userId = request.user!.userId;
    const watchlist = await getWatchlist(userId);

    // Enrich each item with balance, txCount, lastActive from accounts table
    const items = await Promise.all(
      watchlist.map(async (item) => {
        const overview = await getAddressOverview(item.address);
        const stats = await getAddressStats(item.address);
        const txCount = stats
          ? Number(stats.sent) + Number(stats.received)
          : 0;

        return {
          address: item.address,
          label: item.label,
          balance: overview?.balance ?? '0',
          txCount,
          lastActive: overview?.last_seen_block ?? null,
          notifyIncoming: item.notify_incoming,
          notifyOutgoing: item.notify_outgoing,
          notifyThreshold: item.notify_threshold,
          webhookUrl: item.webhook_url,
          createdAt: item.created_at,
        };
      }),
    );

    return { ok: true, data: { items } };
  });

  // POST /watchlist — add address
  app.post('/', async (request, reply) => {
    const userId = request.user!.userId;
    const body = request.body as {
      address?: string;
      label?: string;
      notifyIncoming?: boolean;
      notifyOutgoing?: boolean;
      notifyThreshold?: string;
      webhookUrl?: string;
    };

    if (!body.address || !ADDRESS_RE.test(body.address)) {
      reply.status(400);
      return { ok: false, error: 'Invalid address format. Expected 0x + 40 hex characters.' };
    }

    // Check max limit
    const count = await getWatchlistCount(userId);
    if (count >= MAX_WATCHLIST) {
      reply.status(400);
      return { ok: false, error: `Maximum ${MAX_WATCHLIST} watched addresses allowed.` };
    }

    // Check for duplicate
    const existing = await getWatchlistItem(userId, body.address);
    if (existing) {
      reply.status(409);
      return { ok: false, error: 'Address is already in your watchlist.' };
    }

    const item = await addToWatchlist(
      userId,
      body.address,
      body.label,
      body.notifyIncoming,
      body.notifyOutgoing,
      body.notifyThreshold,
      body.webhookUrl,
    );

    return { ok: true, data: { item } };
  });

  // DELETE /watchlist/:address — remove address
  app.delete('/:address', async (request, reply) => {
    const userId = request.user!.userId;
    const { address } = request.params as { address: string };

    if (!ADDRESS_RE.test(address)) {
      reply.status(400);
      return { ok: false, error: 'Invalid address format.' };
    }

    const removed = await removeFromWatchlist(userId, address);
    if (!removed) {
      reply.status(404);
      return { ok: false, error: 'Address not found in watchlist.' };
    }

    return { ok: true, data: { removed: true } };
  });

  // PATCH /watchlist/:address — update settings
  app.patch('/:address', async (request, reply) => {
    const userId = request.user!.userId;
    const { address } = request.params as { address: string };
    const body = request.body as {
      label?: string;
      notifyIncoming?: boolean;
      notifyOutgoing?: boolean;
      notifyThreshold?: string | null;
      webhookUrl?: string | null;
    };

    if (!ADDRESS_RE.test(address)) {
      reply.status(400);
      return { ok: false, error: 'Invalid address format.' };
    }

    const item = await updateWatchlistItem(userId, address, {
      label: body.label,
      notifyIncoming: body.notifyIncoming,
      notifyOutgoing: body.notifyOutgoing,
      notifyThreshold: body.notifyThreshold,
      webhookUrl: body.webhookUrl,
    });

    if (!item) {
      reply.status(404);
      return { ok: false, error: 'Address not found in watchlist.' };
    }

    return { ok: true, data: { item } };
  });

  // GET /watchlist/:address/check — check if address is watched
  app.get('/:address/check', async (request, reply) => {
    const userId = request.user!.userId;
    const { address } = request.params as { address: string };

    if (!ADDRESS_RE.test(address)) {
      reply.status(400);
      return { ok: false, error: 'Invalid address format.' };
    }

    const item = await getWatchlistItem(userId, address);
    return { ok: true, data: { watching: item !== null, item } };
  });
}
