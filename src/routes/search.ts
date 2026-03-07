import { FastifyInstance } from 'fastify';
import {
  getBlockByHeight, getBlockByHash, getTransactionByHash,
  getAddressOverview, searchTokensByName,
  searchBlockHeightPrefix, searchBlockHashPrefix,
  searchTransactionHashPrefix, searchAddressPrefix,
} from '../db/queries.js';

export default async function searchRoutes(app: FastifyInstance) {
  // GET /search
  app.get('/', async (request, reply) => {
    const q = (request.query as Record<string, string>).q?.trim();
    if (!q) {
      reply.status(400);
      return { ok: false, error: 'Missing query parameter: q' };
    }

    const isNumeric = /^\d+$/.test(q);
    const isHex = /^0x[0-9a-fA-F]+$/i.test(q);
    const isText = !isNumeric && !isHex && q.length >= 2;

    const [blockByHeight, blockByHash, transaction, address, tokens] = await Promise.all([
      isNumeric ? getBlockByHeight(q) : null,
      isHex ? getBlockByHash(q) : null,
      isHex ? getTransactionByHash(q) : null,
      isHex && q.length === 42 ? getAddressOverview(q.toLowerCase()) : null,
      isText ? searchTokensByName(q, 5) : [],
    ]);

    return {
      ok: true,
      data: { query: q, blockByHeight, blockByHash, transaction, address, tokens },
    };
  });

  // GET /search/suggest
  app.get('/suggest', async (request, reply) => {
    const q = (request.query as Record<string, string>).q?.trim();
    if (!q) {
      reply.status(400);
      return { ok: false, error: 'Missing query parameter: q' };
    }

    const isNumeric = /^\d+$/.test(q);
    const isHex = /^0x[0-9a-fA-F]+$/i.test(q);
    const isText = !isNumeric && !isHex && q.length >= 2;

    const [blockHeights, blockHashes, txHashes, addresses, tokens] = await Promise.all([
      isNumeric ? searchBlockHeightPrefix(q, 5) : [],
      isHex ? searchBlockHashPrefix(q, 5) : [],
      isHex ? searchTransactionHashPrefix(q, 5) : [],
      isHex ? searchAddressPrefix(q, 5) : [],
      isText ? searchTokensByName(q, 5) : [],
    ]);

    return {
      ok: true,
      data: { query: q, blockHeights, blockHashes, txHashes, addresses, tokens },
    };
  });
}
