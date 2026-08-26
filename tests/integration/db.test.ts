import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acquireLease,
  appendAuditEvent,
  createInteractiveExperiment,
  createPool,
  createResearchSession,
  migrations,
  runMigrations,
  upsertPolicyVersion
} from "@edgelab/db";

const connectionString =
  process.env.TEST_DATABASE_URL ?? "postgres://edgelab:edgelab@localhost:55432/edgelab";

const pool = createPool({ connectionString, max: 4, statementTimeoutMs: 5000 });

async function resetPublicSchema(): Promise<void> {
  await pool.query("DROP SCHEMA public CASCADE");
  await pool.query("CREATE SCHEMA public");
}

async function applyInitialMigrationOnly(): Promise<void> {
  const sql = await readFile(join(process.cwd(), "packages/db/migrations/0001_initial_schema.sql"), "utf8");
  const sha256 = createHash("sha256").update(sql).digest("hex");
  await pool.query(sql);
  await pool.query(
    "INSERT INTO schema_migrations(version, sha256) VALUES ('0001_initial_schema', $1)",
    [sha256]
  );
}

async function seedExperiment(): Promise<{
  experimentId: string;
  episodeId: string;
  snapshotId: string;
  policyId: string;
}> {
  const owner = "0x0000000000000000000000000000000000000abc";
  await pool.query("INSERT INTO wallet_identities(address) VALUES ($1)", [owner]);
  const policyA = await pool.query<{ id: string }>(
    `
      INSERT INTO policy_versions(policy_id, version, label, adapter_name, source_hash, manifest)
      VALUES ('a', '1.0.0', 'A', 'adapter-a', $1, '{}'::jsonb)
      RETURNING id
    `,
    ["a".repeat(64)]
  );
  const policyB = await pool.query<{ id: string }>(
    `
      INSERT INTO policy_versions(policy_id, version, label, adapter_name, source_hash, manifest)
      VALUES ('b', '1.0.0', 'B', 'adapter-b', $1, '{}'::jsonb)
      RETURNING id
    `,
    ["b".repeat(64)]
  );
  const risk = await pool.query<{ id: string }>(
    `
      INSERT INTO risk_envelopes(version, max_order_raw, max_aggregate_raw, allowed_actions, allowed_intervals, envelope_hash)
      VALUES ('1.0.0', 5000000, 10000000, ARRAY['WATCH_ONLY'], ARRAY[900, 3600], $1)
      RETURNING id
    `,
    ["c".repeat(64)]
  );
  const experiment = await pool.query<{ id: string }>(
    `
      INSERT INTO experiments(owner_address, policy_a_id, policy_b_id, risk_envelope_id, rule_version, decision_offset_sec)
      VALUES ($1, $2, $3, $4, 'rules-1', 0)
      RETURNING id
    `,
    [owner, policyA.rows[0]?.id, policyB.rows[0]?.id, risk.rows[0]?.id]
  );
  const episode = await pool.query<{ id: string }>(
    `
      INSERT INTO market_episodes(
        experiment_id, market_id, asset, interval_seconds, pool_address, market_nonce,
        expires_at, source_observed_at
      )
      VALUES ($1, 'market-1', 'BTC', 900, '0x0000000000000000000000000000000000000def', 1, now() + interval '15 minutes', now())
      RETURNING id
    `,
    [experiment.rows[0]?.id]
  );
  const snapshot = await pool.query<{ id: string }>(
    `
      INSERT INTO market_snapshots(episode_id, chain_id, captured_at, snapshot_hash, evidence_class, payload)
      VALUES ($1, 50312, now(), $2, 'MOCK', '{}'::jsonb)
      RETURNING id
    `,
    [episode.rows[0]?.id, "d".repeat(64)]
  );

  return {
    experimentId: experiment.rows[0]?.id ?? "",
    episodeId: episode.rows[0]?.id ?? "",
    snapshotId: snapshot.rows[0]?.id ?? "",
    policyId: policyA.rows[0]?.id ?? ""
  };
}

