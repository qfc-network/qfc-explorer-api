import Redis from 'ioredis';

let redis: Redis | null = null;

/**
 * Get or create Redis connection.
 * Returns null if REDIS_URL is not set (cache disabled, all ops become no-ops).
 */
export function getRedis(): Redis | null {
  if (redis) return redis;

  const url = process.env.REDIS_URL;
  if (!url) return null;

  redis = new Redis(url, {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    retryStrategy(times) {
      if (times > 3) return null; // stop retrying
      return Math.min(times * 200, 2000);
    },
  });

  redis.on('error', (err) => {
    console.error('[cache] Redis error:', err.message);
  });

  redis.connect().catch(() => {
    // silent — getRedis() will return the instance, ops will fail gracefully
  });

  return redis;
}

export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}

/**
 * Get a cached value. Returns null on miss or if Redis is unavailable.
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    const val = await r.get(key);
    return val ? (JSON.parse(val) as T) : null;
  } catch {
    return null;
  }
}

/**
 * Set a cached value with TTL in seconds.
 */
export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch {
    // cache write failure is non-fatal
  }
}

/**
 * Delete a cached key (or pattern with wildcard).
 */
export async function cacheDel(key: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    if (key.includes('*')) {
      const keys = await r.keys(key);
      if (keys.length > 0) await r.del(...keys);
    } else {
      await r.del(key);
    }
  } catch {
    // non-fatal
  }
}

/**
 * Cache-through helper: get from cache, or compute and store.
 */
export async function cached<T>(
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>
): Promise<T> {
  const hit = await cacheGet<T>(key);
  if (hit !== null) return hit;

  const value = await compute();
  await cacheSet(key, value, ttlSeconds);
  return value;
}
