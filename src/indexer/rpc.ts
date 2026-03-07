import { setTimeout as delay } from 'node:timers/promises';

type JsonRpcResponse<T> = {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
};

/**
 * RPC client with round-robin load balancing across multiple nodes
 * and optional archive node for historical/trace queries.
 */
export class RpcClient {
  private idCounter = 1;
  private readonly urls: string[];
  private readonly archiveUrl: string | null;
  private roundRobinIndex = 0;

  constructor(urls: string | string[], archiveUrl?: string) {
    this.urls = Array.isArray(urls) ? urls : urls.split(',').map((u) => u.trim()).filter(Boolean);
    this.archiveUrl = archiveUrl ?? null;
    if (this.urls.length === 0) {
      throw new Error('At least one RPC URL is required');
    }
  }

  private nextUrl(): string {
    const url = this.urls[this.roundRobinIndex % this.urls.length];
    this.roundRobinIndex++;
    return url;
  }

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    let lastError: Error | null = null;
    // Try each node once
    for (let i = 0; i < this.urls.length; i++) {
      const url = this.nextUrl();
      try {
        return await this.callUrl<T>(url, method, params);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    throw lastError ?? new Error('All RPC nodes failed');
  }

  /**
   * Call archive node for historical queries (debug_traceTransaction, old state).
   * Falls back to regular nodes if no archive URL is configured.
   */
  async callArchive<T>(method: string, params: unknown[] = []): Promise<T> {
    if (this.archiveUrl) {
      return this.callUrl<T>(this.archiveUrl, method, params);
    }
    return this.call<T>(method, params);
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

  async callArchiveWithRetry<T>(method: string, params: unknown[] = [], attempts = 3): Promise<T> {
    let lastError: unknown;
    for (let i = 0; i < attempts; i += 1) {
      try {
        return await this.callArchive<T>(method, params);
      } catch (error) {
        lastError = error;
        await delay(500 * (i + 1));
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Archive RPC call failed');
  }

  private async callUrl<T>(url: string, method: string, params: unknown[]): Promise<T> {
    const id = this.idCounter++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    const res = await fetch(url, {
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

  get nodeCount(): number {
    return this.urls.length;
  }

  get hasArchive(): boolean {
    return this.archiveUrl !== null;
  }
}
