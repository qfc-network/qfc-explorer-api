-- Partition high-volume tables by block_height for better query performance
-- and easier data lifecycle management (drop old partitions instead of DELETE).
--
-- Strategy: Range partitioning by block_height, 1M blocks per partition.
-- This script converts existing tables to partitioned tables.
--
-- IMPORTANT: Run during maintenance window. This recreates tables.

BEGIN;

-- ============================================================
-- 1. transactions — partition by block_height
-- ============================================================

ALTER TABLE transactions RENAME TO transactions_old;

CREATE TABLE transactions (
  hash          TEXT NOT NULL,
  block_hash    TEXT,
  block_height  BIGINT NOT NULL,
  tx_index      INTEGER,
  type          TEXT,
  from_address  TEXT NOT NULL,
  to_address    TEXT,
  value         TEXT NOT NULL DEFAULT '0',
  nonce         TEXT,
  gas_limit     TEXT,
  gas_price     TEXT,
  status        TEXT,
  data          BYTEA,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (hash, block_height)
) PARTITION BY RANGE (block_height);

-- Create partitions (0-999999, 1000000-1999999, etc.)
CREATE TABLE transactions_p0 PARTITION OF transactions
  FOR VALUES FROM (0) TO (1000000);
CREATE TABLE transactions_p1 PARTITION OF transactions
  FOR VALUES FROM (1000000) TO (2000000);
CREATE TABLE transactions_p2 PARTITION OF transactions
  FOR VALUES FROM (2000000) TO (3000000);
CREATE TABLE transactions_p3 PARTITION OF transactions
  FOR VALUES FROM (3000000) TO (4000000);
CREATE TABLE transactions_p4 PARTITION OF transactions
  FOR VALUES FROM (4000000) TO (5000000);
CREATE TABLE transactions_default PARTITION OF transactions DEFAULT;

INSERT INTO transactions SELECT * FROM transactions_old;
DROP TABLE transactions_old;

CREATE INDEX idx_tx_block_height ON transactions (block_height);
CREATE INDEX idx_tx_from ON transactions (from_address);
CREATE INDEX idx_tx_to ON transactions (to_address);
CREATE INDEX idx_tx_status ON transactions (status);

-- ============================================================
-- 2. events — partition by block_height
-- ============================================================

ALTER TABLE events RENAME TO events_old;

CREATE TABLE events (
  tx_hash          TEXT NOT NULL,
  block_height     BIGINT NOT NULL,
  log_index        INTEGER NOT NULL,
  contract_address TEXT,
  topic0           TEXT,
  topic1           TEXT,
  topic2           TEXT,
  topic3           TEXT,
  data             BYTEA,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tx_hash, log_index, block_height)
) PARTITION BY RANGE (block_height);

CREATE TABLE events_p0 PARTITION OF events
  FOR VALUES FROM (0) TO (1000000);
CREATE TABLE events_p1 PARTITION OF events
  FOR VALUES FROM (1000000) TO (2000000);
CREATE TABLE events_p2 PARTITION OF events
  FOR VALUES FROM (2000000) TO (3000000);
CREATE TABLE events_p3 PARTITION OF events
  FOR VALUES FROM (3000000) TO (4000000);
CREATE TABLE events_p4 PARTITION OF events
  FOR VALUES FROM (4000000) TO (5000000);
CREATE TABLE events_default PARTITION OF events DEFAULT;

INSERT INTO events SELECT * FROM events_old;
DROP TABLE events_old;

CREATE INDEX idx_events_block ON events (block_height);
CREATE INDEX idx_events_contract ON events (contract_address);
CREATE INDEX idx_events_topic0 ON events (topic0);

-- ============================================================
-- 3. token_transfers — partition by block_height
-- ============================================================

ALTER TABLE token_transfers RENAME TO token_transfers_old;

CREATE TABLE token_transfers (
  token_address TEXT NOT NULL,
  tx_hash       TEXT NOT NULL,
  block_height  BIGINT NOT NULL,
  log_index     INTEGER NOT NULL,
  from_address  TEXT NOT NULL,
  to_address    TEXT NOT NULL,
  value         TEXT NOT NULL DEFAULT '0',
  token_id      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tx_hash, log_index, block_height)
) PARTITION BY RANGE (block_height);

CREATE TABLE token_transfers_p0 PARTITION OF token_transfers
  FOR VALUES FROM (0) TO (1000000);
CREATE TABLE token_transfers_p1 PARTITION OF token_transfers
  FOR VALUES FROM (1000000) TO (2000000);
CREATE TABLE token_transfers_p2 PARTITION OF token_transfers
  FOR VALUES FROM (2000000) TO (3000000);
CREATE TABLE token_transfers_p3 PARTITION OF token_transfers
  FOR VALUES FROM (3000000) TO (4000000);
CREATE TABLE token_transfers_p4 PARTITION OF token_transfers
  FOR VALUES FROM (4000000) TO (5000000);
CREATE TABLE token_transfers_default PARTITION OF token_transfers DEFAULT;

INSERT INTO token_transfers SELECT * FROM token_transfers_old;
DROP TABLE token_transfers_old;

CREATE INDEX idx_tt_block ON token_transfers (block_height);
CREATE INDEX idx_tt_token ON token_transfers (token_address);
CREATE INDEX idx_tt_from ON token_transfers (from_address);
CREATE INDEX idx_tt_to ON token_transfers (to_address);

-- ============================================================
-- 4. internal_transactions — partition by block_height
-- ============================================================

-- Already new table, recreate as partitioned
DROP TABLE IF EXISTS internal_transactions;

CREATE TABLE internal_transactions (
  tx_hash        TEXT NOT NULL,
  block_height   BIGINT NOT NULL,
  trace_index    INTEGER NOT NULL,
  call_type      TEXT NOT NULL,
  depth          INTEGER NOT NULL DEFAULT 0,
  from_address   TEXT NOT NULL,
  to_address     TEXT NOT NULL,
  value          TEXT NOT NULL DEFAULT '0',
  gas            TEXT NOT NULL DEFAULT '0',
  gas_used       TEXT NOT NULL DEFAULT '0',
  input          TEXT,
  output         TEXT,
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tx_hash, trace_index, block_height)
) PARTITION BY RANGE (block_height);

CREATE TABLE internal_transactions_p0 PARTITION OF internal_transactions
  FOR VALUES FROM (0) TO (1000000);
CREATE TABLE internal_transactions_p1 PARTITION OF internal_transactions
  FOR VALUES FROM (1000000) TO (2000000);
CREATE TABLE internal_transactions_p2 PARTITION OF internal_transactions
  FOR VALUES FROM (2000000) TO (3000000);
CREATE TABLE internal_transactions_p3 PARTITION OF internal_transactions
  FOR VALUES FROM (3000000) TO (4000000);
CREATE TABLE internal_transactions_p4 PARTITION OF internal_transactions
  FOR VALUES FROM (4000000) TO (5000000);
CREATE TABLE internal_transactions_default PARTITION OF internal_transactions DEFAULT;

CREATE INDEX idx_internal_tx_block ON internal_transactions (block_height);
CREATE INDEX idx_internal_tx_from ON internal_transactions (from_address);
CREATE INDEX idx_internal_tx_to ON internal_transactions (to_address);
CREATE INDEX idx_internal_tx_type ON internal_transactions (call_type);

COMMIT;
