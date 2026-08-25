import { describe, expect, it } from "vitest";
import { MarketSnapshotSchema } from "@edgelab/domain";
import {
  createHistoricalPolicyManifest,
  createHistoricalPolicyRegistry,
  PolicyRuntimeError,
  createPolicyManifest,
  createPolicyRegistry,
  evaluateHistoricalPolicy,
  evaluatePolicy,
  historicalPolicies,
  referencePolicies,
  type PolicyAdapter
} from "@edgelab/policy-runtime";
import { buildHistoricalDecisionFrame } from "@edgelab/replay";
import type { HistoricalFillEvidence, HistoricalMarketEvidence } from "@edgelab/dreamdex";

const snapshot = MarketSnapshotSchema.parse({
  marketId: "market-policy",
  chainId: 50312,
  asset: "BTC",
  intervalSeconds: 900,
  capturedAt: "2026-08-24T14:00:00.000Z",
  source: {
    sdkVersion: "0.28.1",
    rpcUrl: "https://api.infra.testnet.somnia.network/",
    indexerUrl: "https://dev.smk.somnia.host/v1/graphql",
    evidenceClass: "MOCK"
  },
  book: {
    bids: [{ priceRaw: "1000", quantityRaw: "1000" }],
    asks: []
  }
});

const historicalSource = {
  plane: "MAINNET_HISTORICAL",
  chainId: 5031,
  rpcUrl: "https://api.infra.mainnet.somnia.network",
  indexerUrl: "https://prd.smk.somnia.host/v1/graphql",
  sdkVersion: "0.28.1",
  evidenceClass: "CAPTURED",
  retrievedAt: "2026-08-25T11:20:00.000Z",
  writePolicy: "read-only-no-mainnet-signer"
} as const;

const historicalMarket: HistoricalMarketEvidence = {
  stableMarketId: `0x${"5".repeat(64)}`,
  marketAddress: "0x0000000000000000000000000000000000000555",
  poolAddress: "0x0000000000000000000000000000000000000666",
  asset: "BTC",
  question: "Will BTC close up?",
  status: "Finalized",
  finalized: true,
  winningOutcome: "YES",
  intervalSeconds: 3600,
  tradingStartSeconds: 1787566000,
  expirySeconds: 1787570000,
  tradeCount: 1,
  openingPriceRaw: "500000",
  source: historicalSource
};

function historicalFill(overrides: Partial<HistoricalFillEvidence> = {}): HistoricalFillEvidence {
  return {
    id: "fill-policy",
    marketId: historicalMarket.stableMarketId,
    poolAddress: historicalMarket.poolAddress,
    fillPriceRaw: "510000",
    quantityRaw: "1000000",
    quoteQuantityRaw: "510000",
    kind: "DIRECT_YES",
    makerOrderId: "maker",
    makerRemainingQuantityRaw: "0",
    makerSide: "SELL_YES",
    takerOrderId: "taker",
    takerRemainingQuantityRaw: "0",
    takerSide: "BUY_YES",
    takerIsBid: true,
    timestampSeconds: 1787566500,
    blockNumber: "46",
    logIndex: "3",
    txHash: "0xfill",
    source: historicalSource,
    ...overrides
  };
}

