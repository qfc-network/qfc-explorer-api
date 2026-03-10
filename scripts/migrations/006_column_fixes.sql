-- Migration 006: Fix column name mismatches between code and schema
-- transactions.data → input_data (code expects input_data)
-- blocks: add base_fee_per_gas column (code expects it)

-- Rename transactions.data to input_data
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name='transactions' AND column_name='data'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name='transactions' AND column_name='input_data'
  ) THEN
    ALTER TABLE transactions RENAME COLUMN data TO input_data;
  END IF;
END$$;

-- Add base_fee_per_gas to blocks (EIP-1559 base fee)
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS base_fee_per_gas NUMERIC(30,0);

-- Add EIP-1559 fee columns to transactions
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS max_fee_per_gas NUMERIC(30,0);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS max_priority_fee_per_gas NUMERIC(30,0);

COMMENT ON COLUMN blocks.base_fee_per_gas IS 'EIP-1559 base fee per gas in wei';
COMMENT ON COLUMN transactions.input_data IS 'Transaction input/calldata as hex string';
COMMENT ON COLUMN transactions.max_fee_per_gas IS 'EIP-1559 max fee per gas';
COMMENT ON COLUMN transactions.max_priority_fee_per_gas IS 'EIP-1559 max priority fee per gas (miner tip)';
