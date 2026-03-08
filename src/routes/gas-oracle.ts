import { FastifyInstance } from 'fastify';
import { getReadPool } from '../db/pool.js';
import { cached } from '../lib/cache.js';

export default async function gasOracleRoutes(app: FastifyInstance) {
  // GET /gas-oracle — gas price oracle with percentile-based recommendations
  app.get('/', async () => {
    const data = await cached('gas-oracle', 12, async () => {
      const pool = getReadPool();

      const [blocksResult, txPricesResult] = await Promise.all([
        // Last 20 blocks for base fee and block info
        pool.query(`
          SELECT height, gas_used, gas_limit, base_fee_per_gas, timestamp_ms
          FROM blocks
          ORDER BY height DESC
          LIMIT 20
        `),
        // Recent transaction gas prices (last ~500 txs)
        pool.query(`
          SELECT gas_price
          FROM transactions
          WHERE gas_price IS NOT NULL AND gas_price != '0'
          ORDER BY block_height DESC, tx_index DESC
          LIMIT 500
        `),
      ]);

      const blocks = blocksResult.rows;
      const latestBlock = blocks[0] ?? null;

      // Parse gas prices and sort ascending
      const gasPrices = txPricesResult.rows
        .map((r: { gas_price: string }) => BigInt(r.gas_price))
        .filter((p: bigint) => p > 0n)
        .sort((a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0));

      if (gasPrices.length === 0) {
        return {
          slow: { gwei: '0', wait_sec: 0 },
          standard: { gwei: '0', wait_sec: 0 },
          fast: { gwei: '0', wait_sec: 0 },
          base_fee_gwei: null,
          block_number: latestBlock ? Number(latestBlock.height) : 0,
          last_updated: new Date().toISOString(),
        };
      }

      // Calculate percentiles
      const percentile = (arr: bigint[], pct: number): bigint => {
        const idx = Math.max(0, Math.ceil((pct / 100) * arr.length) - 1);
        return arr[idx];
      };

      const slowWei = percentile(gasPrices, 25);
      const standardWei = percentile(gasPrices, 50);
      const fastWei = percentile(gasPrices, 75);

      const weiToGwei = (wei: bigint): string => {
        const gwei = Number(wei) / 1e9;
        if (gwei < 0.001) return gwei.toExponential(2);
        if (gwei < 1) return gwei.toFixed(3);
        if (gwei < 100) return gwei.toFixed(2);
        return gwei.toFixed(0);
      };

      // Estimate wait times based on block time
      // Calculate avg block time from recent blocks
      let avgBlockTimeSec = 5; // default fallback
      if (blocks.length >= 2) {
        const newest = Number(blocks[0].timestamp_ms);
        const oldest = Number(blocks[blocks.length - 1].timestamp_ms);
        if (newest > oldest) {
          avgBlockTimeSec = (newest - oldest) / 1000 / (blocks.length - 1);
        }
      }

      // Base fee from latest block (may be null for pre-EIP-1559 chains)
      const baseFeeWei = latestBlock?.base_fee_per_gas
        ? BigInt(latestBlock.base_fee_per_gas)
        : null;
      const baseFeeGwei = baseFeeWei !== null ? weiToGwei(baseFeeWei) : null;

      // Suggested tip: fast - base_fee (or just fast/4 as heuristic)
      const suggestedTip = baseFeeWei !== null && fastWei > baseFeeWei
        ? weiToGwei(fastWei - baseFeeWei)
        : weiToGwei(fastWei / 4n > 0n ? fastWei / 4n : 1n);

      return {
        slow: {
          gwei: weiToGwei(slowWei),
          wait_sec: Math.round(avgBlockTimeSec * 6), // ~6 blocks
        },
        standard: {
          gwei: weiToGwei(standardWei),
          wait_sec: Math.round(avgBlockTimeSec * 3), // ~3 blocks
        },
        fast: {
          gwei: weiToGwei(fastWei),
          wait_sec: Math.round(avgBlockTimeSec), // ~1 block
        },
        base_fee_gwei: baseFeeGwei,
        suggested_tip: suggestedTip,
        block_number: latestBlock ? Number(latestBlock.height) : 0,
        last_updated: new Date().toISOString(),
      };
    });

    return { ok: true, data };
  });
}