describe("POLICY-001 immutable policy runtime", () => {
  it("creates deterministic immutable manifests for compile-time policies", () => {
    const first = createPolicyManifest(referencePolicies[0]);
    const second = createPolicyManifest(referencePolicies[0]);
    expect(first).toEqual(second);
    expect(first.sourceHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects duplicate policy versions in the registry", () => {
    expect(() => createPolicyRegistry([referencePolicies[0], referencePolicies[0]])).toThrow(
      PolicyRuntimeError
    );
  });

  it("evaluates without outcome, network, or clock access in input", () => {
    const decision = evaluatePolicy(referencePolicies[1], {
      snapshot,
      decidedAt: "2026-08-24T14:00:10.000Z",
      snapshotHash: "1".repeat(64)
    });
    expect(decision.forecastPUp).toBe(0.54);
    expect(decision.reasonCodes).toContain("CAPTURED_BOOK_ONLY");
  });

  it("rejects malformed policy outputs instead of recording partial success", () => {
    const invalidPolicy: PolicyAdapter = {
      policyId: "invalid",
      version: "1.0.0",
      label: "Invalid",
      adapterName: "invalidPolicy",
      evaluate() {
        return {
          forecastPUp: Number.NaN,
          action: "WATCH_ONLY",
          reasonCodes: ["INVALID"]
        };
      }
    };
    expect(() =>
      evaluatePolicy(invalidPolicy, {
        snapshot,
        decidedAt: "2026-08-24T14:00:10.000Z",
        snapshotHash: "2".repeat(64)
      })
    ).toThrow(PolicyRuntimeError);
  });

  it("converts thrown policy errors into reason-coded runtime failures", () => {
    const throwingPolicy: PolicyAdapter = {
      policyId: "throws",
      version: "1.0.0",
      label: "Throws",
      adapterName: "throwingPolicy",
      evaluate() {
        throw new Error("boom");
      }
    };
    expect(() =>
      evaluatePolicy(throwingPolicy, {
        snapshot,
        decidedAt: "2026-08-24T14:00:10.000Z",
        snapshotHash: "3".repeat(64)
      })
    ).toThrow("boom");
  });

  it("publishes deterministic historical policy manifests", () => {
    const manifest = createHistoricalPolicyManifest(historicalPolicies[0]);
    expect(manifest).toEqual(createHistoricalPolicyManifest(historicalPolicies[0]));
    expect(manifest).toMatchObject({
      policyId: "historical-last-trade",
      version: "1.0.0",
      label: "Last-Trade Probability"
    });
    expect(manifest.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(createHistoricalPolicyRegistry(historicalPolicies).get("historical-last-trade@1.0.0")).toEqual(
      manifest
    );
  });

  it("evaluates Last-Trade Probability only from pre-cutoff historical fills", () => {
    const frameResult = buildHistoricalDecisionFrame({
      market: historicalMarket,
      decisionAt: "2026-08-24T10:17:00.000Z",
      cutoffBlock: "100",
      quoteDecimals: 6,
      openingPrice: null,
      candles: [],
      orders: [],
      fills: [historicalFill(), historicalFill({ id: "future", blockNumber: "101", fillPriceRaw: "990000" })]
    });
    const decision = evaluateHistoricalPolicy(historicalPolicies[0], {
      frame: frameResult.frame,
      frameHash: frameResult.frameHash
    });

    expect(decision.policyId).toBe("historical-last-trade");
    expect(decision.forecastPUp).toBe(0.51);
    expect(decision.action).toBe("WATCH_ONLY");
    expect(decision.reasonCodes).toContain("PRE_CUTOFF_FILL");
    expect(decision.reasonCodes).toContain("YES_FILL_PRICE");
    expect(JSON.stringify(decision)).not.toContain("990000");
  });

  it("inverts NO-side historical fill prices into target YES probability", () => {
    const frameResult = buildHistoricalDecisionFrame({
      market: historicalMarket,
      decisionAt: "2026-08-24T10:17:00.000Z",
      cutoffBlock: "100",
      quoteDecimals: 6,
      openingPrice: null,
      candles: [],
      orders: [],
      fills: [
        historicalFill({
          fillPriceRaw: "490000",
          kind: "DIRECT_NO",
          makerSide: "SELL_NO",
          takerSide: "BUY_NO"
        })
      ]
    });
    const decision = evaluateHistoricalPolicy(historicalPolicies[0], {
      frame: frameResult.frame,
      frameHash: frameResult.frameHash
    });

    expect(decision.forecastPUp).toBe(0.51);
    expect(decision.action).toBe("WATCH_ONLY");
    expect(decision.reasonCodes).toContain("NO_FILL_PRICE_INVERTED");
  });

  it("abstains when a historical fill side cannot be mapped to YES or NO", () => {
    const frameResult = buildHistoricalDecisionFrame({
      market: historicalMarket,
      decisionAt: "2026-08-24T10:17:00.000Z",
      cutoffBlock: "100",
      quoteDecimals: 6,
      openingPrice: null,
      candles: [],
      orders: [],
      fills: [
        historicalFill({
          kind: "DIRECT",
          makerSide: "SELL",
          takerSide: "BUY"
        })
      ]
    });
    const decision = evaluateHistoricalPolicy(historicalPolicies[0], {
      frame: frameResult.frame,
      frameHash: frameResult.frameHash
    });

    expect(decision.forecastPUp).toBe(0.5);
    expect(decision.action).toBe("ABSTAIN");
    expect(decision.reasonCodes).toContain("FILL_OUTCOME_SIDE_UNSUPPORTED");
  });

  it("abstains when the historical frame has no qualifying pre-cutoff fill", () => {
    const frameResult = buildHistoricalDecisionFrame({
      market: historicalMarket,
      decisionAt: "2026-08-24T10:17:00.000Z",
      cutoffBlock: "100",
      quoteDecimals: 6,
      openingPrice: null,
      candles: [],
      orders: [],
      fills: []
    });
    const decision = evaluateHistoricalPolicy(historicalPolicies[0], {
      frame: frameResult.frame,
      frameHash: frameResult.frameHash
    });

    expect(decision.forecastPUp).toBe(0.5);
    expect(decision.action).toBe("ABSTAIN");
    expect(decision.reasonCodes).toContain("NO_PRE_CUTOFF_FILL");
  });
});
