import { createHash } from "node:crypto";
import type pg from "pg";
import { type PolicyDecision, type Verdict } from "@edgelab/domain";
import {
  assessEvidence,
  type EvidenceAssessment,
  type EvidenceThresholds,
  type ScoredDecision
} from "@edgelab/metrics";

export interface MetricAssessmentInput {
  readonly pool: pg.Pool;
  readonly experimentId: string;
  readonly policyVersionId: string;
  readonly ruleVersion: string;
  readonly replayRunId?: string;
  readonly evidencePlane?: "MAINNET_HISTORICAL" | "SHANNON_FORWARD";
  readonly promotionScope?: "HISTORICAL_REPLAY_ONLY" | "FORWARD_WINDOW";
  readonly provenance?: Record<string, unknown>;
  readonly thresholds?: EvidenceThresholds;
}

export interface PersistedMetricAssessment {
  readonly metricRunId: string;
  readonly assessmentId: string;
  readonly verdict: Verdict;
  readonly reasonCodes: readonly string[];
  readonly sampleSize: number;
  readonly exclusionCount: number;
  readonly pnlStatus: "NOT_AVAILABLE" | "AVAILABLE";
  readonly inputHash: string;
  readonly assessmentHash: string;
}

interface DecisionOutcomeRow {
  readonly decision_id: string;
  readonly policy_id: string;
  readonly policy_version: string;
  readonly forecast_p_up: number | null;
  readonly action: string;
  readonly reason_codes: string[];
  readonly decided_at: Date;
  readonly snapshot_hash: string;
  readonly policy_hash: string;
  readonly market_id: string;
  readonly resolved: boolean | null;
  readonly voided: boolean | null;
  readonly winner: string | null;
}

function canonicalize(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map((item) => canonicalize(item));
  }
  if (input !== null && typeof input === "object") {
    return Object.fromEntries(
      Object.entries(input)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, canonicalize(value)])
    );
  }
  return input;
}

function sha256(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(input))).digest("hex");
}

function toPolicyDecision(row: DecisionOutcomeRow): PolicyDecision {
  if (row.forecast_p_up === null) {
    throw new Error("Cannot convert replay abstention without forecast into scored policy decision");
  }
  return {
    policyId: row.policy_id,
    policyVersion: row.policy_version,
    forecastPUp: row.forecast_p_up,
    action: row.action as PolicyDecision["action"],
    reasonCodes: row.reason_codes,
    decidedAt: row.decided_at.toISOString(),
    snapshotHash: row.snapshot_hash,
    policyHash: row.policy_hash
  };
}

async function loadDecisionOutcomes(input: MetricAssessmentInput): Promise<DecisionOutcomeRow[]> {
  const result = await input.pool.query<DecisionOutcomeRow>(
    `
      SELECT
        sd.id AS decision_id,
        pv.policy_id,
        pv.version AS policy_version,
        sd.forecast_p_up,
        sd.action,
        sd.reason_codes,
        sd.decided_at,
        ms.snapshot_hash,
        sd.policy_hash,
        me.market_id,
        s.resolved,
        s.voided,
        s.winner
      FROM shadow_decisions sd
      JOIN policy_versions pv ON pv.id = sd.policy_version_id
      JOIN market_snapshots ms ON ms.id = sd.snapshot_id
      JOIN market_episodes me ON me.id = sd.episode_id
      LEFT JOIN settlements s ON s.market_id = me.market_id
      WHERE sd.experiment_id = $1
        AND sd.policy_version_id = $2
      ORDER BY sd.decided_at ASC, sd.id ASC
    `,
    [input.experimentId, input.policyVersionId]
  );
  return result.rows;
}

async function loadReplayDecisionOutcomes(input: MetricAssessmentInput): Promise<DecisionOutcomeRow[]> {
  if (input.replayRunId === undefined) {
    return [];
  }
  const result = await input.pool.query<DecisionOutcomeRow>(
    `
      SELECT
        rd.id AS decision_id,
        pv.policy_id,
        pv.version AS policy_version,
        rd.forecast_p_up,
        rd.action,
        rd.reason_codes,
        rd.decision_at AS decided_at,
        rd.frame_hash AS snapshot_hash,
        pv.source_hash AS policy_hash,
        rd.market_id,
        (rd.outcome_result IN ('YES', 'NO')) AS resolved,
        false AS voided,
        rd.outcome_result AS winner
      FROM replay_decisions rd
      JOIN replay_runs rr ON rr.id = rd.replay_run_id
      JOIN policy_versions pv ON pv.id = rd.policy_version_id
      WHERE rr.experiment_id = $1
        AND rd.policy_version_id = $2
        AND rd.replay_run_id = $3
      ORDER BY rd.decision_at ASC, rd.id ASC
    `,
    [input.experimentId, input.policyVersionId, input.replayRunId]
  );
  return result.rows;
}

function scoreRows(rows: readonly DecisionOutcomeRow[]): {
  readonly scored: readonly ScoredDecision[];
  readonly exclusionCount: number;
} {
  const scored: ScoredDecision[] = [];
  let exclusionCount = 0;
  for (const row of rows) {
    if (row.action === "ABSTAIN" || row.forecast_p_up === null) {
      exclusionCount += 1;
      continue;
    }
    if (row.voided === true) {
      exclusionCount += 1;
      continue;
    }
    if (row.resolved !== true || (row.winner !== "YES" && row.winner !== "NO")) {
      exclusionCount += 1;
      continue;
    }
    scored.push({
      decision: toPolicyDecision(row),
      outcomeUp: row.winner === "YES"
    });
  }
  return { scored, exclusionCount };
}

