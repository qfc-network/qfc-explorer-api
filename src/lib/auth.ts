import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const BCRYPT_ROUNDS = 12;
const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY = '7d';

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET env var is not set');
  return secret;
}

function getJwtRefreshSecret(): string {
  const secret = process.env.JWT_REFRESH_SECRET;
  if (!secret) throw new Error('JWT_REFRESH_SECRET env var is not set');
  return secret;
}

// --- Password hashing ---

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// --- JWT ---

export type AccessTokenPayload = { userId: string; email: string };
export type RefreshTokenPayload = { userId: string; tokenId: string };

export function signAccessToken(payload: { userId: string; email: string }): string {
  return jwt.sign(payload, getJwtSecret(), {
    algorithm: 'HS256',
    expiresIn: ACCESS_TOKEN_EXPIRY,
  });
}

export function signRefreshToken(userId: string): { token: string; tokenId: string } {
  const tokenId = crypto.randomUUID();
  const token = jwt.sign({ userId, tokenId }, getJwtRefreshSecret(), {
    algorithm: 'HS256',
    expiresIn: REFRESH_TOKEN_EXPIRY,
  });
  return { token, tokenId };
}

export function verifyAccessToken(token: string): AccessTokenPayload | null {
  try {
    const payload = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] });
    return payload as AccessTokenPayload;
  } catch {
    return null;
  }
}

export function verifyRefreshToken(token: string): RefreshTokenPayload | null {
  try {
    const payload = jwt.verify(token, getJwtRefreshSecret(), { algorithms: ['HS256'] });
    return payload as RefreshTokenPayload;
  } catch {
    return null;
  }
}

// --- Token hashing (for storing in DB) ---

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
