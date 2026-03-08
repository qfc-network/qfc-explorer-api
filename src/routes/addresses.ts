import { FastifyInstance } from 'fastify';
import {
  getAddressOverview, getAddressStats, getAddressAnalysis,
  getContractByAddress, getTokenHoldingsByAddress, getNftHoldingsByAddress,
  getAddressTransactions, getTokenTransfersByAddress,
  getInternalTxsByAddress, getAddressLabel, getTokenApprovalsByOwner,
} from '../db/queries.js';
import { getReadPool } from '../db/pool.js';
import { rpcCallSafe } from '../lib/rpc.js';
import { clamp, parseNumber, parseOrder } from '../lib/pagination.js';
import { cached } from '../lib/cache.js';

export default async function addressesRoutes(app: FastifyInstance) {
  // GET /address/:address
  app.get('/:address', async (request) => {
    const { address } = request.params as { address: string };
    const q = request.query as Record<string, string>;
    const tab = q.tab || 'transactions';
    const page = parseNumber(q.page, 1);
    const limit = clamp(parseNumber(q.limit, 25), 1, 100);
    const order = parseOrder(q.order);
    const offset = (page - 1) * limit;

    const [overview, stats, analysis, contract, tokenHoldings, nftHoldings, label] = await Promise.all([
      getAddressOverview(address),
      getAddressStats(address),
      getAddressAnalysis(address),
      getContractByAddress(address),
      getTokenHoldingsByAddress(address),
      getNftHoldingsByAddress(address),
      getAddressLabel(address),
    ]);

    let transactions = null;
    let tokenTransfers = null;
    let internalTxs = null;

    if (tab === 'token_transfers') {
      tokenTransfers = await getTokenTransfersByAddress(address, limit, offset, order);
    } else if (tab === 'internal_txs') {
      internalTxs = await getInternalTxsByAddress(address, limit, offset, order);
    } else {
      transactions = await getAddressTransactions(address, limit, offset, order);
    }

    return {
      ok: true,
      data: {
        address, label, overview, stats, analysis, contract,
        tokenHoldings, nftHoldings,
        tab, page, limit, order, transactions, tokenTransfers, internalTxs,
      },
    };
  });

  // GET /address/:address/export — CSV export for address transactions or token transfers
  // Supports optional date range: ?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
  app.get('/:address/export', async (request, reply) => {
    const { address } = request.params as { address: string };
    const q = request.query as Record<string, string>;
    const type = q.type || 'transactions'; // transactions | token_transfers
    const limit = clamp(parseNumber(q.limit, 5000), 100, 10000);
    const order = parseOrder(q.order);
    const direction = order === 'asc' ? 'ASC' : 'DESC';
    const pool = getReadPool();

    // Date range filter: resolve to block height range via blocks table
    let startBlock: string | null = null;
    let endBlock: string | null = null;
    if (q.start_date) {
      const ts = new Date(q.start_date).getTime();
      if (!isNaN(ts)) {
        const r = await pool.query('SELECT MIN(height) AS h FROM blocks WHERE timestamp_ms >= $1', [ts]);
        startBlock = r.rows[0]?.h ?? null;
      }
    }
    if (q.end_date) {
      const ts = new Date(q.end_date).getTime() + 86400000; // end of day
      if (!isNaN(ts)) {
        const r = await pool.query('SELECT MAX(height) AS h FROM blocks WHERE timestamp_ms < $1', [ts]);
        endBlock = r.rows[0]?.h ?? null;
      }
    }

    let csv = '';

    if (type === 'token_transfers') {
      const params: (string | number)[] = [address, limit];
      let dateFilter = '';
      if (startBlock) { params.push(startBlock); dateFilter += ` AND tt.block_height >= $${params.length}`; }
      if (endBlock) { params.push(endBlock); dateFilter += ` AND tt.block_height <= $${params.length}`; }

      const result = await pool.query(
        `SELECT tt.tx_hash, tt.block_height, tt.token_address, tt.from_address, tt.to_address, tt.value,
                t.symbol AS token_symbol, t.decimals AS token_decimals
         FROM token_transfers tt LEFT JOIN tokens t ON t.address = tt.token_address
         WHERE (tt.from_address = $1 OR tt.to_address = $1)${dateFilter}
         ORDER BY tt.block_height ${direction}, tt.log_index ${direction}
         LIMIT $2`,
        params
      );
      const headers = ['tx_hash', 'block_height', 'token_address', 'from_address', 'to_address', 'value', 'token_symbol', 'token_decimals'];
      csv = [headers.join(','), ...result.rows.map((r: Record<string, unknown>) =>
        headers.map((h) => String(r[h] ?? '')).join(',')
      )].join('\n');
    } else {
      const params: (string | number)[] = [address, limit];
      let dateFilter = '';
      if (startBlock) { params.push(startBlock); dateFilter += ` AND block_height >= $${params.length}`; }
      if (endBlock) { params.push(endBlock); dateFilter += ` AND block_height <= $${params.length}`; }

      const result = await pool.query(
        `SELECT hash, block_height, from_address, to_address, value, status, gas_used, gas_price
         FROM transactions WHERE (from_address = $1 OR to_address = $1)${dateFilter}
         ORDER BY block_height ${direction}, tx_index ${direction}
         LIMIT $2`,
        params
      );
      const headers = ['hash', 'block_height', 'from_address', 'to_address', 'value', 'status', 'gas_used', 'gas_price'];
      csv = [headers.join(','), ...result.rows.map((r: Record<string, unknown>) =>
        headers.map((h) => String(r[h] ?? '')).join(',')
      )].join('\n');
    }

    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', `attachment; filename=qfc-${address.slice(0, 10)}-${type}.csv`);
    return csv;
  });

  // GET /address/:address/approvals — token approval checker
  app.get('/:address/approvals', async (request) => {
    const { address } = request.params as { address: string };

    const rawApprovals = await getTokenApprovalsByOwner(address);

    // Deduplicate: keep only the latest approval per (token, spender)
    const latestMap = new Map<string, typeof rawApprovals[0]>();
    for (const row of rawApprovals) {
      const spender = '0x' + (row.spender_topic as string).slice(-40);
      const key = `${row.token_address}:${spender}`;
      if (!latestMap.has(key)) {
        latestMap.set(key, row);
      }
    }

    // Parse and enrich
    const approvals = [];
    for (const [, row] of latestMap) {
      const spender = '0x' + (row.spender_topic as string).slice(-40);
      const dataHex = row.data ? (row.data as Buffer).toString('hex') : '0';
      const allowance = dataHex.length >= 64 ? BigInt('0x' + dataHex.slice(0, 64)).toString() : '0';

      // Skip zero (revoked) approvals
      if (allowance === '0') continue;

      const isUnlimited = BigInt(allowance) >= BigInt('0x' + 'f'.repeat(64)) / 2n;

      approvals.push({
        tokenAddress: row.token_address,
        tokenName: row.token_name ?? null,
        tokenSymbol: row.token_symbol ?? null,
        tokenDecimals: row.token_decimals ?? null,
        spender,
        allowance,
        isUnlimited,
        blockHeight: row.block_height,
        txHash: row.tx_hash,
      });
    }

    return { ok: true, data: { address, approvals } };
  });

  // GET /address/:address/nft-metadata — fetch NFT tokenURI + metadata for holdings
  app.get('/:address/nft-metadata', async (request) => {
    const { address } = request.params as { address: string };
    const holdings = await getNftHoldingsByAddress(address);

    const results = await Promise.all(
      holdings.slice(0, 20).map(async (nft: Record<string, unknown>) => {
        const tokenAddress = String(nft.token_address);
        const tokenId = String(nft.token_id);
        const cacheKey = `nft:meta:${tokenAddress}:${tokenId}`;

        const metadata = await cached(cacheKey, 3600, async () => {
          return fetchNftMetadata(tokenAddress, tokenId);
        });

        return {
          tokenAddress,
          tokenId,
          tokenName: nft.token_name ?? null,
          tokenSymbol: nft.token_symbol ?? null,
          tokenType: nft.token_type ?? null,
          balance: nft.balance ?? '1',
          metadata,
        };
      })
    );

    return { ok: true, data: { address, nfts: results } };
  });
}

