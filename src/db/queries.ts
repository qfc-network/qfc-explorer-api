import { getReadPool } from './pool.js';

export type BlockRow = {
  hash: string;
  height: string;
  parent_hash: string | null;
  producer: string | null;
  timestamp_ms: string;
  tx_count: number;
};

export type TransactionRow = {
  hash: string;
  block_height: string;
  from_address: string;
  to_address: string | null;
  value: string;
  status: string;
  gas_limit?: string;
  data?: string | null;
};

export type TxFilters = {
  address?: string;
  status?: string;
  min_value?: string;
  max_value?: string;
  method?: string;
  from_date?: string;
  to_date?: string;
  tx_type?: string;
};

function appendTxFilterClauses(
  clauses: string[],
  params: Array<string | number>,
  startIndex: number,
  filters?: TxFilters,
): number {
  let paramIndex = startIndex;

  if (filters?.address) {
    clauses.push(`(from_address = $${paramIndex} OR to_address = $${paramIndex})`);
    params.push(filters.address);
    paramIndex += 1;
  }
  if (filters?.status && filters.status !== 'all') {
    const statusVal = filters.status === 'success' ? '1' : filters.status === 'failed' ? '0' : filters.status;
    clauses.push(`status = $${paramIndex}`);
    params.push(statusVal);
    paramIndex += 1;
  }
  if (filters?.min_value) {
    // Cast value to numeric for comparison (handles both hex and decimal stored values)
    clauses.push(`CAST(value AS NUMERIC) >= $${paramIndex}`);
    params.push(filters.min_value);
    paramIndex += 1;
  }
  if (filters?.max_value) {
    clauses.push(`CAST(value AS NUMERIC) <= $${paramIndex}`);
    params.push(filters.max_value);
    paramIndex += 1;
  }
  if (filters?.method) {
    // method is first 4 bytes selector e.g. "0xa9059cbb" — match first 10 chars of input_data
    clauses.push(`input_data LIKE $${paramIndex}`);
    params.push(`${filters.method}%`);
    paramIndex += 1;
  }
  if (filters?.from_date) {
    clauses.push(`created_at >= $${paramIndex}`);
    params.push(filters.from_date);
    paramIndex += 1;
  }
  if (filters?.to_date) {
    clauses.push(`created_at <= $${paramIndex}`);
    params.push(filters.to_date);
    paramIndex += 1;
  }
  if (filters?.tx_type && filters.tx_type !== 'all') {
    if (filters.tx_type === 'native') {
      clauses.push(`(input_data IS NULL OR input_data = '0x' OR input_data = '')`);
    } else if (filters.tx_type === 'contract') {
      clauses.push(`length(input_data) > 2`);
    }
  }

  return paramIndex;
}

// --- Blocks ---

