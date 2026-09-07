ALTER TYPE verdict ADD VALUE IF NOT EXISTS 'STRATEGY_QUALIFIED';

ALTER TABLE execution_intents
  ADD COLUMN IF NOT EXISTS assessment_id uuid REFERENCES evidence_assessments(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS policy_version_id uuid REFERENCES policy_versions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS candidate_snapshot_hash text CHECK (
    candidate_snapshot_hash IS NULL OR candidate_snapshot_hash ~ '^[a-f0-9]{64}$'
  ),
  ADD COLUMN IF NOT EXISTS candidate_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS last_validated_at timestamptz;

ALTER TABLE chain_transactions
  ADD COLUMN IF NOT EXISTS tx_role text CHECK (tx_role IN ('approval', 'order', 'redeem')),
  ADD COLUMN IF NOT EXISTS transaction_input_hash text CHECK (
    transaction_input_hash IS NULL OR transaction_input_hash ~ '^[a-f0-9]{64}$'
  );

ALTER TABLE order_evidence
  DROP CONSTRAINT IF EXISTS order_evidence_tx_hash_order_id_observed_at_key;

CREATE UNIQUE INDEX IF NOT EXISTS order_evidence_receipt_state_key
  ON order_evidence(tx_hash, order_id, state, remaining_quantity_raw);

CREATE INDEX IF NOT EXISTS execution_intents_strategy_idx
  ON execution_intents(experiment_id, assessment_id, policy_version_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS one_transaction_role_per_intent
  ON chain_transactions(intent_id, tx_role)
  WHERE tx_role IS NOT NULL;
