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
  process.env.TEST_DATABASE_URL ?? "postgres://edgelab:edgelab@localhost:55432/edgelab";

const pool = createPool({ connectionString, max: 4, statementTimeoutMs: 5000 });

const config: DreamDexReadConfig = {
  rpcUrl: "https://api.infra.testnet.somnia.network/",
  wsRpcUrl: "wss://api.infra.testnet.somnia.network/ws",
  indexerUrl: "https://dev.smk.somnia.host/v1/graphql",
  chainId: 50312,
  sdkVersion: "0.28.1"
};

const fixedNow = new Date("2026-08-24T15:30:00.000Z");
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
      VALUES ($1, $2, $3, $4, 'observe-rules-1', 0)
      RETURNING id
    `,
    [owner, policyA, policyB, risk.rows[0]?.id]
  );
  return experiment.rows[0]?.id ?? "";
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

async function observe(experimentId: string, row: BinaryMarket, holderId: string): Promise<ObserveExperimentResult> {
  return observeExperiment({
    pool,
    dreamDexClient: clientWith(row),
    dreamDexConfig: config,
    experimentId,
    policyAdapters: referencePolicies,
    holderId,
    leaseTtlMs: 1,
    clock: { now: () => fixedNow },
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
});
