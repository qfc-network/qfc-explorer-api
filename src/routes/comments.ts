import { FastifyInstance } from 'fastify';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import {
  getComments,
  addComment,
  updateComment,
  deleteComment,
  flagComment,
  getRating,
  getAverageRating,
  upsertRating,
} from '../db/comments-queries.js';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const MAX_BODY_LENGTH = 2000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export default async function commentsRoutes(app: FastifyInstance) {
  // GET /comments/:address — list comments (public, paginated)
  app.get('/:address', async (request, reply) => {
    const { address } = request.params as { address: string };
    if (!ADDRESS_RE.test(address)) {
      reply.status(400);
      return { ok: false, error: 'Invalid address format' };
    }

    const q = request.query as Record<string, string>;
    const page = Math.max(1, parseInt(q.page || '1', 10) || 1);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(q.limit || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT));

    const { comments, total } = await getComments(address, page, limit);
    return { ok: true, data: { comments, total, page, limit } };
  });

  // POST /comments/:address — add comment (auth required)
  app.post('/:address', { preHandler: requireAuth }, async (request, reply) => {
    const { address } = request.params as { address: string };
    if (!ADDRESS_RE.test(address)) {
      reply.status(400);
      return { ok: false, error: 'Invalid address format' };
    }

    const body = request.body as { body?: string };
    if (!body.body || typeof body.body !== 'string' || body.body.trim().length === 0) {
      reply.status(400);
      return { ok: false, error: 'Comment body is required.' };
    }

    const text = body.body.trim();
    if (text.length > MAX_BODY_LENGTH) {
      reply.status(400);
      return { ok: false, error: `Comment must be ${MAX_BODY_LENGTH} characters or less.` };
    }

    const userId = request.user!.userId;
    const comment = await addComment(address, userId, text);
    if (!comment) {
      reply.status(429);
      return { ok: false, error: 'Maximum comments per contract reached (50).' };
    }

    return { ok: true, data: { comment } };
  });

  // PATCH /comments/:id — update own comment (auth required)
  app.patch('/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { body?: string };

    if (!body.body || typeof body.body !== 'string' || body.body.trim().length === 0) {
      reply.status(400);
      return { ok: false, error: 'Comment body is required.' };
    }

    const text = body.body.trim();
    if (text.length > MAX_BODY_LENGTH) {
      reply.status(400);
      return { ok: false, error: `Comment must be ${MAX_BODY_LENGTH} characters or less.` };
    }

    const userId = request.user!.userId;
    const comment = await updateComment(id, userId, text);
    if (!comment) {
      reply.status(404);
      return { ok: false, error: 'Comment not found or not yours.' };
    }

    return { ok: true, data: { comment } };
  });

  // DELETE /comments/:id — delete own comment (auth required)
  app.delete('/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user!.userId;

    const removed = await deleteComment(id, userId);
    if (!removed) {
      reply.status(404);
      return { ok: false, error: 'Comment not found or not yours.' };
    }

    return { ok: true, data: { deleted: true } };
  });

  // POST /comments/:id/flag — flag comment (auth required)
  app.post('/:id/flag', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user!.userId;

    const flagged = await flagComment(id, userId);
    if (!flagged) {
      reply.status(404);
      return { ok: false, error: 'Comment not found.' };
    }

    return { ok: true, data: { flagged: true } };
  });

  // GET /comments/:address/rating — get average rating (public)
  app.get('/:address/rating', async (request, reply) => {
    const { address } = request.params as { address: string };
    if (!ADDRESS_RE.test(address)) {
      reply.status(400);
      return { ok: false, error: 'Invalid address format' };
    }

    const avg = await getAverageRating(address);

    // If user is authenticated, also return their rating
    let userRating: number | null = null;
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      // Use optionalAuth pattern inline
      const { verifyAccessToken } = await import('../lib/auth.js');
      const token = authHeader.slice(7);
      const payload = verifyAccessToken(token);
      if (payload) {
        const rating = await getRating(address, payload.userId);
        userRating = rating?.rating ?? null;
      }
    }

    return { ok: true, data: { ...avg, userRating } };
  });

  // POST /comments/:address/rating — upsert own rating (auth required)
  app.post('/:address/rating', { preHandler: requireAuth }, async (request, reply) => {
    const { address } = request.params as { address: string };
    if (!ADDRESS_RE.test(address)) {
      reply.status(400);
      return { ok: false, error: 'Invalid address format' };
    }

    const body = request.body as { rating?: number };
    const rating = body.rating;
    if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) {
      reply.status(400);
      return { ok: false, error: 'Rating must be an integer between 1 and 5.' };
    }

    const userId = request.user!.userId;
    const result = await upsertRating(address, userId, rating);
    const avg = await getAverageRating(address);

    return { ok: true, data: { rating: result, ...avg } };
  });
}