describe("DB-001 schema and recovery controls", () => {
  beforeAll(async () => {
    await resetPublicSchema();
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("runs migrations idempotently and records hashes", async () => {
    const rerun = await runMigrations(pool);
    expect(rerun).toHaveLength(migrations.length);
    for (const migration of rerun) {
      expect(migration.applied).toBe(false);
      expect(migration.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("rejects same-version policy identity mutation", async () => {
    const manifest = { policyId: "immutable-test", version: "1.0.0", behavior: "neutral" };
    const id = await upsertPolicyVersion(pool, {
      policyId: "immutable-test",
      version: "1.0.0",
      label: "Immutable test",
      adapterName: "immutableTest",
      sourceHash: "9".repeat(64),
      manifest
    });
    await expect(
      upsertPolicyVersion(pool, {
        policyId: "immutable-test",
        version: "1.0.0",
        label: "Immutable test",
        adapterName: "immutableTest",
        sourceHash: "8".repeat(64),
        manifest: { ...manifest, behavior: "changed" }
      })
    ).rejects.toThrow("POLICY_VERSION_IMMUTABLE_CONFLICT");
    await expect(pool.query("UPDATE policy_versions SET label = 'changed' WHERE id = $1", [id])).rejects.toThrow(
      /append-only/
    );
  });

  it("enforces chain and wallet identity constraints", async () => {
    await expect(
      pool.query("INSERT INTO wallet_identities(address, chain_id) VALUES ($1, $2)", [
        "0x0000000000000000000000000000000000000001",
        1
      ])
    ).rejects.toThrow();
  });

  it("enforces unique pre-outcome shadow decisions", async () => {
    const seeded = await seedExperiment();
    const decisionSql = `
      INSERT INTO shadow_decisions(
        experiment_id, episode_id, policy_version_id, snapshot_id, decision_offset_sec,
        forecast_p_up, action, reason_codes, decided_at, policy_hash, risk_hash
      )
      VALUES ($1, $2, $3, $4, 0, 0.5, 'WATCH_ONLY', ARRAY['TEST'], now(), $5, $6)
    `;
    await pool.query(decisionSql, [
      seeded.experimentId,
      seeded.episodeId,
      seeded.policyId,
      seeded.snapshotId,
      "e".repeat(64),
      "f".repeat(64)
    ]);
    await expect(
      pool.query(decisionSql, [
        seeded.experimentId,
        seeded.episodeId,
        seeded.policyId,
        seeded.snapshotId,
        "e".repeat(64),
        "f".repeat(64)
      ])
    ).rejects.toThrow();
  });

  it("prevents more than one nonterminal intent per wallet and market", async () => {
    const owner = "0x0000000000000000000000000000000000000bed";
    await pool.query("INSERT INTO wallet_identities(address) VALUES ($1)", [owner]);
    const sql = `
      INSERT INTO execution_intents(
        owner_address, market_id, chain_id, intent_type, state, pool_address, side,
        price_raw, quantity_raw, escrow_raw, expires_at, caps, idempotency_key, intent_hash
      )
      VALUES ($1, 'market-intent', 50312, 'INTEGRATION_PROBE', 'AWAITING_APPROVAL',
        '0x0000000000000000000000000000000000000bee', 'BUY_YES',
        1000, 1000, 1, now() + interval '5 minutes', '{}'::jsonb, $2, $3)
    `;
    await pool.query(sql, [owner, randomUUID(), "1".repeat(64)]);
    await expect(pool.query(sql, [owner, randomUUID(), "2".repeat(64)])).rejects.toThrow();
  });

  it("uses leases to allow one active worker holder", async () => {
    const first = await acquireLease(pool, "observe", "worker-a", 60_000);
    const second = await acquireLease(pool, "observe", "worker-b", 60_000);
    const renewal = await acquireLease(pool, "observe", "worker-a", 60_000);
    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(false);
    expect(second.holderId).toBe("worker-a");
    expect(renewal.acquired).toBe(true);
  });

  it("appends audit events with hash chaining", async () => {
    const first = await appendAuditEvent(pool, {
      actor: "system",
      action: "MIGRATION_TEST",
      targetType: "schema",
      targetId: "public",
      outcome: "PASS",
      correlationId: randomUUID()
    });
    const second = await appendAuditEvent(pool, {
      actor: "system",
      action: "MIGRATION_TEST_2",
      targetType: "schema",
      targetId: "public",
      outcome: "PASS",
      correlationId: randomUUID()
    });
    const rows = await pool.query<{ previous_hash: string | null }>(
      "SELECT previous_hash FROM audit_events WHERE event_hash = $1",
      [second]
    );
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toMatch(/^[a-f0-9]{64}$/);
    expect(rows.rows[0]?.previous_hash).toBe(first);
  });

  it("backfills legacy experiments into immutable configuration versions", async () => {
    await resetPublicSchema();
    await applyInitialMigrationOnly();
    const seeded = await seedExperiment();
    const migrated = await runMigrations(pool);
    expect(migrated[0]?.applied).toBe(false);
    expect(migrated[1]?.applied).toBe(true);
    expect(migrated[2]?.applied).toBe(true);
    expect(migrated[3]?.applied).toBe(true);

    const backfill = await pool.query<{
      active_configuration_id: string | null;
      configuration_count: string;
      policy_count: string;
    }>(
      `
        SELECT
          experiments.active_configuration_id,
          count(DISTINCT experiment_configuration_versions.id) AS configuration_count,
          count(DISTINCT experiment_policy_versions.id) AS policy_count
        FROM experiments
        LEFT JOIN experiment_configuration_versions
          ON experiment_configuration_versions.experiment_id = experiments.id
        LEFT JOIN experiment_policy_versions
          ON experiment_policy_versions.configuration_id = experiment_configuration_versions.id
        WHERE experiments.id = $1
        GROUP BY experiments.id
      `,
      [seeded.experimentId]
    );
    expect(backfill.rows[0]?.active_configuration_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(backfill.rows[0]?.configuration_count).toBe("1");
    expect(backfill.rows[0]?.policy_count).toBe("2");
    await expect(
      pool.query("UPDATE experiment_configuration_versions SET rule_version = 'mutated'")
    ).rejects.toThrow(/append-only/);
  });

  it("persists session-owned experiments without requiring a wallet identity", async () => {
    await resetPublicSchema();
    await runMigrations(pool);
    const session = await createResearchSession(pool, {
      tokenHash: "a".repeat(64),
      csrfHash: "b".repeat(64),
      expiresAt: new Date(Date.now() + 60_000)
    });
    const created = await createInteractiveExperiment(pool, {
      sessionId: session.id,
      name: "BTC hourly historical replay",
      createIdempotencyKey: "create-btc-hourly",
      configuration: {
        mode: "HISTORICAL_REPLAY",
        assets: ["BTC"],
        intervals: [3600],
        decisionOffsetSec: 0,
        ruleVersion: "interactive-2.0.0",
        config: {
          sourcePlane: "MAINNET_HISTORICAL",
          bookReconstruction: "SOURCE_INCOMPLETE"
        },
        configHash: "c".repeat(64)
      }
    });

    const rows = await pool.query<{
      name: string;
      owner_address: string | null;
      created_by_session_id: string;
      active_configuration_id: string;
      mode: string;
      assets: string[];
    }>(
      `
        SELECT
          experiments.name,
          experiments.owner_address,
          experiments.created_by_session_id,
          experiments.active_configuration_id,
          experiment_configuration_versions.mode,
          experiment_configuration_versions.assets
        FROM experiments
        JOIN experiment_configuration_versions
          ON experiment_configuration_versions.id = experiments.active_configuration_id
        WHERE experiments.id = $1
      `,
      [created.experimentId]
    );
    expect(created.version).toBe(1);
    expect(rows.rows[0]?.name).toBe("BTC hourly historical replay");
    expect(rows.rows[0]?.owner_address).toBeNull();
    expect(rows.rows[0]?.created_by_session_id).toBe(session.id);
    expect(rows.rows[0]?.active_configuration_id).toBe(created.configurationId);
    expect(rows.rows[0]?.mode).toBe("HISTORICAL_REPLAY");
    expect(rows.rows[0]?.assets).toEqual(["BTC"]);

    const duplicate = await createInteractiveExperiment(pool, {
      sessionId: session.id,
      name: "BTC hourly historical replay",
      createIdempotencyKey: "create-btc-hourly",
      configuration: {
        mode: "HISTORICAL_REPLAY",
        assets: ["BTC"],
        intervals: [3600],
        decisionOffsetSec: 0,
        ruleVersion: "interactive-2.0.0",
        config: {
          sourcePlane: "MAINNET_HISTORICAL",
          bookReconstruction: "SOURCE_INCOMPLETE"
        },
        configHash: "c".repeat(64)
      }
    });
    expect(duplicate.experimentId).toBe(created.experimentId);
    expect(duplicate.configurationId).toBe(created.configurationId);
    expect(duplicate.idempotentReplay).toBe(true);
  });
});
