import { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { getLatestBlocks, getLatestTransactions, getStatsOverview } from '../db/queries.js';

type Subscription = {
  ws: WebSocket;
  channels: Set<string>;       // 'blocks' | 'txs' | 'stats'
  addresses: Set<string>;       // lowercase addresses for tx filtering
};

const subscribers = new Set<Subscription>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastBlockHeight: string | null = null;

const POLL_INTERVAL_MS = Math.max(Number(process.env.SSE_INTERVAL_MS || 5000), 3000);

async function broadcastUpdates() {
  if (subscribers.size === 0) return;

  try {
    const [blocks, txs, stats] = await Promise.all([
      getLatestBlocks(5),
      getLatestTransactions(10),
      getStatsOverview(),
    ]);

    const currentHeight = blocks[0]?.height?.toString() ?? null;
    const isNewBlock = currentHeight !== lastBlockHeight && currentHeight !== null;
    lastBlockHeight = currentHeight;

    if (!isNewBlock) return;

    for (const sub of subscribers) {
      if (sub.ws.readyState !== 1) continue; // OPEN

      try {
        if (sub.channels.has('blocks')) {
          sub.ws.send(JSON.stringify({ event: 'new_block', data: blocks[0] }));
        }

        if (sub.channels.has('txs')) {
          sub.ws.send(JSON.stringify({ event: 'new_txs', data: txs.slice(0, 5) }));
        }

        if (sub.channels.has('stats')) {
          sub.ws.send(JSON.stringify({ event: 'stats', data: stats }));
        }

        // Address-specific tx notifications
        if (sub.addresses.size > 0) {
          const matched = txs.filter(
            (tx) =>
              sub.addresses.has((tx.from_address || '').toLowerCase()) ||
              sub.addresses.has((tx.to_address || '').toLowerCase())
          );
          if (matched.length > 0) {
            sub.ws.send(JSON.stringify({ event: 'address_txs', data: matched }));
          }
        }
      } catch {
        // send failed, will be cleaned up on close
      }
    }
  } catch {
    // poll error, skip this cycle
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(broadcastUpdates, POLL_INTERVAL_MS);
}

function stopPollingIfEmpty() {
  if (subscribers.size === 0 && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    lastBlockHeight = null;
  }
}

export default async function wsRoutes(app: FastifyInstance) {
  await app.register(websocket);

  app.get('/ws', { websocket: true }, (socket) => {
    const sub: Subscription = {
      ws: socket,
      channels: new Set(),
      addresses: new Set(),
    };
    subscribers.add(sub);
    startPolling();

    socket.send(JSON.stringify({ event: 'connected', data: { message: 'Send subscribe/unsubscribe commands' } }));

    socket.on('message', (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          action: 'subscribe' | 'unsubscribe';
          channel?: string;
          address?: string;
        };

        if (msg.action === 'subscribe') {
          if (msg.channel && ['blocks', 'txs', 'stats'].includes(msg.channel)) {
            sub.channels.add(msg.channel);
            socket.send(JSON.stringify({ event: 'subscribed', data: { channel: msg.channel } }));
          }
          if (msg.address) {
            sub.addresses.add(msg.address.toLowerCase());
            socket.send(JSON.stringify({ event: 'subscribed', data: { address: msg.address.toLowerCase() } }));
          }
        } else if (msg.action === 'unsubscribe') {
          if (msg.channel) {
            sub.channels.delete(msg.channel);
            socket.send(JSON.stringify({ event: 'unsubscribed', data: { channel: msg.channel } }));
          }
          if (msg.address) {
            sub.addresses.delete(msg.address.toLowerCase());
            socket.send(JSON.stringify({ event: 'unsubscribed', data: { address: msg.address.toLowerCase() } }));
          }
        }
      } catch {
        socket.send(JSON.stringify({ event: 'error', data: { message: 'Invalid JSON' } }));
      }
    });

    socket.on('close', () => {
      subscribers.delete(sub);
      stopPollingIfEmpty();
    });
  });
}

export function getWsStats() {
  let totalChannels = 0;
  let totalAddresses = 0;
  for (const sub of subscribers) {
    totalChannels += sub.channels.size;
    totalAddresses += sub.addresses.size;
  }
  return {
    connections: subscribers.size,
    channels: totalChannels,
    addresses: totalAddresses,
    polling: pollTimer !== null,
  };
}
