# QFC Explorer API — Developer Guide

## Project Overview
QFC blockchain explorer backend — standalone Fastify + TypeScript API server.
Separated from [qfc-explorer](https://github.com/qfc-network/qfc-explorer) (Next.js frontend).

## Tech Stack
- **Framework**: Fastify 5, TypeScript, ESM
- **Database**: PostgreSQL 16 (via `pg` pool) — shared with qfc-explorer
- **Monitoring**: Prometheus metrics via `prom-client`
- **Real-time**: Server-Sent Events (SSE)
- **Solidity compiler**: `solc` (optional, for contract verification)

## Key Commands
```bash
npm run dev          # Dev server (tsx watch, auto-reload)
npm run build        # Production build (tsc)
npm start            # Start production server (node dist/server.js)
npm run start:indexer # Start indexer (node dist/indexer/index.js)
npm run indexer      # Dev indexer (tsx, no watch)
npm run indexer:dev  # Dev indexer (tsx watch, auto-reload)
npm run typecheck    # TypeScript check (tsc --noEmit)
```

## Project Structure
```
src/
  server.ts              # Fastify entry point, plugin registration, graceful shutdown
  routes/
    blocks.ts            # GET /blocks, GET /blocks/:height, GET /blocks/:height/internal
    transactions.ts      # GET /txs, GET /txs/:hash (DB + RPC fallback), GET /txs/:hash/internal
    addresses.ts         # GET /address/:address (overview, stats, txs, tokens, NFTs, internal_txs tab)
    contracts.ts         # GET /contract/:address, POST /contract/call, POST /contract/verify
                         # POST /contract/verify-json (Standard JSON Input), POST /contract/decode
                         # POST /contract/decode-log, GET /contract (list), GET /contract/verified
    tokens.ts            # GET /tokens, GET /tokens/:address, GET /tokens/:address/holders
    search.ts            # GET /search (categorized), GET /search/suggest (with labels + contracts)
    analytics.ts         # GET /analytics, GET /analytics/daily, GET /analytics/export
    network.ts           # GET /network (epoch, validators, hashrate via RPC)
    inference.ts         # GET /inference, GET /inference/task (QFC AI inference)
    governance.ts        # GET /governance/models
    leaderboard.ts       # GET /leaderboard (top balances, active, validators, contracts)
    stream.ts            # GET /stream (SSE real-time stats)
    ws.ts                # GET /ws (WebSocket subscriptions: blocks, txs, stats, address)
    admin.ts             # GET /admin/db, GET /admin/indexer, POST /admin/indexer/rescan
                         # GET /admin/archive, POST /admin/archive (cold storage)
    health.ts            # GET /health (DB + RPC + indexer lag check)
    tools.ts             # GET /tools/keccak256
  db/
    pool.ts              # PostgreSQL connection pool (singleton)
    queries.ts           # All DB query helpers (blocks, txs, addresses, tokens, stats, search)
    health.ts            # Health check queries (DB, RPC, indexer lag)
  lib/
    rpc.ts               # Centralized RPC client (rpcCall / rpcCallSafe)
    abi-decoder.ts       # ABI decoding (function calldata + event logs from verified contracts)
    archive.ts           # Data archival (move old partitions to archive schema, fallback queries)
    pagination.ts        # Query param parsing (parseNumber, clamp, parseOrder)
    format.ts            # Formatting utilities (shortenHash, formatWeiToQfc)
    rate-limit.ts        # In-memory rate limiter (100 req/min/IP)
  middleware/
    metrics.ts           # Prometheus histogram/counter/gauge registration + /metrics endpoint
    metrics-updater.ts   # Background timer updating blockchain gauges every 15s
  indexer/
    index.ts             # Orchestrator: main loop, admin commands, pipeline coordination
    block.ts             # Block processor: blocks, txs, accounts, receipts/events, balances
    token.ts             # Token processor: ERC-20/721/1155 transfers, metadata, balances
    contract.ts          # Contract processor: creation detection, code_hash, account upsert
    internal-tx.ts       # Internal tx processor: debug_traceTransaction → internal_transactions
    state.ts             # Shared indexer_state helpers (height, stats, admin commands, daily stats)
    rpc.ts               # RpcClient with retry logic
    types.ts             # RPC types (block, tx, receipt, log, trace)
    utils.ts             # Hex/buffer/decode utilities
    qfc.ts               # QFC-specific RPC types (validators, epoch, inference, governance)
    __tests__/            # Indexer unit tests
```

## Database
Shares the same PostgreSQL database and schema as qfc-explorer. Key tables:
- `blocks` — indexed blocks (hash, height, producer, gas, timestamps)
- `transactions` — indexed transactions (hash, from, to, value, status, gas)
- `accounts` — address balances and nonces
- `contracts` — deployed contracts, verification metadata, ABI
- `events` — transaction event logs (topics + data)
- `tokens` — ERC-20/721/1155 token metadata
- `token_transfers` — token transfer history
- `token_balances` — current holder balances
- `internal_transactions` — internal calls from debug_traceTransaction (CALL, CREATE, etc.)
- `address_labels` — human-readable names for known addresses (exchanges, projects, etc.)
- `daily_stats` — pre-aggregated daily metrics for charts
- `indexer_state` — indexer progress tracking (last_processed_height, etc.)

No migrations live here — all schema managed by qfc-explorer (`scripts/migrations/`).

## API Response Format
All routes return consistent JSON:
```json
{ "ok": true, "data": { ... } }
{ "ok": false, "error": "message" }
```

## Prometheus Metrics
`GET /metrics` exposes:
- `qfc_api_request_duration_seconds` — histogram by method/route/status
- `qfc_api_requests_total` — counter by method/route/status
- `qfc_api_errors_total` — counter for 4xx/5xx responses
- `qfc_indexer_lag_blocks` — gauge, blocks behind RPC head
- `qfc_indexer_height` / `qfc_rpc_height` — gauge
- `qfc_total_blocks` / `qfc_total_transactions` / `qfc_total_accounts` — gauge
- `qfc_db_healthy` / `qfc_rpc_healthy` — gauge (1=ok, 0=down)
- Default Node.js metrics (GC, event loop, memory)

### Indexer Metrics (`:9090/metrics`)
- `qfc_indexer_blocks_processed_total` — counter
- `qfc_indexer_blocks_skipped_total` — counter
- `qfc_indexer_block_process_duration_seconds` — histogram
- `qfc_indexer_pipeline_stage_duration_seconds` — histogram by stage (block, token_contract, internal_tx)
- `qfc_indexer_txs_processed_total` — counter
- `qfc_indexer_current_height` / `qfc_indexer_chain_height` — gauge
- `qfc_indexer_lag_blocks` — gauge
- `qfc_indexer_rpc_duration_seconds` — histogram by method/node
- `qfc_indexer_rpc_errors_total` — counter by method/node
- `qfc_indexer_token_transfers_total` / `qfc_indexer_contracts_detected_total` / `qfc_indexer_internal_txs_total` — counter
- `qfc_indexer_batch_duration_seconds` — histogram
- `qfc_indexer_batch_size_blocks` — gauge
- Default Node.js metrics (prefixed `qfc_indexer_`)

## Indexer
The indexer (`src/indexer/index.ts`) is a standalone process that continuously polls the QFC node
and writes blocks, transactions, receipts, events, accounts, tokens, and token transfers to PostgreSQL.

- Run separately from the API server (same image, different command)
- Docker: `command: ["node", "dist/indexer/index.js"]`

Pipeline per block (sequential):
1. **Block** — fetch block + txs from RPC, upsert blocks/txs/accounts/events, refresh balances
2. **Token + Contract** — run in parallel:
   - Token: detect ERC-20/721/1155 transfers, upsert tokens/transfers/balances, fetch metadata
   - Contract: detect creations, compute code_hash (SHA-256), upsert accounts
3. **Internal Tx** — `debug_traceTransaction` with callTracer, flatten nested calls, upsert `internal_transactions`
   (graceful: skipped silently if trace API unavailable)

Admin commands via `indexer_state` table: rescan from height, retry failed blocks.
Refreshes `daily_stats` table after each batch.

## QFC-Specific Notes
- **EVM version**: QFC runs Cancun spec. Default `evmVersion: "cancun"`. Supports PUSH0, MCOPY, TSTORE/TLOAD.
- **eth_call quirk**: QFC testnet may return `0x` for view functions. Use `eth_getStorageAt` as workaround.
- **Proxy detection**: Reads EIP-1967/1822/Beacon storage slots to identify proxy contracts.
- **Custom RPC methods**: `qfc_getEpoch`, `qfc_getValidators`, `qfc_getNodeInfo`, `qfc_getInferenceStats`, `qfc_getSupportedModels`, etc.
- **RPC URL**: Configured via `RPC_URL` env var (default: `http://127.0.0.1:8545`)
  - Testnet: `https://rpc.testnet.qfc.network` (Chain ID 9000)
  - Mainnet: `https://rpc.qfc.network` (Chain ID 9001)

## Branch Strategy
- **main** — stable releases
- **staging** — pre-release testing, triggers CI + Docker build
- Feature branches → merge to staging for testing → merge to main for release

## Environment Variables
| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | — | PostgreSQL primary connection string (required) |
| `DATABASE_REPLICA_URL` | — | PostgreSQL read replica (optional, API reads go here) |
| `RPC_URL` | `http://127.0.0.1:8545` | QFC node RPC endpoint(s), comma-separated for multi-node |
| `RPC_ARCHIVE_URL` | — | Archive node for debug_traceTransaction (optional) |
| `PORT` | `3001` | API server port |
| `HOST` | `0.0.0.0` | Bind address |
| `CORS_ORIGIN` | `*` | Allowed CORS origins |
| `SSE_INTERVAL_MS` | `5000` | SSE push interval (min 3000ms) |
| `REDIS_URL` | — | Redis standalone connection string (optional, cache disabled if unset) |
| `REDIS_CLUSTER_NODES` | — | Redis Cluster nodes, comma-separated host:port (overrides REDIS_URL) |
| `INDEXER_START_HEIGHT` | `0` | Block height to start indexing from |
| `INDEXER_POLL_INTERVAL_MS` | `10000` | Polling interval between indexing batches |
| `INDEXER_USE_FINALIZED` | `true` | Only index finalized blocks |
| `INDEXER_BLOCK_RETRIES` | `3` | Retry attempts per block on failure |
| `INDEXER_SKIP_ON_ERROR` | `false` | Skip failed blocks instead of halting |
| `INDEXER_RETRY_FAILED` | `false` | Retry previously failed blocks on startup |
| `INDEXER_BATCH_SIZE` | `10` | Initial batch size (dynamically adjusted 1–50) |
| `INDEXER_WS_URL` | — | WebSocket endpoint for newHeads subscription (optional, falls back to polling) |
| `INDEXER_METRICS_PORT` | `9090` | Indexer Prometheus metrics port |

## Related Repos
- [qfc-explorer](https://github.com/qfc-network/qfc-explorer) — Next.js frontend
- [qfc-core](https://github.com/qfc-network/qfc-core) — Blockchain node (Rust)
- [qfc-testnet](https://github.com/qfc-network/qfc-testnet) — Testnet deployment configs