async function insertMetricRun(input: {
  readonly pool: pg.Pool;
  readonly assessment: EvidenceAssessment;
  readonly experimentId: string;
  readonly policyVersionId: string;
  readonly ruleVersion: string;
  readonly replayRunId?: string;
  readonly evidencePlane?: "MAINNET_HISTORICAL" | "SHANNON_FORWARD";
  readonly promotionScope?: "HISTORICAL_REPLAY_ONLY" | "FORWARD_WINDOW";
  readonly provenance?: Record<string, unknown>;
  readonly inputHash: string;
}): Promise<string> {
  const result = await input.pool.query<{ id: string }>(
    `
      INSERT INTO metric_runs(
        experiment_id, policy_version_id, rule_version, sample_size, exclusion_count,
        brier_score, calibration_bias, neutral_baseline_delta, execution_metrics,
        pnl_status, input_hash, replay_run_id, evidence_plane, promotion_scope, provenance
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15::jsonb)
      ON CONFLICT (experiment_id, policy_version_id, rule_version, input_hash) DO UPDATE
      SET input_hash = EXCLUDED.input_hash
      RETURNING id
    `,
    [
      input.experimentId,
      input.policyVersionId,
      input.ruleVersion,
      input.assessment.metrics.sampleSize,
      input.assessment.metrics.exclusionCount,
      input.assessment.metrics.brierScore,
      input.assessment.metrics.calibrationBias,
      input.assessment.metrics.neutralBaselineDelta,
      JSON.stringify(input.assessment.metrics.executionMetrics),
      input.assessment.metrics.pnlStatus,
      input.inputHash,
      input.replayRunId ?? null,
      input.evidencePlane ?? "SHANNON_FORWARD",
      input.promotionScope ?? "FORWARD_WINDOW",
      JSON.stringify(input.provenance ?? {})
    ]
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("Metric run insert did not return an id");
  }
  return row.id;
}

async function insertAssessment(input: {
  readonly pool: pg.Pool;
  readonly metricRunId: string;
  readonly ruleVersion: string;
  readonly assessment: EvidenceAssessment;
  readonly assessmentHash: string;
}): Promise<string> {
  const result = await input.pool.query<{ id: string }>(
    `
      INSERT INTO evidence_assessments(
        metric_run_id, rule_version, verdict, reason_codes, thresholds, assessment_hash
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6)
      ON CONFLICT (assessment_hash) DO UPDATE
      SET assessment_hash = EXCLUDED.assessment_hash
      RETURNING id
    `,
    [
      input.metricRunId,
      input.ruleVersion,
      input.assessment.verdict,
      input.assessment.reasonCodes,
      JSON.stringify(input.assessment.thresholds),
      input.assessmentHash
    ]
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("Evidence assessment insert did not return an id");
  }
  return row.id;
}

export async function runMetricAssessment(input: MetricAssessmentInput): Promise<PersistedMetricAssessment> {
  const rows =
    input.replayRunId === undefined ? await loadDecisionOutcomes(input) : await loadReplayDecisionOutcomes(input);
  const scored = scoreRows(rows);
  const assessmentOptions: { exclusionCount: number; thresholds?: EvidenceThresholds } = {
    exclusionCount: scored.exclusionCount
  };
  if (input.thresholds !== undefined) {
    assessmentOptions.thresholds = input.thresholds;
  }
  const assessment = assessEvidence(scored.scored, assessmentOptions);
  const inputHash = sha256({
    rows: rows.map((row) => ({
      decisionId: row.decision_id,
      marketId: row.market_id,
      resolved: row.resolved,
      voided: row.voided,
      winner: row.winner
    })),
    evidencePlane: input.evidencePlane ?? (input.replayRunId === undefined ? "SHANNON_FORWARD" : "MAINNET_HISTORICAL"),
    replayRunId: input.replayRunId ?? null,
    thresholds: assessment.thresholds,
    ruleVersion: input.ruleVersion
  });
  const metricRunId = await insertMetricRun({
    pool: input.pool,
    assessment,
    experimentId: input.experimentId,
    policyVersionId: input.policyVersionId,
    ruleVersion: input.ruleVersion,
    evidencePlane: input.evidencePlane ?? (input.replayRunId === undefined ? "SHANNON_FORWARD" : "MAINNET_HISTORICAL"),
    promotionScope: input.promotionScope ?? (input.replayRunId === undefined ? "FORWARD_WINDOW" : "HISTORICAL_REPLAY_ONLY"),
    ...(input.replayRunId === undefined ? {} : { replayRunId: input.replayRunId }),
    ...(input.provenance === undefined ? {} : { provenance: input.provenance }),
    inputHash
  });
  const assessmentHash = sha256({ metricRunId, assessment, inputHash });
  const assessmentId = await insertAssessment({
    pool: input.pool,
    metricRunId,
    ruleVersion: input.ruleVersion,
    assessment,
    assessmentHash
  });
  return {
    metricRunId,
    assessmentId,
    verdict: assessment.verdict,
    reasonCodes: assessment.reasonCodes,
    sampleSize: assessment.metrics.sampleSize,
    exclusionCount: assessment.metrics.exclusionCount,
    pnlStatus: assessment.metrics.pnlStatus,
    inputHash,
    assessmentHash
  };
}
