import crypto from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  updateApiKeyName,
  getApiKeyCount,
  getApiKeyUsage,
} from '../db/apikey-queries.js';

const MAX_KEYS = 3;

function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export default async function apikeysRoutes(app: FastifyInstance) {
  // All routes require user auth
  app.addHook('preHandler', requireAuth);

  // GET /api-keys — list user's API keys
  app.get('/', async (request, _reply) => {
    const userId = request.user!.userId;
    const keys = await listApiKeys(userId);

    // Enrich each key with recent usage
    const enrichedKeys = await Promise.all(
      keys.map(async (key) => {
        const usage = await getApiKeyUsage(key.id, 7);
        return {
          id: key.id,
          keyPrefix: key.key_prefix,
          name: key.name,
          tier: key.tier,
          rateLimit: key.rate_limit,
          dailyLimit: key.daily_limit,
          requestsToday: key.requests_today,
          lastUsedAt: key.last_used_at,
          createdAt: key.created_at,
          usage: usage.map((u) => ({ date: u.date, count: u.request_count })),
        };
      }),
    );

    return { ok: true, data: { keys: enrichedKeys } };
  });

  // POST /api-keys — create new key
  app.post('/', async (request, reply) => {
    const userId = request.user!.userId;
    const body = request.body as { name?: string };

    // Check max limit
    const count = await getApiKeyCount(userId);
    if (count >= MAX_KEYS) {
      reply.status(400);
      return { ok: false, error: `Maximum ${MAX_KEYS} API keys allowed.` };
    }

    const name = body.name?.trim() || 'Default';

    // Generate key: qfc_ + 64 hex chars (32 random bytes)
    const rawKey = 'qfc_' + crypto.randomBytes(32).toString('hex');
    const keyHash = hashKey(rawKey);
    const keyPrefix = rawKey.substring(0, 8); // "qfc_" + first 4 hex chars

    const row = await createApiKey(userId, name, keyHash, keyPrefix);

    return {
      ok: true,
      data: {
        key: rawKey, // Full key shown once — never again
        id: row.id,
        name: row.name,
        tier: row.tier,
        rateLimit: row.rate_limit,
        dailyLimit: row.daily_limit,
      },
    };
  });

  // DELETE /api-keys/:id — revoke key
  app.delete('/:id', async (request, reply) => {
    const userId = request.user!.userId;
    const { id } = request.params as { id: string };

    const revoked = await revokeApiKey(userId, id);
    if (!revoked) {
      reply.status(404);
      return { ok: false, error: 'API key not found.' };
    }

    return { ok: true, data: { revoked: true } };
  });

  // PATCH /api-keys/:id — rename key
  app.patch('/:id', async (request, reply) => {
    const userId = request.user!.userId;
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string };

    if (!body.name?.trim()) {
      reply.status(400);
      return { ok: false, error: 'Name is required.' };
    }

    const updated = await updateApiKeyName(userId, id, body.name.trim());
    if (!updated) {
      reply.status(404);
      return { ok: false, error: 'API key not found.' };
    }

    return { ok: true, data: { updated: true } };
  });

  // GET /api-keys/:id/usage — usage stats for last 30 days
  app.get('/:id/usage', async (request, _reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { days?: string };
    const days = Math.min(Math.max(Number(query.days) || 30, 1), 90);

    const usage = await getApiKeyUsage(id, days);

    return {
      ok: true,
      data: {
        usage: usage.map((u) => ({ date: u.date, count: u.request_count })),
      },
    };
  });
}
