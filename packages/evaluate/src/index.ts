import { createHash } from "node:crypto";
import type pg from "pg";
import { type PolicyDecision, type Verdict } from "@edgelab/domain";
import {
  assessEvidence,
  assessEconomicScenario,
  assessV4Forecast,
  calculatePairedMetrics,
  pairedMovingBlockDeltaInterval,
  type EvidenceAssessment,
  type EvidenceThresholds,
  type ScenarioReturnObservation,
  type ScoredDecision
} from "@edgelab/metrics";

export interface MetricAssessmentInput {
  readonly pool: pg.Pool;
  readonly experimentId: string;
  readonly policyVersionId: string;
  readonly ruleVersion: string;
  readonly replayRunId?: string;
  readonly evidencePlane?: "MAINNET_HISTORICAL" | "SHANNON_FORWARD";
  readonly promotionScope?: "PROMOTE_TO_FORWARD_OBSERVATION" | "FORWARD_WINDOW" | "EXECUTION_EXPOSURE";
  readonly qualificationTarget?: "FORWARD_OBSERVATION" | "EXECUTION_EXPOSURE";
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

export const EVALUATION_VERSION = "edgelab-evaluation-v3" as const;
export const EVALUATION_V4_VERSION = "edgelab-evaluation-v4" as const;

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
  readonly policy_version_source_hash: string;
  readonly configuration_hash: string | null;
  readonly market_id: string;
  readonly decision_window_valid: boolean;
  readonly resolved: boolean | null;
  readonly voided: boolean | null;
  readonly winner: string | null;
  readonly source_manifest_digest: string | null;
  readonly source_completeness: string | null;
  readonly source_version: string | null;
  readonly query_version: string | null;
  readonly replay_input_hash: string | null;
  readonly replay_output_hash: string | null;
  readonly outcome_loaded_at: Date | null;
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

export function hashCanonicalEvaluationInput(input: unknown): string {
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
        pv.source_hash AS policy_version_source_hash,
        ecv.config_hash AS configuration_hash,
        me.market_id,
        (
          ms.captured_at >= GREATEST(
            COALESCE(me.trading_starts_at + interval '1 second', '-infinity'::timestamptz),
            me.expires_at - make_interval(secs => sd.decision_offset_sec)
          )
          AND ms.captured_at < me.expires_at
        ) AS decision_window_valid,
        s.resolved,
        s.voided,
        s.winner,
        null::text AS source_manifest_digest,
        null::text AS source_completeness,
        null::text AS source_version,
        null::text AS query_version,
        null::text AS replay_input_hash,
        null::text AS replay_output_hash,
        null::timestamptz AS outcome_loaded_at
      FROM shadow_decisions sd
      JOIN policy_versions pv ON pv.id = sd.policy_version_id
      JOIN experiments e ON e.id = sd.experiment_id
      LEFT JOIN experiment_configuration_versions ecv ON ecv.id = e.active_configuration_id
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
        pv.source_hash AS policy_version_source_hash,
        ecv.config_hash AS configuration_hash,
        rd.market_id,
        true AS decision_window_valid,
        (ro.outcome_result IN ('YES', 'NO')) AS resolved,
        false AS voided,
        ro.outcome_result AS winner,
        rsm.canonical_digest AS source_manifest_digest,
        rsm.completeness AS source_completeness,
        rsm.source_version,
        rsm.query_version,
        rr.input_hash AS replay_input_hash,
        rr.output_hash AS replay_output_hash,
        ro.loaded_at AS outcome_loaded_at
      FROM replay_decisions rd
      JOIN replay_runs rr ON rr.id = rd.replay_run_id
      JOIN policy_versions pv ON pv.id = rd.policy_version_id
      JOIN experiment_configuration_versions ecv ON ecv.id = rr.configuration_id
      LEFT JOIN historical_source_manifests rsm
        ON rsm.replay_run_id = rd.replay_run_id AND rsm.market_id = rd.market_id
      LEFT JOIN replay_outcomes ro ON ro.replay_decision_id = rd.id
      WHERE rr.experiment_id = $1
        AND rd.policy_version_id = $2
        AND rd.replay_run_id = $3
        AND rr.invalidated_at IS NULL
        AND rr.status IN ('COMPLETED', 'SUCCEEDED')
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
    if (!row.decision_window_valid) {
      exclusionCount += 1;
      continue;
    }
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
  readonly pool: pg.Pool | pg.PoolClient;
  readonly assessment: EvidenceAssessment;
  readonly experimentId: string;
  readonly policyVersionId: string;
  readonly ruleVersion: string;
  readonly replayRunId?: string;
  readonly evidencePlane?: "MAINNET_HISTORICAL" | "SHANNON_FORWARD";
  readonly promotionScope?: "PROMOTE_TO_FORWARD_OBSERVATION" | "FORWARD_WINDOW" | "EXECUTION_EXPOSURE";
  readonly provenance?: Record<string, unknown>;
  readonly inputHash: string;
  readonly canonicalInput: Record<string, unknown>;
}): Promise<string> {
  const result = await input.pool.query<{ id: string }>(
    `
      INSERT INTO metric_runs(
        experiment_id, policy_version_id, rule_version, sample_size, exclusion_count,
        brier_score, calibration_bias, neutral_baseline_delta, execution_metrics,
        pnl_status, input_hash, replay_run_id, evidence_plane, promotion_scope, provenance,
        evaluation_version, canonical_input
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15::jsonb,
        $16, $17::jsonb)
      ON CONFLICT (experiment_id, policy_version_id, rule_version, input_hash) DO NOTHING
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
      JSON.stringify(input.provenance ?? {}),
      EVALUATION_VERSION,
      JSON.stringify(input.canonicalInput)
    ]
  );
  const row = result.rows[0];
  if (row !== undefined) {
    return row.id;
  }
  const existing = await input.pool.query<{ readonly id: string }>(
    `
      SELECT id
      FROM metric_runs
      WHERE experiment_id = $1 AND policy_version_id = $2 AND rule_version = $3 AND input_hash = $4
        AND evaluation_version = $5 AND canonical_input = $6::jsonb
    `,
    [
      input.experimentId,
      input.policyVersionId,
      input.ruleVersion,
      input.inputHash,
      EVALUATION_VERSION,
      JSON.stringify(input.canonicalInput)
    ]
  );
  if (existing.rows[0] === undefined) {
    throw new Error("METRIC_RUN_IMMUTABLE_CONFLICT");
  }
  return existing.rows[0].id;
}

async function insertAssessment(input: {
  readonly pool: pg.Pool | pg.PoolClient;
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
      ON CONFLICT (assessment_hash) DO NOTHING
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
  if (row !== undefined) {
    return row.id;
  }
  const existing = await input.pool.query<{ readonly id: string }>(
    `
      SELECT id FROM evidence_assessments
      WHERE assessment_hash = $1 AND metric_run_id = $2 AND rule_version = $3
        AND verdict = $4 AND reason_codes = $5 AND thresholds = $6::jsonb
    `,
    [
      input.assessmentHash,
      input.metricRunId,
      input.ruleVersion,
      input.assessment.verdict,
      input.assessment.reasonCodes,
      JSON.stringify(input.assessment.thresholds)
    ]
  );
  if (existing.rows[0] === undefined) {
    throw new Error("EVIDENCE_ASSESSMENT_IMMUTABLE_CONFLICT");
  }
  return existing.rows[0].id;
}

export async function runMetricAssessment(input: MetricAssessmentInput): Promise<PersistedMetricAssessment> {
  const client = await input.pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const transactionInput = { ...input, pool: client as unknown as pg.Pool };
    const rows =
      input.replayRunId === undefined
        ? await loadDecisionOutcomes(transactionInput)
        : await loadReplayDecisionOutcomes(transactionInput);
    if (
      input.replayRunId !== undefined &&
      (rows.length === 0 ||
        rows.some(
          (row) =>
            row.source_completeness !== "COMPLETE" ||
            row.source_manifest_digest === null ||
            row.configuration_hash === null ||
            row.replay_input_hash === null ||
            row.replay_output_hash === null ||
            row.outcome_loaded_at === null
        ))
    ) {
      throw new Error("EVALUATION_PROVENANCE_INCOMPLETE");
    }
    const scored = scoreRows(rows);
    const assessmentOptions: {
      exclusionCount: number;
      thresholds?: EvidenceThresholds;
      qualificationTarget?: "FORWARD_OBSERVATION" | "EXECUTION_EXPOSURE";
    } = {
      exclusionCount: scored.exclusionCount,
      ...(input.qualificationTarget === undefined ? {} : { qualificationTarget: input.qualificationTarget })
    };
    if (input.thresholds !== undefined) {
      assessmentOptions.thresholds = input.thresholds;
    }
    const assessment = assessEvidence(scored.scored, assessmentOptions);
    const evidencePlane =
      input.evidencePlane ?? (input.replayRunId === undefined ? "SHANNON_FORWARD" : "MAINNET_HISTORICAL");
    const promotionScope =
      input.promotionScope ?? (input.replayRunId === undefined ? "FORWARD_WINDOW" : "PROMOTE_TO_FORWARD_OBSERVATION");
    const canonicalInput = {
      evaluationVersion: EVALUATION_VERSION,
      experimentId: input.experimentId,
      policyVersionId: input.policyVersionId,
      ruleVersion: input.ruleVersion,
      replayRunId: input.replayRunId ?? null,
      evidencePlane,
      promotionScope,
      thresholds: assessment.thresholds,
      provenance: input.provenance ?? {},
      rows: rows.map((row) => ({
        decisionId: row.decision_id,
        marketId: row.market_id,
        policyId: row.policy_id,
        policyVersion: row.policy_version,
        policyVersionSourceHash: row.policy_version_source_hash,
        forecastPUp: row.forecast_p_up,
        action: row.action,
        reasonCodes: row.reason_codes,
        decidedAt: row.decided_at.toISOString(),
        frameOrSnapshotHash: row.snapshot_hash,
        decisionPolicyHash: row.policy_hash,
        configurationHash: row.configuration_hash,
        decisionWindowValid: row.decision_window_valid,
        resolved: row.resolved,
        voided: row.voided,
        winner: row.winner,
        sourceManifestDigest: row.source_manifest_digest,
        sourceCompleteness: row.source_completeness,
        sourceVersion: row.source_version,
        queryVersion: row.query_version,
        replayInputHash: row.replay_input_hash,
        replayOutputHash: row.replay_output_hash,
        outcomeLoadedAt: row.outcome_loaded_at?.toISOString() ?? null
      }))
    } satisfies Record<string, unknown>;
    const inputHash = hashCanonicalEvaluationInput(canonicalInput);
    const metricRunId = await insertMetricRun({
      pool: client,
      assessment,
      experimentId: input.experimentId,
      policyVersionId: input.policyVersionId,
      ruleVersion: input.ruleVersion,
      evidencePlane,
      promotionScope,
      ...(input.replayRunId === undefined ? {} : { replayRunId: input.replayRunId }),
      ...(input.provenance === undefined ? {} : { provenance: input.provenance }),
      inputHash,
      canonicalInput
    });
    const assessmentHash = hashCanonicalEvaluationInput({
      evaluationVersion: EVALUATION_VERSION,
      assessment,
      inputHash
    });
    const assessmentId = await insertAssessment({
      pool: client,
      metricRunId,
      ruleVersion: input.ruleVersion,
      assessment,
      assessmentHash
    });
    await client.query("COMMIT");
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
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export interface PersistedV4Assessment {
  readonly assessmentId: string;
  readonly metricRunId: string;
  readonly protocolId: string;
  readonly forecastStatus: string;
  readonly reasonCodes: readonly string[];
  readonly pairedMetrics: ReturnType<typeof calculatePairedMetrics>;
  readonly deltaInterval: ReturnType<typeof pairedMovingBlockDeltaInterval>;
  readonly eligibleScheduledCount: number;
  readonly coverage: number;
  readonly studyEnded: boolean;
  readonly sourceDigest: string;
  readonly seed: string;
  readonly algorithm: "PAIRED_MOVING_BLOCK_BOOTSTRAP_UTC_DAY_V1";
  readonly createdAt: Date;
  readonly integrityStatus: { readonly internallyReproducible: boolean; readonly externallyTimeAnchored: false; readonly completenessChecked: false };
  readonly economics: ReturnType<typeof assessEconomicScenario>;
  readonly executionEligibility: "BLOCKED" | "ELIGIBLE_FOR_FRESH_REVIEW";
}

export async function runV4Assessment(input: { readonly pool: pg.Pool; readonly experimentId: string; readonly protocolId?: string; readonly now?: Date }): Promise<PersistedV4Assessment> {
  const protocolResult = await input.pool.query<{
    id: string; manifest_hash: string; window_from: Date; window_to: Date; manifest: Record<string, unknown>; policy_version_id: string;
  }>(
    `SELECT op.id, op.manifest_hash, op.window_from, op.window_to, op.manifest, epv.policy_version_id
     FROM observation_protocols op
     JOIN experiment_policy_versions epv ON epv.configuration_id = op.configuration_id AND epv.role = 'CANDIDATE'
     WHERE op.experiment_id = $1 AND ($2::uuid IS NULL OR op.id = $2) ORDER BY op.registered_at DESC LIMIT 1`,
    [input.experimentId, input.protocolId ?? null]
  );
  const protocol = protocolResult.rows[0];
  if (protocol === undefined) throw new Error("V4 observation protocol not found");
  const records = await input.pool.query<{
    id: string; observation_key: string; candidate_probability: number; baseline_probability: number | null;
    outcome_up: boolean | null; captured_at: Date; integrity_status: { internallyReproducible?: boolean };
  }>(
    `SELECT pfr.id, concat(pfr.chain_id, ':', pfr.venue_id, ':', pfr.market_generation_id, ':', pfr.decision_offset_sec) AS observation_key,
       pfr.candidate_probability, pfr.baseline_probability,
       CASE WHEN COALESCE(pfr.outcome, s.winner) = 'YES' THEN true WHEN COALESCE(pfr.outcome, s.winner) = 'NO' THEN false ELSE NULL END AS outcome_up,
       pfr.captured_at, pfr.integrity_status
     FROM paired_forecast_records pfr LEFT JOIN settlements s ON s.market_id = pfr.market_generation_id
     WHERE pfr.protocol_id = $1 AND pfr.candidate_probability IS NOT NULL
       AND COALESCE(pfr.outcome, s.winner) IN ('YES','NO') ORDER BY pfr.captured_at, pfr.id`,
    [protocol.id]
  );
  const observations = records.rows.flatMap((row) => row.outcome_up === null ? [] : [{
    observationKey: row.observation_key, candidateProbability: row.candidate_probability,
    marketProbability: row.baseline_probability, outcomeUp: row.outcome_up, observedAt: row.captured_at.toISOString()
  }]);
  const pairedMetrics = calculatePairedMetrics(observations);
  const deltaInterval = pairedMovingBlockDeltaInterval(observations, { seed: protocol.manifest_hash, replicates: 10_000, blockLengthDays: 2, familySize: 1 });
  const scheduled = await input.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM market_episodes me
     WHERE me.experiment_id = $1 AND (me.expires_at - make_interval(secs => (SELECT decision_offset_sec FROM experiments WHERE id = $1))) >= $2
       AND (me.expires_at - make_interval(secs => (SELECT decision_offset_sec FROM experiments WHERE id = $1))) < $3`,
    [input.experimentId, protocol.window_from, protocol.window_to]
  );
  const eligibleScheduledCount = Number(scheduled.rows[0]?.count ?? 0);
  const studyEnded = (input.now ?? new Date()) >= protocol.window_to;
  const gate = assessV4Forecast({
    sourcePlane: "SHANNON_FORWARD", pairedMetrics, deltaInterval, eligibleScheduledCount, studyEnded,
    integrityComplete: records.rows.every((row) => row.integrity_status.internallyReproducible === true)
  });
  const coverage = eligibleScheduledCount === 0 ? 0 : pairedMetrics.pairedSampleSize / eligibleScheduledCount;
  const scenarioResult = await input.pool.query<{
    paired_record_id: string; market_generation_id: string; side: "BUY_YES" | "BUY_NO" | null;
    scenario_action: "TRADE" | "NO_TRADE" | "SOURCE_UNAVAILABLE"; captured_at: Date;
    primary_plan: { fillableQuantityRaw?: unknown; totalCollateralRaw?: unknown } | null;
    stress_plan: { fillableQuantityRaw?: unknown; totalCollateralRaw?: unknown } | null;
    fixed_bankroll_raw: string; winner: string | null;
  }>(
    `SELECT esr.paired_record_id,pfr.market_generation_id,esr.side,esr.scenario_action,esr.captured_at,
            esr.primary_plan,esr.stress_plan,esr.fixed_bankroll_raw,COALESCE(pfr.outcome,s.winner) AS winner
       FROM economic_scenario_records esr
       JOIN paired_forecast_records pfr ON pfr.id=esr.paired_record_id
       LEFT JOIN settlements s ON s.market_id=pfr.market_generation_id
      WHERE esr.protocol_id=$1 ORDER BY esr.captured_at,esr.id`,
    [protocol.id]
  );
  const scenarioObservations: ScenarioReturnObservation[] = scenarioResult.rows.flatMap<ScenarioReturnObservation>((row) => {
    if (row.scenario_action === "SOURCE_UNAVAILABLE") return [];
    if (row.scenario_action === "NO_TRADE") return [{
      observationKey: row.paired_record_id, observedAt: row.captured_at.toISOString(),
      primaryNetReturn: 0, stressNetReturn: 0, deployedCollateralReturn: null, action: "NO_TRADE" as const
    }];
    const primaryQuantity = typeof row.primary_plan?.fillableQuantityRaw === "string" ? BigInt(row.primary_plan.fillableQuantityRaw) : null;
    const stressQuantity = typeof row.stress_plan?.fillableQuantityRaw === "string" ? BigInt(row.stress_plan.fillableQuantityRaw) : null;
    const primaryCost = typeof row.primary_plan?.totalCollateralRaw === "string" ? BigInt(row.primary_plan.totalCollateralRaw) : null;
    const stressCost = typeof row.stress_plan?.totalCollateralRaw === "string" ? BigInt(row.stress_plan.totalCollateralRaw) : null;
    if (primaryQuantity === null || stressQuantity === null || primaryCost === null || stressCost === null || row.side === null || !["YES", "NO"].includes(row.winner ?? "")) return [];
    const won = (row.side === "BUY_YES" && row.winner === "YES") || (row.side === "BUY_NO" && row.winner === "NO");
    const primaryPayout = won ? primaryQuantity : 0n;
    const stressPayout = won ? stressQuantity : 0n;
    const bankroll = Number(BigInt(row.fixed_bankroll_raw));
    if (!Number.isFinite(bankroll) || bankroll <= 0) return [];
    const primaryNet = Number(primaryPayout - primaryCost);
    const stressNet = Number(stressPayout - stressCost);
    return [{
      observationKey: row.paired_record_id, observedAt: row.captured_at.toISOString(),
      primaryNetReturn: primaryNet / bankroll, stressNetReturn: stressNet / bankroll,
      deployedCollateralReturn: primaryCost === 0n ? null : primaryNet / Number(primaryCost), action: "TRADE" as const
    }];
  });
  const economicsSeed = createHash("sha256").update(`${protocol.manifest_hash}:economics`).digest("hex");
  const economics = assessEconomicScenario({
    observations: scenarioObservations, eligibleScheduledCount, studyEnded,
    forecastStatus: gate.status, seed: economicsSeed
  });
  const executionEligibility = gate.status === "FORWARD_CRITERIA_MET" && economics.status === "SCENARIO_CRITERIA_MET"
    ? "ELIGIBLE_FOR_FRESH_REVIEW" as const
    : "BLOCKED" as const;
  const canonicalInput = { evaluationVersion: EVALUATION_V4_VERSION, protocolId: protocol.id, protocolHash: protocol.manifest_hash, manifest: protocol.manifest, observations, scenarioObservations, eligibleScheduledCount };
  const inputHash = hashCanonicalEvaluationInput(canonicalInput);
  const sourceDigest = hashCanonicalEvaluationInput({ protocolHash: protocol.manifest_hash, observations, scenarioObservations });
  const assessmentHash = hashCanonicalEvaluationInput({ inputHash, gate, economics, pairedMetrics, deltaInterval, sourceDigest });
  const client = await input.pool.connect();
  try {
    await client.query("BEGIN");
    const metric = await client.query<{ id: string }>(
      `INSERT INTO metric_runs(experiment_id, policy_version_id, rule_version, sample_size, exclusion_count, brier_score, calibration_bias,
       neutral_baseline_delta, execution_metrics, pnl_status, input_hash, evidence_plane, promotion_scope, provenance, evaluation_version, canonical_input)
       VALUES ($1,$2,$3,$4,$5,$6,NULL,NULL,'{"tradeabilityStatus":"NOT_EVALUATED"}'::jsonb,'NOT_AVAILABLE',$7,'SHANNON_FORWARD','FORWARD_WINDOW',$8::jsonb,$3,$9::jsonb)
       ON CONFLICT (experiment_id, policy_version_id, rule_version, input_hash) DO NOTHING RETURNING id`,
      [input.experimentId, protocol.policy_version_id, EVALUATION_V4_VERSION, pairedMetrics.pairedSampleSize,
        pairedMetrics.missingBaselineCount + pairedMetrics.duplicateCount, pairedMetrics.candidateBrier, inputHash,
        JSON.stringify({ protocolId: protocol.id, sourceDigest }), JSON.stringify(canonicalInput)]
    );
    const metricRunId = metric.rows[0]?.id ?? (await client.query<{ id: string }>(
      "SELECT id FROM metric_runs WHERE experiment_id=$1 AND policy_version_id=$2 AND rule_version=$3 AND input_hash=$4",
      [input.experimentId, protocol.policy_version_id, EVALUATION_V4_VERSION, inputHash]
    )).rows[0]?.id;
    if (metricRunId === undefined) throw new Error("V4 metric persistence failed");
    const assessment = await client.query<{ id: string }>(
      `INSERT INTO evidence_assessments(metric_run_id, rule_version, verdict, reason_codes, thresholds, assessment_hash)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT (assessment_hash) DO NOTHING RETURNING id`,
      [metricRunId, EVALUATION_V4_VERSION, gate.status, [...gate.reasonCodes, ...economics.reasonCodes], JSON.stringify({ formalFloor: 200, minimumUtcDays: 20, pairedCoverage: .8, scenarioCoverage: .8, minimumWeekGroups: 4 }), assessmentHash]
    );
    const assessmentId = assessment.rows[0]?.id ?? (await client.query<{ id: string }>("SELECT id FROM evidence_assessments WHERE assessment_hash=$1", [assessmentHash])).rows[0]?.id;
    if (assessmentId === undefined) throw new Error("V4 assessment persistence failed");
    await client.query(
      `INSERT INTO assessment_v4_details(assessment_id, protocol_id, forecast_status, economics_status, execution_eligibility,
       paired_metrics, intervals, sample_counts, coverage, economics_metrics, integrity_status, algorithm, seed, source_digest)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,'PAIRED_MOVING_BLOCK_BOOTSTRAP_UTC_DAY_V1',$12,$13)
       ON CONFLICT (assessment_id) DO NOTHING`,
      [assessmentId, protocol.id, gate.status, economics.status, executionEligibility,
        JSON.stringify(pairedMetrics), JSON.stringify({ deltaBrier: deltaInterval, stressMeanPerWindowReturn: economics.stressInterval }),
        JSON.stringify({ paired: pairedMetrics.pairedSampleSize, eligibleScheduled: eligibleScheduledCount }),
        JSON.stringify({ paired: coverage, scenario: economics.coverage }), JSON.stringify(economics),
        JSON.stringify({ internallyReproducible: records.rows.every((row) => row.integrity_status.internallyReproducible === true), externallyTimeAnchored: false, completenessChecked: false }), protocol.manifest_hash, sourceDigest]
    );
    const persistedDetail = await client.query<{ created_at: Date }>("SELECT created_at FROM assessment_v4_details WHERE assessment_id=$1", [assessmentId]);
    await client.query("COMMIT");
    return {
      assessmentId, metricRunId, protocolId: protocol.id, forecastStatus: gate.status, reasonCodes: gate.reasonCodes,
      pairedMetrics, deltaInterval, eligibleScheduledCount, coverage, studyEnded, sourceDigest,
      seed: protocol.manifest_hash, algorithm: "PAIRED_MOVING_BLOCK_BOOTSTRAP_UTC_DAY_V1",
      createdAt: persistedDetail.rows[0]?.created_at ?? new Date(),
      economics,
      executionEligibility,
      integrityStatus: {
        internallyReproducible: records.rows.every((row) => row.integrity_status.internallyReproducible === true),
        externallyTimeAnchored: false,
        completenessChecked: false
      }
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
