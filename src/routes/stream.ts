import { FastifyInstance } from 'fastify';
import { getStatsOverview } from '../db/queries.js';

const SSE_INTERVAL_MS = Math.max(Number(process.env.SSE_INTERVAL_MS || 5000), 3000);

export default async function streamRoutes(app: FastifyInstance) {
  // GET /stream — Server-Sent Events
  app.get('/', async (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    reply.raw.write('event: ready\ndata: connected\n\n');

    const send = async () => {
      try {
        const stats = await getStatsOverview();
        reply.raw.write(`data: ${JSON.stringify(stats)}\n\n`);
      } catch {
        // ignore SSE errors
      }
    };

    await send();
    const timer = setInterval(send, SSE_INTERVAL_MS);

    request.raw.on('close', () => {
      clearInterval(timer);
    });

    // Prevent Fastify from sending a response
    await new Promise(() => {});
  });
}
