DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'evidence_plane') THEN
    CREATE TYPE evidence_plane AS ENUM ('MAINNET_HISTORICAL', 'SHANNON_FORWARD', 'SHANNON_EXECUTION');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'experiment_mode') THEN
    CREATE TYPE experiment_mode AS ENUM ('HISTORICAL_REPLAY', 'LIVE_SHADOW');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'replay_status') THEN
    CREATE TYPE replay_status AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');
  END IF;
END $$;

ALTER TYPE evidence_class ADD VALUE IF NOT EXISTS 'RECONSTRUCTED_FROM_AUTHENTIC_LOGS';
ALTER TYPE evidence_class ADD VALUE IF NOT EXISTS 'MODELED';
ALTER TYPE experiment_status ADD VALUE IF NOT EXISTS 'REPLAY_QUEUED';
ALTER TYPE experiment_status ADD VALUE IF NOT EXISTS 'REPLAY_RUNNING';
ALTER TYPE experiment_status ADD VALUE IF NOT EXISTS 'EVALUATION_READY';

CREATE TABLE IF NOT EXISTS research_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  csrf_hash text NOT NULL CHECK (csrf_hash ~ '^[a-f0-9]{64}$'),
  csrf_version integer NOT NULL DEFAULT 1 CHECK (csrf_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

ALTER TABLE experiments ADD COLUMN IF NOT EXISTS name text;
UPDATE experiments SET name = concat('Legacy experiment ', left(id::text, 8)) WHERE name IS NULL;
ALTER TABLE experiments ALTER COLUMN name SET DEFAULT 'Untitled experiment';
ALTER TABLE experiments ALTER COLUMN name SET NOT NULL;

ALTER TABLE experiments ADD COLUMN IF NOT EXISTS created_by_session_id uuid REFERENCES research_sessions(id) ON DELETE SET NULL;
ALTER TABLE experiments ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'PRIVATE';
ALTER TABLE experiments ADD COLUMN IF NOT EXISTS active_configuration_id uuid;
ALTER TABLE experiments ALTER COLUMN owner_address DROP NOT NULL;
ALTER TABLE experiments ALTER COLUMN policy_a_id DROP NOT NULL;
ALTER TABLE experiments ALTER COLUMN policy_b_id DROP NOT NULL;
ALTER TABLE experiments ALTER COLUMN risk_envelope_id DROP NOT NULL;
ALTER TABLE experiments ALTER COLUMN rule_version DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'experiments_owner_subject_check'
  ) THEN
    ALTER TABLE experiments
      ADD CONSTRAINT experiments_owner_subject_check
      CHECK (owner_address IS NOT NULL OR created_by_session_id IS NOT NULL) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'experiments_visibility_check'
  ) THEN
    ALTER TABLE experiments
      ADD CONSTRAINT experiments_visibility_check
      CHECK (visibility IN ('PRIVATE', 'PUBLIC_PROVEN', 'SHARED_LINK')) NOT VALID;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS experiment_configuration_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES experiments(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  mode experiment_mode NOT NULL,
  assets text[] NOT NULL CHECK (array_length(assets, 1) >= 1 AND assets <@ ARRAY['BTC', 'ETH']::text[]),
  intervals integer[] NOT NULL CHECK (array_length(intervals, 1) >= 1 AND 0 < ALL(intervals)),
  window_from timestamptz,
  window_to timestamptz,
  decision_offset_sec integer NOT NULL CHECK (decision_offset_sec BETWEEN -3600 AND 3600),
  risk_envelope_id uuid REFERENCES risk_envelopes(id) ON DELETE RESTRICT,
  rule_version text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  config_hash text NOT NULL CHECK (config_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (window_from IS NULL OR window_to IS NULL OR window_from < window_to),
  UNIQUE (experiment_id, version),
  UNIQUE (experiment_id, config_hash)
);

CREATE OR REPLACE FUNCTION prevent_experiment_configuration_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'experiment configuration versions are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS experiment_configuration_versions_append_only ON experiment_configuration_versions;
CREATE TRIGGER experiment_configuration_versions_append_only
  BEFORE UPDATE OR DELETE ON experiment_configuration_versions
  FOR EACH ROW EXECUTE FUNCTION prevent_experiment_configuration_mutation();

CREATE TABLE IF NOT EXISTS experiment_policy_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES experiments(id) ON DELETE RESTRICT,
  configuration_id uuid NOT NULL REFERENCES experiment_configuration_versions(id) ON DELETE RESTRICT,
  policy_version_id uuid NOT NULL REFERENCES policy_versions(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('CANDIDATE', 'BENCHMARK')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (configuration_id, policy_version_id),
  UNIQUE (configuration_id, role)
);

INSERT INTO experiment_configuration_versions (
  experiment_id,
  version,
  mode,
  assets,
  intervals,
  decision_offset_sec,
  risk_envelope_id,
  rule_version,
  config,
  config_hash
)
SELECT
  experiments.id,
  1,
  'LIVE_SHADOW',
  ARRAY['BTC', 'ETH']::text[],
  COALESCE(risk_envelopes.allowed_intervals, ARRAY[900, 3600]::integer[]),
  experiments.decision_offset_sec,
  experiments.risk_envelope_id,
  COALESCE(experiments.rule_version, 'legacy'),
  jsonb_build_object(
    'backfill', true,
    'source', '0001_initial_schema',
    'legacyPolicyAId', experiments.policy_a_id,
    'legacyPolicyBId', experiments.policy_b_id
  ),
  encode(digest(concat_ws(':', experiments.id::text, 'legacy-config-v1'), 'sha256'), 'hex')
FROM experiments
LEFT JOIN risk_envelopes ON risk_envelopes.id = experiments.risk_envelope_id
WHERE NOT EXISTS (
  SELECT 1
  FROM experiment_configuration_versions existing
  WHERE existing.experiment_id = experiments.id
    AND existing.version = 1
);

UPDATE experiments
SET active_configuration_id = experiment_configuration_versions.id
FROM experiment_configuration_versions
WHERE experiment_configuration_versions.experiment_id = experiments.id
  AND experiment_configuration_versions.version = 1
  AND experiments.active_configuration_id IS NULL;

INSERT INTO experiment_policy_versions (experiment_id, configuration_id, policy_version_id, role)
SELECT experiments.id, experiment_configuration_versions.id, experiments.policy_a_id, 'CANDIDATE'
FROM experiments
JOIN experiment_configuration_versions ON experiment_configuration_versions.experiment_id = experiments.id
WHERE experiments.policy_a_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO experiment_policy_versions (experiment_id, configuration_id, policy_version_id, role)
SELECT experiments.id, experiment_configuration_versions.id, experiments.policy_b_id, 'BENCHMARK'
FROM experiments
JOIN experiment_configuration_versions ON experiment_configuration_versions.experiment_id = experiments.id
WHERE experiments.policy_b_id IS NOT NULL
ON CONFLICT DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'experiments_active_configuration_fk'
  ) THEN
    ALTER TABLE experiments
      ADD CONSTRAINT experiments_active_configuration_fk
      FOREIGN KEY (active_configuration_id)
      REFERENCES experiment_configuration_versions(id)
      ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE experiments VALIDATE CONSTRAINT experiments_owner_subject_check;
