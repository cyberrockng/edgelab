import { describe, expect, it } from "vitest";
import {
  HistoricalDecisionFrameSchema,
  buildHistoricalDecisionFrame
} from "@edgelab/replay";
import type {
  HistoricalCandleEvidence,
  HistoricalFillEvidence,
  HistoricalMarketEvidence,
  HistoricalOrderEvidence
} from "@edgelab/dreamdex";

const source = {
  plane: "MAINNET_HISTORICAL",
  chainId: 5031,
  rpcUrl: "https://api.infra.mainnet.somnia.network",
  indexerUrl: "https://prd.smk.somnia.host/v1/graphql",
  sdkVersion: "0.28.1",
  evidenceClass: "CAPTURED",
  retrievedAt: "2026-08-25T11:15:00.000Z",
  writePolicy: "read-only-no-mainnet-signer"
} as const;

const market: HistoricalMarketEvidence = {
  stableMarketId: `0x${"4".repeat(64)}`,
  marketAddress: "0x0000000000000000000000000000000000000a44",
  poolAddress: "0x0000000000000000000000000000000000000b44",
  asset: "BTC",
  question: "Will BTC close up?",
  status: "Finalized",
  finalized: true,
  winningOutcome: "YES",
  intervalSeconds: 3600,
  tradingStartSeconds: 1787566400,
  expirySeconds: 1787570000,
  tradeCount: 2,
  openingPriceRaw: "100000",
  source
};

function candle(bucketStartSeconds: number, closePriceRaw: string): HistoricalCandleEvidence {
  return {
    bucketStartSeconds,
    intervalSeconds: 300,
    openPriceRaw: "100",
    highPriceRaw: "110",
    lowPriceRaw: "90",
    closePriceRaw,
    baseVolumeRaw: "25",
    quoteVolumeRaw: "2500",
    tradeCount: 2,
    source
  };
}

function order(overrides: Partial<HistoricalOrderEvidence> = {}): HistoricalOrderEvidence {
  return {
    id: "order-before",
    orderId: "101",
    marketId: market.stableMarketId,
    side: "BUY_YES",
    isBid: true,
    priceRaw: "10000",
    fullQuantityRaw: "1000000",
    filledQuantityRaw: "250000",
    remainingQuantityRaw: "750000",
    status: "Open",
    rested: true,
    expireTimestampNs: "1787570100000000000",
    placedAtBlock: "44",
    placedAtTimestampSeconds: 1787566500,
    lastUpdatedAtBlock: "55",
    lastUpdatedAtTimestampSeconds: 1787566600,
    placedTxHash: "0xplaced",
    source,
    ...overrides
  };
}

function fill(overrides: Partial<HistoricalFillEvidence> = {}): HistoricalFillEvidence {
  return {
    id: "fill-before",
    marketId: market.stableMarketId,
    poolAddress: market.poolAddress,
    fillPriceRaw: "10100",
    quantityRaw: "500000",
    quoteQuantityRaw: "5050",
    kind: "DIRECT_YES",
    makerOrderId: "101",
    makerRemainingQuantityRaw: "500000",
    makerSide: "SELL_YES",
    takerOrderId: "201",
    takerRemainingQuantityRaw: "0",
    takerSide: "BUY_YES",
    takerIsBid: true,
    timestampSeconds: 1787566520,
    blockNumber: "46",
    logIndex: "3",
    txHash: "0xfill",
    source,
    ...overrides
  };
}

