ALTER TABLE experiments
ADD COLUMN IF NOT EXISTS create_idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS experiments_session_create_idempotency_idx
  ON experiments(created_by_session_id, create_idempotency_key)
  WHERE created_by_session_id IS NOT NULL
    AND create_idempotency_key IS NOT NULL;
