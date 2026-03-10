-- Migration 005: token_prices table
-- Stores token price data from external oracles/CoinGecko

CREATE TABLE IF NOT EXISTS token_prices (
    token_address  VARCHAR(42)    NOT NULL PRIMARY KEY,
    price_usd      NUMERIC(30,10) NOT NULL DEFAULT 0,
    market_cap_usd NUMERIC(30,2),
    change_24h     NUMERIC(10,4),
    volume_24h     NUMERIC(30,2),
    coingecko_id   VARCHAR(100),
    source         VARCHAR(50)    NOT NULL DEFAULT 'manual',
    updated_at     TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_token_prices_updated_at ON token_prices (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_prices_coingecko ON token_prices (coingecko_id) WHERE coingecko_id IS NOT NULL;

COMMENT ON TABLE token_prices IS 'Token price data — populated by price-updater service or manually';
