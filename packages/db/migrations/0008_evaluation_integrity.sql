ALTER TABLE metric_runs
  ADD COLUMN IF NOT EXISTS evaluation_version text NOT NULL DEFAULT 'legacy';
ALTER TABLE metric_runs
  ADD COLUMN IF NOT EXISTS canonical_input jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION reject_immutable_evaluation_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% records are append-only', TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS historical_source_manifests_append_only ON historical_source_manifests;
CREATE TRIGGER historical_source_manifests_append_only
BEFORE UPDATE OR DELETE ON historical_source_manifests
FOR EACH ROW EXECUTE FUNCTION reject_immutable_evaluation_evidence_mutation();

DROP TRIGGER IF EXISTS metric_runs_append_only ON metric_runs;
CREATE TRIGGER metric_runs_append_only
BEFORE UPDATE OR DELETE ON metric_runs
FOR EACH ROW EXECUTE FUNCTION reject_immutable_evaluation_evidence_mutation();

DROP TRIGGER IF EXISTS evidence_assessments_append_only ON evidence_assessments;
CREATE TRIGGER evidence_assessments_append_only
BEFORE UPDATE OR DELETE ON evidence_assessments
FOR EACH ROW EXECUTE FUNCTION reject_immutable_evaluation_evidence_mutation();

DROP TRIGGER IF EXISTS shadow_decisions_append_only ON shadow_decisions;
CREATE TRIGGER shadow_decisions_append_only
BEFORE UPDATE OR DELETE ON shadow_decisions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_evaluation_evidence_mutation();
