-- Archive schema for cold storage of old blockchain data
CREATE SCHEMA IF NOT EXISTS archive;

-- Archive copies of partitioned tables (non-partitioned, compressed)
CREATE TABLE IF NOT EXISTS archive.transactions (LIKE transactions INCLUDING ALL);
CREATE TABLE IF NOT EXISTS archive.events (LIKE events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS archive.token_transfers (LIKE token_transfers INCLUDING ALL);
CREATE TABLE IF NOT EXISTS archive.internal_transactions (LIKE internal_transactions INCLUDING ALL);

-- Archive metadata tracking
CREATE TABLE IF NOT EXISTS archive.archive_log (
  id              SERIAL PRIMARY KEY,
  table_name      VARCHAR(100) NOT NULL,
  partition_name  VARCHAR(100) NOT NULL,
  min_height      BIGINT NOT NULL,
  max_height      BIGINT NOT NULL,
  row_count       BIGINT NOT NULL,
  archived_at     TIMESTAMPTZ DEFAULT NOW(),
  compressed      BOOLEAN DEFAULT false,
  storage_path    VARCHAR(512)   -- optional: S3/MinIO path for external export
);

CREATE INDEX IF NOT EXISTS idx_archive_log_table ON archive.archive_log (table_name);
CREATE INDEX IF NOT EXISTS idx_archive_log_height ON archive.archive_log (table_name, min_height, max_height);

-- Archive config in indexer_state
INSERT INTO indexer_state (key, value, updated_at)
VALUES ('archive_threshold_height', '0', NOW())
ON CONFLICT (key) DO NOTHING;