export async function getLatestBlocks(limit = 10): Promise<BlockRow[]> {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT hash, height, parent_hash, producer, timestamp_ms, tx_count
     FROM blocks ORDER BY height DESC LIMIT $1`,
    [limit]
  );
  return result.rows;
}

export async function getBlocksPage(
  limit: number, offset: number, order: 'asc' | 'desc' = 'desc', producer?: string | null
): Promise<BlockRow[]> {
  const pool = getReadPool();
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  const params: Array<string | number> = [limit, offset];
  const where = producer ? 'WHERE producer = $3' : '';
  if (producer) params.push(producer);
  const result = await pool.query(
    `SELECT hash, height, parent_hash, producer, timestamp_ms, tx_count
     FROM blocks ${where} ORDER BY height ${direction} LIMIT $1 OFFSET $2`,
    params
  );
  return result.rows;
}

export async function getBlocksByCursor(
  limit: number, cursorHeight: string, order: 'asc' | 'desc' = 'desc', producer?: string | null
): Promise<BlockRow[]> {
  const pool = getReadPool();
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  const op = order === 'asc' ? '>' : '<';
  const clauses: string[] = [`height ${op} $2`];
  const params: Array<string | number> = [limit, cursorHeight];
  if (producer) {
    clauses.push('producer = $3');
    params.push(producer);
  }
  const where = `WHERE ${clauses.join(' AND ')}`;
  const result = await pool.query(
    `SELECT hash, height, parent_hash, producer, timestamp_ms, tx_count
     FROM blocks ${where} ORDER BY height ${direction} LIMIT $1`,
    params
  );
  return result.rows;
}

export async function getTransactionsByCursor(
  limit: number, cursorBlockHeight: string, cursorTxIndex: string,
  order: 'asc' | 'desc' = 'desc',
  filters?: TxFilters
): Promise<Array<TransactionRow & { tx_index: number }>> {
  const pool = getReadPool();
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  const op = order === 'asc' ? '>' : '<';
  const clauses: string[] = [`(block_height, tx_index) ${op} ($2, $3)`];
  const params: Array<string | number> = [limit, cursorBlockHeight, cursorTxIndex];

  appendTxFilterClauses(clauses, params, 4, filters);

  const where = `WHERE ${clauses.join(' AND ')}`;
  const result = await pool.query(
    `SELECT hash, block_height, tx_index, from_address, to_address, value, status
     FROM transactions ${where}
     ORDER BY block_height ${direction}, tx_index ${direction}
     LIMIT $1`,
    params
  );
  return result.rows;
}

export async function getBlockByHeight(height: string) {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT hash, height, parent_hash, producer, timestamp_ms, gas_limit, gas_used,
            state_root, transactions_root, receipts_root
     FROM blocks WHERE height = $1 LIMIT 1`,
    [height]
  );
  return result.rows[0] ?? null;
}

export async function getBlockByHash(hash: string) {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT hash, height FROM blocks WHERE hash = $1 LIMIT 1`,
    [hash]
  );
  return result.rows[0] ?? null;
}

export async function getTransactionsByBlockHeight(
  height: string, limit: number, offset: number, order: 'asc' | 'desc' = 'desc'
): Promise<TransactionRow[]> {
  const pool = getReadPool();
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  const result = await pool.query(
    `SELECT hash, block_height, from_address, to_address, value, status
     FROM transactions WHERE block_height = $1
     ORDER BY tx_index ${direction} LIMIT $2 OFFSET $3`,
    [height, limit, offset]
  );
  return result.rows;
}

// --- Transactions ---

export async function getLatestTransactions(limit = 10): Promise<TransactionRow[]> {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT hash, block_height, from_address, to_address, value, status
     FROM transactions ORDER BY block_height DESC, tx_index DESC LIMIT $1`,
    [limit]
  );
  return result.rows;
}

export async function getTransactionsPage(
  limit: number, offset: number, order: 'asc' | 'desc' = 'desc',
  filters?: TxFilters
): Promise<TransactionRow[]> {
  const pool = getReadPool();
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  const clauses: string[] = [];
  const params: Array<string | number> = [limit, offset];

  appendTxFilterClauses(clauses, params, 3, filters);

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await pool.query(
    `SELECT hash, block_height, tx_index, from_address, to_address, value, status
     FROM transactions ${where}
     ORDER BY block_height ${direction}, tx_index ${direction}
     LIMIT $1 OFFSET $2`,
    params
  );
  return result.rows;
}

export async function getTransactionByHash(hash: string) {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT t.hash, t.block_height, t.from_address, t.to_address, t.value, t.status,
            t.gas_limit, t.gas_price, t.nonce, t.data, t.type, b.timestamp_ms
     FROM transactions t LEFT JOIN blocks b ON b.height = t.block_height
     WHERE t.hash = $1 LIMIT 1`,
    [hash]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    ...row,
    data: row.data ? `0x${row.data.toString('hex')}` : null,
    timestamp_ms: row.timestamp_ms?.toString() ?? null,
  };
}

export async function getReceiptLogsByTxHash(hash: string) {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT contract_address, topic0, topic1, topic2, topic3, data
     FROM events WHERE tx_hash = $1 ORDER BY log_index ASC`,
    [hash]
  );
  return result.rows.map((row: Record<string, unknown>) => ({
    ...row,
    data: row.data ? `0x${(row.data as Buffer).toString('hex')}` : null,
  }));
}

