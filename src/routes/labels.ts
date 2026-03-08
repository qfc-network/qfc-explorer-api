import { FastifyInstance } from 'fastify';
import { listAddressLabelsByCategory, countAddressLabels, submitAddressLabel, searchAddressLabels } from '../db/queries.js';
import { requireAuth } from '../middleware/auth.js';
import { clamp, parseNumber } from '../lib/pagination.js';

export default async function labelsRoutes(app: FastifyInstance) {
  // GET /labels — public listing of all approved labels with categories
  app.get('/', async (request) => {
    const q = request.query as Record<string, string>;
    const category = q.category || undefined;
    const search = q.q || undefined;
    const page = parseNumber(q.page, 1);
    const limit = clamp(parseNumber(q.limit, 50), 1, 200);
    const offset = (page - 1) * limit;

    if (search) {
      const labels = await searchAddressLabels(search, limit);
      const filtered = category && category !== 'all'
        ? labels.filter((l: { category?: string }) => l.category === category)
        : labels;
      return {
        ok: true,
        data: {
          labels: filtered.map((l: Record<string, unknown>) => ({
            address: l.address,
            name: l.label,
            category: l.category || 'other',
            description: l.description || null,
            logoUrl: l.logo_url || null,
            verified: l.verified ?? true,
          })),
          total: filtered.length,
          page,
          limit,
        },
      };
    }

    const [labels, total] = await Promise.all([
      listAddressLabelsByCategory(category, limit, offset),
      countAddressLabels(category),
    ]);

    return {
      ok: true,
      data: {
        labels: labels.map((l: Record<string, unknown>) => ({
          address: l.address,
          name: l.label,
          category: l.category || 'other',
          description: l.description || null,
          logoUrl: l.logo_url || null,
          verified: l.verified ?? true,
        })),
        total,
        page,
        limit,
      },
    };
  });

  // POST /labels/submit — authenticated users can submit label suggestions
  app.post('/submit', { preHandler: [requireAuth] }, async (request, reply) => {
    const body = request.body as {
      address: string;
      name: string;
      category?: string;
      description?: string;
    };

    if (!body.address || !body.name) {
      reply.status(400);
      return { ok: false, error: 'Missing address or name' };
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(body.address)) {
      reply.status(400);
      return { ok: false, error: 'Invalid address format' };
    }

    const validCategories = ['exchange', 'defi', 'bridge', 'mev', 'token', 'whale', 'validator', 'system', 'other'];
    const category = body.category && validCategories.includes(body.category) ? body.category : 'other';

    const userId = request.user!.userId;
    await submitAddressLabel(body.address, body.name, category, body.description, userId);

    return {
      ok: true,
      data: {
        address: body.address.toLowerCase(),
        name: body.name,
        category,
        status: 'pending',
      },
    };
  });
}
