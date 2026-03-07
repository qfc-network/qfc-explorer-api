const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8545';

let rpcId = 1;

export async function rpcCall<T = unknown>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: rpcId++ }),
    signal: AbortSignal.timeout(10000),
  });
  const json = await res.json() as { result?: T; error?: { message: string } };
  if (json.error) {
    throw new Error(`RPC error: ${json.error.message}`);
  }
  return json.result as T;
}

export async function rpcCallSafe<T = unknown>(method: string, params: unknown[]): Promise<T | null> {
  try {
    return await rpcCall<T>(method, params);
  } catch {
    return null;
  }
}
