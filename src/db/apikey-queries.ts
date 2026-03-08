import { getPool, getReadPool } from './pool.js';

// --- Types ---

export type ApiKeyRow = {
  id: string;
  user_id: string;
  key_prefix: string;
  key_hash: string;
  name: string;
  tier: string;
  rate_limit: number;
  daily_limit: number;
  requests_today: number;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
};

export type ApiKeyUsageRow = {
  date: string;
  request_count: number;
};

// --- API Keys ---

export async function createApiKey(
  userId: string,
  name: string,
  keyHash: string,
  keyPrefix: string,
  tier: string = 'free',
): Promise<ApiKeyRow> {
  const pool = getPool();
  const tierConfig = TIER_LIMITS[tier] || TIER_LIMITS.free;
  const result = await pool.query(
    `INSERT INTO api_keys (user_id, name, key_hash, key_prefix, tier, rate_limit, daily_limit)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, user_id, key_prefix, key_hash, name, tier, rate_limit, daily_limit, requests_today, last_used_at, created_at, revoked_at`,
    [userId, name, keyHash, keyPrefix, tier, tierConfig.rateLimit, tierConfig.dailyLimit],
  );
  return result.rows[0];
}

export async function listApiKeys(userId: string): Promise<Omit<ApiKeyRow, 'key_hash'>[]> {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT id, user_id, key_prefix, name, tier, rate_limit, daily_limit, requests_today, last_used_at, created_at, revoked_at
     FROM api_keys
     WHERE user_id = $1 AND revoked_at IS NULL
     ORDER BY created_at DESC`,
    [userId],
  );
  return result.rows;
}

export async function getApiKeyByHash(keyHash: string): Promise<ApiKeyRow | null> {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT id, user_id, key_prefix, key_hash, name, tier, rate_limit, daily_limit, requests_today, last_used_at, created_at, revoked_at
     FROM api_keys
     WHERE key_hash = $1 AND revoked_at IS NULL
     LIMIT 1`,
    [keyHash],
  );
  return result.rows[0] ?? null;
}

export async function revokeApiKey(userId: string, keyId: string): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(
    `UPDATE api_keys SET revoked_at = NOW()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [keyId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function updateApiKeyName(userId: string, keyId: string, name: string): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(
    `UPDATE api_keys SET name = $1
     WHERE id = $2 AND user_id = $3 AND revoked_at IS NULL`,
    [name, keyId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getApiKeyCount(userId: string): Promise<number> {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
  return result.rows[0]?.count ?? 0;
}

export async function incrementUsage(keyId: string): Promise<void> {
  const pool = getPool();
  // Upsert daily usage row
  await pool.query(
    `INSERT INTO api_key_usage (key_id, date, request_count)
     VALUES ($1, CURRENT_DATE, 1)
     ON CONFLICT (key_id, date)
     DO UPDATE SET request_count = api_key_usage.request_count + 1`,
    [keyId],
  );
  // Update last_used_at and requests_today
  await pool.query(
    `UPDATE api_keys SET last_used_at = NOW(), requests_today = requests_today + 1
     WHERE id = $1`,
    [keyId],
  );
}

export async function getApiKeyUsage(keyId: string, days: number = 30): Promise<ApiKeyUsageRow[]> {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT date::text, request_count
     FROM api_key_usage
     WHERE key_id = $1 AND date >= CURRENT_DATE - $2::int
     ORDER BY date DESC`,
    [keyId, days],
  );
  return result.rows;
}

export async function resetDailyCounters(): Promise<void> {
  const pool = getPool();
  await pool.query(`UPDATE api_keys SET requests_today = 0 WHERE requests_today > 0`);
}

// --- Tier config ---

export const TIER_LIMITS: Record<string, { rateLimit: number; dailyLimit: number }> = {
  free: { rateLimit: 5, dailyLimit: 100_000 },
  standard: { rateLimit: 10, dailyLimit: 500_000 },
  pro: { rateLimit: 30, dailyLimit: -1 }, // -1 = unlimited
};