ALTER TABLE experiments VALIDATE CONSTRAINT experiments_visibility_check;

CREATE TABLE IF NOT EXISTS replay_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES experiments(id) ON DELETE RESTRICT,
  configuration_id uuid NOT NULL REFERENCES experiment_configuration_versions(id) ON DELETE RESTRICT,
  plane evidence_plane NOT NULL DEFAULT 'MAINNET_HISTORICAL' CHECK (plane = 'MAINNET_HISTORICAL'),
  status replay_status NOT NULL DEFAULT 'QUEUED',
  frozen_now timestamptz NOT NULL,
  selected_count integer NOT NULL DEFAULT 0 CHECK (selected_count >= 0),
  processed_count integer NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
  scored_count integer NOT NULL DEFAULT 0 CHECK (scored_count >= 0),
  excluded_count integer NOT NULL DEFAULT 0 CHECK (excluded_count >= 0),
  capability text NOT NULL DEFAULT 'BOOK_RECONSTRUCTION_UNVERIFIED_FAIL_CLOSED',
  source_version text NOT NULL,
  query_version text NOT NULL,
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  output_hash text CHECK (output_hash IS NULL OR output_hash ~ '^[a-f0-9]{64}$'),
  error_code text,
  checkpoints jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  CHECK (processed_count <= selected_count),
  CHECK (scored_count <= processed_count),
  CHECK (excluded_count <= processed_count)
);