// --- Addresses ---

export async function getAddressOverview(address: string) {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT address, balance, nonce, last_seen_block FROM accounts WHERE address = $1 LIMIT 1`,
    [address]
  );
  return result.rows[0] ?? null;
}

export async function getAddressStats(address: string) {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM transactions WHERE from_address = $1) AS sent,
       (SELECT COUNT(*) FROM transactions WHERE to_address = $1) AS received`,
    [address]
  );
  return result.rows[0] ?? null;
}

export async function getAddressAnalysis(address: string) {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM transactions WHERE from_address = $1) AS sent_count,
       (SELECT COUNT(*) FROM transactions WHERE to_address = $1) AS received_count,
       (SELECT COALESCE(SUM(value::numeric), 0) FROM transactions WHERE from_address = $1) AS sent_value,
       (SELECT COALESCE(SUM(value::numeric), 0) FROM transactions WHERE to_address = $1) AS received_value`,
    [address]
  );
  return result.rows[0] ?? null;
}

export async function getAddressTransactions(
  address: string, limit: number, offset: number, order: 'asc' | 'desc' = 'desc'
): Promise<TransactionRow[]> {
  const pool = getReadPool();
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  const result = await pool.query(
    `SELECT hash, block_height, from_address, to_address, value, status
     FROM transactions WHERE from_address = $1 OR to_address = $1
     ORDER BY block_height ${direction}, tx_index ${direction}
     LIMIT $2 OFFSET $3`,
    [address, limit, offset]
  );
  return result.rows;
}

// --- Contracts ---

export async function getContractByAddress(address: string) {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT creator_tx_hash, created_at_block, code_hash, is_verified FROM contracts WHERE address = $1 LIMIT 1`,
    [address]
  );
  return result.rows[0] ?? null;
}

// --- Tokens ---

export async function getTokensPage(limit: number, offset: number, order: 'asc' | 'desc' = 'desc') {
  const pool = getReadPool();
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  const result = await pool.query(
    `SELECT address, name, symbol, decimals, total_supply, last_seen_block, token_type
     FROM tokens ORDER BY last_seen_block ${direction} NULLS LAST LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return result.rows;
}

export async function getTokenByAddress(address: string) {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT address, name, symbol, decimals, total_supply, last_seen_block, token_type
     FROM tokens WHERE address = $1 LIMIT 1`,
    [address]
  );
  return result.rows[0] ?? null;
}

export async function getTokenTransfers(
  tokenAddress: string, limit: number, offset: number, order: 'asc' | 'desc' = 'desc'
) {
  const pool = getReadPool();
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  const result = await pool.query(
    `SELECT tx_hash, block_height, from_address, to_address, value, token_id
     FROM token_transfers WHERE token_address = $1
     ORDER BY block_height ${direction}, log_index ${direction}
     LIMIT $2 OFFSET $3`,
    [tokenAddress, limit, offset]
  );
  return result.rows;
}

export async function getTokenHolders(tokenAddress: string, limit: number) {
  const pool = getReadPool();
  const token = await pool.query(`SELECT address FROM tokens WHERE address = $1 LIMIT 1`, [tokenAddress]);
  if (token.rowCount === 0) return null;
  const result = await pool.query(
    `SELECT holder_address AS address, balance FROM token_balances
     WHERE token_address = $1 AND token_id IS NULL AND balance::numeric > 0
     ORDER BY balance::numeric DESC LIMIT $2`,
    [tokenAddress, limit]
  );
  return result.rows;
}

