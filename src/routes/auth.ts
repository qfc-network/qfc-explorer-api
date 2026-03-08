import crypto from 'node:crypto';
import { FastifyInstance } from 'fastify';
import {
  hashPassword,
  verifyPassword,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashToken,
} from '../lib/auth.js';
import {
  createUser,
  getUserByEmail,
  getUserById,
  updateUser,
  updatePassword,
  createRefreshToken,
  getRefreshToken,
  revokeRefreshToken,
  revokeAllUserRefreshTokens,
  createPasswordReset,
  getPasswordReset,
  markPasswordResetUsed,
} from '../db/auth-queries.js';
import { requireAuth } from '../middleware/auth.js';

// --- Simple per-IP rate limiter for auth endpoints ---

const authRateStore = new Map<string, { count: number; resetAt: number }>();
const AUTH_WINDOW_MS = 60_000;
const AUTH_MAX_REQUESTS = 10;

function checkAuthRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = authRateStore.get(ip);
  if (!entry || entry.resetAt < now) {
    authRateStore.set(ip, { count: 1, resetAt: now + AUTH_WINDOW_MS });
    return true;
  }
  if (entry.count >= AUTH_MAX_REQUESTS) return false;
  entry.count++;
  return true;
}

// Cleanup stale entries periodically
setInterval(() => {
  const now = Date.now();
  authRateStore.forEach((entry, ip) => {
    if (entry.resetAt < now) authRateStore.delete(ip);
  });
}, 5 * 60_000).unref();

// --- Helpers ---

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function sanitizeUser(user: { id: string; email: string; display_name: string | null; avatar_url: string | null }) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    avatarUrl: user.avatar_url,
  };
}

const REFRESH_COOKIE = 'qfc_refresh';
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function setRefreshCookie(reply: any, token: string): void {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/auth',
    maxAge: REFRESH_TOKEN_TTL_MS / 1000, // seconds
  });
}

function clearRefreshCookie(reply: any): void {
  reply.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/auth',
  });
}

async function issueTokens(userId: string, email: string, reply: any) {
  const accessToken = signAccessToken({ userId, email });
  const { token: refreshJwt, tokenId } = signRefreshToken(userId);
  const tokenHash = hashToken(tokenId);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
  await createRefreshToken(userId, tokenHash, expiresAt);
  setRefreshCookie(reply, refreshJwt);
  return accessToken;
}

// --- Routes ---

