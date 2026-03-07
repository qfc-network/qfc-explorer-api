-- Address labels: human-readable names for known addresses
CREATE TABLE IF NOT EXISTS address_labels (
  address     VARCHAR(42) PRIMARY KEY,
  label       VARCHAR(255) NOT NULL,
  category    VARCHAR(50),   -- 'exchange', 'defi', 'bridge', 'project', 'system', 'whale', etc.
  description TEXT,
  website     VARCHAR(512),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_address_labels_label ON address_labels USING gin (to_tsvector('simple', label));
CREATE INDEX IF NOT EXISTS idx_address_labels_category ON address_labels (category);

-- Full-text search index on tokens (name + symbol)
CREATE INDEX IF NOT EXISTS idx_tokens_name_fts ON tokens USING gin (to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(symbol, '')));
