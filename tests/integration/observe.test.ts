import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@edgelab/db";
import {
  observeExperiment,
  registerPolicyVersion,
  type ObserveExperimentResult
} from "@edgelab/observe";
import { referencePolicies } from "@edgelab/policy-runtime";
import type { DreamDexReadConfig, DreamDexSdkClient } from "@edgelab/dreamdex";
import type { BinaryMarket } from "@somnia-chain/markets-sdk";

const connectionString =
  process.env.TEST_DATABASE_URL ?? "postgres://edgelab:edgelab@localhost:55432/edgelab_test";

const pool = createPool({ connectionString, max: 4, statementTimeoutMs: 5000 });

const config: DreamDexReadConfig = {
  rpcUrl: "https://api.infra.testnet.somnia.network/",
  wsRpcUrl: "wss://api.infra.testnet.somnia.network/ws",
  indexerUrl: "https://dev.smk.somnia.host/v1/graphql",
  chainId: 50312,
  sdkVersion: "0.28.1"
};

const fixedNow = new Date("2026-08-24T15:59:30.000Z");
const owner = "0x0000000000000000000000000000000000000ace";

function market(expiry: string): BinaryMarket {
  return {
    id: "0xmarket",
    marketType: "BINARY",
    poolAddress: "0x0000000000000000000000000000000000000a11",
    lastPrice: null,
    lastTradeAt: null,
    cumulativeBaseVolume: "0",
    cumulativeQuoteVolume: "0",
    tradeCount: "0",
    baseDecimals: 6,
    quoteDecimals: 6,
    createdAtTimestamp: "1787570000",
    marketId: `0x${"1".repeat(64)}`,
    marketAddress: "0x0000000000000000000000000000000000000b11",
    yesTokenId: "1",
    noTokenId: "2",
    collateral: "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E",
    asset: "BTC",
    question: "Will BTC close up?",
    status: "Trading",
    oracleQuestion: "BTC up?",
    oracleQuestionId: "1",
    strike: "100000",
    tradingStart: "1787570000",
    expiry,
    winningOutcome: null,
    payoutNumerators: null,
    payoutDenominator: null,
    resolvedAtBlock: null,
    resolvedAtTimestamp: null,
    createdByTx: null,
    creator: null,
    voided: false,
    backing: "0",
    nonce: "58",
    finalized: false,
    netBacking: null,
    context: "0x",
    intervalSec: "900",
    interval: "15m",
    operatorId: 1,
    venueId: "0x4d41494e"
  };
}

function clientWith(row: BinaryMarket): DreamDexSdkClient {
  return {
    listLiveBinaryMarkets() {
      return Promise.resolve([row]);
    },
    getBinaryBookParams() {
      return Promise.resolve({
        tickSize: 1000n,
        lotSize: 1000n,
        minQuantity: 1000n
      });
    },
    getLiveBinaryOrderBookByMarket() {
      return {
        yesBids: [{ price: 1000n, quantity: 2000n }],
        yesAsks: [{ price: 2000n, quantity: 1000n }],
        noBids: [],
        noAsks: []
      };
    },
    getBinaryMarket() {
      return Promise.resolve(row);
    }
  };
}

async function resetPublicSchema(): Promise<void> {
  await pool.query("DROP SCHEMA public CASCADE");
  await pool.query("CREATE SCHEMA public");
}

async function seedExperiment(): Promise<string> {
  await pool.query("INSERT INTO wallet_identities(address) VALUES ($1)", [owner]);
  const policyA = await registerPolicyVersion(pool, referencePolicies[0]);
  const policyB = await registerPolicyVersion(pool, referencePolicies[1]);
  const risk = await pool.query<{ id: string }>(
    `
      INSERT INTO risk_envelopes(version, max_order_raw, max_aggregate_raw, allowed_actions, allowed_intervals, envelope_hash)
      VALUES ('observe-test', 0, 0, ARRAY['WATCH_ONLY'], ARRAY[900], $1)
      RETURNING id
    `,
    ["3".repeat(64)]
  );
  const experiment = await pool.query<{ id: string }>(
    `
      INSERT INTO experiments(owner_address, policy_a_id, policy_b_id, risk_envelope_id, rule_version, decision_offset_sec)
      VALUES ($1, $2, $3, $4, 'observe-rules-1', 60)
      RETURNING id
    `,
    [owner, policyA, policyB, risk.rows[0]?.id]
  );
  return experiment.rows[0]?.id ?? "";
}

