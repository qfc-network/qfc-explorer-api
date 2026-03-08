import { getPool, getReadPool } from './pool.js';

// --- Types ---

export type CommentRow = {
  id: string;
  contract_address: string;
  user_id: string;
  body: string;
  is_flagged: boolean;
  created_at: string;
  updated_at: string;
  display_name: string | null;
  email: string;
};

export type RatingRow = {
  contract_address: string;
  user_id: string;
  rating: number;
  created_at: string;
};

export type AverageRating = {
  average: number | null;
  count: number;
};

// --- Comments ---

export async function getComments(
  address: string,
  page: number,
  limit: number
): Promise<{ comments: CommentRow[]; total: number }> {
  const pool = getReadPool();
  const offset = (page - 1) * limit;
  const [rows, countResult] = await Promise.all([
    pool.query(
      `SELECT c.id, c.contract_address, c.user_id, c.body, c.is_flagged,
              c.created_at, c.updated_at,
              u.display_name, u.email
       FROM contract_comments c
       JOIN users u ON u.id = c.user_id
       WHERE c.contract_address = $1
       ORDER BY c.created_at DESC
       LIMIT $2 OFFSET $3`,
      [address, limit, offset]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM contract_comments WHERE contract_address = $1`,
      [address]
    ),
  ]);
  return {
    comments: rows.rows,
    total: countResult.rows[0]?.total ?? 0,
  };
}

export async function addComment(
  address: string,
  userId: string,
  body: string
): Promise<CommentRow | null> {
  const pool = getPool();

  // Enforce max 50 comments per user per contract
  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM contract_comments
     WHERE contract_address = $1 AND user_id = $2`,
    [address, userId]
  );
  if ((countResult.rows[0]?.cnt ?? 0) >= 50) {
    return null;
  }

  const result = await pool.query(
    `INSERT INTO contract_comments (contract_address, user_id, body)
     VALUES ($1, $2, $3)
     RETURNING id, contract_address, user_id, body, is_flagged, created_at, updated_at`,
    [address, userId, body]
  );
  // Join user info
  const comment = result.rows[0];
  const userResult = await pool.query(
    `SELECT display_name, email FROM users WHERE id = $1`,
    [userId]
  );
  const user = userResult.rows[0];
  return {
    ...comment,
    display_name: user?.display_name ?? null,
    email: user?.email ?? '',
  };
}

export async function updateComment(
  id: string,
  userId: string,
  body: string
): Promise<CommentRow | null> {
  const pool = getPool();
  const result = await pool.query(
    `UPDATE contract_comments
     SET body = $1, updated_at = NOW()
     WHERE id = $2 AND user_id = $3
     RETURNING id, contract_address, user_id, body, is_flagged, created_at, updated_at`,
    [body, id, userId]
  );
  if (result.rows.length === 0) return null;
  const comment = result.rows[0];
  const userResult = await pool.query(
    `SELECT display_name, email FROM users WHERE id = $1`,
    [userId]
  );
  const user = userResult.rows[0];
  return {
    ...comment,
    display_name: user?.display_name ?? null,
    email: user?.email ?? '',
  };
}

export async function deleteComment(
  id: string,
  userId: string
): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(
    `DELETE FROM contract_comments WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function flagComment(
  id: string,
  _userId: string
): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(
    `UPDATE contract_comments SET is_flagged = true WHERE id = $1`,
    [id]
  );
  return (result.rowCount ?? 0) > 0;
}

// --- Ratings ---

export async function getRating(
  address: string,
  userId: string
): Promise<RatingRow | null> {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT contract_address, user_id, rating, created_at
     FROM contract_ratings
     WHERE contract_address = $1 AND user_id = $2
     LIMIT 1`,
    [address, userId]
  );
  return result.rows[0] ?? null;
}

export async function getAverageRating(address: string): Promise<AverageRating> {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT AVG(rating)::float AS average, COUNT(*)::int AS count
     FROM contract_ratings
     WHERE contract_address = $1`,
    [address]
  );
  const row = result.rows[0];
  return {
    average: row?.average ?? null,
    count: row?.count ?? 0,
  };
}

export async function upsertRating(
  address: string,
  userId: string,
  rating: number
): Promise<RatingRow> {
  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO contract_ratings (contract_address, user_id, rating)
     VALUES ($1, $2, $3)
     ON CONFLICT (contract_address, user_id)
     DO UPDATE SET rating = EXCLUDED.rating, created_at = NOW()
     RETURNING contract_address, user_id, rating, created_at`,
    [address, userId, rating]
  );
  return result.rows[0];
}
