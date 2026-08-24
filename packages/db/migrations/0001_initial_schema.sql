CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'evidence_class') THEN
    CREATE TYPE evidence_class AS ENUM ('LIVE', 'CAPTURED', 'MOCK', 'SIMULATED_FROM_CAPTURED_BOOK');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'verdict') THEN
    CREATE TYPE verdict AS ENUM ('PROMOTE', 'HOLD', 'REJECT', 'INSUFFICIENT_EVIDENCE');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'experiment_status') THEN
    CREATE TYPE experiment_status AS ENUM (
      'DRAFT', 'READY', 'OBSERVING', 'SETTLEMENT_PENDING', 'EVALUATED',
      'INSUFFICIENT_EVIDENCE', 'HOLD', 'REJECT', 'PROMOTION_REVIEW', 'PROMOTED',
      'PAUSED', 'FAILED'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'episode_state') THEN
    CREATE TYPE episode_state AS ENUM (
      'DISCOVERED', 'SNAPSHOT_DUE', 'DECISION_RECORDED', 'AWAITING_SETTLEMENT',
      'RESOLVED', 'VOIDED', 'EXCLUDED', 'STALE'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'execution_state') THEN
    CREATE TYPE execution_state AS ENUM (
      'INTENT_DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'SUBMITTING',
      'TX_CONFIRMED', 'ORDER_VERIFIED', 'UNFILLED', 'PARTIALLY_FILLED',
      'FILLED', 'SETTLED', 'CANCELLED', 'EXPIRED', 'UNVERIFIED', 'FAILED'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now(),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$')
);

CREATE TABLE IF NOT EXISTS wallet_identities (
  address text PRIMARY KEY,
  chain_id integer NOT NULL DEFAULT 50312 CHECK (chain_id = 50312),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_authenticated_at timestamptz,
  CHECK (address = lower(address)),
  CHECK (address ~ '^0x[a-f0-9]{40}$')
);

CREATE TABLE IF NOT EXISTS policy_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id text NOT NULL,
  version text NOT NULL,
  label text NOT NULL,
  adapter_name text NOT NULL,
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  manifest jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (policy_id, version)
);

CREATE TABLE IF NOT EXISTS risk_envelopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version text NOT NULL,
  max_order_raw numeric(78,0) NOT NULL CHECK (max_order_raw >= 0),
  max_aggregate_raw numeric(78,0) NOT NULL CHECK (max_aggregate_raw >= 0),
  allowed_actions text[] NOT NULL,
  allowed_intervals integer[] NOT NULL,
  envelope_hash text NOT NULL UNIQUE CHECK (envelope_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_address text NOT NULL REFERENCES wallet_identities(address),
  policy_a_id uuid NOT NULL REFERENCES policy_versions(id),
  policy_b_id uuid NOT NULL REFERENCES policy_versions(id),
  risk_envelope_id uuid NOT NULL REFERENCES risk_envelopes(id),
  rule_version text NOT NULL,
  status experiment_status NOT NULL DEFAULT 'DRAFT',
  decision_offset_sec integer NOT NULL CHECK (decision_offset_sec BETWEEN -3600 AND 3600),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (policy_a_id <> policy_b_id)
);

CREATE TABLE IF NOT EXISTS market_episodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES experiments(id) ON DELETE RESTRICT,
  market_id text NOT NULL,
  asset text NOT NULL CHECK (asset IN ('BTC', 'ETH')),
  interval_seconds integer NOT NULL CHECK (interval_seconds > 0),
  venue text NOT NULL DEFAULT 'DreamDEX Event Contracts',
  pool_address text NOT NULL CHECK (pool_address ~ '^0x[a-fA-F0-9]{40}$'),
  market_nonce bigint NOT NULL CHECK (market_nonce >= 0),
  trading_starts_at timestamptz,
  expires_at timestamptz NOT NULL,
  source_observed_at timestamptz NOT NULL,
  state episode_state NOT NULL DEFAULT 'DISCOVERED',
  exclusion_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (experiment_id, market_id)
);

