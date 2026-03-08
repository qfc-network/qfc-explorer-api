import { FastifyRequest, FastifyReply } from 'fastify';
import { verifyAccessToken, type AccessTokenPayload } from '../lib/auth.js';

// Extend Fastify request to carry authenticated user info
declare module 'fastify' {
  interface FastifyRequest {
    user?: AccessTokenPayload;
  }
}

/**
 * PreHandler hook — requires a valid Bearer token.
 * Sets request.user = { userId, email } on success.
 * Returns 401 if missing or invalid.
 */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.status(401);
    reply.send({ ok: false, error: 'Authentication required' });
    return;
  }

  const token = authHeader.slice(7);
  const payload = verifyAccessToken(token);
  if (!payload) {
    reply.status(401);
    reply.send({ ok: false, error: 'Invalid or expired token' });
    return;
  }

  request.user = payload;
}

/**
 * PreHandler hook — optionally parses Bearer token.
 * Sets request.user if valid, but does NOT fail if absent/invalid.
 */
export async function optionalAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return;

  const token = authHeader.slice(7);
  const payload = verifyAccessToken(token);
  if (payload) {
    request.user = payload;
  }
}
