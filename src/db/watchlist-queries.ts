import { getPool, getReadPool } from './pool.js';

// --- Types ---

export type WatchlistRow = {
  id: string;
  user_id: string;
  address: string;
  label: string | null;
  notify_incoming: boolean;
  notify_outgoing: boolean;
  notify_threshold: string | null;
  webhook_url: string | null;
  created_at: string;
};

export type WatcherRow = {
  user_id: string;
  webhook_url: string | null;
  notify_incoming: boolean;
  notify_outgoing: boolean;
  notify_threshold: string | null;
};

// --- Watchlist CRUD ---

export async function addToWatchlist(
  userId: string,
  address: string,
  label?: string,
  notifyIncoming?: boolean,
  notifyOutgoing?: boolean,
  notifyThreshold?: string,
  webhookUrl?: string,
): Promise<WatchlistRow> {
  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO watchlist (user_id, address, label, notify_incoming, notify_outgoing, notify_threshold, webhook_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, user_id, address, label, notify_incoming, notify_outgoing, notify_threshold, webhook_url, created_at`,
    [
      userId,
      address.toLowerCase(),
      label || null,
      notifyIncoming ?? true,
      notifyOutgoing ?? true,
      notifyThreshold || null,
      webhookUrl || null,
    ],
  );
  return result.rows[0];
}

export async function removeFromWatchlist(userId: string, address: string): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(
    `DELETE FROM watchlist WHERE user_id = $1 AND address = $2`,
    [userId, address.toLowerCase()],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getWatchlist(userId: string): Promise<WatchlistRow[]> {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT id, user_id, address, label, notify_incoming, notify_outgoing, notify_threshold, webhook_url, created_at
     FROM watchlist WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return result.rows;
}

export async function getWatchlistItem(userId: string, address: string): Promise<WatchlistRow | null> {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT id, user_id, address, label, notify_incoming, notify_outgoing, notify_threshold, webhook_url, created_at
     FROM watchlist WHERE user_id = $1 AND address = $2 LIMIT 1`,
    [userId, address.toLowerCase()],
  );
  return result.rows[0] ?? null;
}

export async function updateWatchlistItem(
  userId: string,
  address: string,
  fields: {
    label?: string;
    notifyIncoming?: boolean;
    notifyOutgoing?: boolean;
    notifyThreshold?: string | null;
    webhookUrl?: string | null;
  },
): Promise<WatchlistRow | null> {
  const pool = getPool();
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (fields.label !== undefined) {
    sets.push(`label = $${idx}`);
    params.push(fields.label);
    idx++;
  }
  if (fields.notifyIncoming !== undefined) {
    sets.push(`notify_incoming = $${idx}`);
    params.push(fields.notifyIncoming);
    idx++;
  }
  if (fields.notifyOutgoing !== undefined) {
    sets.push(`notify_outgoing = $${idx}`);
    params.push(fields.notifyOutgoing);
    idx++;
  }
  if (fields.notifyThreshold !== undefined) {
    sets.push(`notify_threshold = $${idx}`);
    params.push(fields.notifyThreshold);
    idx++;
  }
  if (fields.webhookUrl !== undefined) {
    sets.push(`webhook_url = $${idx}`);
    params.push(fields.webhookUrl);
    idx++;
  }

  if (sets.length === 0) return getWatchlistItem(userId, address);

  params.push(userId);
  params.push(address.toLowerCase());

  const result = await pool.query(
    `UPDATE watchlist SET ${sets.join(', ')}
     WHERE user_id = $${idx} AND address = $${idx + 1}
     RETURNING id, user_id, address, label, notify_incoming, notify_outgoing, notify_threshold, webhook_url, created_at`,
    params,
  );
  return result.rows[0] ?? null;
}

export async function isWatching(userId: string, address: string): Promise<boolean> {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT 1 FROM watchlist WHERE user_id = $1 AND address = $2 LIMIT 1`,
    [userId, address.toLowerCase()],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getWatchersForAddress(address: string): Promise<WatcherRow[]> {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT user_id, webhook_url, notify_incoming, notify_outgoing, notify_threshold
     FROM watchlist WHERE address = $1`,
    [address.toLowerCase()],
  );
  return result.rows;
}

export async function getWatchlistCount(userId: string): Promise<number> {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count FROM watchlist WHERE user_id = $1`,
    [userId],
  );
  return result.rows[0]?.count ?? 0;
}