CREATE TABLE IF NOT EXISTS market_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id uuid NOT NULL REFERENCES market_episodes(id) ON DELETE RESTRICT,
  chain_id integer NOT NULL CHECK (chain_id = 50312),
  captured_at timestamptz NOT NULL,
  source_seconds bigint,
  source_nanoseconds bigint CHECK (source_nanoseconds IS NULL OR source_nanoseconds >= 0),
  snapshot_hash text NOT NULL UNIQUE CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
  evidence_class evidence_class NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shadow_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES experiments(id) ON DELETE RESTRICT,
  episode_id uuid NOT NULL REFERENCES market_episodes(id) ON DELETE RESTRICT,
  policy_version_id uuid NOT NULL REFERENCES policy_versions(id) ON DELETE RESTRICT,
  snapshot_id uuid NOT NULL REFERENCES market_snapshots(id) ON DELETE RESTRICT,
  decision_offset_sec integer NOT NULL,
  forecast_p_up double precision NOT NULL CHECK (forecast_p_up >= 0 AND forecast_p_up <= 1),
  action text NOT NULL,
  proposal jsonb,
  reason_codes text[] NOT NULL CHECK (array_length(reason_codes, 1) >= 1),
  decided_at timestamptz NOT NULL,
  policy_hash text NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
  risk_hash text NOT NULL CHECK (risk_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (experiment_id, policy_version_id, episode_id, decision_offset_sec)
);

CREATE OR REPLACE FUNCTION enforce_shadow_decision_pre_outcome()
RETURNS trigger AS $$
DECLARE
  episode_expiry timestamptz;
BEGIN
  SELECT expires_at INTO episode_expiry FROM market_episodes WHERE id = NEW.episode_id;
  IF episode_expiry IS NULL THEN
    RAISE EXCEPTION 'episode % not found for shadow decision', NEW.episode_id;
  END IF;
  IF NEW.decided_at >= episode_expiry THEN
    RAISE EXCEPTION 'shadow decision must be recorded before outcome expiry';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS shadow_decisions_pre_outcome ON shadow_decisions;
CREATE TRIGGER shadow_decisions_pre_outcome
  BEFORE INSERT OR UPDATE ON shadow_decisions
  FOR EACH ROW EXECUTE FUNCTION enforce_shadow_decision_pre_outcome();

CREATE TABLE IF NOT EXISTS settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id text NOT NULL,
  resolved boolean NOT NULL,
  voided boolean NOT NULL DEFAULT false,
  winner text,
  source_observed_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  settlement_hash text NOT NULL UNIQUE CHECK (settlement_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT (resolved AND voided))
);

CREATE TABLE IF NOT EXISTS metric_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES experiments(id) ON DELETE RESTRICT,
  policy_version_id uuid NOT NULL REFERENCES policy_versions(id) ON DELETE RESTRICT,
  rule_version text NOT NULL,
  sample_size integer NOT NULL CHECK (sample_size >= 0),
  exclusion_count integer NOT NULL CHECK (exclusion_count >= 0),
  brier_score double precision CHECK (brier_score IS NULL OR brier_score >= 0),
  calibration_bias double precision,
  neutral_baseline_delta double precision,
  execution_metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  pnl_status text NOT NULL CHECK (pnl_status IN ('NOT_AVAILABLE', 'AVAILABLE')),
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (experiment_id, policy_version_id, rule_version, input_hash)
);

CREATE TABLE IF NOT EXISTS evidence_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_run_id uuid NOT NULL REFERENCES metric_runs(id) ON DELETE RESTRICT,
  rule_version text NOT NULL,
  verdict verdict NOT NULL,
  reason_codes text[] NOT NULL CHECK (array_length(reason_codes, 1) >= 1),
  thresholds jsonb NOT NULL,
  assessment_hash text NOT NULL UNIQUE CHECK (assessment_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS promotion_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id uuid NOT NULL REFERENCES evidence_assessments(id) ON DELETE RESTRICT,
  reviewer_address text NOT NULL REFERENCES wallet_identities(address),
  subject_hash text NOT NULL CHECK (subject_hash ~ '^[a-f0-9]{64}$'),
  decision text NOT NULL CHECK (decision IN ('APPROVE', 'REJECT', 'REVOKE')),
  nonce text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reviewer_address, nonce)
);

