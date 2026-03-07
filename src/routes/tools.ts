import { FastifyInstance } from 'fastify';
import sha3 from 'js-sha3';
const { keccak256 } = sha3;

export default async function toolsRoutes(app: FastifyInstance) {
  // GET /tools/keccak256
  app.get('/keccak256', async (request, reply) => {
    const q = request.query as Record<string, string>;
    if (!q.input) {
      reply.status(400);
      return { ok: false, error: 'Missing input parameter' };
    }
    const hash = '0x' + keccak256(q.input);
    return { ok: true, data: { input: q.input, hash } };
  });
}