async function seedV4Experiment(): Promise<string> {
  const experimentId = await seedExperiment();
  const base = await pool.query<{ policy_a_id: string }>("SELECT policy_a_id FROM experiments WHERE id=$1", [experimentId]);
  const configuration = await pool.query<{ id: string }>(
    `INSERT INTO experiment_configuration_versions(experiment_id, version, mode, assets, intervals, window_from, window_to, decision_offset_sec, rule_version, config, config_hash)
     VALUES ($1,2,'LIVE_SHADOW',ARRAY['BTC'],ARRAY[900],'2026-08-24T15:00:00Z','2026-08-24T17:00:00Z',60,'edgelab-evaluation-v4','{}'::jsonb,$2) RETURNING id`,
    [experimentId, "8".repeat(64)]
  );
  const configurationId = configuration.rows[0]?.id ?? "";
  await pool.query("UPDATE experiments SET active_configuration_id=$1 WHERE id=$2", [configurationId, experimentId]);
  await pool.query("INSERT INTO experiment_policy_versions(experiment_id,configuration_id,policy_version_id,role) VALUES ($1,$2,$3,'CANDIDATE')", [experimentId, configurationId, base.rows[0]?.policy_a_id]);
  const protocol = await pool.query<{ id: string }>(
    `INSERT INTO observation_protocols(experiment_id,configuration_id,family,rule_version,window_from,window_to,manifest,manifest_hash)
     VALUES ($1,$2,'BTC:900:60','edgelab-evaluation-v4','2026-08-24T15:00:00Z','2026-08-24T17:00:00Z','{}'::jsonb,$3) RETURNING id`,
    [experimentId, configurationId, "9".repeat(64)]
  );
  await pool.query("INSERT INTO campaign_runs(experiment_id,configuration_id,protocol_id,lifecycle) VALUES ($1,$2,$3,'COLLECTING')", [experimentId, configurationId, protocol.rows[0]?.id]);
  return experimentId;
}

async function counts(): Promise<{ episodes: number; snapshots: number; decisions: number }> {
  const result = await pool.query<{ episodes: string; snapshots: string; decisions: string }>(
    `
      SELECT
        (SELECT count(*) FROM market_episodes) AS episodes,
        (SELECT count(*) FROM market_snapshots) AS snapshots,
        (SELECT count(*) FROM shadow_decisions) AS decisions
    `
  );
  const row = result.rows[0];
  return {
    episodes: Number(row?.episodes ?? 0),
    snapshots: Number(row?.snapshots ?? 0),
    decisions: Number(row?.decisions ?? 0)
  };
}

async function observe(
  experimentId: string,
  row: BinaryMarket,
  holderId: string,
  observationNow = fixedNow
): Promise<ObserveExperimentResult> {
  return observeExperiment({
    pool,
    dreamDexClient: clientWith(row),
    dreamDexConfig: config,
    experimentId,
    policyAdapters: referencePolicies,
    holderId,
    leaseTtlMs: 1,
    clock: { now: () => observationNow },
    intervals: [900]
  });
}