export default async function authRoutes(app: FastifyInstance) {
  // POST /auth/register
  app.post('/register', async (request, reply) => {
    const ip = request.ip;
    if (!checkAuthRateLimit(ip)) {
      reply.status(429);
      return { ok: false, error: 'Too many requests. Try again later.' };
    }

    const body = request.body as { email?: string; password?: string };
    if (!body.email || !EMAIL_RE.test(body.email)) {
      reply.status(400);
      return { ok: false, error: 'Invalid email address' };
    }
    if (!body.password || body.password.length < 8) {
      reply.status(400);
      return { ok: false, error: 'Password must be at least 8 characters' };
    }

    const existing = await getUserByEmail(body.email);
    if (existing) {
      reply.status(409);
      return { ok: false, error: 'Email already registered' };
    }

    const pwHash = await hashPassword(body.password);
    const user = await createUser(body.email, pwHash);
    const accessToken = await issueTokens(user.id, user.email, reply);

    return {
      ok: true,
      data: {
        user: sanitizeUser(user),
        accessToken,
      },
    };
  });

  // POST /auth/login
  app.post('/login', async (request, reply) => {
    const ip = request.ip;
    if (!checkAuthRateLimit(ip)) {
      reply.status(429);
      return { ok: false, error: 'Too many requests. Try again later.' };
    }

    const body = request.body as { email?: string; password?: string };
    if (!body.email || !body.password) {
      reply.status(400);
      return { ok: false, error: 'Email and password are required' };
    }

    const user = await getUserByEmail(body.email);
    if (!user || !user.password_hash) {
      reply.status(401);
      return { ok: false, error: 'Invalid email or password' };
    }

    const valid = await verifyPassword(body.password, user.password_hash);
    if (!valid) {
      reply.status(401);
      return { ok: false, error: 'Invalid email or password' };
    }

    const accessToken = await issueTokens(user.id, user.email, reply);

    return {
      ok: true,
      data: {
        user: sanitizeUser(user),
        accessToken,
      },
    };
  });

  // POST /auth/refresh
  app.post('/refresh', async (request, reply) => {
    const cookies = (request as any).cookies as Record<string, string> | undefined;
    const refreshJwt = cookies?.[REFRESH_COOKIE];
    if (!refreshJwt) {
      reply.status(401);
      return { ok: false, error: 'No refresh token' };
    }

    const payload = verifyRefreshToken(refreshJwt);
    if (!payload) {
      reply.status(401);
      return { ok: false, error: 'Invalid or expired refresh token' };
    }

    const oldTokenHash = hashToken(payload.tokenId);
    const storedToken = await getRefreshToken(oldTokenHash);
    if (!storedToken) {
      reply.status(401);
      return { ok: false, error: 'Refresh token revoked or expired' };
    }

    // Revoke old token (rotation)
    await revokeRefreshToken(oldTokenHash);

    const user = await getUserById(storedToken.user_id);
    if (!user) {
      reply.status(401);
      return { ok: false, error: 'User not found' };
    }

    const accessToken = await issueTokens(user.id, user.email, reply);

    return {
      ok: true,
      data: { accessToken },
    };
  });

  // POST /auth/logout
  app.post('/logout', async (request, reply) => {
    const cookies = (request as any).cookies as Record<string, string> | undefined;
    const refreshJwt = cookies?.[REFRESH_COOKIE];

    if (refreshJwt) {
      const payload = verifyRefreshToken(refreshJwt);
      if (payload) {
        const tokenHash = hashToken(payload.tokenId);
        await revokeRefreshToken(tokenHash);
      }
    }

    clearRefreshCookie(reply);
    return { ok: true };
  });

  // GET /auth/me
  app.get('/me', { preHandler: [requireAuth] }, async (request, reply) => {
    const user = await getUserById(request.user!.userId);
    if (!user) {
      reply.status(404);
      return { ok: false, error: 'User not found' };
    }
    return { ok: true, data: { user: sanitizeUser(user) } };
  });

  // PATCH /auth/me
  app.patch('/me', { preHandler: [requireAuth] }, async (request, reply) => {
    const body = request.body as { displayName?: string; avatarUrl?: string };
    const user = await updateUser(request.user!.userId, {
      displayName: body.displayName,
      avatarUrl: body.avatarUrl,
    });
    if (!user) {
      reply.status(404);
      return { ok: false, error: 'User not found' };
    }
    return { ok: true, data: { user: sanitizeUser(user) } };
  });

  // POST /auth/password/forgot
  app.post('/password/forgot', async (request, reply) => {
    const ip = request.ip;
    if (!checkAuthRateLimit(ip)) {
      reply.status(429);
      return { ok: false, error: 'Too many requests. Try again later.' };
    }

    const body = request.body as { email?: string };
    // Always return success to avoid revealing whether email exists
    if (!body.email) {
      return { ok: true, data: { message: 'If that email is registered, a reset link has been sent.' } };
    }

    const user = await getUserByEmail(body.email);
    if (user) {
      const resetToken = crypto.randomUUID();
      const tokenHash = hashToken(resetToken);
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
      await createPasswordReset(user.id, tokenHash, expiresAt);

      // No email sending — log reset URL to console
      const baseUrl = process.env.EXPLORER_URL || 'http://localhost:3000';
      console.log(`[Auth] Password reset token for ${user.email}: ${baseUrl}/reset-password?token=${resetToken}`);
    }

    return { ok: true, data: { message: 'If that email is registered, a reset link has been sent.' } };
  });

  // POST /auth/password/reset
  app.post('/password/reset', async (request, reply) => {
    const body = request.body as { token?: string; password?: string };
    if (!body.token || !body.password || body.password.length < 8) {
      reply.status(400);
      return { ok: false, error: 'Valid token and password (min 8 chars) are required' };
    }

    const tokenHash = hashToken(body.token);
    const resetRecord = await getPasswordReset(tokenHash);
    if (!resetRecord) {
      reply.status(400);
      return { ok: false, error: 'Invalid or expired reset token' };
    }

    const newHash = await hashPassword(body.password);
    await updatePassword(resetRecord.user_id, newHash);
    await markPasswordResetUsed(tokenHash);
    await revokeAllUserRefreshTokens(resetRecord.user_id);

    return { ok: true, data: { message: 'Password has been reset. Please log in again.' } };
  });

  // --- OAuth placeholders ---

  app.get('/oauth/github', async (_request, reply) => {
    reply.status(501);
    return { ok: false, error: 'OAuth not configured' };
  });

  app.get('/oauth/github/callback', async (_request, reply) => {
    reply.status(501);
    return { ok: false, error: 'OAuth not configured' };
  });

  app.get('/oauth/google', async (_request, reply) => {
    reply.status(501);
    return { ok: false, error: 'OAuth not configured' };
  });

  app.get('/oauth/google/callback', async (_request, reply) => {
    reply.status(501);
    return { ok: false, error: 'OAuth not configured' };
  });
}
