# QFC Explorer API

Fastify + TypeScript backend for [QFC Blockchain Explorer](https://github.com/qfc-network/qfc-explorer).

## Features

- RESTful API for blocks, transactions, addresses, contracts, tokens
- Prometheus metrics (`/metrics`) — request latency, error rate, blockchain gauges
- Server-Sent Events (`/stream`) — real-time network stats
- Contract verification (Solidity source → bytecode matching)
- EIP-1967/1822 proxy contract detection
- Rate limiting (in-memory, Redis-ready)

## Quick Start

```bash
# Install
npm install

# Configure
cp .env.example .env
# Edit .env with your DATABASE_URL and RPC_URL

# Development
npm run dev

# Production
npm run build
npm start
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/blocks` | Paginated block list |
| GET | `/blocks/:height` | Block details + transactions |
| GET | `/txs` | Paginated transaction list |
| GET | `/txs/:hash` | Transaction details + logs |
| GET | `/address/:address` | Address profile (EOA/contract) |
| GET | `/contract/:address` | Contract details + proxy detection |
| POST | `/contract/call` | Read-only contract call |
| GET | `/contract/verified` | Top verified contracts |
| POST | `/contract/verify` | Source code verification |
| GET | `/tokens` | Token list |
| GET | `/tokens/:address` | Token details + transfers |
| GET | `/tokens/:address/holders` | Token holder rankings |
| GET | `/search` | Full-text search |
| GET | `/search/suggest` | Autocomplete suggestions |
| GET | `/analytics` | Network overview + time series |
| GET | `/analytics/daily` | Daily aggregate stats |
| GET | `/analytics/export` | CSV/JSON data export |
| GET | `/network` | Network status + validators |
| GET | `/inference` | AI inference stats |
| GET | `/inference/task` | Query inference task |
| GET | `/governance/models` | Supported models |
| GET | `/leaderboard` | Top accounts/validators/contracts |
| GET | `/stream` | SSE real-time stats |
| GET | `/health` | Health check (DB + RPC + indexer) |
| GET | `/metrics` | Prometheus metrics |
| GET | `/admin/db` | DB pool stats |
| GET | `/admin/indexer` | Indexer state |
| GET | `/tools/keccak256` | Keccak256 hash |

## Docker

```bash
docker build -t qfc-explorer-api .
docker run -p 3001:3001 \
  -e DATABASE_URL=postgres://... \
  -e RPC_URL=http://qfc-node:8545 \
  qfc-explorer-api
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | — | PostgreSQL connection string |
| `RPC_URL` | `http://127.0.0.1:8545` | QFC node RPC endpoint |
| `PORT` | `3001` | API server port |
| `HOST` | `0.0.0.0` | API server host |
| `CORS_ORIGIN` | `*` | Allowed CORS origins |
| `SSE_INTERVAL_MS` | `5000` | SSE push interval (min 3000) |
