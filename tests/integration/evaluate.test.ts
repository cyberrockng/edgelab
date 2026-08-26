import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@edgelab/db";
import { hashCanonicalEvaluationInput, runMetricAssessment } from "@edgelab/evaluate";

const connectionString =
  process.env.TEST_DATABASE_URL ?? "postgres://edgelab:edgelab@localhost:55432/edgelab";

const pool = createPool({ connectionString, max: 4, statementTimeoutMs: 5000 });
const owner = "0x0000000000000000000000000000000000000efe";

async function resetPublicSchema(): Promise<void> {
  await pool.query("DROP SCHEMA public CASCADE");
  await pool.query("CREATE SCHEMA public");
}

async function seedMetricExperiment(): Promise<{ experimentId: string; policyVersionId: string }> {
  await pool.query("INSERT INTO wallet_identities(address) VALUES ($1)", [owner]);
  const policyA = await pool.query<{ id: string }>(
    `
      INSERT INTO policy_versions(policy_id, version, label, adapter_name, source_hash, manifest)
      VALUES ('metric-a', '1.0.0', 'Metric A', 'metric-a', $1, '{}'::jsonb)
      RETURNING id
    `,
    ["a".repeat(64)]
  );
  const policyB = await pool.query<{ id: string }>(
    `
      INSERT INTO policy_versions(policy_id, version, label, adapter_name, source_hash, manifest)
      VALUES ('metric-b', '1.0.0', 'Metric B', 'metric-b', $1, '{}'::jsonb)
      RETURNING id
    `,
    ["b".repeat(64)]
  );
  const risk = await pool.query<{ id: string }>(
    `
      INSERT INTO risk_envelopes(version, max_order_raw, max_aggregate_raw, allowed_actions, allowed_intervals, envelope_hash)
      VALUES ('metric-risk', 0, 0, ARRAY['WATCH_ONLY'], ARRAY[900], $1)
      RETURNING id
    `,
    ["c".repeat(64)]
  );
  const experiment = await pool.query<{ id: string }>(
    `
      INSERT INTO experiments(owner_address, policy_a_id, policy_b_id, risk_envelope_id, rule_version, decision_offset_sec)
      VALUES ($1, $2, $3, $4, 'metric-rules-1', 0)
      RETURNING id
    `,
    [owner, policyA.rows[0]?.id, policyB.rows[0]?.id, risk.rows[0]?.id]
  );
  const experimentId = experiment.rows[0]?.id ?? "";
  const policyVersionId = policyA.rows[0]?.id ?? "";
  const outcomes = [
    { marketId: "metric-market-1", forecast: 0.8, winner: "YES", voided: false },
    { marketId: "metric-market-2", forecast: 0.4, winner: "NO", voided: false },
    { marketId: "metric-market-3", forecast: 0.6, winner: "YES", voided: false },
    { marketId: "metric-market-4", forecast: 0.9, winner: null, voided: true }
  ];

  for (const [index, item] of outcomes.entries()) {
    const episode = await pool.query<{ id: string }>(
      `
        INSERT INTO market_episodes(
          experiment_id, market_id, asset, interval_seconds, pool_address, market_nonce,
          expires_at, source_observed_at, state
        )
        VALUES ($1, $2, 'BTC', 900, '0x0000000000000000000000000000000000000abc', $3,
          '2026-08-24T16:00:00.000Z', '2026-08-24T15:45:00.000Z', $4)
        RETURNING id
      `,
      [experimentId, item.marketId, index, item.voided ? "VOIDED" : "RESOLVED"]
    );
    const snapshot = await pool.query<{ id: string }>(
      `
        INSERT INTO market_snapshots(episode_id, chain_id, captured_at, snapshot_hash, evidence_class, payload)
        VALUES ($1, 50312, '2026-08-24T15:45:00.000Z', $2, 'MOCK', '{}'::jsonb)
        RETURNING id
      `,
      [episode.rows[0]?.id, String(index + 1).repeat(64)]
    );
    await pool.query(
      `
        INSERT INTO shadow_decisions(
          experiment_id, episode_id, policy_version_id, snapshot_id, decision_offset_sec,
          forecast_p_up, action, reason_codes, decided_at, policy_hash, risk_hash
        )
        VALUES ($1, $2, $3, $4, 0, $5, 'WATCH_ONLY', ARRAY['TEST'], '2026-08-24T15:50:00.000Z', $6, $7)
      `,
      [
        experimentId,
        episode.rows[0]?.id,
        policyVersionId,
        snapshot.rows[0]?.id,
        item.forecast,
        "d".repeat(64),
        "e".repeat(64)
      ]
    );
    await pool.query(
      `
        INSERT INTO settlements(market_id, resolved, voided, winner, source_observed_at, payload, settlement_hash)
        VALUES ($1, $2, $3, $4, '2026-08-24T16:05:00.000Z', '{}'::jsonb, $5)
      `,
      [item.marketId, !item.voided, item.voided, item.winner, String(index + 5).repeat(64)]
    );
  }
  return { experimentId, policyVersionId };
}