describe("OBSERVE-001 live-shadow observation pipeline", () => {
  beforeAll(async () => {
    await resetPublicSchema();
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("records one pre-outcome snapshot and shadow decisions idempotently", async () => {
    const experimentId = await seedExperiment();
    const first = await observe(experimentId, market("1787587200"), "observe-a");
    const second = await observe(experimentId, market("1787587200"), "observe-a");

    expect(first.leaseAcquired).toBe(true);
    expect(first.discoveredMarketCount).toBe(1);
    expect(first.observed[0]).toMatchObject({
      insertedDecisionCount: 2,
      reusedDecisionCount: 0,
      skipped: false
    });
    expect(second.observed[0]).toMatchObject({
      insertedDecisionCount: 0,
      reusedDecisionCount: 2,
      skipped: false
    });
    await expect(counts()).resolves.toEqual({ episodes: 1, snapshots: 1, decisions: 2 });
  });

  it("preserves the DreamDEX discovery reason when no requested market is available", async () => {
    await resetPublicSchema();
    await runMigrations(pool);
    const experimentId = await seedExperiment();
    const nonMatchingMarket = { ...market("1787587200"), asset: "ETH" } as BinaryMarket;
    const result = await observeExperiment({
      pool,
      dreamDexClient: clientWith(nonMatchingMarket),
      dreamDexConfig: config,
      experimentId,
      policyAdapters: referencePolicies,
      holderId: randomUUID(),
      leaseTtlMs: 1,
      clock: { now: () => fixedNow },
      assets: ["BTC"],
      intervals: [900]
    });

    expect(result).toMatchObject({
      leaseAcquired: true,
      discoveredMarketCount: 0,
      observed: [],
      discoveryIssue: {
        reasonCode: "DREAMDEX_NO_ELIGIBLE_MARKET",
        message: "No BTC/ETH Trading successor market matched the requested intervals"
      }
    });
    await expect(counts()).resolves.toEqual({ episodes: 0, snapshots: 0, decisions: 0 });
  });

  it("rejects already-expired markets before snapshot or decision writes", async () => {
    await resetPublicSchema();
    await runMigrations(pool);
    const experimentId = await seedExperiment();
    const result = await observe(experimentId, market("1787580000"), randomUUID());

    expect(result.observed[0]).toMatchObject({
      snapshotId: null,
      insertedDecisionCount: 0,
      skipped: true,
      reasonCode: "MARKET_ALREADY_EXPIRED"
    });
    await expect(counts()).resolves.toEqual({ episodes: 1, snapshots: 0, decisions: 0 });
  });

  it("defers capture until the configured pre-expiry decision window", async () => {
    await resetPublicSchema();
    await runMigrations(pool);
    const experimentId = await seedExperiment();
    const result = await observe(
      experimentId,
      market("1787587200"),
      randomUUID(),
      new Date("2026-08-24T15:30:00.000Z")
    );

    expect(result.observed[0]).toMatchObject({
      snapshotId: null,
      insertedDecisionCount: 0,
      skipped: true,
      reasonCode: "DECISION_WINDOW_NOT_OPEN"
    });
    await expect(counts()).resolves.toEqual({ episodes: 1, snapshots: 0, decisions: 0 });
  });

  it("captures v4 only in the five-second lead window and persists the paired midpoint", async () => {
    await resetPublicSchema();
    await runMigrations(pool);
    const experimentId = await seedV4Experiment();
    const early = await observe(experimentId, market("1787587200"), randomUUID(), new Date("2026-08-24T15:58:54.000Z"));
    expect(early.observed[0]?.reasonCode).toBe("DECISION_WINDOW_NOT_OPEN");
    const captured = await observe(experimentId, market("1787587200"), randomUUID(), new Date("2026-08-24T15:58:57.000Z"));
    expect(captured.observed[0]).toMatchObject({ skipped: false, insertedDecisionCount: 1 });
    const paired = await pool.query<{ baseline_probability: number; baseline_bid_raw: string; baseline_ask_raw: string; captured_at: Date; decision_deadline: Date; candidate_received_at: Date }>("SELECT baseline_probability,baseline_bid_raw,baseline_ask_raw,captured_at,decision_deadline,candidate_received_at FROM paired_forecast_records");
    expect(paired.rows[0]?.baseline_probability).toBeCloseTo(.0015, 12);
    expect(paired.rows[0]?.baseline_bid_raw).toBe("1000");
    expect(paired.rows[0]?.baseline_ask_raw).toBe("2000");
    expect(paired.rows[0]?.captured_at.toISOString()).toBe("2026-08-24T15:58:57.000Z");
    expect(paired.rows[0]?.decision_deadline.toISOString()).toBe("2026-08-24T15:59:00.000Z");
    const pairedRow = paired.rows[0];
    expect(pairedRow).toBeDefined();
    if (pairedRow === undefined) throw new Error("paired record missing");
    expect(pairedRow.candidate_received_at < pairedRow.decision_deadline).toBe(true);
    const scenario = await pool.query<{ classification: string; scenario_action: string; raw_levels: unknown[]; fixed_bankroll_raw: string; per_window_budget_raw: string }>(
      "SELECT classification,scenario_action,raw_levels,fixed_bankroll_raw,per_window_budget_raw FROM economic_scenario_records"
    );
    expect(scenario.rows[0]).toMatchObject({
      classification: "SIMULATED_FROM_CAPTURED_BOOK",
      fixed_bankroll_raw: "100000000",
      per_window_budget_raw: "1000000"
    });
    expect(scenario.rows[0]?.raw_levels.length).toBeGreaterThan(0);
  });
});
