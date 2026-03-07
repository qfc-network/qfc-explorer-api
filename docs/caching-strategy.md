# QFC Explorer API — Caching Strategy

## Overview

Redis-based caching layer with **graceful degradation** — when `REDIS_URL` is not configured, all cache operations become no-ops and the API falls back to direct DB/RPC queries. This means Redis is entirely optional; the API functions identically without it, just slower on hot paths.

## Architecture

```
Client Request
  │
  ▼
Fastify Route Handler
  │
  ├─ cache hit? ──► return cached JSON
  │
  ├─ cache miss ──► DB/RPC query ──► store in Redis (TTL) ──► return
  │
  └─ Redis unavailable ──► DB/RPC query ──► return (no caching)
```

### Core Primitives (`src/lib/cache.ts`)

| Function | Description |
|----------|-------------|
| `cached(key, ttl, compute)` | Cache-through: return cached value or compute + store |
| `cacheGet(key)` | Read from cache, returns `null` on miss or error |
| `cacheSet(key, value, ttl)` | Write to cache with TTL (seconds) |
| `cacheDel(key)` | Delete key or pattern (supports `*` wildcard via `KEYS`) |

All operations are wrapped in try/catch — cache failures are **non-fatal** and silently ignored.

## TTL Strategy by Route

| Route | Cache Key | TTL | Rationale |
|-------|-----------|-----|-----------|
| `GET /blocks` | `blocks:{page}:{limit}:{order}:{producer}` | **5s** | Block list changes frequently as new blocks arrive |
| `GET /blocks/:height` | `block:{height}:{page}:{limit}:{order}` | **60s** | Finalized blocks are immutable |
| `GET /txs/:hash` (indexed) | `tx:{hash}` | **60s** | Indexed transactions are finalized |
| `GET /txs/:hash` (RPC fallback) | `tx:{hash}` | **15s** | May get indexed later, shorter TTL to pick up enriched data |
| `GET /contract/:address` | `contract:{address}` | **30s** | Contract code is immutable, balance may change |
| `GET /contract/verified` | `contracts:verified` | **60s** | Verified contract list rarely changes |
| `GET /analytics` | `analytics:overview` | **30s** | Aggregate stats update with each block |
| `GET /analytics/daily` | `analytics:daily:{days}` | **60s** | Daily stats are pre-aggregated, update once per batch |
| `GET /leaderboard` | `leaderboard` | **60s** | Heavy multi-query aggregation, acceptable staleness |
| `GET /health` | `health` | **10s** | Frequent checks but DB/RPC probes are cheap |

### Routes Without Caching

| Route | Reason |
|-------|--------|
| `GET /txs` (list) | Paginated with filters, high cardinality |
| `GET /address/:address` | Real-time balance from RPC, personalized data |
| `GET /tokens/*` | Low traffic, fast DB queries |
| `GET /search/*` | Query-specific, high cardinality |
| `GET /network` | Live RPC data (epoch, validators, node info) |
| `GET /inference/*` | Live inference stats from RPC |
| `GET /governance/*` | Live model registry from RPC |
| `GET /stream` (SSE) | Real-time push, caching defeats the purpose |
| `GET /analytics/export` | Large payloads, infrequent access |
| `POST /contract/call` | Dynamic contract reads |
| `POST /contract/verify` | Write operation |

## Redis Connection

```typescript
// Lazy singleton — connects on first access
const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 1,    // fail fast per request
  lazyConnect: true,           // don't block startup
  retryStrategy(times) {
    if (times > 3) return null; // stop reconnecting after 3 attempts
    return Math.min(times * 200, 2000);
  },
});
```

Key design decisions:
- **Lazy connect**: Server starts immediately even if Redis is down
- **Fast failure**: `maxRetriesPerRequest: 1` prevents request-level blocking
- **Bounded reconnect**: Stops retrying after 3 failures to avoid log spam
- **Silent errors**: All cache operations catch and swallow exceptions

## Cache Key Naming Convention

```
{entity}:{identifier}:{params}
```

Examples:
- `blocks:1:25:desc:` — block list page 1, 25 per page, descending, no producer filter
- `block:42:1:25:desc` — block #42 detail with tx pagination
- `tx:0xabc...` — transaction by hash
- `contract:0xdef...` — contract detail by address
- `contracts:verified` — verified contracts leaderboard
- `analytics:overview` — network overview stats
- `analytics:daily:30` — daily stats for 30 days
- `leaderboard` — full leaderboard
- `health` — health check

## Cache Invalidation

Currently uses **TTL-based expiration only** — no active invalidation. This is acceptable because:

1. Block explorer data is **append-only** (new blocks/txs) rather than mutable
2. Short TTLs (5–60s) provide near-real-time freshness for most use cases
3. The indexer processes blocks in batches, so a few seconds of staleness is within the indexing latency anyway

The `cacheDel` function supports wildcard patterns for future use (e.g., invalidating all block pages when a new block is indexed):
```typescript
await cacheDel('blocks:*');  // clears all block list caches
```

## Monitoring

Redis connection status is included in the `/health` endpoint:
```json
{
  "status": "healthy",
  "redis": { "connected": true }
}
```

## Docker Compose

```yaml
redis:
  image: redis:7-alpine
  ports: ["6379:6379"]
  volumes: ["redis-data:/data"]

explorer-api:
  environment:
    - REDIS_URL=redis://redis:6379
```

Without the `REDIS_URL` variable, the API runs without caching — useful for local development or single-instance deployments where the overhead of Redis isn't justified.
