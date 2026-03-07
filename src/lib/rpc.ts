/**
 * Multi-RPC client with round-robin load balancing and archive node support.
 *
 * Environment variables:
 *   RPC_URL          — comma-separated list of RPC endpoints (round-robin)
 *   RPC_ARCHIVE_URL  — archive node for historical queries (debug_*, eth_getStorageAt at old blocks)
 *
 * Examples:
 *   RPC_URL=http://node1:8545,http://node2:8545,http://node3:8545
 *   RPC_ARCHIVE_URL=http://archive-node:8545
 */

type JsonRpcResponse<T> = {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: { code: number; message: string };
};

const TIMEOUT_MS = 10_000;

function parseUrls(envVar: string | undefined, fallback: string): string[] {
  if (!envVar) return [fallback];
  return envVar.split(',').map((u) => u.trim()).filter(Boolean);
}

const rpcUrls = parseUrls(process.env.RPC_URL, 'http://127.0.0.1:8545');
const archiveUrl = process.env.RPC_ARCHIVE_URL || null;

let rpcId = 1;
let roundRobinIndex = 0;

function nextUrl(): string {
  const url = rpcUrls[roundRobinIndex % rpcUrls.length];
  roundRobinIndex++;
  return url;
}

async function callUrl<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: rpcId++ }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await res.json() as JsonRpcResponse<T>;
  if (json.error) {
    throw new Error(`RPC error: ${json.error.message}`);
  }
  return json.result as T;
}

/**
 * Call an RPC method with round-robin failover across configured nodes.
 * Tries each node once before giving up.
 */
export async function rpcCall<T = unknown>(method: string, params: unknown[]): Promise<T> {
  let lastError: Error | null = null;
  for (let i = 0; i < rpcUrls.length; i++) {
    const url = nextUrl();
    try {
      return await callUrl<T>(url, method, params);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      // Continue to next node
    }
  }
  throw lastError ?? new Error('All RPC nodes failed');
}

/**
 * Safe wrapper — returns null instead of throwing.
 */
export async function rpcCallSafe<T = unknown>(method: string, params: unknown[]): Promise<T | null> {
  try {
    return await rpcCall<T>(method, params);
  } catch {
    return null;
  }
}

/**
 * Call archive node for historical queries (debug_*, old block state).
 * Falls back to regular RPC if no archive node is configured.
 */
export async function rpcCallArchive<T = unknown>(method: string, params: unknown[]): Promise<T> {
  if (archiveUrl) {
    return callUrl<T>(archiveUrl, method, params);
  }
  return rpcCall<T>(method, params);
}

export async function rpcCallArchiveSafe<T = unknown>(method: string, params: unknown[]): Promise<T | null> {
  try {
    return await rpcCallArchive<T>(method, params);
  } catch {
    return null;
  }
}

/**
 * Get info about configured RPC endpoints (for health/admin).
 */
export function getRpcConfig() {
  return {
    nodes: rpcUrls,
    archiveNode: archiveUrl,
    nodeCount: rpcUrls.length,
  };
}
