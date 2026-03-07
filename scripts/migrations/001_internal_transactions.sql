-- Internal transactions table (from debug_traceTransaction callTracer)
CREATE TABLE IF NOT EXISTS internal_transactions (
  tx_hash        TEXT NOT NULL,
  block_height   BIGINT NOT NULL,
  trace_index    INTEGER NOT NULL,
  call_type      TEXT NOT NULL,       -- CALL, STATICCALL, DELEGATECALL, CREATE, CREATE2, SELFDESTRUCT
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
  PRIMARY KEY (tx_hash, trace_index)
);

CREATE INDEX IF NOT EXISTS idx_internal_tx_block ON internal_transactions (block_height);
CREATE INDEX IF NOT EXISTS idx_internal_tx_from ON internal_transactions (from_address);
CREATE INDEX IF NOT EXISTS idx_internal_tx_to ON internal_transactions (to_address);
CREATE INDEX IF NOT EXISTS idx_internal_tx_type ON internal_transactions (call_type);
