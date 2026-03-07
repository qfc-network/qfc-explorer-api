import { setTimeout as delay } from 'node:timers/promises';

type JsonRpcResponse<T> = {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
};

export class RpcClient {
  private idCounter = 1;
  private readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const id = this.idCounter++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (!res.ok) {
      throw new Error(`RPC HTTP ${res.status}: ${res.statusText}`);
    }

    const payload = (await res.json()) as JsonRpcResponse<T>;
    if (payload.error) {
      throw new Error(`RPC ${payload.error.code}: ${payload.error.message}`);
    }

    if (typeof payload.result === 'undefined') {
      throw new Error('RPC response missing result');
    }

    return payload.result;
  }

  async callWithRetry<T>(method: string, params: unknown[] = [], attempts = 3): Promise<T> {
    let lastError: unknown;
    for (let i = 0; i < attempts; i += 1) {
      try {
        return await this.call<T>(method, params);
      } catch (error) {
        lastError = error;
        await delay(500 * (i + 1));
      }
    }

    throw lastError instanceof Error ? lastError : new Error('RPC call failed');
  }
}
