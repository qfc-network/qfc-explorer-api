import { FastifyInstance } from 'fastify';
import { getReadPool } from '../db/pool.js';
import { cached } from '../lib/cache.js';

const MAX_ADDRESSES = 20;
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export default async function batchRoutes(app: FastifyInstance) {
  // POST /batch/addresses — batch query multiple addresses
  app.post('/addresses', async (request, reply) => {
    const body = request.body as { addresses?: string[] };

    if (!body.addresses || !Array.isArray(body.addresses)) {
      reply.status(400);
      return { ok: false, error: 'Missing or invalid "addresses" array' };
    }

    if (body.addresses.length === 0) {
      reply.status(400);
      return { ok: false, error: 'Addresses array must not be empty' };
    }

    if (body.addresses.length > MAX_ADDRESSES) {
      reply.status(400);
      return { ok: false, error: `Maximum ${MAX_ADDRESSES} addresses allowed per request` };
    }

    // Validate and normalize addresses
    const addresses: string[] = [];
    for (const addr of body.addresses) {
      if (typeof addr !== 'string' || !ADDRESS_RE.test(addr)) {
        reply.status(400);
        return { ok: false, error: `Invalid address format: ${addr}` };
      }
      addresses.push(addr.toLowerCase());
    }

    // Deduplicate
    const uniqueAddresses = [...new Set(addresses)];

    const cacheKey = `batch:addresses:${uniqueAddresses.sort().join(',')}`;
    const data = await cached(cacheKey, 15, async () => {
      const pool = getReadPool();

      // Run all queries in parallel using ANY($1) for efficiency
      const [accountsResult, txCountsResult, labelsResult, contractsResult] = await Promise.all([
        // Balances and nonces from accounts table
        pool.query(
          `SELECT address, balance, nonce
           FROM accounts
           WHERE address = ANY($1)`,
          [uniqueAddresses]
        ),
        // Transaction counts (sent + received)
        pool.query(
          `SELECT
             address,
             COALESCE(sent, 0)::int AS sent,
             COALESCE(received, 0)::int AS received
           FROM (
             SELECT
               a.address,
               (SELECT COUNT(*) FROM transactions WHERE from_address = a.address) AS sent,
               (SELECT COUNT(*) FROM transactions WHERE to_address = a.address) AS received
             FROM unnest($1::text[]) AS a(address)
           ) sub`,
          [uniqueAddresses]
        ),
        // Labels from address_labels table
        pool.query(
          `SELECT address, label
           FROM address_labels
           WHERE address = ANY($1)`,
          [uniqueAddresses]
        ),
        // Contract check
        pool.query(
          `SELECT address
           FROM contracts
           WHERE address = ANY($1)`,
          [uniqueAddresses]
        ),
      ]);

      // Build lookup maps
      const accountMap = new Map<string, { balance: string; nonce: number }>();
      for (const row of accountsResult.rows) {
        accountMap.set(row.address, {
          balance: row.balance ?? '0',
          nonce: Number(row.nonce ?? 0),
        });
      }

      const txCountMap = new Map<string, { sent: number; received: number }>();
      for (const row of txCountsResult.rows) {
        txCountMap.set(row.address, {
          sent: Number(row.sent),
          received: Number(row.received),
        });
      }

      const labelMap = new Map<string, string>();
      for (const row of labelsResult.rows) {
        labelMap.set(row.address, row.label);
      }

      const contractSet = new Set<string>();
      for (const row of contractsResult.rows) {
        contractSet.add(row.address);
      }

      // Assemble response in the order requested
      const addressResults = uniqueAddresses.map((addr) => {
        const account = accountMap.get(addr);
        const txCount = txCountMap.get(addr);
        return {
          address: addr,
          balance: account?.balance ?? '0',
          nonce: account?.nonce ?? 0,
          tx_count: {
            sent: txCount?.sent ?? 0,
            received: txCount?.received ?? 0,
          },
          label: labelMap.get(addr) ?? null,
          is_contract: contractSet.has(addr),
        };
      });

      return { addresses: addressResults };
    });

    return { ok: true, data };
  });
}
