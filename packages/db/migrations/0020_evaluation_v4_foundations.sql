ALTER TYPE verdict ADD VALUE IF NOT EXISTS 'HISTORICAL_SCREEN_PASSED';
ALTER TYPE verdict ADD VALUE IF NOT EXISTS 'FORWARD_CRITERIA_MET';
ALTER TYPE verdict ADD VALUE IF NOT EXISTS 'NO_DEMONSTRATED_IMPROVEMENT';
ALTER TYPE verdict ADD VALUE IF NOT EXISTS 'UNDERPERFORMS_MARKET';
ALTER TYPE verdict ADD VALUE IF NOT EXISTS 'INSUFFICIENT';

CREATE TABLE IF NOT EXISTS observation_protocols (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES experiments(id) ON DELETE RESTRICT,
  configuration_id uuid NOT NULL REFERENCES experiment_configuration_versions(id) ON DELETE RESTRICT,
  family text NOT NULL,
  rule_version text NOT NULL CHECK (rule_version = 'edgelab-evaluation-v4'),
  window_from timestamptz NOT NULL,
  window_to timestamptz NOT NULL,
  manifest jsonb NOT NULL,
  manifest_hash text NOT NULL CHECK (manifest_hash ~ '^[a-f0-9]{64}$'),
  registered_at timestamptz NOT NULL DEFAULT now(),
  CHECK (window_to > window_from),
  UNIQUE (experiment_id, configuration_id, manifest_hash),
  UNIQUE (configuration_id)
);

CREATE TABLE IF NOT EXISTS campaign_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES experiments(id) ON DELETE RESTRICT,
  configuration_id uuid NOT NULL REFERENCES experiment_configuration_versions(id) ON DELETE RESTRICT,
  protocol_id uuid NOT NULL REFERENCES observation_protocols(id) ON DELETE RESTRICT,
  lifecycle text NOT NULL CHECK (lifecycle IN ('STARTING','COLLECTING','WAITING_WINDOW','WAITING_SETTLEMENT','DEGRADED','STALE','PAUSED','COMPLETED')),
  lease_holder text,
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  next_boundary_at timestamptz,
  watermark jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_heartbeat_at timestamptz,
  last_source_success_at timestamptz,
  last_capture_at timestamptz,
  last_settlement_check_at timestamptz,
  source_error_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (protocol_id)
);

CREATE TABLE IF NOT EXISTS paired_forecast_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  protocol_id uuid NOT NULL REFERENCES observation_protocols(id) ON DELETE RESTRICT,
  campaign_run_id uuid NOT NULL REFERENCES campaign_runs(id) ON DELETE RESTRICT,
  candidate_policy_version_id uuid NOT NULL REFERENCES policy_versions(id) ON DELETE RESTRICT,
  chain_id integer NOT NULL,
  venue_id text NOT NULL,
  market_generation_id text NOT NULL,
  asset text NOT NULL CHECK (asset IN ('BTC','ETH')),
  interval_sec integer NOT NULL CHECK (interval_sec IN (900,3600)),
  decision_offset_sec integer NOT NULL CHECK (decision_offset_sec > 0),
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
  snapshot_source jsonb NOT NULL,
  candidate_probability double precision CHECK (candidate_probability IS NULL OR candidate_probability BETWEEN 0 AND 1),
  baseline_probability double precision CHECK (baseline_probability IS NULL OR baseline_probability BETWEEN 0 AND 1),
  baseline_bid_raw text,
  baseline_ask_raw text,
  quote_decimals integer NOT NULL CHECK (quote_decimals BETWEEN 0 AND 36),
  captured_at timestamptz NOT NULL,
  decision_deadline timestamptz NOT NULL,
  candidate_received_at timestamptz,
  action text NOT NULL,
  inclusion_reason text NOT NULL,
  outcome text CHECK (outcome IS NULL OR outcome IN ('YES','NO','VOID','UNRESOLVED')),
  outcome_provenance jsonb,
  integrity_status jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (captured_at < decision_deadline),
  CHECK (candidate_received_at IS NULL OR candidate_received_at < decision_deadline),
  UNIQUE (chain_id, venue_id, market_generation_id, decision_offset_sec, candidate_policy_version_id, protocol_id)
);

