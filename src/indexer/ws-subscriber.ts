import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

/**
 * WebSocket subscriber for `eth_subscribe("newHeads")`.
 *
 * Connects to a WebSocket-enabled Ethereum node and emits 'newHead' events
 * when new blocks are produced. Falls back gracefully — if WS is unavailable,
 * the indexer continues with polling.
 *
 * Auto-reconnects on disconnect with exponential backoff (1s → 2s → 4s → … → 60s).
 */
export class WsSubscriber extends EventEmitter {
  private ws: WebSocket | null = null;
  private subscriptionId: string | null = null;
  private readonly url: string;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _connected = false;
  private _stopped = false;
  private idCounter = 1;

  constructor(url: string) {
    super();
    this.url = url;
  }

  get connected(): boolean {
    return this._connected;
  }

  /**
   * Start the WebSocket connection and subscribe to newHeads.
   */
  start(): void {
    this._stopped = false;
    this.connect();
  }

  /**
   * Stop the subscriber and close the WebSocket connection.
   */
  stop(): void {
    this._stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
    this.subscriptionId = null;
  }

  private connect(): void {
    if (this._stopped) return;

    try {
      this.ws = new WebSocket(this.url);
    } catch (error) {
      console.warn(`[WS] Failed to create WebSocket connection:`, error);
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      console.log(`[WS] Connected to ${this.url}`);
      this.reconnectAttempts = 0;
      this._connected = true;
      this.subscribe();
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());

        // Subscription confirmation
        if (msg.id && msg.result && !msg.method) {
          this.subscriptionId = msg.result;
          console.log(`[WS] Subscribed to newHeads (subscription: ${this.subscriptionId})`);
          return;
        }

        // newHead notification
        if (msg.method === 'eth_subscription' && msg.params?.subscription === this.subscriptionId) {
          const blockNumber = msg.params.result?.number;
          if (blockNumber) {
            this.emit('newHead', blockNumber);
          }
        }
      } catch {
        // Ignore malformed messages
      }
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      const reasonStr = reason.toString() || 'unknown';
      console.warn(`[WS] Disconnected (code=${code}, reason=${reasonStr})`);
      this._connected = false;
      this.subscriptionId = null;
      this.scheduleReconnect();
    });

    this.ws.on('error', (error: Error) => {
      console.warn(`[WS] Error:`, error.message);
      // 'close' event will follow, triggering reconnect
    });
  }

  private subscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const id = this.idCounter++;
    this.ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'eth_subscribe',
      params: ['newHeads'],
    }));
  }

  private scheduleReconnect(): void {
    if (this._stopped) return;

    const backoffMs = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 60_000);
    this.reconnectAttempts += 1;
    console.log(`[WS] Reconnecting in ${backoffMs}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, backoffMs);
  }

  /**
   * Returns a promise that resolves when a new head is received,
   * or after the given timeout (whichever comes first).
   *
   * @returns true if a new head was received, false if timed out
   */
  waitForNewHead(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this._connected) {
        resolve(false);
        return;
      }

      let timer: ReturnType<typeof setTimeout>;
      const onNewHead = () => {
        clearTimeout(timer);
        resolve(true);
      };

      timer = setTimeout(() => {
        this.removeListener('newHead', onNewHead);
        resolve(false);
      }, timeoutMs);

      this.once('newHead', onNewHead);
    });
  }
}
