import { FastifyInstance } from 'fastify';
import {
  getTokensPage, getTokenByAddress, getTokenTransfers,
  getTokenHolders, getNftHoldersByToken, getRecentTokenTransfers,
} from '../db/queries.js';
import { clamp, parseNumber, parseOrder, parseSort } from '../lib/pagination.js';
import { getTokenPrice, getTokenPrices, getTokenSparkline } from '../lib/price-service.js';
import { getReadPool } from '../db/pool.js';

// ---- NFT metadata helpers ----
const IPFS_GATEWAY = 'https://ipfs.io/ipfs/';
const NFT_METADATA_FETCH_TIMEOUT = 5000;

// In-memory cache: key = `${address}:${tokenId}`, value = { data, expiresAt }
const nftMetadataCache = new Map<string, { data: NftMetadataResult | null; expiresAt: number }>();
const NFT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

type NftAttribute = { trait_type?: string; value?: string | number };

type NftMetadataResult = {
  name?: string;
  description?: string;
  image?: string;
  attributes?: NftAttribute[];
};

function resolveUri(uri: string): string {
  if (!uri) return '';
  const trimmed = uri.trim();
  if (trimmed.startsWith('ipfs://ipfs/')) return IPFS_GATEWAY + trimmed.slice('ipfs://ipfs/'.length);
  if (trimmed.startsWith('ipfs://')) return IPFS_GATEWAY + trimmed.slice('ipfs://'.length);
  if (trimmed.startsWith('ar://')) return 'https://arweave.net/' + trimmed.slice('ar://'.length);
  if (trimmed.startsWith('data:') || trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  if (/^(Qm[1-9A-Za-z]{44}|bafy[a-z0-9]+)/i.test(trimmed)) return IPFS_GATEWAY + trimmed;
  return trimmed;
}

function encodeUint256(tokenId: string): string {
  return BigInt(tokenId).toString(16).padStart(64, '0');
}

function decodeAbiString(hex: string): string {
  const data = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (data.length < 128) return '';
  const len = parseInt(data.slice(64, 128), 16);
  if (isNaN(len) || len === 0) return '';
  const strHex = data.slice(128, 128 + len * 2);
  const bytes = new Uint8Array(strHex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(strHex.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder().decode(bytes);
}

async function fetchTokenUriViaRpc(contractAddress: string, tokenId: string): Promise<string | null> {
  const rpcUrl = process.env.RPC_URL || 'http://127.0.0.1:8545';
  const encoded = encodeUint256(tokenId);
  // tokenURI(uint256) = 0xc87b56dd, uri(uint256) = 0x0e89341c
  for (const selector of ['0xc87b56dd', '0x0e89341c']) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), NFT_METADATA_FETCH_TIMEOUT);
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: contractAddress, data: selector + encoded }, 'latest'] }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const json = await res.json() as { result?: string; error?: unknown };
      if (json.error || !json.result || json.result === '0x') continue;
      const uri = decodeAbiString(json.result);
      if (uri.length > 0) return uri;
    } catch { /* try next */ }
  }
  return null;
}

async function fetchNftMetadataFromUri(uri: string): Promise<NftMetadataResult | null> {
  const resolved = resolveUri(uri);
  // Handle data URIs
  if (resolved.startsWith('data:application/json')) {
    try {
      const json = resolved.includes(',') ? resolved.slice(resolved.indexOf(',') + 1) : '';
      const parsed = resolved.includes('base64,')
        ? JSON.parse(Buffer.from(json, 'base64').toString('utf-8'))
        : JSON.parse(decodeURIComponent(json));
      return normalizeNftMetadata(parsed);
    } catch { return null; }
  }
  if (!resolved.startsWith('http://') && !resolved.startsWith('https://')) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NFT_METADATA_FETCH_TIMEOUT);
    const res = await fetch(resolved, { signal: controller.signal, headers: { Accept: 'application/json' } });
    clearTimeout(timer);
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('text/html')) return null;
    const parsed = await res.json();
    return normalizeNftMetadata(parsed);
  } catch { return null; }
}

function normalizeNftMetadata(raw: Record<string, unknown>): NftMetadataResult {
  const meta: NftMetadataResult = {};
  if (typeof raw.name === 'string') meta.name = raw.name;
  if (typeof raw.description === 'string') meta.description = raw.description;
  const imageRaw = raw.image ?? raw.image_url ?? raw.image_data;
  if (typeof imageRaw === 'string' && imageRaw.length > 0) meta.image = resolveUri(imageRaw);
  if (Array.isArray(raw.attributes)) {
    meta.attributes = raw.attributes.map((a: Record<string, unknown>) => ({
      trait_type: typeof a.trait_type === 'string' ? a.trait_type : undefined,
      value: typeof a.value === 'string' || typeof a.value === 'number' ? a.value : undefined,
    }));
  }
  return meta;
}