export async function getRecentTokenTransfers(
  limit: number, offset: number, order: 'asc' | 'desc' = 'desc', tokenType?: string
) {
  const pool = getReadPool();
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  const typeFilter = tokenType ? 'AND t.token_type = $4' : '';
  const params: unknown[] = [limit, offset];
  if (tokenType) params.push(tokenType);
  const result = await pool.query(
    `SELECT tt.tx_hash, tt.block_height, tt.token_address, tt.from_address, tt.to_address,
            tt.value, tt.token_id,
            t.name AS token_name, t.symbol AS token_symbol, t.decimals AS token_decimals, t.token_type
     FROM token_transfers tt LEFT JOIN tokens t ON t.address = tt.token_address
     ${tokenType ? 'WHERE t.token_type = $3' : ''}
     ORDER BY tt.block_height ${direction}, tt.log_index ${direction}
     LIMIT $1 OFFSET $2`,
    params
  );
  return result.rows;
}

export async function getTokenTransfersByAddress(
  address: string, limit: number, offset: number, order: 'asc' | 'desc' = 'desc'
) {
  const pool = getReadPool();
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  const result = await pool.query(
    `SELECT tt.tx_hash, tt.block_height, tt.token_address, tt.from_address, tt.to_address, tt.value,
            t.name AS token_name, t.symbol AS token_symbol, t.decimals AS token_decimals
     FROM token_transfers tt LEFT JOIN tokens t ON t.address = tt.token_address
     WHERE tt.from_address = $1 OR tt.to_address = $1
     ORDER BY tt.block_height ${direction}, tt.log_index ${direction}
     LIMIT $2 OFFSET $3`,
    [address, limit, offset]
  );
  return result.rows;
}

export async function getTokenHoldingsByAddress(address: string) {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT tb.token_address, t.name AS token_name, t.symbol AS token_symbol,
            t.decimals AS token_decimals, t.token_type, tb.balance
     FROM token_balances tb LEFT JOIN tokens t ON t.address = tb.token_address
     WHERE tb.holder_address = $1 AND tb.token_id IS NULL AND tb.balance::numeric > 0
     ORDER BY tb.balance::numeric DESC`,
    [address]
  );
  return result.rows;
}

export async function getNftHoldingsByAddress(address: string) {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT tb.token_address, t.name AS token_name, t.symbol AS token_symbol,
            t.token_type, tb.token_id, tb.balance
     FROM token_balances tb LEFT JOIN tokens t ON t.address = tb.token_address
     WHERE tb.holder_address = $1 AND tb.token_id IS NOT NULL AND tb.balance::numeric > 0
     ORDER BY tb.token_address, tb.token_id`,
    [address]
  );
  return result.rows;
}

