type RateLimitEntry = { count: number; resetAt: number };
type RateLimitStats = { ip: string; requests: number; limited: boolean; resetAt: number };

const store = new Map<string, RateLimitEntry>();
const history: Array<{ ip: string; path: string; timestamp: number; limited: boolean }> = [];

const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS = 100;
const HISTORY_SIZE = 1000;

export function checkRateLimit(ip: string): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const entry = store.get(ip);

  if (Math.random() < 0.01) cleanupExpired();

  if (!entry || entry.resetAt < now) {
    store.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, remaining: MAX_REQUESTS - 1, resetAt: now + WINDOW_MS };
  }

  if (entry.count >= MAX_REQUESTS) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }

  entry.count += 1;
  return { allowed: true, remaining: MAX_REQUESTS - entry.count, resetAt: entry.resetAt };
}

export function recordRequest(ip: string, path: string, limited: boolean): void {
  history.push({ ip, path, timestamp: Date.now(), limited });
  if (history.length > HISTORY_SIZE) {
    history.splice(0, history.length - HISTORY_SIZE);
  }
}

export function getRateLimitStats() {
  const now = Date.now();
  const activeEntries: RateLimitStats[] = [];
  store.forEach((entry, ip) => {
    if (entry.resetAt > now) {
      activeEntries.push({ ip: maskIp(ip), requests: entry.count, limited: entry.count >= MAX_REQUESTS, resetAt: entry.resetAt });
    }
  });
  activeEntries.sort((a, b) => b.requests - a.requests);

  const oneMinuteAgo = now - WINDOW_MS;
  const recentHistory = history.filter((r) => r.timestamp > oneMinuteAgo);
  const limitedCount = recentHistory.filter((r) => r.limited).length;

  return {
    activeIps: activeEntries.length,
    totalRequests: recentHistory.length,
    limitedRequests: limitedCount,
    topIps: activeEntries.slice(0, 10),
    recentRequests: history.slice(-50).reverse().map((r) => ({ ...r, ip: maskIp(r.ip) })),
  };
}

export function getConfig() {
  return { windowMs: WINDOW_MS, maxRequests: MAX_REQUESTS };
}

function cleanupExpired(): void {
  const now = Date.now();
  store.forEach((entry, ip) => {
    if (entry.resetAt < now) store.delete(ip);
  });
}

function maskIp(ip: string): string {
  const parts = ip.split('.');
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.*`;
  return ip.substring(0, 12) + '...';
}