async function getCachedNftMetadata(contractAddress: string, tokenId: string): Promise<NftMetadataResult | null> {
  const key = `${contractAddress.toLowerCase()}:${tokenId}`;
  const cached = nftMetadataCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  const tokenUri = await fetchTokenUriViaRpc(contractAddress, tokenId);
  if (!tokenUri) {
    nftMetadataCache.set(key, { data: null, expiresAt: Date.now() + NFT_CACHE_TTL_MS });
    return null;
  }
  const metadata = await fetchNftMetadataFromUri(tokenUri);
  nftMetadataCache.set(key, { data: metadata, expiresAt: Date.now() + NFT_CACHE_TTL_MS });
  return metadata;
}

const SORT_FIELDS = ['market_cap', 'holders', 'volume', 'price', 'name', 'transfers'] as const;
const TOKEN_TYPES = ['erc20', 'erc721', 'erc1155', 'all'] as const;

export default async function tokensRoutes(app: FastifyInstance) {
  // GET /tokens
  app.get('/', async (request) => {
    const q = request.query as Record<string, string>;
    const page = parseNumber(q.page, 1);
    const limit = clamp(parseNumber(q.limit, 25), 1, 100);
    const order = parseOrder(q.order);
    const sort = parseSort(q.sort, [...SORT_FIELDS], 'market_cap');
    const type = TOKEN_TYPES.includes(q.type as any) ? q.type : 'all';
    const offset = (page - 1) * limit;

    const pool = getReadPool();
    const direction = order === 'asc' ? 'ASC' : 'DESC';

    // Build WHERE clause for type filter
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (type !== 'all') {
      conditions.push(`t.token_type = $${paramIndex}`);
      params.push(type);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Build ORDER BY clause based on sort
    let orderByClause: string;
    switch (sort) {
      case 'holders':
        orderByClause = `holder_count ${direction} NULLS LAST`;
        break;
      case 'volume':
        orderByClause = `tp.volume_24h ${direction} NULLS LAST`;
        break;
      case 'price':
        orderByClause = `tp.price_usd ${direction} NULLS LAST`;
        break;
      case 'name':
        orderByClause = `t.name ${direction} NULLS LAST`;
        break;
      case 'transfers':
        orderByClause = `transfer_count ${direction} NULLS LAST`;
        break;
      case 'market_cap':
      default:
        orderByClause = `tp.market_cap_usd ${direction} NULLS LAST`;
        break;
    }

    params.push(limit, offset);
    const limitParam = `$${paramIndex}`;
    const offsetParam = `$${paramIndex + 1}`;

    const sql = `
      SELECT
        t.address, t.name, t.symbol, t.decimals, t.total_supply, t.last_seen_block, t.token_type,
        tp.price_usd, tp.market_cap_usd, tp.change_24h, tp.volume_24h,
        (SELECT COUNT(*)::int FROM token_balances tb WHERE tb.token_address = t.address AND tb.balance != '0') AS holder_count,
        (SELECT COUNT(*)::int FROM token_transfers tt WHERE tt.token_address = t.address) AS transfer_count
      FROM tokens t
      LEFT JOIN token_prices tp ON tp.token_address = t.address
      ${whereClause}
      ORDER BY ${orderByClause}
      LIMIT ${limitParam} OFFSET ${offsetParam}
    `;

    const result = await pool.query(sql, params);
    const items = result.rows.map((row: any) => ({
      address: row.address,
      name: row.name,
      symbol: row.symbol,
      decimals: row.decimals,
      total_supply: row.total_supply,
      last_seen_block: row.last_seen_block,
      token_type: row.token_type,
      price_usd: row.price_usd != null ? Number(row.price_usd) : null,
      market_cap_usd: row.market_cap_usd != null ? Number(row.market_cap_usd) : null,
      change_24h: row.change_24h != null ? Number(row.change_24h) : null,
      volume_24h: row.volume_24h != null ? Number(row.volume_24h) : null,
      holder_count: row.holder_count ?? 0,
      transfer_count: row.transfer_count ?? 0,
    }));

    // Get total count for pagination
    const countSql = `
      SELECT COUNT(*)::int AS total
      FROM tokens t
      LEFT JOIN token_prices tp ON tp.token_address = t.address
      ${whereClause}
    `;
    const countResult = await pool.query(countSql, params.slice(0, paramIndex - 1));
    const total = countResult.rows[0]?.total ?? 0;

    return { ok: true, data: { page, limit, order, sort, type, total, items } };
  });

  // GET /tokens/transfers — recent token transfers (all tokens)
  app.get('/transfers', async (request) => {
    const q = request.query as Record<string, string>;
    const page = parseNumber(q.page, 1);
    const limit = clamp(parseNumber(q.limit, 25), 1, 100);
    const order = parseOrder(q.order);
    const offset = (page - 1) * limit;
    const type = q.type; // optional: 'ERC-20', 'ERC-721', 'ERC-1155'
    const items = await getRecentTokenTransfers(limit, offset, order, type);
    return { ok: true, data: { page, limit, order, type: type ?? null, items } };
  });

  // GET /tokens/nfts/transfers — recent NFT transfers only (ERC-721 + ERC-1155)
  app.get('/nfts/transfers', async (request) => {
    const q = request.query as Record<string, string>;
    const page = parseNumber(q.page, 1);
    const limit = clamp(parseNumber(q.limit, 25), 1, 100);
    const order = parseOrder(q.order);
    const offset = (page - 1) * limit;
    const pool = getReadPool();
    const direction = order === 'asc' ? 'ASC' : 'DESC';

    const result = await pool.query(
      `SELECT tt.tx_hash, tt.block_height, tt.token_address, tt.from_address, tt.to_address,
              tt.value, tt.token_id,
              t.name AS token_name, t.symbol AS token_symbol, t.decimals AS token_decimals, t.token_type
       FROM token_transfers tt
       LEFT JOIN tokens t ON t.address = tt.token_address
       WHERE t.token_type IN ('erc721', 'erc1155')
       ORDER BY tt.block_height ${direction}, tt.log_index ${direction}
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );

    return { ok: true, data: { page, limit, order, type: 'nft', items: result.rows } };
  });

  // GET /tokens/nfts/mints — recent NFT mints inferred from zero-address transfers
  app.get('/nfts/mints', async (request) => {
    const q = request.query as Record<string, string>;
    const page = parseNumber(q.page, 1);
    const limit = clamp(parseNumber(q.limit, 25), 1, 100);
    const order = parseOrder(q.order);
    const offset = (page - 1) * limit;
    const pool = getReadPool();
    const direction = order === 'asc' ? 'ASC' : 'DESC';

    const result = await pool.query(
      `SELECT tt.tx_hash, tt.block_height, tt.token_address, tt.from_address, tt.to_address,
              tt.value, tt.token_id,
              t.name AS token_name, t.symbol AS token_symbol, t.decimals AS token_decimals, t.token_type
       FROM token_transfers tt
       LEFT JOIN tokens t ON t.address = tt.token_address
       WHERE t.token_type IN ('erc721', 'erc1155')
         AND LOWER(tt.from_address) = '0x0000000000000000000000000000000000000000'
       ORDER BY tt.block_height ${direction}, tt.log_index ${direction}
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );

    return { ok: true, data: { page, limit, order, type: 'nft_mint', items: result.rows } };
  });

  // GET /tokens/:address
  app.get('/:address', async (request, reply) => {
    const { address } = request.params as { address: string };
    const q = request.query as Record<string, string>;
    const page = parseNumber(q.page, 1);
    const limit = clamp(parseNumber(q.limit, 25), 1, 100);
    const order = parseOrder(q.order);
    const offset = (page - 1) * limit;

    const token = await getTokenByAddress(address);
    if (!token) {
      reply.status(404);
      return { ok: false, error: 'Token not found' };
    }

    const [transfers, price] = await Promise.all([
      getTokenTransfers(address, limit, offset, order),
      getTokenPrice(address),
    ]);
    return { ok: true, data: { token, price, page, limit, order, transfers } };
  });

  // GET /tokens/:address/holders
  app.get('/:address/holders', async (request, reply) => {
    const { address } = request.params as { address: string };
    const q = request.query as Record<string, string>;
    const limit = clamp(parseNumber(q.limit, 25), 1, 200);

    const token = await getTokenByAddress(address);
    if (!token) {
      reply.status(404);
      return { ok: false, error: 'Token not found' };
    }

    const [holders, nftHolders] = await Promise.all([
      getTokenHolders(address, limit),
      getNftHoldersByToken(address, limit),
    ]);

    return { ok: true, data: { token, holders, nftHolders } };
  });

  // GET /tokens/:address/sparkline — 7-day price history
  app.get('/:address/sparkline', async (request, reply) => {
    const { address } = request.params as { address: string };

    const token = await getTokenByAddress(address);
    if (!token) {
      reply.status(404);
      return { ok: false, error: 'Token not found' };
    }

    const sparkline = await getTokenSparkline(address);
    return { ok: true, data: { tokenAddress: address.toLowerCase(), sparkline } };
  });

  // GET /tokens/:address/nfts — paginated NFT gallery for a collection
  app.get('/:address/nfts', async (request, reply) => {
    const { address } = request.params as { address: string };
    const q = request.query as Record<string, string>;
    const page = parseNumber(q.page, 1);
    const limit = clamp(parseNumber(q.limit, 20), 1, 100);
    const offset = (page - 1) * limit;
    const addr = address.toLowerCase();

    const token = await getTokenByAddress(addr);
    if (!token) {
      reply.status(404);
      return { ok: false, error: 'Token not found' };
    }

    const pool = getReadPool();

    // Count total NFTs
    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS total FROM token_balances WHERE token_address = $1 AND balance != '0' AND token_id IS NOT NULL`,
      [addr],
    );
    const total = countRes.rows[0]?.total ?? 0;

    // Get paginated NFT items
    const itemsRes = await pool.query(
      `SELECT holder_address, token_id, balance
       FROM token_balances
       WHERE token_address = $1 AND balance != '0' AND token_id IS NOT NULL
       ORDER BY token_id::numeric ASC
       LIMIT $2 OFFSET $3`,
      [addr, limit, offset],
    );

    // Fetch metadata for each item (best effort, parallel with concurrency limit)
    const items = await Promise.all(
      itemsRes.rows.map(async (row: { holder_address: string; token_id: string; balance: string }) => {
        let metadata: NftMetadataResult | null = null;
        try {
          metadata = await getCachedNftMetadata(addr, row.token_id);
        } catch { /* non-critical */ }
        return {
          token_id: row.token_id,
          owner: row.holder_address,
          balance: row.balance,
          image: metadata?.image ?? null,
          name: metadata?.name ?? null,
        };
      }),
    );

    return { ok: true, data: { items, total, page, limit } };
  });

  // GET /tokens/:address/nft/:tokenId — individual NFT detail
  app.get('/:address/nft/:tokenId', async (request, reply) => {
    const { address, tokenId } = request.params as { address: string; tokenId: string };
    const addr = address.toLowerCase();

    const token = await getTokenByAddress(addr);
    if (!token) {
      reply.status(404);
      return { ok: false, error: 'Token not found' };
    }

    const pool = getReadPool();

    // Get current owner from token_balances
    const ownerRes = await pool.query(
      `SELECT holder_address, balance FROM token_balances
       WHERE token_address = $1 AND token_id = $2 AND balance != '0'
       ORDER BY balance::numeric DESC LIMIT 1`,
      [addr, tokenId],
    );
    const owner = ownerRes.rows[0]?.holder_address ?? null;

    // Get transfer history for this specific token ID
    const transfersRes = await pool.query(
      `SELECT tx_hash, block_height, from_address, to_address, value
       FROM token_transfers
       WHERE token_address = $1 AND token_id = $2
       ORDER BY block_height DESC, tx_hash
       LIMIT 100`,
      [addr, tokenId],
    );

    // Fetch metadata
    let metadata: NftMetadataResult | null = null;
    try {
      metadata = await getCachedNftMetadata(addr, tokenId);
    } catch { /* non-critical */ }

    return {
      ok: true,
      data: {
        token: {
          name: token.name,
          symbol: token.symbol,
          standard: token.token_type,
        },
        nft: {
          token_id: tokenId,
          owner,
          metadata: metadata
            ? {
                name: metadata.name ?? null,
                description: metadata.description ?? null,
                image: metadata.image ?? null,
                attributes: metadata.attributes ?? [],
              }
            : { name: null, description: null, image: null, attributes: [] },
          transfers: transfersRes.rows.map((r: any) => ({
            tx_hash: r.tx_hash,
            block_height: r.block_height,
            from_address: r.from_address,
            to_address: r.to_address,
            value: r.value,
          })),
        },
      },
    };
  });
}