export async function getNftHoldersByToken(tokenAddress: string, limit: number) {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT holder_address AS address, token_id, balance FROM token_balances
     WHERE token_address = $1 AND token_id IS NOT NULL AND balance::numeric > 0
     ORDER BY token_id::numeric ASC LIMIT $2`,
    [tokenAddress, limit]
  );
  return result.rows;
}

// --- Stats ---

export async function getStatsOverview() {
  const pool = getReadPool();
  const result = await pool.query(
    `WITH recent_blocks AS (
       SELECT height, timestamp_ms FROM blocks WHERE height > 0 ORDER BY height DESC LIMIT 100
     ),
     recent_txs AS (
       SELECT COUNT(*) AS tx_count FROM transactions
       WHERE block_height >= (SELECT MIN(height) FROM recent_blocks)
     ),
     total_accounts AS (SELECT COUNT(*) AS total FROM accounts)
     SELECT
       (SELECT MAX(height) FROM recent_blocks) AS latest_block,
       (SELECT MAX(timestamp_ms) FROM recent_blocks) AS latest_timestamp_ms,
       CASE WHEN (SELECT COUNT(*) FROM recent_blocks) > 1 THEN
         ((SELECT MAX(timestamp_ms) FROM recent_blocks) - (SELECT MIN(timestamp_ms) FROM recent_blocks))::numeric
         / (SELECT COUNT(*) - 1 FROM recent_blocks)
       ELSE NULL END AS avg_block_time_ms,
       CASE WHEN (SELECT COUNT(*) FROM recent_blocks) > 1 THEN
         (SELECT tx_count FROM recent_txs)::numeric
         / (((SELECT MAX(timestamp_ms) FROM recent_blocks) - (SELECT MIN(timestamp_ms) FROM recent_blocks)) / 1000.0)
       ELSE NULL END AS tps,
       (SELECT total FROM total_accounts) AS active_addresses`
  );
  return result.rows[0] ?? {
    latest_block: null, latest_timestamp_ms: null, avg_block_time_ms: null, tps: null, active_addresses: null,
  };
}

export async function getStatsSeries() {
  const pool = getReadPool();

  const btResult = await pool.query(`
    WITH recent_blocks AS (
      SELECT height, timestamp_ms FROM blocks WHERE height > 0 ORDER BY height DESC LIMIT 20
    )
    SELECT height, timestamp_ms,
      COALESCE(timestamp_ms - LAG(timestamp_ms) OVER (ORDER BY height), 0) AS block_time_ms
    FROM recent_blocks ORDER BY height ASC
  `);
  const block_time_ms = btResult.rows.map((row: Record<string, unknown>) => ({
    label: String(row.height), value: Number(row.block_time_ms ?? 0),
  }));

  const txResult = await pool.query(`
    WITH active_blocks AS (
      SELECT DISTINCT block_height FROM transactions ORDER BY block_height DESC LIMIT 20
    ),
    tx_counts AS (
      SELECT block_height, COUNT(*)::int AS tx_count FROM transactions
      WHERE block_height IN (SELECT block_height FROM active_blocks) GROUP BY block_height
    ),
    address_counts AS (
      SELECT block_height, COUNT(DISTINCT addr)::int AS active FROM (
        SELECT block_height, from_address AS addr FROM transactions
        UNION ALL SELECT block_height, to_address AS addr FROM transactions
      ) a WHERE block_height IN (SELECT block_height FROM active_blocks) GROUP BY block_height
    )
    SELECT t.block_height AS height, t.tx_count, COALESCE(a.active, 0) AS active_addresses
    FROM tx_counts t LEFT JOIN address_counts a ON a.block_height = t.block_height
    ORDER BY t.block_height ASC
  `);
  const tps = txResult.rows.map((row: Record<string, unknown>) => ({
    label: String(row.height), value: Number(row.tx_count ?? 0),
  }));
  const active_addresses = txResult.rows.map((row: Record<string, unknown>) => ({
    label: String(row.height), value: Number(row.active_addresses ?? 0),
  }));

  return { block_time_ms, tps, active_addresses };
}

// --- Daily Stats ---

export async function getDailyStats(days: number = 30) {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT date::text, tx_count::text, active_addresses, new_contracts,
            total_gas_used::text, avg_gas_price::text, block_count, avg_block_time_ms::text
     FROM daily_stats WHERE date >= CURRENT_DATE - $1::int ORDER BY date ASC`,
    [days]
  );
  return result.rows;
}

// --- Search ---

export async function searchBlockHeightPrefix(prefix: string, limit: number) {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT height FROM blocks WHERE height LIKE $1 ORDER BY height DESC LIMIT $2`,
    [`${prefix}%`, limit]
  );
  return result.rows.map((row: Record<string, unknown>) => row.height as string);
}

export async function searchBlockHashPrefix(prefix: string, limit: number) {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT hash, height FROM blocks WHERE hash ILIKE $1 ORDER BY height DESC LIMIT $2`,
    [`${prefix}%`, limit]
  );
  return result.rows;
}

