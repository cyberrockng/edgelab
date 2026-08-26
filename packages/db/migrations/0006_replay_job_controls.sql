ALTER TYPE replay_status ADD VALUE IF NOT EXISTS 'COMPLETED';
ALTER TYPE replay_status ADD VALUE IF NOT EXISTS 'SOURCE_BLOCKED';

ALTER TABLE replay_runs
  ADD COLUMN IF NOT EXISTS created_by_session_id uuid REFERENCES research_sessions(id) ON DELETE RESTRICT;
ALTER TABLE replay_runs ADD COLUMN IF NOT EXISTS deadline_at timestamptz;
ALTER TABLE replay_runs ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz;
ALTER TABLE replay_runs ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz;

UPDATE replay_runs
SET created_by_session_id = experiments.created_by_session_id,
    deadline_at = COALESCE(replay_runs.deadline_at, replay_runs.created_at + interval '5 minutes')
FROM experiments
WHERE experiments.id = replay_runs.experiment_id
  AND replay_runs.created_by_session_id IS NULL;

ALTER TABLE replay_runs DROP CONSTRAINT IF EXISTS replay_runs_idempotency_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS replay_runs_session_idempotency_idx
  ON replay_runs(created_by_session_id, idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS replay_runs_one_active_session_idx
  ON replay_runs(created_by_session_id)
  WHERE created_by_session_id IS NOT NULL
    AND status IN ('QUEUED', 'RUNNING');
CREATE INDEX IF NOT EXISTS replay_runs_queue_idx
  ON replay_runs(status, created_at)
  WHERE status IN ('QUEUED', 'RUNNING');
