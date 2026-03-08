import { getPool, getReadPool } from '../db/pool.js';

export interface TokenPrice {
  tokenAddress: string;
  priceUsd: number;
  marketCapUsd: number | null;
  change24h: number | null;
  volume24h: number | null;
  source: string;
  updatedAt: string;
}

/**
 * Get price data for a single token address.
 */
export async function getTokenPrice(address: string): Promise<TokenPrice | null> {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT token_address, price_usd, market_cap_usd, change_24h, volume_24h, source, updated_at
     FROM token_prices WHERE token_address = $1 LIMIT 1`,
    [address.toLowerCase()]
  );
  const row = result.rows[0];
  if (!row) return null;
  return mapRow(row);
}

/**
 * Batch lookup prices for multiple token addresses.
 */
export async function getTokenPrices(addresses: string[]): Promise<Map<string, TokenPrice>> {
  if (addresses.length === 0) return new Map();
  const pool = getReadPool();
  const lower = addresses.map((a) => a.toLowerCase());
  const result = await pool.query(
    `SELECT token_address, price_usd, market_cap_usd, change_24h, volume_24h, source, updated_at
     FROM token_prices WHERE token_address = ANY($1)`,
    [lower]
  );
  const map = new Map<string, TokenPrice>();
  for (const row of result.rows) {
    map.set(row.token_address, mapRow(row));
  }
  return map;
}

/**
 * Get 7-day price sparkline from token_price_history.
 */
export async function getTokenSparkline(
  address: string
): Promise<Array<{ timestamp: number; price: number }>> {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT EXTRACT(EPOCH FROM recorded_at)::bigint AS timestamp, price_usd
     FROM token_price_history
     WHERE token_address = $1 AND recorded_at >= NOW() - INTERVAL '7 days'
     ORDER BY recorded_at ASC`,
    [address.toLowerCase()]
  );
  return result.rows.map((r: any) => ({
    timestamp: Number(r.timestamp),
    price: Number(r.price_usd),
  }));
}

/**
 * Upsert a manual price entry for a token.
 */
export async function setManualPrice(
  address: string,
  priceUsd: number,
  marketCapUsd?: number,
  change24h?: number,
  volume24h?: number
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO token_prices (token_address, price_usd, market_cap_usd, change_24h, volume_24h, source, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'manual', NOW())
     ON CONFLICT (token_address) DO UPDATE SET
       price_usd = EXCLUDED.price_usd,
       market_cap_usd = EXCLUDED.market_cap_usd,
       change_24h = EXCLUDED.change_24h,
       volume_24h = EXCLUDED.volume_24h,
       source = 'manual',
       updated_at = NOW()`,
    [address.toLowerCase(), priceUsd, marketCapUsd ?? null, change24h ?? null, volume24h ?? null]
  );
}

/**
 * Delete a price entry.
 */
export async function deletePrice(address: string): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(
    `DELETE FROM token_prices WHERE token_address = $1`,
    [address.toLowerCase()]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * List all configured prices.
 */
export async function listPrices(): Promise<TokenPrice[]> {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT token_address, price_usd, market_cap_usd, change_24h, volume_24h, source, updated_at
     FROM token_prices ORDER BY updated_at DESC`
  );
  return result.rows.map(mapRow);
}

/**
 * Fetch prices from CoinGecko API v3.
 * @param ids - CoinGecko coin IDs (e.g. ['bitcoin', 'ethereum'])
 * @returns Map of coingecko_id -> price data
 */
export async function fetchCoinGeckoPrices(
  ids: string[]
): Promise<Map<string, { usd: number; usd_market_cap?: number; usd_24h_change?: number; usd_24h_vol?: number }>> {
  const map = new Map<string, { usd: number; usd_market_cap?: number; usd_24h_change?: number; usd_24h_vol?: number }>();
  if (ids.length === 0) return map;

  const joined = ids.join(',');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(joined)}&vs_currencies=usd&include_market_cap=true&include_24hr_change=true&include_24hr_vol=true`;

  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.warn(`[price] CoinGecko HTTP ${res.status}: ${res.statusText}`);
      return map;
    }
    const data = await res.json() as Record<string, any>;
    for (const [id, values] of Object.entries(data)) {
      if (values && typeof values.usd === 'number') {
        map.set(id, {
          usd: values.usd,
          usd_market_cap: values.usd_market_cap,
          usd_24h_change: values.usd_24h_change,
          usd_24h_vol: values.usd_24h_vol,
        });
      }
    }
  } catch (err: any) {
    console.warn(`[price] CoinGecko fetch error: ${err.message}`);
  }

  return map;
}

// --- internal helpers ---

function mapRow(row: any): TokenPrice {
  return {
    tokenAddress: row.token_address,
    priceUsd: Number(row.price_usd),
    marketCapUsd: row.market_cap_usd != null ? Number(row.market_cap_usd) : null,
    change24h: row.change_24h != null ? Number(row.change_24h) : null,
    volume24h: row.volume_24h != null ? Number(row.volume_24h) : null,
    source: row.source,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}
