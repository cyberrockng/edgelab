import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@edgelab/db";
import { observeExperiment, registerPolicyVersion } from "@edgelab/observe";
import { reconcileSettlements } from "@edgelab/settle";
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

const beforeExpiry = new Date("2026-08-24T15:45:00.000Z");
const afterExpiry = new Date("2026-08-24T16:01:00.000Z");
const owner = "0x0000000000000000000000000000000000000dad";

function binaryMarket(overrides: Partial<BinaryMarket> = {}): BinaryMarket {
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
    marketId: `0x${"5".repeat(64)}`,
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
    expiry: "1787587200",
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
    venueId: "0x4d41494e",
    ...overrides
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

async function seedObservedEpisode(row: BinaryMarket): Promise<void> {
  await pool.query("INSERT INTO wallet_identities(address) VALUES ($1)", [owner]);
  const policyA = await registerPolicyVersion(pool, referencePolicies[0]);
  const policyB = await registerPolicyVersion(pool, referencePolicies[1]);
  const risk = await pool.query<{ id: string }>(
    `
      INSERT INTO risk_envelopes(version, max_order_raw, max_aggregate_raw, allowed_actions, allowed_intervals, envelope_hash)
      VALUES ($1, 0, 0, ARRAY['WATCH_ONLY'], ARRAY[900], $2)
      RETURNING id
    `,
    [randomUUID(), "6".repeat(64)]
  );
  const experiment = await pool.query<{ id: string }>(
    `
      INSERT INTO experiments(owner_address, policy_a_id, policy_b_id, risk_envelope_id, rule_version, decision_offset_sec)
      VALUES ($1, $2, $3, $4, 'settle-rules-1', 0)
      RETURNING id
    `,
    [owner, policyA, policyB, risk.rows[0]?.id]
  );
  await observeExperiment({
    pool,
    dreamDexClient: clientWith(row),
    dreamDexConfig: config,
    experimentId: experiment.rows[0]?.id ?? "",
    policyAdapters: referencePolicies,
    holderId: randomUUID(),
    leaseTtlMs: 1,
    clock: { now: () => beforeExpiry },
    intervals: [900]
  });
}

async function settlementCounts(): Promise<{ settlements: number; resolved: number; voided: number }> {
  const result = await pool.query<{ settlements: string; resolved: string; voided: string }>(
    `
      SELECT
        (SELECT count(*) FROM settlements) AS settlements,
        (SELECT count(*) FROM market_episodes WHERE state = 'RESOLVED') AS resolved,
        (SELECT count(*) FROM market_episodes WHERE state = 'VOIDED') AS voided
    `
  );
  const row = result.rows[0];
  return {
    settlements: Number(row?.settlements ?? 0),
    resolved: Number(row?.resolved ?? 0),
    voided: Number(row?.voided ?? 0)
  };
}

describe("SETTLE-001 settlement reconciliation", () => {
  beforeAll(async () => {
    await resetPublicSchema();
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("records resolved outcomes idempotently without touching execution or PnL", async () => {
    const observed = binaryMarket();
    await seedObservedEpisode(observed);
    const resolved = binaryMarket({
      status: "Finalized",
      finalized: true,
      winningOutcome: 0,
      payoutNumerators: ["10000000", "0"],
      payoutDenominator: "10000000",
      resolvedAtBlock: "123",
      resolvedAtTimestamp: "1787587201"
    });

    const first = await reconcileSettlements({
      pool,
      dreamDexClient: clientWith(resolved),
      holderId: "settle-a",
      leaseTtlMs: 1,
      clock: { now: () => afterExpiry }
    });
    const second = await reconcileSettlements({
      pool,
      dreamDexClient: clientWith(resolved),
      holderId: "settle-a",
      leaseTtlMs: 1,
      clock: { now: () => afterExpiry }
    });

    expect(first.reconciled[0]).toMatchObject({
      outcome: "RESOLVED_YES",
      terminal: true,
      insertedSettlement: true,
      reusedSettlement: false
    });
    expect(second.reconciled[0]).toMatchObject({
      outcome: "RESOLVED_YES",
      terminal: true,
      insertedSettlement: false,
      reusedSettlement: true
    });
    await expect(settlementCounts()).resolves.toEqual({ settlements: 1, resolved: 1, voided: 0 });
  });

  it("records voided markets as terminal but winnerless", async () => {
    await resetPublicSchema();
    await runMigrations(pool);
    await seedObservedEpisode(binaryMarket());
    const voided = binaryMarket({
      status: "Voided",
      finalized: true,
      voided: true,
      payoutNumerators: ["5000000", "5000000"],
      payoutDenominator: "10000000",
      resolvedAtBlock: "124",
      resolvedAtTimestamp: "1787587201"
    });

    const result = await reconcileSettlements({
      pool,
      dreamDexClient: clientWith(voided),
      holderId: randomUUID(),
      leaseTtlMs: 1,
      clock: { now: () => afterExpiry }
    });

    expect(result.reconciled[0]).toMatchObject({
      outcome: "VOIDED",
      terminal: true,
      insertedSettlement: true
    });
    await expect(settlementCounts()).resolves.toEqual({ settlements: 1, resolved: 0, voided: 1 });
  });

  it("keeps post-expiry unresolved markets pending without fabricating outcomes", async () => {
    await resetPublicSchema();
    await runMigrations(pool);
    await seedObservedEpisode(binaryMarket());
    const pending = binaryMarket({
      status: "Settling",
      finalized: false,
      winningOutcome: null,
      voided: false
    });

    const result = await reconcileSettlements({
      pool,
      dreamDexClient: clientWith(pending),
      holderId: randomUUID(),
      leaseTtlMs: 1,
      clock: { now: () => afterExpiry }
    });

    expect(result.reconciled[0]).toMatchObject({
      outcome: "PENDING",
      terminal: false,
      insertedSettlement: false
    });
    await expect(settlementCounts()).resolves.toEqual({ settlements: 0, resolved: 0, voided: 0 });
  });
});