// Fetch tokenURI and resolve metadata
async function fetchNftMetadata(tokenAddress: string, tokenId: string) {
  try {
    // tokenURI(uint256) selector = 0xc87b56dd
    const tokenIdHex = BigInt(tokenId).toString(16).padStart(64, '0');
    const data = '0xc87b56dd' + tokenIdHex;

    const raw = await rpcCallSafe<string>('eth_call', [
      { to: tokenAddress, data },
      'latest',
    ]);

    if (!raw || raw === '0x') {
      // Try ERC-1155 uri(uint256) = 0x0e89341c
      const raw1155 = await rpcCallSafe<string>('eth_call', [
        { to: tokenAddress, data: '0x0e89341c' + tokenIdHex },
        'latest',
      ]);
      if (!raw1155 || raw1155 === '0x') return null;
      return resolveTokenUri(decodeString(raw1155), tokenId);
    }

    return resolveTokenUri(decodeString(raw), tokenId);
  } catch {
    return null;
  }
}

function decodeString(raw: string): string {
  try {
    const hex = raw.slice(2);
    const offset = parseInt(hex.slice(0, 64), 16) * 2;
    const len = parseInt(hex.slice(offset, offset + 64), 16);
    const strHex = hex.slice(offset + 64, offset + 64+ len * 2);
    return Buffer.from(strHex, 'hex').toString('utf8');
  } catch {
    return '';
  }
}

async function resolveTokenUri(uri: string, tokenId: string): Promise<{
  uri: string;
  name?: string;
  description?: string;
  image?: string;
} | null> {
  if (!uri) return null;

  // ERC-1155 {id} substitution
  uri = uri.replace('{id}', BigInt(tokenId).toString(16).padStart(64, '0'));

  // Resolve IPFS URIs
  let fetchUrl = uri;
  if (uri.startsWith('ipfs://')) {
    fetchUrl = `https://ipfs.io/ipfs/${uri.slice(7)}`;
  } else if (uri.startsWith('data:application/json;base64,')) {
    try {
      const json = JSON.parse(Buffer.from(uri.slice(29), 'base64').toString());
      return {
        uri,
        name: json.name,
        description: json.description,
        image: resolveImageUrl(json.image),
      };
    } catch {
      return { uri };
    }
  } else if (uri.startsWith('data:application/json,')) {
    try {
      const json = JSON.parse(decodeURIComponent(uri.slice(22)));
      return {
        uri,
        name: json.name,
        description: json.description,
        image: resolveImageUrl(json.image),
      };
    } catch {
      return { uri };
    }
  }

  // Fetch JSON metadata
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(fetchUrl, { signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) return { uri };
    const json = await resp.json();
    return {
      uri,
      name: json.name,
      description: json.description,
      image: resolveImageUrl(json.image),
    };
  } catch {
    return { uri };
  }
}

function resolveImageUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (url.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${url.slice(7)}`;
  return url;
}