CREATE TABLE IF NOT EXISTS assessment_v4_details (
  assessment_id uuid PRIMARY KEY REFERENCES evidence_assessments(id) ON DELETE RESTRICT,
  protocol_id uuid NOT NULL REFERENCES observation_protocols(id) ON DELETE RESTRICT,
  forecast_status text NOT NULL CHECK (forecast_status IN ('NOT_EVALUATED','INSUFFICIENT','HISTORICAL_SCREEN_PASSED','FORWARD_CRITERIA_MET','NO_DEMONSTRATED_IMPROVEMENT','UNDERPERFORMS_MARKET')),
  economics_status text NOT NULL CHECK (economics_status IN ('NOT_EVALUATED','SOURCE_INCOMPLETE','INSUFFICIENT','SCENARIO_CRITERIA_MET','SCENARIO_REJECTED')),
  execution_eligibility text NOT NULL CHECK (execution_eligibility IN ('BLOCKED','ELIGIBLE_FOR_FRESH_REVIEW')),
  paired_metrics jsonb NOT NULL,
  intervals jsonb NOT NULL,
  sample_counts jsonb NOT NULL,
  coverage jsonb NOT NULL,
  economics_metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  integrity_status jsonb NOT NULL,
  algorithm text NOT NULL,
  seed text NOT NULL,
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS economic_scenario_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paired_record_id uuid NOT NULL UNIQUE REFERENCES paired_forecast_records(id) ON DELETE RESTRICT,
  protocol_id uuid NOT NULL REFERENCES observation_protocols(id) ON DELETE RESTRICT,
  classification text NOT NULL CHECK (classification = 'SIMULATED_FROM_CAPTURED_BOOK'),
  side text CHECK (side IS NULL OR side IN ('BUY_YES','BUY_NO')),
  scenario_action text NOT NULL CHECK (scenario_action IN ('TRADE','NO_TRADE','SOURCE_UNAVAILABLE')),
  raw_levels jsonb NOT NULL,
  book_parameters jsonb,
  primary_plan jsonb,
  stress_plan jsonb,
  fixed_bankroll_raw text NOT NULL CHECK (fixed_bankroll_raw ~ '^\d+$'),
  per_window_budget_raw text NOT NULL CHECK (per_window_budget_raw ~ '^\d+$'),
  stress_price_addend_raw text NOT NULL CHECK (stress_price_addend_raw ~ '^\d+$'),
  source_reason text,
  captured_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS comparison_scope_manifests (
  comparison_set_id uuid PRIMARY KEY REFERENCES comparison_sets(id) ON DELETE RESTRICT,
  comparison_mode text NOT NULL CHECK (comparison_mode IN ('MATCHED_INTERSECTION','DESCRIPTIVE_ONLY')),
  manifest jsonb NOT NULL,
  manifest_hash text NOT NULL UNIQUE CHECK (manifest_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS execution_quote_details (
  execution_intent_id uuid PRIMARY KEY REFERENCES execution_intents(id) ON DELETE RESTRICT,
  raw_levels jsonb NOT NULL,
  requested_quantity_raw text NOT NULL CHECK (requested_quantity_raw ~ '^\d+$'),
  fillable_quantity_raw text NOT NULL CHECK (fillable_quantity_raw ~ '^\d+$'),
  lot_size_raw text NOT NULL CHECK (lot_size_raw ~ '^\d+$'),
  tick_size_raw text NOT NULL CHECK (tick_size_raw ~ '^\d+$'),
  max_collateral_raw text NOT NULL CHECK (max_collateral_raw ~ '^\d+$'),
  average_price_raw text CHECK (average_price_raw IS NULL OR average_price_raw ~ '^\d+$'),
  worst_price_raw text CHECK (worst_price_raw IS NULL OR worst_price_raw ~ '^\d+$'),
  conservative_net_raw text NOT NULL CHECK (conservative_net_raw ~ '^-?\d+$'),
  reserves jsonb NOT NULL,
  policy_hash text NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
  review_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS published_studies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES experiments(id) ON DELETE RESTRICT,
  public_slug text NOT NULL UNIQUE CHECK (public_slug ~ '^[a-z0-9][a-z0-9-]*$'),
  assessment_id uuid NOT NULL REFERENCES evidence_assessments(id) ON DELETE RESTRICT,
  report_artifact_id uuid REFERENCES evidence_artifacts(id) ON DELETE RESTRICT,
  publication_state text NOT NULL CHECK (publication_state IN ('DRAFT','PUBLISHED','RETIRED')),
  campaign_projection_policy jsonb,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS forecast_commitment_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  protocol_id uuid NOT NULL REFERENCES observation_protocols(id) ON DELETE RESTRICT,
  sequence bigint NOT NULL CHECK (sequence >= 0),
  previous_root text CHECK (previous_root IS NULL OR previous_root ~ '^[a-f0-9]{64}$'),
  root text NOT NULL CHECK (root ~ '^[a-f0-9]{64}$'),
  leaf_count integer NOT NULL CHECK (leaf_count > 0),
  state text NOT NULL CHECK (state IN ('PENDING','SUBMITTED','CONFIRMED','LATE','FAILED')),
  chain_coordinates jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (protocol_id, sequence),
  UNIQUE (protocol_id, root)
);

CREATE TABLE IF NOT EXISTS external_forecast_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  protocol_id uuid NOT NULL REFERENCES observation_protocols(id) ON DELETE RESTRICT,
  adapter_identity text NOT NULL,
  server_challenge text NOT NULL UNIQUE,
  nonce text NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  signature text NOT NULL,
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
  received_at timestamptz NOT NULL,
  decision_deadline timestamptz NOT NULL,
  accepted_record_id uuid REFERENCES paired_forecast_records(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (received_at < decision_deadline),
  UNIQUE (protocol_id, adapter_identity, nonce)
);

CREATE INDEX IF NOT EXISTS campaign_runs_protocol_idx ON campaign_runs(protocol_id, created_at DESC);
CREATE INDEX IF NOT EXISTS observation_protocols_manifest_hash_idx ON observation_protocols(manifest_hash);
CREATE INDEX IF NOT EXISTS paired_forecast_protocol_capture_idx ON paired_forecast_records(protocol_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS economic_scenarios_protocol_capture_idx ON economic_scenario_records(protocol_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS published_studies_public_idx ON published_studies(publication_state, published_at DESC) WHERE publication_state = 'PUBLISHED';

CREATE OR REPLACE FUNCTION prevent_observation_protocol_mutation()
RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'observation protocols are append-only'; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS observation_protocols_append_only ON observation_protocols;
CREATE TRIGGER observation_protocols_append_only BEFORE UPDATE OR DELETE ON observation_protocols
FOR EACH ROW EXECUTE FUNCTION prevent_observation_protocol_mutation();

CREATE OR REPLACE FUNCTION prevent_comparison_scope_mutation()
RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'comparison scope manifests are append-only'; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS comparison_scope_manifests_append_only ON comparison_scope_manifests;
CREATE TRIGGER comparison_scope_manifests_append_only BEFORE UPDATE OR DELETE ON comparison_scope_manifests
FOR EACH ROW EXECUTE FUNCTION prevent_comparison_scope_mutation();