describe("METRIC-001 persisted assessment", () => {
  beforeAll(async () => {
    await resetPublicSchema();
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("writes deterministic metric and verdict rows while excluding voids", async () => {
    const seeded = await seedMetricExperiment();
    const result = await runMetricAssessment({
      pool,
      experimentId: seeded.experimentId,
      policyVersionId: seeded.policyVersionId,
      ruleVersion: "metric-rules-1",
      thresholds: {
        minSampleSize: 2,
        promoteMaxBrierScore: 0.2,
        promoteMaxAbsCalibrationBias: 0.1,
        rejectWorseThanNeutralBy: 0.02
      }
    });

    expect(result.verdict).toBe("PROMOTE_TO_FORWARD_OBSERVATION");
    expect(result.sampleSize).toBe(3);
    expect(result.exclusionCount).toBe(1);
    expect(result.pnlStatus).toBe("NOT_AVAILABLE");

    const rows = await pool.query<{
      brier_score: number;
      pnl_status: string;
      verdict: string;
      evaluation_version: string;
      canonical_input: { readonly rows?: readonly { readonly forecastPUp?: number; readonly action?: string }[] };
    }>(
      `
        SELECT mr.brier_score, mr.pnl_status, mr.evaluation_version, mr.canonical_input, ea.verdict
        FROM metric_runs mr
        JOIN evidence_assessments ea ON ea.metric_run_id = mr.id
        WHERE mr.id = $1
      `,
      [result.metricRunId]
    );
    expect(rows.rows[0]?.brier_score).toBeCloseTo(0.12, 12);
    expect(rows.rows[0]?.pnl_status).toBe("NOT_AVAILABLE");
    expect(rows.rows[0]?.verdict).toBe("PROMOTE_TO_FORWARD_OBSERVATION");
    expect(rows.rows[0]?.evaluation_version).toBe("edgelab-evaluation-v2");
    expect(rows.rows[0]?.canonical_input.rows?.map((row) => row.forecastPUp)).toContain(0.8);
    expect(rows.rows[0]?.canonical_input.rows?.every((row) => row.action === "WATCH_ONLY")).toBe(true);

    const duplicate = await runMetricAssessment({
      pool,
      experimentId: seeded.experimentId,
      policyVersionId: seeded.policyVersionId,
      ruleVersion: "metric-rules-1",
      thresholds: {
        minSampleSize: 2,
        promoteMaxBrierScore: 0.2,
        promoteMaxAbsCalibrationBias: 0.1,
        rejectWorseThanNeutralBy: 0.02
      }
    });
    expect(duplicate).toEqual(result);
    await expect(pool.query("UPDATE metric_runs SET sample_size = 999 WHERE id = $1", [result.metricRunId])).rejects.toThrow(
      /append-only/
    );
    await expect(
      pool.query("UPDATE evidence_assessments SET verdict = 'REJECT' WHERE id = $1", [result.assessmentId])
    ).rejects.toThrow(/append-only/);

    await pool.query(`
      CREATE FUNCTION reject_test_assessment_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced assessment insert failure'; END;
      $$;
    `);
    await pool.query(`
      CREATE TRIGGER reject_test_assessment_insert
      BEFORE INSERT ON evidence_assessments
      FOR EACH ROW EXECUTE FUNCTION reject_test_assessment_insert();
    `);
    await expect(
      runMetricAssessment({
        pool,
        experimentId: seeded.experimentId,
        policyVersionId: seeded.policyVersionId,
        ruleVersion: "metric-rules-rollback"
      })
    ).rejects.toThrow("forced assessment insert failure");
    await pool.query("DROP TRIGGER reject_test_assessment_insert ON evidence_assessments");
    await pool.query("DROP FUNCTION reject_test_assessment_insert()");
    const partial = await pool.query<{ readonly count: string }>(
      "SELECT count(*)::text AS count FROM metric_runs WHERE rule_version = 'metric-rules-rollback'"
    );
    expect(partial.rows[0]?.count).toBe("0");
  });

  it("changes the canonical digest for every decision-defining field", () => {
    const base = {
      forecastPUp: 0.6,
      action: "WATCH_ONLY",
      reasonCodes: ["BASE"],
      frameOrSnapshotHash: "a".repeat(64),
      decisionPolicyHash: "b".repeat(64),
      configurationHash: "c".repeat(64),
      sourceManifestDigest: "d".repeat(64),
      sourceCompleteness: "COMPLETE",
      winner: "YES",
      thresholds: { minSampleSize: 30 },
      promotionScope: "PROMOTE_TO_FORWARD_OBSERVATION",
      evaluationVersion: "edgelab-evaluation-v2"
    };
    const changes: Record<string, unknown> = {
      forecastPUp: 0.4,
      action: "ABSTAIN",
      reasonCodes: ["CHANGED"],
      frameOrSnapshotHash: "e".repeat(64),
      decisionPolicyHash: "f".repeat(64),
      configurationHash: "1".repeat(64),
      sourceManifestDigest: "2".repeat(64),
      sourceCompleteness: "PARTIAL",
      winner: "NO",
      thresholds: { minSampleSize: 31 },
      promotionScope: "FORWARD_WINDOW",
      evaluationVersion: "edgelab-evaluation-v3"
    };
    const baseline = hashCanonicalEvaluationInput(base);
    for (const [key, value] of Object.entries(changes)) {
      expect(hashCanonicalEvaluationInput({ ...base, [key]: value }), key).not.toBe(baseline);
    }
  });
});