export async function searchTransactionHashPrefix(prefix: string, limit: number) {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT hash, block_height FROM transactions WHERE hash ILIKE $1 ORDER BY block_height DESC LIMIT $2`,
    [`${prefix}%`, limit]
  );
  return result.rows;
}

export async function searchAddressPrefix(prefix: string, limit: number) {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT address FROM accounts WHERE address ILIKE $1 ORDER BY last_seen_block DESC NULLS LAST LIMIT $2`,
    [`${prefix}%`, limit]
  );
  return result.rows.map((row: Record<string, unknown>) => row.address as string);
}

export async function searchTokensByName(query: string, limit: number) {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT address, name, symbol, token_type FROM tokens
     WHERE name ILIKE $1 OR symbol ILIKE $1
     ORDER BY last_seen_block DESC NULLS LAST LIMIT $2`,
    [`%${query}%`, limit]
  );
  return result.rows;
}

// --- Internal Transactions ---

export async function getInternalTxsByTxHash(txHash: string) {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT tx_hash, block_height, trace_index, call_type, depth,
            from_address, to_address, value, gas, gas_used, error
     FROM internal_transactions WHERE tx_hash = $1
     ORDER BY trace_index ASC`,
    [txHash]
  );
  return result.rows;
}

export async function getInternalTxsByAddress(
  address: string, limit: number, offset: number, order: 'asc' | 'desc' = 'desc'
) {
  const pool = getReadPool();
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  const result = await pool.query(
    `SELECT tx_hash, block_height, trace_index, call_type, depth,
            from_address, to_address, value, gas, gas_used, error
     FROM internal_transactions
     WHERE from_address = $1 OR to_address = $1
     ORDER BY block_height ${direction}, trace_index ASC
     LIMIT $2 OFFSET $3`,
    [address, limit, offset]
  );
  return result.rows;
}

export async function getInternalTxsByBlock(
  blockHeight: string, limit: number, offset: number
) {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT tx_hash, trace_index, call_type, depth,
            from_address, to_address, value, gas, gas_used, error
     FROM internal_transactions WHERE block_height = $1
     ORDER BY trace_index ASC
     LIMIT $2 OFFSET $3`,
    [blockHeight, limit, offset]
  );
  return result.rows;
}

export async function searchContractsByName(query: string, limit: number) {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT c.address, t.name, COALESCE(c.is_verified, false) AS is_verified
     FROM contracts c LEFT JOIN tokens t ON t.address = c.address
     WHERE c.is_verified = true AND (t.name ILIKE $1 OR t.symbol ILIKE $1)
     ORDER BY c.created_at_block DESC NULLS LAST LIMIT $2`,
    [`%${query}%`, limit]
  );
  return result.rows;
}

// --- Address Labels ---

export async function getAddressLabel(address: string) {
  const pool = getReadPool();
  const result = await pool.query(
    'SELECT address, label, category, description, website FROM address_labels WHERE address = $1 LIMIT 1',
    [address.toLowerCase()]
  );
  return result.rows[0] || null;
}

export async function getAddressLabels(addresses: string[]) {
  if (addresses.length === 0) return [];
  const pool = getReadPool();
  const placeholders = addresses.map((_, i) => `$${i + 1}`).join(',');
  const result = await pool.query(
    `SELECT address, label, category FROM address_labels WHERE address IN (${placeholders})`,
    addresses.map((a) => a.toLowerCase())
  );
  return result.rows;
}

export async function listAddressLabels(limit: number) {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT address, label, category, description, website, created_at FROM address_labels ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return result.rows;
}