CREATE TABLE IF NOT EXISTS execution_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_address text NOT NULL REFERENCES wallet_identities(address),
  experiment_id uuid REFERENCES experiments(id) ON DELETE RESTRICT,
  market_id text NOT NULL,
  chain_id integer NOT NULL CHECK (chain_id = 50312),
  intent_type text NOT NULL CHECK (intent_type IN ('TRIAL', 'INTEGRATION_PROBE')),
  state execution_state NOT NULL DEFAULT 'INTENT_DRAFT',
  pool_address text NOT NULL CHECK (pool_address ~ '^0x[a-fA-F0-9]{40}$'),
  side text NOT NULL,
  price_raw numeric(78,0) NOT NULL CHECK (price_raw >= 0),
  quantity_raw numeric(78,0) NOT NULL CHECK (quantity_raw >= 0),
  escrow_raw numeric(78,0) NOT NULL CHECK (escrow_raw >= 0),
  expires_at timestamptz NOT NULL,
  caps jsonb NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  intent_hash text NOT NULL UNIQUE CHECK (intent_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS one_nonterminal_intent_per_wallet_market
  ON execution_intents(owner_address, market_id)
  WHERE state NOT IN ('SETTLED', 'CANCELLED', 'EXPIRED', 'UNVERIFIED', 'FAILED');

CREATE TABLE IF NOT EXISTS chain_transactions (
  tx_hash text PRIMARY KEY CHECK (tx_hash ~ '^0x[a-fA-F0-9]{64}$'),
  intent_id uuid NOT NULL REFERENCES execution_intents(id) ON DELETE RESTRICT,
  chain_id integer NOT NULL CHECK (chain_id = 50312),
  from_address text NOT NULL REFERENCES wallet_identities(address),
  nonce numeric(78,0) NOT NULL CHECK (nonce >= 0),
  receipt_status boolean,
  block_number numeric(78,0) CHECK (block_number IS NULL OR block_number >= 0),
  log_hash text CHECK (log_hash IS NULL OR log_hash ~ '^[a-f0-9]{64}$'),
  verified_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_hash text NOT NULL REFERENCES chain_transactions(tx_hash) ON DELETE RESTRICT,
  order_id text NOT NULL,
  state execution_state NOT NULL,
  quantity_raw numeric(78,0) NOT NULL CHECK (quantity_raw >= 0),
  remaining_quantity_raw numeric(78,0) NOT NULL CHECK (remaining_quantity_raw >= 0),
  evidence_source text NOT NULL,
  observed_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (tx_hash, order_id, observed_at)
);

CREATE TABLE IF NOT EXISTS fill_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_hash text NOT NULL REFERENCES chain_transactions(tx_hash) ON DELETE RESTRICT,
  fill_index integer NOT NULL CHECK (fill_index >= 0),
  quantity_raw numeric(78,0) NOT NULL CHECK (quantity_raw >= 0),
  price_raw numeric(78,0) NOT NULL CHECK (price_raw >= 0),
  observed_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (tx_hash, fill_index)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  outcome text NOT NULL,
  correlation_id text NOT NULL,
  safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  previous_hash text CHECK (previous_hash IS NULL OR previous_hash ~ '^[a-f0-9]{64}$'),
  event_hash text NOT NULL UNIQUE CHECK (event_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS evidence_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id text NOT NULL,
  artifact_type text NOT NULL,
  path_or_url text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  commit_sha text NOT NULL,
  build_id text,
  environment text NOT NULL,
  evidence_class evidence_class NOT NULL,
  redaction text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (evidence_id, path_or_url, sha256)
);

CREATE TABLE IF NOT EXISTS feedback_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_name text NOT NULL,
  source_version text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH')),
  repro_steps text NOT NULL,
  expected text NOT NULL,
  actual text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'OPEN',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS worker_leases (
  lease_key text PRIMARY KEY,
  holder_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  renewed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS market_episodes_state_expiry_idx ON market_episodes(state, expires_at);
CREATE INDEX IF NOT EXISTS shadow_decisions_episode_idx ON shadow_decisions(episode_id);
CREATE INDEX IF NOT EXISTS audit_events_target_time_idx ON audit_events(target_type, target_id, created_at);
CREATE INDEX IF NOT EXISTS execution_intents_state_idx ON execution_intents(state, created_at);