CREATE TABLE IF NOT EXISTS replay_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  replay_run_id uuid NOT NULL REFERENCES replay_runs(id) ON DELETE RESTRICT,
  market_id text NOT NULL,
  policy_version_id uuid NOT NULL REFERENCES policy_versions(id) ON DELETE RESTRICT,
  decision_at timestamptz NOT NULL,
  cutoff_block numeric(78,0) NOT NULL CHECK (cutoff_block >= 0),
  frame_hash text NOT NULL CHECK (frame_hash ~ '^[a-f0-9]{64}$'),
  forecast_p_up double precision CHECK (forecast_p_up IS NULL OR (forecast_p_up >= 0 AND forecast_p_up <= 1)),
  action text NOT NULL,
  reason_codes text[] NOT NULL CHECK (array_length(reason_codes, 1) >= 1),
  outcome_loaded_at timestamptz,
  outcome_result text,
  exclusion_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (replay_run_id, market_id, policy_version_id)
);

ALTER TABLE metric_runs ADD COLUMN IF NOT EXISTS evidence_plane evidence_plane NOT NULL DEFAULT 'SHANNON_FORWARD';
ALTER TABLE metric_runs ADD COLUMN IF NOT EXISTS replay_run_id uuid REFERENCES replay_runs(id) ON DELETE RESTRICT;
ALTER TABLE metric_runs ADD COLUMN IF NOT EXISTS promotion_scope text NOT NULL DEFAULT 'FORWARD_WINDOW';
ALTER TABLE metric_runs ADD COLUMN IF NOT EXISTS provenance jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS comparison_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by_session_id uuid REFERENCES research_sessions(id) ON DELETE SET NULL,
  owner_address text REFERENCES wallet_identities(address) ON DELETE SET NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (created_by_session_id IS NOT NULL OR owner_address IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS comparison_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comparison_set_id uuid NOT NULL REFERENCES comparison_sets(id) ON DELETE RESTRICT,
  assessment_id uuid NOT NULL REFERENCES evidence_assessments(id) ON DELETE RESTRICT,
  display_order integer NOT NULL CHECK (display_order >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (comparison_set_id, assessment_id),
  UNIQUE (comparison_set_id, display_order)
);

CREATE TABLE IF NOT EXISTS historical_source_manifests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  replay_run_id uuid NOT NULL REFERENCES replay_runs(id) ON DELETE RESTRICT,
  market_id text NOT NULL,
  source_version text NOT NULL,
  query_version text NOT NULL,
  orders_count integer NOT NULL DEFAULT 0 CHECK (orders_count >= 0),
  fills_count integer NOT NULL DEFAULT 0 CHECK (fills_count >= 0),
  candles_count integer NOT NULL DEFAULT 0 CHECK (candles_count >= 0),
  first_block numeric(78,0) CHECK (first_block IS NULL OR first_block >= 0),
  last_block numeric(78,0) CHECK (last_block IS NULL OR last_block >= 0),
  completeness text NOT NULL CHECK (completeness IN ('COMPLETE', 'PARTIAL', 'UNAVAILABLE')),
  canonical_digest text NOT NULL CHECK (canonical_digest ~ '^[a-f0-9]{64}$'),
  retrieved_at timestamptz NOT NULL,
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (first_block IS NULL OR last_block IS NULL OR first_block <= last_block),
  UNIQUE (replay_run_id, market_id)
);

CREATE INDEX IF NOT EXISTS research_sessions_active_idx
  ON research_sessions(expires_at, revoked_at);
CREATE INDEX IF NOT EXISTS experiments_session_idx
  ON experiments(created_by_session_id, created_at);
CREATE INDEX IF NOT EXISTS experiment_configurations_experiment_idx
  ON experiment_configuration_versions(experiment_id, version);
CREATE INDEX IF NOT EXISTS experiment_policies_config_idx
  ON experiment_policy_versions(configuration_id, role);
CREATE INDEX IF NOT EXISTS replay_runs_experiment_status_idx
  ON replay_runs(experiment_id, status, created_at);
CREATE INDEX IF NOT EXISTS replay_decisions_run_market_idx
  ON replay_decisions(replay_run_id, market_id);
CREATE INDEX IF NOT EXISTS metric_runs_replay_idx
  ON metric_runs(replay_run_id);
CREATE INDEX IF NOT EXISTS comparison_sets_session_idx
  ON comparison_sets(created_by_session_id, updated_at);
CREATE INDEX IF NOT EXISTS historical_source_manifests_run_idx
  ON historical_source_manifests(replay_run_id, market_id);
