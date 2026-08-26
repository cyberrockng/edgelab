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

function historicalPolicy(version: string) {
  const policy = historicalPolicies.find((adapter) => adapter.version === version);
  if (policy === undefined) {
    throw new Error(`Missing historical policy ${version}`);
  }
  return policy;
}

describe("POLICY-001 immutable policy runtime", () => {
  it("creates deterministic immutable manifests for compile-time policies", () => {
    const first = createPolicyManifest(referencePolicies[0]);
    const second = createPolicyManifest(referencePolicies[0]);
    expect(first).toEqual(second);
    expect(first.sourceHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes policy identity when executable behavior changes under the same metadata", () => {
    const original = referencePolicies[0];
    const changed: PolicyAdapter = {
      ...original,
      evaluate() {
        return {
          forecastPUp: 0.51,
          action: "WATCH_ONLY",
          reasonCodes: ["REFERENCE_POLICY", "NEUTRAL_BASELINE"]
        };
      }
    };
    expect(createPolicyManifest(changed).sourceHash).not.toBe(createPolicyManifest(original).sourceHash);
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
    const v1Manifest = createHistoricalPolicyManifest(historicalPolicy("1.0.0"));
    const v11Manifest = createHistoricalPolicyManifest(historicalPolicy("1.1.0"));
    expect(v1Manifest).toEqual(createHistoricalPolicyManifest(historicalPolicy("1.0.0")));
    expect(v1Manifest).toMatchObject({
      policyId: "historical-last-trade",
      version: "1.0.0",
      label: "Last-Trade Probability"
    });
    expect(v11Manifest).toMatchObject({
      policyId: "historical-last-trade",
      version: "1.1.0",
      label: "Last-Trade Probability"
    });
    expect(v1Manifest.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(v11Manifest.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(v11Manifest.sourceHash).not.toBe(v1Manifest.sourceHash);
    const registry = createHistoricalPolicyRegistry(historicalPolicies);
    expect(registry.get("historical-last-trade@1.0.0")).toEqual(v1Manifest);
    expect(registry.get("historical-last-trade@1.1.0")).toEqual(v11Manifest);
  });

  it("changes corrected historical policy identity when behavior-defining helper semantics change", () => {
    const original = historicalPolicy("1.1.0");
    const changed = {
      ...original,
      identitySource: `${original.identitySource ?? ""}\nhelper mutation: compareHistoricalFills reverses log order`
    };
    expect(createHistoricalPolicyManifest(changed).sourceHash).not.toBe(
      createHistoricalPolicyManifest(original).sourceHash
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
    const decision = evaluateHistoricalPolicy(historicalPolicy("1.0.0"), {
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
    const decision = evaluateHistoricalPolicy(historicalPolicy("1.0.0"), {
      frame: frameResult.frame,
      frameHash: frameResult.frameHash
    });

    expect(decision.forecastPUp).toBe(0.51);
    expect(decision.action).toBe("WATCH_ONLY");
    expect(decision.reasonCodes).toContain("NO_FILL_PRICE_INVERTED");
  });

  it("uses DreamDEX canonical YES probability for a NO-tagged mint-pair fill in v1.1.0", () => {
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
          fillPriceRaw: "700000",
          kind: "MINT_A_PAIR",
          makerSide: "BUY_YES",
          takerSide: "BUY_NO"
        })
      ]
    });
    const decision = evaluateHistoricalPolicy(historicalPolicy("1.1.0"), {
      frame: frameResult.frame,
      frameHash: frameResult.frameHash
    });

    expect(decision.forecastPUp).toBe(0.7);
    expect(decision.action).toBe("WATCH_ONLY");
    expect(decision.reasonCodes).toContain("DREAMDEX_YES_TERM_PRICE");
    expect(decision.reasonCodes).toContain("NO_TAG_NOT_INVERTED");
    expect(decision.reasonCodes).toContain("MINT_PAIR_ELIGIBLE");
  });

  it("uses DreamDEX canonical YES probability for direct YES and direct NO fills in v1.1.0", () => {
    for (const fill of [
      historicalFill({ fillPriceRaw: "700000", kind: "DIRECT_YES", makerSide: "BUY_YES", takerSide: "SELL_YES" }),
      historicalFill({ fillPriceRaw: "700000", kind: "DIRECT_NO", makerSide: "BUY_NO", takerSide: "SELL_NO" })
    ]) {
      const frameResult = buildHistoricalDecisionFrame({
        market: historicalMarket,
        decisionAt: "2026-08-24T10:17:00.000Z",
        cutoffBlock: "100",
        quoteDecimals: 6,
        openingPrice: null,
        candles: [],
        orders: [],
        fills: [fill]
      });
      const decision = evaluateHistoricalPolicy(historicalPolicy("1.1.0"), {
        frame: frameResult.frame,
        frameHash: frameResult.frameHash
      });

      expect(decision.forecastPUp).toBe(0.7);
      expect(decision.action).toBe("WATCH_ONLY");
      expect(decision.reasonCodes).toContain("DREAMDEX_YES_TERM_PRICE");
      expect(decision.reasonCodes).toContain("NO_TAG_NOT_INVERTED");
    }
  });

  it("accepts BURN_A_PAIR fills when source and cutoff data are complete in v1.1.0", () => {
    const frameResult = buildHistoricalDecisionFrame({
      market: historicalMarket,
      decisionAt: "2026-08-24T10:17:00.000Z",
      cutoffBlock: "100",
      quoteDecimals: 6,
      openingPrice: null,
      candles: [],
      orders: [],
      fills: [historicalFill({ fillPriceRaw: "640000", kind: "BURN_A_PAIR", makerSide: "SELL_YES", takerSide: "SELL_NO" })]
    });
    const decision = evaluateHistoricalPolicy(historicalPolicy("1.1.0"), {
      frame: frameResult.frame,
      frameHash: frameResult.frameHash
    });

    expect(decision.forecastPUp).toBe(0.64);
    expect(decision.action).toBe("WATCH_ONLY");
    expect(decision.reasonCodes).toContain("DREAMDEX_YES_TERM_PRICE");
  });

  it("selects the deterministic latest qualifying pre-cutoff fill in v1.1.0", () => {
    const frameResult = buildHistoricalDecisionFrame({
      market: historicalMarket,
      decisionAt: "2026-08-24T10:17:00.000Z",
      cutoffBlock: "100",
      quoteDecimals: 6,
      openingPrice: null,
      candles: [],
      orders: [],
      fills: [
        historicalFill({ id: "unsupported-late", timestampSeconds: 1787566510, kind: "UNKNOWN", fillPriceRaw: "900000" }),
        historicalFill({ id: "eligible-earlier", timestampSeconds: 1787566500, kind: "DIRECT_NO", fillPriceRaw: "610000" })
      ]
    });
    const decision = evaluateHistoricalPolicy(historicalPolicy("1.1.0"), {
      frame: frameResult.frame,
      frameHash: frameResult.frameHash
    });

    expect(decision.forecastPUp).toBe(0.61);
    expect(decision.action).toBe("WATCH_ONLY");
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
    const decision = evaluateHistoricalPolicy(historicalPolicy("1.0.0"), {
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
    const decision = evaluateHistoricalPolicy(historicalPolicy("1.0.0"), {
      frame: frameResult.frame,
      frameHash: frameResult.frameHash
    });

    expect(decision.forecastPUp).toBe(0.5);
    expect(decision.action).toBe("ABSTAIN");
    expect(decision.reasonCodes).toContain("NO_PRE_CUTOFF_FILL");
  });

  it("orders same-block fills by transaction index before log index", () => {
    const frameResult = buildHistoricalDecisionFrame({
      market: historicalMarket,
      decisionAt: "2026-08-24T10:17:00.000Z",
      cutoffBlock: "100",
      quoteDecimals: 6,
      openingPrice: null,
      candles: [],
      orders: [],
      fills: [
        historicalFill({ id: "earlier-tx", transactionIndex: "3", logIndex: "99", fillPriceRaw: "510000" }),
        historicalFill({ id: "later-tx", transactionIndex: "4", logIndex: "1", fillPriceRaw: "620000" })
      ]
    });
    const decision = evaluateHistoricalPolicy(historicalPolicy("1.0.0"), {
      frame: frameResult.frame,
      frameHash: frameResult.frameHash
    });

    expect(decision.forecastPUp).toBe(0.62);
  });

  it("excludes post-cutoff fills and abstains when no v1.1.0 fill qualifies", () => {
    const frameResult = buildHistoricalDecisionFrame({
      market: historicalMarket,
      decisionAt: "2026-08-24T10:17:00.000Z",
      cutoffBlock: "100",
      quoteDecimals: 6,
      openingPrice: null,
      candles: [],
      orders: [],
      fills: [historicalFill({ id: "future", blockNumber: "101", fillPriceRaw: "880000" })]
    });
    const decision = evaluateHistoricalPolicy(historicalPolicy("1.1.0"), {
      frame: frameResult.frame,
      frameHash: frameResult.frameHash
    });

    expect(frameResult.frame.exclusions).toContain("FILL_AFTER_CUTOFF");
    expect(decision.forecastPUp).toBe(0.5);
    expect(decision.action).toBe("ABSTAIN");
    expect(decision.reasonCodes).toContain("NO_PRE_CUTOFF_FILL");
  });

  it("orders same-block v1.1.0 fills by transaction index and log index", () => {
    const frameResult = buildHistoricalDecisionFrame({
      market: historicalMarket,
      decisionAt: "2026-08-24T10:17:00.000Z",
      cutoffBlock: "100",
      quoteDecimals: 6,
      openingPrice: null,
      candles: [],
      orders: [],
      fills: [
        historicalFill({ id: "earlier-log", transactionIndex: "4", logIndex: "1", fillPriceRaw: "510000" }),
        historicalFill({ id: "later-log", transactionIndex: "4", logIndex: "2", fillPriceRaw: "630000" })
      ]
    });
    const decision = evaluateHistoricalPolicy(historicalPolicy("1.1.0"), {
      frame: frameResult.frame,
      frameHash: frameResult.frameHash
    });

    expect(decision.forecastPUp).toBe(0.63);
  });
});