describe("REPLAY-001 anti-look-ahead frame boundary", () => {
  it("excludes future candles, orders, fills, and outcome fields from the decision frame", () => {
    const first = buildHistoricalDecisionFrame({
      market,
      decisionAt: "2026-08-24T10:17:00.000Z",
      cutoffBlock: "100",
      quoteDecimals: 6,
      openingPrice: { priceRaw: "100000", availableAtBlock: "40" },
      candles: [candle(1787566200, "105"), candle(1787566800, "999999")],
      orders: [
        order(),
        order({
          id: "order-future",
          placedAtBlock: "101",
          lastUpdatedAtBlock: "101",
          placedAtTimestampSeconds: 1787567900,
          lastUpdatedAtTimestampSeconds: 1787567900,
          priceRaw: "999999"
        })
      ],
      fills: [
        fill(),
        fill({
          id: "fill-future",
          blockNumber: "101",
          timestampSeconds: 1787567900,
          fillPriceRaw: "999999"
        })
      ]
    });
    const mutatedFuture = buildHistoricalDecisionFrame({
      market: { ...market, winningOutcome: "NO", status: "Resolved" },
      decisionAt: "2026-08-24T10:17:00.000Z",
      cutoffBlock: "100",
      quoteDecimals: 6,
      openingPrice: { priceRaw: "100000", availableAtBlock: "40" },
      candles: [candle(1787566200, "105"), candle(1787566800, "1")],
      orders: [
        order(),
        order({
          id: "order-future",
          placedAtBlock: "101",
          lastUpdatedAtBlock: "101",
          placedAtTimestampSeconds: 1787567900,
          lastUpdatedAtTimestampSeconds: 1787567900,
          priceRaw: "1"
        })
      ],
      fills: [fill(), fill({ id: "fill-future", blockNumber: "101", timestampSeconds: 1787567900, fillPriceRaw: "1" })]
    });

    expect(first.frameHash).toBe(mutatedFuture.frameHash);
    expect(first.frame.candles).toHaveLength(1);
    expect(first.frame.orders).toHaveLength(1);
    expect(first.frame.fills).toHaveLength(1);
    expect(first.frame.exclusions).toEqual([
      "FILL_AFTER_CUTOFF",
      "INCOMPLETE_OR_FUTURE_CANDLE",
      "ORDER_AFTER_CUTOFF"
    ]);
    expect(JSON.stringify(first.frame)).not.toContain("winningOutcome");
    expect(JSON.stringify(first.frame)).not.toContain("999999");
  });

  it("uses a strict decision-time boundary and excludes data at the decision second", () => {
    const result = buildHistoricalDecisionFrame({
      market,
      decisionAt: "2026-08-24T10:17:00.000Z",
      cutoffBlock: "100",
      quoteDecimals: 6,
      openingPrice: { priceRaw: "100000", availableAtBlock: "101" },
      candles: [candle(1787566560, "105")],
      orders: [order({ id: "order-at-decision", placedAtTimestampSeconds: 1787566620 })],
      fills: [fill({ id: "fill-at-decision", timestampSeconds: 1787566620 })]
    });

    expect(result.frame.openingPrice).toBeNull();
    expect(result.frame.candles).toEqual([]);
    expect(result.frame.orders).toEqual([]);
    expect(result.frame.fills).toEqual([]);
    expect(result.frame.exclusions).toEqual([
      "FILL_AFTER_CUTOFF",
      "INCOMPLETE_OR_FUTURE_CANDLE",
      "OPENING_PRICE_AFTER_CUTOFF",
      "ORDER_AFTER_CUTOFF"
    ]);
  });

  it("rejects outcome fields at the runtime decision-frame boundary", () => {
    const result = buildHistoricalDecisionFrame({
      market,
      decisionAt: "2026-08-24T10:17:00.000Z",
      cutoffBlock: "100",
      quoteDecimals: 6,
      openingPrice: null,
      candles: [],
      orders: [],
      fills: []
    });

    expect(HistoricalDecisionFrameSchema.safeParse({ ...result.frame, winningOutcome: "YES" }).success).toBe(false);
    expect(HistoricalDecisionFrameSchema.safeParse({ ...result.frame, closingPriceRaw: "101" }).success).toBe(false);
    expect(HistoricalDecisionFrameSchema.safeParse({ ...result.frame, resolution: { winner: "YES" } }).success).toBe(false);
  });
});
