import { FastifyInstance } from 'fastify';
import {
  getBlockByHeight, getBlockByHash, getTransactionByHash,
  getAddressOverview, searchTokensByName, searchTokensFts,
  searchBlockHeightPrefix, searchBlockHashPrefix,
  searchTransactionHashPrefix, searchAddressPrefix,
  searchContractsByName, searchAddressLabels, getAddressLabel,
} from '../db/queries.js';

type SearchResult = {
  type: 'block' | 'transaction' | 'address' | 'token' | 'contract' | 'label';
  data: unknown;
};

export default async function searchRoutes(app: FastifyInstance) {
  // GET /search — categorized search
  app.get('/', async (request, reply) => {
    const q = (request.query as Record<string, string>).q?.trim();
    if (!q) {
      reply.status(400);
      return { ok: false, error: 'Missing query parameter: q' };
    }

    const isNumeric = /^\d+$/.test(q);
    const isHex = /^0x[0-9a-fA-F]+$/i.test(q);
    const isAddress = isHex && q.length === 42;
    const isText = !isNumeric && !isHex && q.length >= 2;

    const [blockByHeight, blockByHash, transaction, address, tokens, contracts, labels] = await Promise.all([
      isNumeric ? getBlockByHeight(q) : null,
      isHex ? getBlockByHash(q) : null,
      isHex ? getTransactionByHash(q) : null,
      isAddress ? getAddressOverview(q.toLowerCase()) : null,
      isText ? searchTokensFts(q, 5).catch(() => searchTokensByName(q, 5)) : [],
      isText ? searchContractsByName(q, 5) : [],
      isText ? searchAddressLabels(q, 5) : [],
    ]);

    // Build categorized results
    const results: SearchResult[] = [];

    if (blockByHeight) results.push({ type: 'block', data: blockByHeight });
    if (blockByHash) results.push({ type: 'block', data: blockByHash });
    if (transaction) results.push({ type: 'transaction', data: transaction });
    if (address) {
      const label = await getAddressLabel(q.toLowerCase());
      results.push({ type: 'address', data: { ...address, label: label?.label ?? null, category: label?.category ?? null } });
    }
    for (const token of tokens as Array<Record<string, unknown>>) {
      results.push({ type: 'token', data: token });
    }
    for (const contract of contracts as Array<Record<string, unknown>>) {
      results.push({ type: 'contract', data: contract });
    }
    for (const label of labels as Array<Record<string, unknown>>) {
      results.push({ type: 'label', data: label });
    }

    return {
      ok: true,
      data: { query: q, total: results.length, results },
    };
  });

  // GET /search/suggest — autocomplete suggestions
  app.get('/suggest', async (request, reply) => {
    const q = (request.query as Record<string, string>).q?.trim();
    if (!q) {
      reply.status(400);
      return { ok: false, error: 'Missing query parameter: q' };
    }

    const isNumeric = /^\d+$/.test(q);
    const isHex = /^0x[0-9a-fA-F]+$/i.test(q);
    const isText = !isNumeric && !isHex && q.length >= 2;

    const [blockHeights, blockHashes, txHashes, addresses, tokens, contracts, labels] = await Promise.all([
      isNumeric ? searchBlockHeightPrefix(q, 5) : [],
      isHex ? searchBlockHashPrefix(q, 5) : [],
      isHex ? searchTransactionHashPrefix(q, 5) : [],
      isHex ? searchAddressPrefix(q, 5) : [],
      isText ? searchTokensFts(q, 5).catch(() => searchTokensByName(q, 5)) : [],
      isText ? searchContractsByName(q, 3) : [],
      isText ? searchAddressLabels(q, 3) : [],
    ]);

    return {
      ok: true,
      data: { query: q, blockHeights, blockHashes, txHashes, addresses, tokens, contracts, labels },
    };
  });
}
