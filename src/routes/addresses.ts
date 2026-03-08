import { FastifyInstance } from 'fastify';
import {
  getAddressOverview, getAddressStats, getAddressAnalysis,
  getContractByAddress, getTokenHoldingsByAddress, getNftHoldingsByAddress,
  getAddressTransactions, getTokenTransfersByAddress,
  getInternalTxsByAddress, getAddressLabel, getTokenApprovalsByOwner,
  getEventsByContractAddress, getEventCountsByContract,
} from '../db/queries.js';
import { getReadPool } from '../db/pool.js';
import { rpcCallSafe } from '../lib/rpc.js';
import { clamp, parseNumber, parseOrder } from '../lib/pagination.js';
import { cached } from '../lib/cache.js';
import { getTokenPrice, getTokenPrices } from '../lib/price-service.js';
import { detectMultisig } from '../lib/multisig-detector.js';

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
    let events = null;
    let eventCounts = null;

    if (tab === 'token_transfers') {
      tokenTransfers = await getTokenTransfersByAddress(address, limit, offset, order);
    } else if (tab === 'internal_txs') {
      internalTxs = await getInternalTxsByAddress(address, limit, offset, order);
    } else if (tab === 'events') {
      const eventFilter = q.event || null;
      [events, eventCounts] = await Promise.all([
        getEventsByContractAddress(address, limit, offset, order, eventFilter),
        getEventCountsByContract(address),
      ]);
    } else {
      transactions = await getAddressTransactions(address, limit, offset, order);
    }

    // --- Portfolio USD valuation ---
    // Get native QFC price + all held token prices in parallel
    const tokenAddresses = (tokenHoldings as Array<{ token_address: string }>).map(
      (h) => h.token_address
    );
    const [qfcPrice, tokenPriceMap] = await Promise.all([
      getTokenPrice('qfc'),
      getTokenPrices(tokenAddresses),
    ]);
    const qfcPriceUsd = qfcPrice?.priceUsd ?? null;

    // Compute native QFC balance USD
    let balanceUsd: number | null = null;
    if (qfcPriceUsd != null && overview) {
      try {
        const wei = BigInt((overview as { balance: string }).balance);
        const qfcAmount = Number(wei) / 1e18;
        const usd = qfcAmount * qfcPriceUsd;
        if (Number.isFinite(usd) && usd > 0) {
          balanceUsd = Math.round(usd * 100) / 100;
        }
      } catch {
        // skip if balance parse fails
      }
    }

    // Enrich token holdings with price_usd and value_usd
    let tokenValueSum = 0;
    const enrichedTokenHoldings = (tokenHoldings as Array<{
      token_address: string;
      token_decimals: number | null;
      balance: string;
      [key: string]: unknown;
    }>).map((h) => {
      const price = tokenPriceMap.get(h.token_address.toLowerCase());
      const priceUsd = price?.priceUsd ?? null;
      let valueUsd: number | null = null;

      if (priceUsd != null) {
        try {
          const decimals = h.token_decimals ?? 18;
          const raw = BigInt(h.balance);
          const humanAmount = Number(raw) / Math.pow(10, decimals);
          const usd = humanAmount * priceUsd;
          if (Number.isFinite(usd) && usd > 0) {
            valueUsd = Math.round(usd * 100) / 100;
            tokenValueSum += usd;
          }
        } catch {
          // skip
        }
      }

      return { ...h, price_usd: priceUsd, value_usd: valueUsd };
    });

    // Sort enriched holdings by value_usd descending (tokens with value first)
    enrichedTokenHoldings.sort((a, b) => (b.value_usd ?? -1) - (a.value_usd ?? -1));

    const totalPortfolioUsd =
      (balanceUsd ?? 0) + tokenValueSum > 0
        ? Math.round(((balanceUsd ?? 0) + tokenValueSum) * 100) / 100
        : null;

    return {
      ok: true,
      data: {
        address, label, overview, stats, analysis, contract,
        tokenHoldings: enrichedTokenHoldings, nftHoldings,
        balance_usd: balanceUsd,
        total_portfolio_usd: totalPortfolioUsd,
        tab, page, limit, order,
        transactions: transactions ? (transactions as Array<Record<string, unknown>>).map((tx) => {
          const inputData = tx.input_data as (string | Buffer | null | undefined);
          let method_id: string | undefined;
          if (inputData) {
            if (Buffer.isBuffer(inputData) && inputData.length >= 4) {
              method_id = '0x' + inputData.subarray(0, 4).toString('hex').toLowerCase();
            } else if (typeof inputData === 'string') {
              const clean = inputData.startsWith('0x') ? inputData.slice(2) : inputData;
              if (clean.length >= 8) method_id = '0x' + clean.slice(0, 8).toLowerCase();
            }
          }
          const { input_data: _input, ...rest } = tx;
          return { ...rest, ...(method_id ? { method_id } : {}) };
        }) : transactions,
        tokenTransfers, internalTxs,
        events, event_counts: eventCounts,
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

  // GET /address/:address/txs/export — Enhanced CSV export with date range, timestamps, gas gwei
  // Query params: from_date (ISO), to_date (ISO), limit (max 5000, default 1000)
  app.get('/:address/txs/export', async (request, reply) => {
    const { address } = request.params as { address: string };
    const q = request.query as Record<string, string>;
    const limit = clamp(parseNumber(q.limit, 1000), 1, 5000);
    const addr = address.toLowerCase();
    const pool = getReadPool();

    // Parse date range
    let fromMs: number | null = null;
    let toMs: number | null = null;
    if (q.from_date) {
      const ts = new Date(q.from_date).getTime();
      if (!isNaN(ts)) fromMs = ts;
    }
    if (q.to_date) {
      const ts = new Date(q.to_date).getTime();
      if (!isNaN(ts)) toMs = ts + 86400000; // end of day
    }

    // Resolve date range to block heights
    let startBlock: string | null = null;
    let endBlock: string | null = null;
    if (fromMs !== null) {
      const r = await pool.query('SELECT MIN(height) AS h FROM blocks WHERE timestamp_ms >= $1', [fromMs]);
      startBlock = r.rows[0]?.h ?? null;
    }
    if (toMs !== null) {
      const r = await pool.query('SELECT MAX(height) AS h FROM blocks WHERE timestamp_ms < $1', [toMs]);
      endBlock = r.rows[0]?.h ?? null;
    }

    // Build query with block timestamp join
    const params: (string | number)[] = [addr, limit];
    let dateFilter = '';
    if (startBlock) { params.push(startBlock); dateFilter += ` AND t.block_height >= $${params.length}`; }
    if (endBlock) { params.push(endBlock); dateFilter += ` AND t.block_height <= $${params.length}`; }

    const result = await pool.query(
      `SELECT t.hash, t.block_height, b.timestamp_ms, t.from_address, t.to_address,
              t.value, t.gas_used, t.gas_price, t.status, t.input
       FROM transactions t
       JOIN blocks b ON b.height = t.block_height
       WHERE (t.from_address = $1 OR t.to_address = $1)${dateFilter}
       ORDER BY t.block_height DESC, t.tx_index DESC
       LIMIT $2`,
      params
    );

    // Get estimated total count (for header)
    const countParams: (string | number)[] = [addr];
    let countDateFilter = '';
    if (startBlock) { countParams.push(startBlock); countDateFilter += ` AND block_height >= $${countParams.length}`; }
    if (endBlock) { countParams.push(endBlock); countDateFilter += ` AND block_height <= $${countParams.length}`; }
    const countResult = await pool.query(
      `SELECT COUNT(*) AS total FROM transactions WHERE (from_address = $1 OR to_address = $1)${countDateFilter}`,
      countParams
    );
    const totalCount = Number(countResult.rows[0]?.total ?? 0);

    // CSV helper: escape fields containing commas, quotes, or newlines
    function csvEscape(val: string): string {
      if (val.includes(',') || val.includes('"') || val.includes('\n') || val.includes('\r')) {
        return '"' + val.replace(/"/g, '""') + '"';
      }
      return val;
    }

    // Format value from wei to QFC
    function weiToQfc(weiStr: string): string {
      try {
        if (!weiStr || weiStr === '0' || weiStr === '0x0') return '0';
        let wei: bigint;
        if (weiStr.startsWith('0x')) {
          wei = BigInt(weiStr);
        } else {
          wei = BigInt(weiStr);
        }
        const whole = wei / 1000000000000000000n;
        const frac = wei % 1000000000000000000n;
        if (frac === 0n) return whole.toString();
        const fracStr = frac.toString().padStart(18, '0').replace(/0+$/, '');
        return `${whole}.${fracStr}`;
      } catch {
        return weiStr;
      }
    }

    // Format gas price from wei to gwei
    function weiToGwei(weiStr: string): string {
      try {
        if (!weiStr || weiStr === '0') return '0';
        const wei = BigInt(weiStr);
        const gwei = wei / 1000000000n;
        const fracWei = wei % 1000000000n;
        if (fracWei === 0n) return gwei.toString();
        const fracStr = fracWei.toString().padStart(9, '0').replace(/0+$/, '');
        return `${gwei}.${fracStr}`;
      } catch {
        return weiStr;
      }
    }

    // Extract method selector from input data
    function extractMethod(input: string | Buffer | null): string {
      if (!input) return '';
      const hex = Buffer.isBuffer(input) ? input.toString('hex') : String(input);
      if (!hex || hex === '' || hex === '0x') return 'transfer';
      const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
      if (clean.length < 8) return 'transfer';
      return '0x' + clean.slice(0, 8);
    }

    // Build CSV rows
    const headers = ['Hash', 'Block', 'Timestamp', 'From', 'To', 'Value (QFC)', 'Gas Used', 'Gas Price (Gwei)', 'Status', 'Method'];
    const rows: string[] = [headers.join(',')];

    for (const r of result.rows as Array<Record<string, unknown>>) {
      const timestamp = r.timestamp_ms
        ? new Date(Number(r.timestamp_ms)).toISOString()
        : '';
      const row = [
        csvEscape(String(r.hash ?? '')),
        csvEscape(String(r.block_height ?? '')),
        csvEscape(timestamp),
        csvEscape(String(r.from_address ?? '')),
        csvEscape(String(r.to_address ?? '')),
        csvEscape(weiToQfc(String(r.value ?? '0'))),
        csvEscape(String(r.gas_used ?? '')),
        csvEscape(weiToGwei(String(r.gas_price ?? '0'))),
        csvEscape(String(r.status ?? '')),
        csvEscape(extractMethod(r.input as string | Buffer | null)),
      ];
      rows.push(row.join(','));
    }

    const csv = rows.join('\n');

    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', `attachment; filename=qfc-${addr.slice(0, 10)}-txs-export.csv`);
    reply.header('X-Total-Count', String(totalCount));
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

  // GET /address/:address/profile — comprehensive address activity analysis
  app.get('/:address/profile', async (request) => {
    const { address } = request.params as { address: string };
    const addr = address.toLowerCase();
    const pool = getReadPool();

    const cacheKey = `addr:profile:${addr}`;
    const profile = await cached(cacheKey, 60, async () => {
      // Run all queries in parallel
      const [
        timeRange,
        txCounts,
        valueSums,
        gasResult,
        uniqueResult,
        topInteractions,
        heatmap,
        tokenDiversityResult,
      ] = await Promise.all([
        // First and last transaction timestamps
        pool.query(
          `SELECT
             MIN(b.timestamp_ms) AS first_tx_at,
             MAX(b.timestamp_ms) AS last_tx_at
           FROM transactions t
           JOIN blocks b ON b.height = t.block_height
           WHERE t.from_address = $1 OR t.to_address = $1`,
          [addr]
        ),
        // Sent and received counts
        pool.query(
          `SELECT
             COUNT(*) FILTER (WHERE from_address = $1) AS total_sent,
             COUNT(*) FILTER (WHERE to_address = $1) AS total_received
           FROM transactions
           WHERE from_address = $1 OR to_address = $1`,
          [addr]
        ),
        // Sent and received value sums (value stored as numeric text / hex)
        pool.query(
          `SELECT
             COALESCE(SUM(CASE WHEN from_address = $1 THEN
               CASE WHEN value ~ '^0x' THEN ('x' || lpad(substr(value, 3), 16, '0'))::bit(64)::bigint
                    WHEN value ~ '^[0-9]+$' THEN value::numeric
                    ELSE 0 END
             ELSE 0 END), 0) AS total_sent_value,
             COALESCE(SUM(CASE WHEN to_address = $1 THEN
               CASE WHEN value ~ '^0x' THEN ('x' || lpad(substr(value, 3), 16, '0'))::bit(64)::bigint
                    WHEN value ~ '^[0-9]+$' THEN value::numeric
                    ELSE 0 END
             ELSE 0 END), 0) AS total_received_value
           FROM transactions
           WHERE from_address = $1 OR to_address = $1`,
          [addr]
        ),
        // Total gas spent (gas_used * gas_price) for sent transactions
        pool.query(
          `SELECT COALESCE(SUM(
             CASE WHEN gas_used ~ '^[0-9]+$' AND gas_price ~ '^[0-9]+$'
                  THEN gas_used::numeric * gas_price::numeric
                  ELSE 0 END
           ), 0) AS total_gas_spent
           FROM transactions
           WHERE from_address = $1`,
          [addr]
        ),
        // Unique interactions (distinct to_address for sent txs)
        pool.query(
          `SELECT COUNT(DISTINCT to_address) AS unique_interactions
           FROM transactions
           WHERE from_address = $1 AND to_address IS NOT NULL`,
          [addr]
        ),
        // Top 10 most interacted addresses
        pool.query(
          `SELECT to_address AS address, COUNT(*) AS tx_count
           FROM transactions
           WHERE from_address = $1 AND to_address IS NOT NULL
           GROUP BY to_address
           ORDER BY tx_count DESC
           LIMIT 10`,
          [addr]
        ),
        // Activity heatmap: daily tx count for last 365 days
        pool.query(
          `SELECT DATE(to_timestamp(b.timestamp_ms / 1000.0)) AS day, COUNT(*) AS tx_count
           FROM transactions t
           JOIN blocks b ON b.height = t.block_height
           WHERE (t.from_address = $1 OR t.to_address = $1)
             AND b.timestamp_ms >= $2
           GROUP BY day
           ORDER BY day ASC`,
          [addr, Date.now() - 365 * 86400000]
        ),
        // Token diversity: distinct token addresses interacted with
        pool.query(
          `SELECT COUNT(DISTINCT token_address) AS token_diversity
           FROM token_transfers
           WHERE from_address = $1 OR to_address = $1`,
          [addr]
        ),
      ]);

      const sent = Number(txCounts.rows[0]?.total_sent ?? 0);
      const received = Number(txCounts.rows[0]?.total_received ?? 0);
      const totalTxs = sent + received;

      // Compute activity level based on tx frequency
      const firstAt = Number(timeRange.rows[0]?.first_tx_at ?? 0);
      const lastAt = Number(timeRange.rows[0]?.last_tx_at ?? 0);
      let activityLevel = 'dormant';
      if (totalTxs > 0 && firstAt > 0) {
        const monthsActive = Math.max(1, (Date.now() - firstAt) / (30 * 86400000));
        const txPerMonth = totalTxs / monthsActive;
        if (txPerMonth > 100) activityLevel = 'very_active';
        else if (txPerMonth > 10) activityLevel = 'active';
        else if (txPerMonth > 1) activityLevel = 'moderate';
        else activityLevel = 'dormant';
      }

      return {
        address: addr,
        first_tx_at: firstAt || null,
        last_tx_at: lastAt || null,
        total_sent: sent,
        total_received: received,
        total_sent_value: String(valueSums.rows[0]?.total_sent_value ?? '0'),
        total_received_value: String(valueSums.rows[0]?.total_received_value ?? '0'),
        total_gas_spent: String(gasResult.rows[0]?.total_gas_spent ?? '0'),
        unique_interactions: Number(uniqueResult.rows[0]?.unique_interactions ?? 0),
        top_interactions: topInteractions.rows.map((r: { address: string; tx_count: string }) => ({
          address: r.address,
          tx_count: Number(r.tx_count),
        })),
        activity_heatmap: heatmap.rows.map((r: { day: string; tx_count: string }) => ({
          day: typeof r.day === 'string' ? r.day : new Date(r.day).toISOString().slice(0, 10),
          count: Number(r.tx_count),
        })),
        token_diversity: Number(tokenDiversityResult.rows[0]?.token_diversity ?? 0),
        activity_level: activityLevel,
      };
    });

    return { ok: true, data: profile };
  });

  // GET /address/:address/activity — daily transaction counts for heatmap
  app.get('/:address/activity', async (request) => {
    const { address } = request.params as { address: string };
    const addr = address.toLowerCase();
    const pool = getReadPool();

    const cacheKey = `addr:activity:${addr}`;
    const result = await cached(cacheKey, 300, async () => {
      const cutoffMs = Date.now() - 365 * 86400000;

      const { rows } = await pool.query(
        `SELECT DATE(to_timestamp(b.timestamp_ms / 1000.0)) AS date, COUNT(*) AS count
         FROM transactions t
         JOIN blocks b ON b.height = t.block_height
         WHERE (t.from_address = $1 OR t.to_address = $1)
           AND b.timestamp_ms >= $2
         GROUP BY date
         ORDER BY date ASC`,
        [addr, cutoffMs]
      );

      return {
        days: rows.map((r: { date: string | Date; count: string }) => ({
          date: typeof r.date === 'string' ? r.date : new Date(r.date).toISOString().slice(0, 10),
          count: Number(r.count),
        })),
      };
    });

    return { ok: true, data: result };
  });

  // GET /address/:address/multisig — detect Safe (Gnosis) multisig wallet
  app.get('/:address/multisig', async (request) => {
    const { address } = request.params as { address: string };
    const addr = address.toLowerCase();

    const cacheKey = `addr:multisig:${addr}`;
    const multisig = await cached(cacheKey, 60, async () => {
      // Only check contracts (EOAs cannot be multisig wallets)
      const contract = await getContractByAddress(addr);
      if (!contract) return null;

      return detectMultisig(addr);
    });

    return { ok: true, data: multisig };
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

  // GET /address/:address/balance-history — daily closing balance over time
  app.get('/:address/balance-history', async (request) => {
    const { address } = request.params as { address: string };
    const q = request.query as Record<string, string>;
    const allowedDays = [7, 30, 90, 365];
    const days = allowedDays.includes(Number(q.days)) ? Number(q.days) : 30;
    const addr = address.toLowerCase();
    const pool = getReadPool();

    const cacheKey = `addr:balhist:${addr}:${days}`;
    const result = await cached(cacheKey, 60, async () => {
      // Get all transactions involving this address, ordered by block_height ASC,
      // with block timestamps for date grouping.
      // We limit lookback to the requested number of days.
      const cutoffMs = Date.now() - days * 86400000;

      const txResult = await pool.query(
        `SELECT t.from_address, t.to_address, t.value, t.gas_used, t.gas_price,
                b.timestamp_ms
         FROM transactions t
         JOIN blocks b ON b.height = t.block_height
         WHERE (t.from_address = $1 OR t.to_address = $1)
           AND b.timestamp_ms >= $2
         ORDER BY t.block_height ASC, t.tx_index ASC`,
        [addr, cutoffMs]
      );

      // Also get current balance from accounts table
      const balResult = await pool.query(
        'SELECT balance FROM accounts WHERE address = $1',
        [addr]
      );
      const currentBalance = String(balResult.rows[0]?.balance ?? '0');

      if (txResult.rows.length === 0) {
        return { points: [], current_balance: currentBalance };
      }

      // To compute historical daily closing balance, we work backwards from
      // the current balance. First, compute the net effect of each transaction.
      // Then, walk backwards from current balance to reconstruct past balances.

      // Group transactions by date (day string YYYY-MM-DD)
      type DayGroup = { date: string; netChange: bigint };
      const dayMap = new Map<string, bigint>();

      for (const row of txResult.rows as Array<{
        from_address: string;
        to_address: string | null;
        value: string;
        gas_used: string;
        gas_price: string;
        timestamp_ms: string;
      }>) {
        const dateStr = new Date(Number(row.timestamp_ms)).toISOString().slice(0, 10);
        let net = dayMap.get(dateStr) ?? 0n;

        // Parse value
        let val = 0n;
        try {
          const v = row.value;
          if (v && v !== '0') {
            val = v.startsWith('0x') ? BigInt(v) : BigInt(v);
          }
        } catch {
          // skip
        }

        const isSender = row.from_address === addr;
        const isReceiver = row.to_address === addr;

        if (isSender) {
          net -= val;
          // Subtract gas cost
          try {
            const gasUsed = row.gas_used && /^\d+$/.test(row.gas_used) ? BigInt(row.gas_used) : 0n;
            const gasPrice = row.gas_price && /^\d+$/.test(row.gas_price) ? BigInt(row.gas_price) : 0n;
            net -= gasUsed * gasPrice;
          } catch {
            // skip
          }
        }
        if (isReceiver) {
          net += val;
        }

        dayMap.set(dateStr, net);
      }

      // Sort days ascending
      const sortedDays = Array.from(dayMap.entries())
        .sort((a, b) => a[0].localeCompare(b[0]));

      // Compute total net change of all these transactions
      let totalNet = 0n;
      for (const [, net] of sortedDays) {
        totalNet += net;
      }

      // The balance at the start of the period = currentBalance - totalNet
      // Then accumulate forward to get closing balance each day
      let runningBalance: bigint;
      try {
        runningBalance = BigInt(currentBalance) - totalNet;
      } catch {
        runningBalance = 0n;
      }

      // Fill all days in the range (even days without tx)
      const startDate = new Date(cutoffMs);
      startDate.setUTCHours(0, 0, 0, 0);
      const endDate = new Date();
      endDate.setUTCHours(0, 0, 0, 0);

      const points: Array<{ date: string; balance: string }> = [];
      const dayNetMap = new Map(sortedDays);

      const d = new Date(startDate);
      while (d <= endDate) {
        const dateStr = d.toISOString().slice(0, 10);
        const dayNet = dayNetMap.get(dateStr) ?? 0n;
        runningBalance += dayNet;
        // Ensure non-negative display
        const displayBalance = runningBalance < 0n ? 0n : runningBalance;
        points.push({ date: dateStr, balance: displayBalance.toString() });
        d.setUTCDate(d.getUTCDate() + 1);
      }

      return { points, current_balance: currentBalance };
    });

    return { ok: true, data: result };
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
