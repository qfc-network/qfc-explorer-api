import { getPool, getReadPool } from '../db/pool.js';
import { fetchCoinGeckoPrices } from './price-service.js';

let timer: ReturnType<typeof setInterval> | null = null;

/** Track last hour we appended a snapshot so we only insert once per hour. */
let lastSnapshotHour = -1;

async function updatePrices() {
  try {
    const pool = getReadPool();

    // Find all tokens that have a coingecko_id configured
    const result = await pool.query(
      `SELECT token_address, coingecko_id FROM token_prices WHERE coingecko_id IS NOT NULL AND coingecko_id != ''`
    );
    if (result.rows.length === 0) return;

    const idToAddress = new Map<string, string>();
    for (const row of result.rows) {
      idToAddress.set(row.coingecko_id, row.token_address);
    }

    const ids = Array.from(idToAddress.keys());
    const prices = await fetchCoinGeckoPrices(ids);

    if (prices.size === 0) return;

    const writePool = getPool();

    // Update token_prices with fresh data
    for (const [cgId, data] of prices) {
      const addr = idToAddress.get(cgId);
      if (!addr) continue;
      await writePool.query(
        `UPDATE token_prices SET
           price_usd = $1,
           market_cap_usd = $2,
           change_24h = $3,
           volume_24h = $4,
           source = 'coingecko',
           updated_at = NOW()
         WHERE token_address = $5`,
        [data.usd, data.usd_market_cap ?? null, data.usd_24h_change ?? null, data.usd_24h_vol ?? null, addr]
      );
    }

    // Append hourly snapshot to token_price_history (once per hour)
    const currentHour = new Date().getUTCHours() + new Date().getUTCDate() * 24;
    if (currentHour !== lastSnapshotHour) {
      lastSnapshotHour = currentHour;
      for (const [cgId, data] of prices) {
        const addr = idToAddress.get(cgId);
        if (!addr) continue;
        await writePool.query(
          `INSERT INTO token_price_history (token_address, price_usd, recorded_at)
           VALUES ($1, $2, NOW())`,
          [addr, data.usd]
        );
      }
    }

    // Prune history older than 8 days
    await writePool.query(
      `DELETE FROM token_price_history WHERE recorded_at < NOW() - INTERVAL '8 days'`
    );

    console.log(`[price] Updated ${prices.size} token prices from CoinGecko`);
  } catch (err: any) {
    console.warn(`[price] Update error: ${err.message}`);
  }
}

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

/**
 * Start the background price updater.
 * Only active when PRICE_SOURCE env is 'coingecko'.
 */
export function startPriceUpdater(intervalMs = FIFTEEN_MINUTES_MS) {
  const source = process.env.PRICE_SOURCE || 'manual';
  if (source !== 'coingecko') {
    console.log(`[price] PRICE_SOURCE=${source}, background updater disabled`);
    return;
  }

  console.log(`[price] Starting CoinGecko price updater (interval: ${intervalMs / 1000}s)`);
  updatePrices(); // Initial update
  timer = setInterval(updatePrices, intervalMs);
}

export function stopPriceUpdater() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
