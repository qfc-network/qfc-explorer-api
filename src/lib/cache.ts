import Redis, { Cluster } from 'ioredis';

type RedisClient = Redis | Cluster;
let client: RedisClient | null = null;

/**
 * Get or create Redis/Cluster connection.
 * Supports two modes:
 *   - REDIS_CLUSTER_NODES=host1:port1,host2:port2,... → ioredis Cluster
 *   - REDIS_URL=redis://host:port → standalone Redis
 * Returns null if neither is set (cache disabled, all ops become no-ops).
 */
export function getRedis(): RedisClient | null {
  if (client) return client;

  const clusterNodes = process.env.REDIS_CLUSTER_NODES;
  const url = process.env.REDIS_URL;

  if (clusterNodes) {
    const nodes = clusterNodes.split(',').map((n) => {
      const [host, port] = n.trim().split(':');
      return { host, port: Number(port) || 6379 };
    });

    client = new Cluster(nodes, {
      redisOptions: {
        maxRetriesPerRequest: 1,
      },
      clusterRetryStrategy(times) {
        if (times > 3) return null;
        return Math.min(times * 200, 2000);
      },
      enableReadyCheck: true,
      scaleReads: 'slave',  // read from replicas for better throughput
    });

    client.on('error', (err) => {
      console.error('[cache] Redis Cluster error:', err.message);
    });

    return client;
  }

  if (!url) return null;

  client = new Redis(url, {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    retryStrategy(times) {
      if (times > 3) return null;
      return Math.min(times * 200, 2000);
    },
  });

  client.on('error', (err) => {
    console.error('[cache] Redis error:', err.message);
  });

  (client as Redis).connect().catch(() => {
    // silent — ops will fail gracefully
  });

  return client;
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
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
 * In cluster mode, scans each master node individually.
 */
export async function cacheDel(key: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    if (key.includes('*')) {
      if (r instanceof Cluster) {
        // Cluster: scan each master node
        const masters = r.nodes('master');
        for (const node of masters) {
          const keys = await scanKeys(node, key);
          if (keys.length > 0) await node.del(...keys);
        }
      } else {
        const keys = await scanKeys(r, key);
        if (keys.length > 0) await r.del(...keys);
      }
    } else {
      await r.del(key);
    }
  } catch {
    // non-fatal
  }
}

/** Scan keys matching a pattern (cluster-safe, avoids KEYS command) */
async function scanKeys(node: Redis, pattern: string): Promise<string[]> {
  return new Promise((resolve) => {
    const found: string[] = [];
    const stream = node.scanStream({ match: pattern, count: 100 });
    stream.on('data', (keys: string[]) => found.push(...keys));
    stream.on('end', () => resolve(found));
    stream.on('error', () => resolve(found));
  });
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

/** Get Redis mode info for health/admin endpoints */
export function getRedisConfig() {
  const clusterNodes = process.env.REDIS_CLUSTER_NODES;
  const url = process.env.REDIS_URL;
  return {
    mode: clusterNodes ? 'cluster' : url ? 'standalone' : 'disabled',
    nodes: clusterNodes ? clusterNodes.split(',').length : url ? 1 : 0,
    connected: client !== null,
  };
}
