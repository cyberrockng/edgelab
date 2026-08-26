ALTER TABLE replay_runs ADD COLUMN IF NOT EXISTS invalidated_at timestamptz;
ALTER TABLE replay_runs ADD COLUMN IF NOT EXISTS invalidated_reason text;

UPDATE replay_runs
SET invalidated_at = COALESCE(invalidated_at, now()),
    invalidated_reason = COALESCE(invalidated_reason, 'SUPERSEDED_AUD_001_REPLAY_PIPELINE')
WHERE invalidated_at IS NULL;

CREATE TABLE IF NOT EXISTS replay_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  replay_decision_id uuid NOT NULL UNIQUE REFERENCES replay_decisions(id) ON DELETE RESTRICT,
  outcome_result text CHECK (outcome_result IS NULL OR outcome_result IN ('YES', 'NO')),
  exclusion_reason text,
  loaded_at timestamptz NOT NULL DEFAULT now(),
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (outcome_result IS NOT NULL OR exclusion_reason IS NOT NULL)
);

CREATE OR REPLACE FUNCTION reject_replay_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'replay evidence is append-only';
END;
$$;

DROP TRIGGER IF EXISTS replay_decisions_append_only ON replay_decisions;
CREATE TRIGGER replay_decisions_append_only
BEFORE UPDATE OR DELETE ON replay_decisions
FOR EACH ROW EXECUTE FUNCTION reject_replay_evidence_mutation();

DROP TRIGGER IF EXISTS replay_outcomes_append_only ON replay_outcomes;
CREATE TRIGGER replay_outcomes_append_only
BEFORE UPDATE OR DELETE ON replay_outcomes
FOR EACH ROW EXECUTE FUNCTION reject_replay_evidence_mutation();

CREATE INDEX IF NOT EXISTS replay_outcomes_decision_idx
  ON replay_outcomes(replay_decision_id, loaded_at);

