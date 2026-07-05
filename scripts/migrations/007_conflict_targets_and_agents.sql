-- Align unique constraints with the indexer's ON CONFLICT targets, and
-- create the agent tables the agent indexer/API expect (previously the
-- indexer skipped every tx-bearing block: "no unique or exclusion
-- constraint matching the ON CONFLICT specification").
--
-- Safe on populated DBs only if no duplicate rows exist for the new keys;
-- on the testnet this runs against an empty re-indexed schema.

BEGIN;

-- transactions: code upserts ON CONFLICT (hash, block_height).
-- Keep the (hash) PK — contracts/events/token_transfers FKs depend on it;
-- a plain unique index on exactly (hash, block_height) satisfies the
-- ON CONFLICT arbiter inference.
CREATE UNIQUE INDEX transactions_hash_block_height_key
  ON transactions (hash, block_height);

-- events: code upserts ON CONFLICT (tx_hash, log_index, block_height)
ALTER TABLE events DROP CONSTRAINT events_tx_hash_log_index_key;
ALTER TABLE events ADD CONSTRAINT events_tx_hash_log_index_block_key UNIQUE (tx_hash, log_index, block_height);

-- token_transfers: code upserts ON CONFLICT (tx_hash, log_index, block_height)
ALTER TABLE token_transfers DROP CONSTRAINT token_transfers_tx_hash_log_index_key;
ALTER TABLE token_transfers ADD CONSTRAINT token_transfers_tx_hash_log_index_block_key UNIQUE (tx_hash, log_index, block_height);

-- token_balances: code upserts ON CONFLICT (token_address, holder_address, COALESCE(token_id, ''))
-- — an expression target needs a matching unique *expression* index.
-- The 3-column unique is the table's PK, and PK membership forces
-- token_id NOT NULL — but ERC-20 balances carry NULL token_id.
ALTER TABLE token_balances DROP CONSTRAINT token_balances_pkey;
ALTER TABLE token_balances ALTER COLUMN token_id DROP NOT NULL;
CREATE UNIQUE INDEX token_balances_addr_holder_tokenid_key
  ON token_balances (token_address, holder_address, COALESCE(token_id, ''));

-- Agent tables (indexer/agent.ts + routes/agents.ts)
CREATE TABLE IF NOT EXISTS agents (
  agent_id      TEXT PRIMARY KEY,
  owner         TEXT NOT NULL,
  agent_address TEXT,
  registered_at BIGINT,
  active        BOOLEAN NOT NULL DEFAULT true,
  deposit       TEXT NOT NULL DEFAULT '0',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents (owner);

CREATE TABLE IF NOT EXISTS agent_transactions (
  id           SERIAL PRIMARY KEY,
  agent_id     TEXT NOT NULL,
  tx_hash      TEXT NOT NULL,
  block_height BIGINT,
  from_addr    TEXT,
  to_addr      TEXT,
  value        TEXT NOT NULL DEFAULT '0',
  method       TEXT,
  status       INTEGER,
  timestamp    BIGINT,
  UNIQUE (tx_hash, agent_id, method)
);
CREATE INDEX IF NOT EXISTS idx_agent_txs_agent ON agent_transactions (agent_id, timestamp DESC);

CREATE TABLE IF NOT EXISTS agent_spending (
  agent_id TEXT NOT NULL,
  date     DATE NOT NULL,
  amount   TEXT NOT NULL DEFAULT '0',
  tx_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (agent_id, date)
);

CREATE TABLE IF NOT EXISTS session_keys (
  key_address      TEXT PRIMARY KEY,
  agent_id         TEXT NOT NULL,
  owner            TEXT,
  expires_at       TEXT,
  revoked          BOOLEAN NOT NULL DEFAULT false,
  permissions      TEXT,
  last_activity_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_session_keys_agent ON session_keys (agent_id);

INSERT INTO migrations (name) VALUES ('007_conflict_targets_and_agents.sql') ON CONFLICT DO NOTHING;

COMMIT;