export async function searchAddressLabels(query: string, limit: number) {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT address, label, category FROM address_labels
     WHERE to_tsvector('simple', label) @@ plainto_tsquery('simple', $1)
        OR label ILIKE $2
     ORDER BY label ASC LIMIT $3`,
    [query, `%${query}%`, limit]
  );
  return result.rows;
}

export async function upsertAddressLabel(
  address: string, label: string, category?: string, description?: string, website?: string
) {
  const pool = getReadPool();
  await pool.query(
    `INSERT INTO address_labels (address, label, category, description, website)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (address) DO UPDATE SET
       label = EXCLUDED.label, category = EXCLUDED.category,
       description = EXCLUDED.description, website = EXCLUDED.website,
       updated_at = NOW()`,
    [address.toLowerCase(), label, category || null, description || null, website || null]
  );
}

export async function listAddressLabelsByCategory(category: string | undefined, limit: number, offset: number) {
  const pool = getReadPool();
  if (category && category !== 'all') {
    const result = await pool.query(
      `SELECT address, label, category, description, website, logo_url, verified, created_at
       FROM address_labels
       WHERE category = $1 AND (verified = TRUE OR submitted_by IS NULL)
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [category, limit, offset]
    );
    return result.rows;
  }
  const result = await pool.query(
    `SELECT address, label, category, description, website, logo_url, verified, created_at
     FROM address_labels
     WHERE verified = TRUE OR submitted_by IS NULL
     ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return result.rows;
}

export async function countAddressLabels(category?: string) {
  const pool = getReadPool();
  if (category && category !== 'all') {
    const result = await pool.query(
      `SELECT COUNT(*) FROM address_labels WHERE category = $1 AND (verified = TRUE OR submitted_by IS NULL)`,
      [category]
    );
    return Number(result.rows[0].count);
  }
  const result = await pool.query(
    `SELECT COUNT(*) FROM address_labels WHERE verified = TRUE OR submitted_by IS NULL`
  );
  return Number(result.rows[0].count);
}

export async function submitAddressLabel(
  address: string, label: string, category: string, description: string | undefined, userId: string
) {
  const pool = getReadPool();
  await pool.query(
    `INSERT INTO address_labels (address, label, category, description, verified, submitted_by, submitted_at)
     VALUES ($1, $2, $3, $4, FALSE, $5, NOW())
     ON CONFLICT (address) DO UPDATE SET
       label = EXCLUDED.label, category = EXCLUDED.category,
       description = EXCLUDED.description, verified = FALSE,
       submitted_by = EXCLUDED.submitted_by, submitted_at = NOW(),
       updated_at = NOW()`,
    [address.toLowerCase(), label, category || 'other', description || null, userId]
  );
}

export async function approveAddressLabel(address: string) {
  const pool = getReadPool();
  const result = await pool.query(
    `UPDATE address_labels SET verified = TRUE, approved_at = NOW(), updated_at = NOW()
     WHERE address = $1 RETURNING address, label, category`,
    [address.toLowerCase()]
  );
  return result.rows[0] || null;
}

// --- Token Approvals ---

export async function getTokenApprovalsByOwner(ownerAddress: string) {
  const pool = getReadPool();
  // Approval(address indexed owner, address indexed spender, uint256 value)
  // topic0 = 0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c93090
  // topic1 = owner (padded), topic2 = spender (padded)
  const ownerPadded = '0x' + ownerAddress.replace('0x', '').toLowerCase().padStart(64, '0');
  const result = await pool.query(
    `SELECT e.contract_address AS token_address, e.topic2 AS spender_topic,
            e.data, e.block_height, e.tx_hash,
            t.name AS token_name, t.symbol AS token_symbol, t.decimals AS token_decimals
     FROM events e
     LEFT JOIN tokens t ON t.address = e.contract_address
     WHERE e.topic0 = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c93090'
       AND e.topic1 = $1
     ORDER BY e.block_height DESC, e.log_index DESC`,
    [ownerPadded]
  );
  return result.rows;
}

// --- Full-text Search ---

export async function searchTokensFts(query: string, limit: number) {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT address, name, symbol, token_type,
            ts_rank(to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(symbol, '')),
                    plainto_tsquery('simple', $1)) AS rank
     FROM tokens
     WHERE to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(symbol, ''))
           @@ plainto_tsquery('simple', $1)
     ORDER BY rank DESC LIMIT $2`,
    [query, limit]
  );
  return result.rows;
}
