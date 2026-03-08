import type { FastifyPluginAsync } from 'fastify';
import { getStatsOverview, getStatsSeries } from '../db/queries.js';

const statsRoutes: FastifyPluginAsync = async (app) => {
  // GET /stats — network overview stats + mini chart series
  app.get('/', async (_req, reply) => {
    const [stats, series] = await Promise.all([
      getStatsOverview(),
      getStatsSeries(),
    ]);
    return reply.send({ ok: true, data: { stats, series } });
  });
};

export default statsRoutes;
