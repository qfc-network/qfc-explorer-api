import crypto from 'node:crypto';
import { FastifyRequest, FastifyReply } from 'fastify';
import { getApiKeyByHash, incrementUsage } from '../db/apikey-queries.js';

// Extend Fastify request to carry API key info
declare module 'fastify' {
  interface FastifyRequest {
    apiKey?: {
      id: string;
      userId: string;
      tier: string;
      rateLimit: number;
      dailyLimit: number;
    };
  }
}

// --- In-memory token bucket rate limiter per key ---

type Bucket = { tokens: number; lastRefill: number };
const buckets = new Map<string, Bucket>();

// Cleanup stale buckets periodically
setInterval(() => {
  const now = Date.now();
  buckets.forEach((bucket, key) => {
    if (now - bucket.lastRefill > 60_000) buckets.delete(key);
  });
}, 60_000).unref();

function checkTokenBucket(keyPrefix: string, rateLimit: number): boolean {
  const now = Date.now();
  let bucket = buckets.get(keyPrefix);

  if (!bucket) {
    bucket = { tokens: rateLimit - 1, lastRefill: now };
    buckets.set(keyPrefix, bucket);
    return true;
  }

  // Refill tokens based on elapsed time
  const elapsed = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(rateLimit, bucket.tokens + elapsed * rateLimit);
  bucket.lastRefill = now;

  if (bucket.tokens < 1) {
    return false;
  }

  bucket.tokens -= 1;
  return true;
}

// --- Hash helper ---

function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

// --- Middleware ---

/**
 * Global onRequest hook that checks for API key authentication.
 * If an API key is present (query param or header), validates and rate-limits.
 * If no key present, falls through for default anonymous rate limits.
 */
export async function apiKeyAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Check for API key in query param or header
  const queryKey = (request.query as Record<string, string | undefined>)?.apikey;
  const headerKey = request.headers['x-api-key'] as string | undefined;
  const rawKey = queryKey || headerKey;

  if (!rawKey) return; // No API key — anonymous access, fall through

  const keyHash = hashApiKey(rawKey);
  const keyRow = await getApiKeyByHash(keyHash);

  if (!keyRow) {
    reply.status(401);
    reply.send({ ok: false, error: 'Invalid or revoked API key' });
    return;
  }

  // Check daily limit (-1 means unlimited)
  if (keyRow.daily_limit > 0 && keyRow.requests_today >= keyRow.daily_limit) {
    reply.status(429);
    reply.send({ ok: false, error: 'Daily API request limit exceeded' });
    return;
  }

  // Check per-second rate limit via token bucket
  if (!checkTokenBucket(keyRow.key_prefix, keyRow.rate_limit)) {
    reply.status(429);
    reply.send({ ok: false, error: 'Rate limit exceeded. Slow down requests.' });
    return;
  }

  // Attach API key info to request
  request.apiKey = {
    id: keyRow.id,
    userId: keyRow.user_id,
    tier: keyRow.tier,
    rateLimit: keyRow.rate_limit,
    dailyLimit: keyRow.daily_limit,
  };

  // Track usage asynchronously (don't block the response)
  incrementUsage(keyRow.id).catch(() => {});
}
