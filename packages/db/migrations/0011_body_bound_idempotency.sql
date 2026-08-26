ALTER TABLE experiments
  ADD COLUMN IF NOT EXISTS create_idempotency_hash text
    CHECK (create_idempotency_hash IS NULL OR create_idempotency_hash ~ '^[a-f0-9]{64}$');

ALTER TABLE replay_runs
  ADD COLUMN IF NOT EXISTS idempotency_hash text
    CHECK (idempotency_hash IS NULL OR idempotency_hash ~ '^[a-f0-9]{64}$');

ALTER TABLE comparison_sets
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS idempotency_hash text
    CHECK (idempotency_hash IS NULL OR idempotency_hash ~ '^[a-f0-9]{64}$');

CREATE UNIQUE INDEX IF NOT EXISTS comparison_sets_session_idempotency_idx
  ON comparison_sets(created_by_session_id, idempotency_key)
  WHERE created_by_session_id IS NOT NULL
    AND idempotency_key IS NOT NULL;
