# QFC Explorer API

[![CI](https://github.com/qfc-network/qfc-explorer-api/actions/workflows/ci.yml/badge.svg)](https://github.com/qfc-network/qfc-explorer-api/actions/workflows/ci.yml)
[![Docker](https://github.com/qfc-network/qfc-explorer-api/actions/workflows/docker.yml/badge.svg)](https://github.com/qfc-network/qfc-explorer-api/actions/workflows/docker.yml)

Standalone backend API for [QFC Blockchain Explorer](https://github.com/qfc-network/qfc-explorer), built with **Fastify + TypeScript**.

Separated from the Next.js frontend to enable independent scaling, Prometheus metrics, and WebSocket support.

## Features

- **Full REST API** — blocks, transactions, addresses, contracts, tokens, search, analytics, leaderboard
- **Prometheus metrics** (`/metrics`) — request latency histogram, error counter, blockchain gauges
- **Server-Sent Events** (`/stream`) — real-time network stats push
- **Contract verification** — Solidity source code → bytecode matching with `solc`
- **Proxy detection** — EIP-1967 / EIP-1822 (UUPS) / Beacon proxy identification
- **AI inference** — QFC-specific inference task tracking and compute stats
- **Health check** — DB connectivity + RPC reachability + indexer lag monitoring
- **Rate limiting** — in-memory (100 req/min/IP), Redis-ready architecture

## Quick Start

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env: set DATABASE_URL and RPC_URL

# Development (auto-reload)
npm run dev

# Production
npm run build
npm start
```

The API server starts on `http://localhost:3001` by default.

## Architecture

```
qfc-explorer (Next.js)  ──fetch()──>  qfc-explorer-api (Fastify :3001)
                                              │
                                        ┌─────┴─────┐
                                        │   Redis    │  (planned)
                                        └─────┬─────┘
                                              │
                                        ┌─────┴─────┐
                                        │ PostgreSQL │  (shared DB)
                                        └─────┬─────┘
                                              │
                                        ┌─────┴─────┐
                                        │ QFC Node   │  (RPC :8545)
                                        └───────────┘
```

## API Endpoints

### Blockchain Data

| Method | Path | Description |
|--------|------|-------------|
| GET | `/blocks` | Paginated block list |
| GET | `/blocks/:height` | Block details + transactions |
| GET | `/txs` | Paginated transaction list (filter by address/status) |
| GET | `/txs/:hash` | Transaction details + event logs (DB + RPC fallback) |
| GET | `/address/:address` | Address profile: balance, txs, tokens, NFTs, contract info |

### Contracts

| Method | Path | Description |
|--------|------|-------------|
| GET | `/contract/:address` | Contract details, bytecode, proxy detection, verification status |
| POST | `/contract/call` | Execute read-only contract call (name, symbol, balanceOf, etc.) |
| GET | `/contract` | Paginated contract list |
| GET | `/contract/verified` | Top verified contracts by interaction count |
| POST | `/contract/verify` | Verify contract source code (Solidity → bytecode match) |

### Tokens

| Method | Path | Description |
|--------|------|-------------|
| GET | `/tokens` | ERC-20/721/1155 token list |
| GET | `/tokens/:address` | Token details + transfer history |
| GET | `/tokens/:address/holders` | Token holder rankings (ERC-20 + NFT) |

### Search

| Method | Path | Description |
|--------|------|-------------|
| GET | `/search?q=...` | Search by block height/hash, tx hash, address, token name |
| GET | `/search/suggest?q=...` | Autocomplete suggestions (5 per category) |

### Analytics & Leaderboard

| Method | Path | Description |
|--------|------|-------------|
| GET | `/analytics` | Network overview + time series (TPS, gas, block time) |
| GET | `/analytics/daily?days=30` | Daily aggregate stats (1-365 days) |
| GET | `/analytics/export?type=tps&format=csv` | CSV/JSON data export |
| GET | `/leaderboard` | Top accounts, validators, contracts by various metrics |

### Network & AI Inference (QFC-specific)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/network` | Epoch info, validators, hashrate |
| GET | `/inference` | AI inference stats, compute info, supported models |
| GET | `/inference/task?id=...` | Query inference task status |
| GET | `/governance/models` | Supported models & governance proposals |

### Operations

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (DB + RPC + indexer lag), returns 503 if degraded |
| GET | `/metrics` | Prometheus metrics (text exposition format) |
| GET | `/stream` | SSE real-time stats (configurable interval) |
| GET | `/admin/db` | Database connection pool stats |
| GET | `/admin/indexer` | Indexer state, batch stats, failed blocks |
| POST | `/admin/indexer/rescan` | Trigger block rescan from height |
| POST | `/admin/indexer/retry-failed` | Retry failed block processing |
| GET | `/admin/rate-limit` | Rate limiting stats |
| GET | `/tools/keccak256?input=...` | Keccak256 hash utility |

### Common Query Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `page` | `1` | Page number |
| `limit` | `25` | Items per page (max 100, holders max 200) |
| `order` | `desc` | Sort order: `asc` or `desc` |

### Response Format

All endpoints return consistent JSON:

```json
// Success
{ "ok": true, "data": { ... } }

// Error
{ "ok": false, "error": "error message" }
```

## Prometheus Metrics

Available at `GET /metrics`:

```
# Request metrics
qfc_api_request_duration_seconds{method, route, status}    histogram
qfc_api_requests_total{method, route, status}              counter
qfc_api_errors_total{route, status}                        counter

# Blockchain gauges (updated every 15s)
qfc_indexer_height                                         gauge
qfc_rpc_height                                             gauge
qfc_indexer_lag_blocks                                     gauge
qfc_total_blocks                                           gauge
qfc_total_transactions                                     gauge
qfc_total_accounts                                         gauge
qfc_db_healthy                                             gauge (1/0)
qfc_rpc_healthy                                            gauge (1/0)

# Default Node.js metrics (GC, event loop, memory)
```

Prometheus scrape config:
```yaml
scrape_configs:
  - job_name: 'qfc-explorer-api'
    static_configs:
      - targets: ['qfc-explorer-api:3001']
```

## Docker

### Build & Run

```bash
docker build -t qfc-explorer-api .
docker run -p 3001:3001 \
  -e DATABASE_URL=postgres://user:pass@host:5432/qfc_explorer \
  -e RPC_URL=http://qfc-node:8545 \
  qfc-explorer-api
```

### Pre-built Image

```bash
docker pull ghcr.io/qfc-network/qfc-explorer-api:staging
```

### Docker Compose (with qfc-explorer)

```yaml
services:
  explorer:
    image: ghcr.io/qfc-network/qfc-explorer:staging
    ports: ['3000:3000']
    environment:
      NEXT_PUBLIC_API_URL: http://api:3001

  api:
    image: ghcr.io/qfc-network/qfc-explorer-api:staging
    ports: ['3001:3001']
    environment:
      DATABASE_URL: postgres://qfc:qfc@postgres:5432/qfc_explorer
      RPC_URL: http://qfc-node:8545
      CORS_ORIGIN: http://localhost:3000

  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: qfc
      POSTGRES_PASSWORD: qfc
      POSTGRES_DB: qfc_explorer
    volumes: ['pgdata:/var/lib/postgresql/data']

volumes:
  pgdata:
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | — | PostgreSQL connection string (**required**) |
| `RPC_URL` | `http://127.0.0.1:8545` | QFC node JSON-RPC endpoint |
| `PORT` | `3001` | API server port |
| `HOST` | `0.0.0.0` | Bind address |
| `CORS_ORIGIN` | `*` | Allowed CORS origins (comma-separated or `*`) |
| `SSE_INTERVAL_MS` | `5000` | SSE push interval in ms (min 3000) |

## Development

```bash
# Type check
npm run typecheck

# Watch mode (auto-reload on file changes)
npm run dev

# Test endpoints
curl http://localhost:3001/health
curl http://localhost:3001/blocks?limit=5
curl http://localhost:3001/metrics
```

## Related Projects

| Repo | Description |
|------|-------------|
| [qfc-explorer](https://github.com/qfc-network/qfc-explorer) | Next.js frontend |
| [qfc-core](https://github.com/qfc-network/qfc-core) | Blockchain node (Rust) |
| [qfc-testnet](https://github.com/qfc-network/qfc-testnet) | Testnet deployment |
| [qfc-docs](https://github.com/qfc-network/qfc-docs) | Documentation (docs.qfc.network) |

## License

MIT
