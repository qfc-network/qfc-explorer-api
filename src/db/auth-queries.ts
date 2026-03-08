import { getPool, getReadPool } from './pool.js';

// --- Types ---

export type UserRow = {
  id: string;
  email: string;
  email_verified: boolean;
  password_hash: string | null;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
};

export type OAuthAccountRow = {
  id: string;
  user_id: string;
  provider: string;
  provider_account_id: string;
  access_token: string | null;
  refresh_token: string | null;
  created_at: string;
  // joined user fields
  email?: string;
  display_name?: string;
  avatar_url?: string;
};

export type RefreshTokenRow = {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  revoked: boolean;
  created_at: string;
};

export type PasswordResetRow = {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  used: boolean;
  created_at: string;
};

// --- Users ---

export async function createUser(email: string, passwordHash?: string): Promise<UserRow> {
  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2)
     RETURNING id, email, email_verified, password_hash, display_name, avatar_url, created_at, updated_at`,
    [email.toLowerCase(), passwordHash || null]
  );
  return result.rows[0];
}

export async function getUserByEmail(email: string): Promise<UserRow | null> {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT id, email, email_verified, password_hash, display_name, avatar_url, created_at, updated_at
     FROM users WHERE email = $1 LIMIT 1`,
    [email.toLowerCase()]
  );
  return result.rows[0] ?? null;
}

export async function getUserById(id: string): Promise<UserRow | null> {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT id, email, email_verified, password_hash, display_name, avatar_url, created_at, updated_at
     FROM users WHERE id = $1 LIMIT 1`,
    [id]
  );
  return result.rows[0] ?? null;
}

export async function updateUser(
  id: string,
  fields: { displayName?: string; avatarUrl?: string }
): Promise<UserRow | null> {
  const pool = getPool();
  const sets: string[] = ['updated_at = NOW()'];
  const params: unknown[] = [];
  let idx = 1;

  if (fields.displayName !== undefined) {
    sets.push(`display_name = $${idx}`);
    params.push(fields.displayName);
    idx++;
  }
  if (fields.avatarUrl !== undefined) {
    sets.push(`avatar_url = $${idx}`);
    params.push(fields.avatarUrl);
    idx++;
  }

  params.push(id);
  const result = await pool.query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $${idx}
     RETURNING id, email, email_verified, password_hash, display_name, avatar_url, created_at, updated_at`,
    params
  );
  return result.rows[0] ?? null;
}

export async function updatePassword(userId: string, newPasswordHash: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
    [newPasswordHash, userId]
  );
}

// --- OAuth Accounts ---

export async function createOAuthAccount(
  userId: string,
  provider: string,
  providerAccountId: string,
  accessToken?: string,
  refreshToken?: string
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO oauth_accounts (user_id, provider, provider_account_id, access_token, refresh_token)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, provider, providerAccountId, accessToken || null, refreshToken || null]
  );
}

export async function getOAuthAccount(
  provider: string,
  providerAccountId: string
): Promise<OAuthAccountRow | null> {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT oa.id, oa.user_id, oa.provider, oa.provider_account_id,
            oa.access_token, oa.refresh_token, oa.created_at,
            u.email, u.display_name, u.avatar_url
     FROM oauth_accounts oa
     JOIN users u ON u.id = oa.user_id
     WHERE oa.provider = $1 AND oa.provider_account_id = $2
     LIMIT 1`,
    [provider, providerAccountId]
  );
  return result.rows[0] ?? null;
}

// --- Refresh Tokens ---

export async function createRefreshToken(
  userId: string,
  tokenHash: string,
  expiresAt: Date
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [userId, tokenHash, expiresAt.toISOString()]
  );
}

export async function getRefreshToken(tokenHash: string): Promise<RefreshTokenRow | null> {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT id, user_id, token_hash, expires_at, revoked, created_at
     FROM refresh_tokens
     WHERE token_hash = $1 AND revoked = FALSE AND expires_at > NOW()
     LIMIT 1`,
    [tokenHash]
  );
  return result.rows[0] ?? null;
}

export async function revokeRefreshToken(tokenHash: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE refresh_tokens SET revoked = TRUE WHERE token_hash = $1`,
    [tokenHash]
  );
}

export async function revokeAllUserRefreshTokens(userId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1 AND revoked = FALSE`,
    [userId]
  );
}

// --- Password Resets ---

export async function createPasswordReset(
  userId: string,
  tokenHash: string,
  expiresAt: Date
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [userId, tokenHash, expiresAt.toISOString()]
  );
}

export async function getPasswordReset(tokenHash: string): Promise<PasswordResetRow | null> {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT id, user_id, token_hash, expires_at, used, created_at
     FROM password_resets
     WHERE token_hash = $1 AND used = FALSE AND expires_at > NOW()
     LIMIT 1`,
    [tokenHash]
  );
  return result.rows[0] ?? null;
}

export async function markPasswordResetUsed(tokenHash: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE password_resets SET used = TRUE WHERE token_hash = $1`,
    [tokenHash]
  );
}

// --- Cleanup ---

export async function cleanupExpiredTokens(): Promise<void> {
  const pool = getPool();
  await pool.query(`DELETE FROM refresh_tokens WHERE expires_at < NOW() OR revoked = TRUE`);
  await pool.query(`DELETE FROM password_resets WHERE expires_at < NOW() OR used = TRUE`);
}
