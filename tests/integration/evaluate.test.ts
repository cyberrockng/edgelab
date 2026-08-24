import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@edgelab/db";
import { runMetricAssessment } from "@edgelab/evaluate";

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

    expect(result.verdict).toBe("PROMOTE");
    expect(result.sampleSize).toBe(3);
    expect(result.exclusionCount).toBe(1);
    expect(result.pnlStatus).toBe("NOT_AVAILABLE");

    const rows = await pool.query<{ brier_score: number; pnl_status: string; verdict: string }>(
      `
        SELECT mr.brier_score, mr.pnl_status, ea.verdict
        FROM metric_runs mr
        JOIN evidence_assessments ea ON ea.metric_run_id = mr.id
        WHERE mr.id = $1
      `,
      [result.metricRunId]
    );
    expect(rows.rows[0]?.brier_score).toBeCloseTo(0.12, 12);
    expect(rows.rows[0]?.pnl_status).toBe("NOT_AVAILABLE");
    expect(rows.rows[0]?.verdict).toBe("PROMOTE");
  });
});
