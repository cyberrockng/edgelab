ALTER TYPE execution_state ADD VALUE IF NOT EXISTS 'TX_PENDING';
ALTER TYPE execution_state ADD VALUE IF NOT EXISTS 'TX_REVERTED';
ALTER TYPE execution_state ADD VALUE IF NOT EXISTS 'REDEEMABLE';
ALTER TYPE execution_state ADD VALUE IF NOT EXISTS 'REDEEMED';
ALTER TYPE execution_state ADD VALUE IF NOT EXISTS 'UNKNOWN';

ALTER TABLE execution_intents
  ADD COLUMN IF NOT EXISTS last_reconciled_at timestamptz,
  ADD COLUMN IF NOT EXISTS reconciliation_payload jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS chain_transactions_intent_role_created_idx
  ON chain_transactions(intent_id, tx_role, created_at DESC);
