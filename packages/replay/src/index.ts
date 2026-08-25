import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  HistoricalCandleEvidence,
  HistoricalFillEvidence,
  HistoricalMarketEvidence,
  HistoricalOrderEvidence
} from "@edgelab/dreamdex";

export const REPLAY_FRAME_SCHEMA_VERSION = "historical-decision-frame-v1" as const;

export const HistoricalFrameClockSchema = z
  .object({
    decisionAt: z.iso.datetime(),
    decisionAtSeconds: z.number().int().nonnegative(),
    cutoffBlock: z.string().regex(/^[0-9]+$/),
    cutoffRule: z.literal("STRICTLY_BEFORE_DECISION_AT")
  })
  .strict();

export const HistoricalFrameMarketSchema = z
  .object({
    stableMarketId: z.string().regex(/^0x[a-f0-9]{64}$/),
    asset: z.enum(["BTC", "ETH"]),
    intervalSeconds: z.number().int().positive(),
    tradingStartSeconds: z.number().int().nonnegative(),
    expirySeconds: z.number().int().nonnegative(),
    question: z.string()
  })
  .strict();

export const HistoricalFrameCandleSchema = z
  .object({
    bucketStartSeconds: z.number().int().nonnegative(),
    intervalSeconds: z.number().int().positive(),
    openPriceRaw: z.string(),
    highPriceRaw: z.string(),
    lowPriceRaw: z.string(),
    closePriceRaw: z.string(),
    baseVolumeRaw: z.string(),
    quoteVolumeRaw: z.string(),
    tradeCount: z.number().int().nonnegative()
  })
  .strict();

export const HistoricalFrameOrderSchema = z
  .object({
    id: z.string(),
    orderId: z.string(),
    side: z.string(),
    isBid: z.boolean().nullable(),
    priceRaw: z.string(),
    fullQuantityRaw: z.string(),
    filledQuantityRaw: z.string(),
    remainingQuantityRaw: z.string(),
    status: z.string(),
    rested: z.boolean(),
    placedAtBlock: z.string().regex(/^[0-9]+$/),
    placedAtTimestampSeconds: z.number().int().nonnegative(),
    lastUpdatedAtBlock: z.string().regex(/^[0-9]+$/),
    lastUpdatedAtTimestampSeconds: z.number().int().nonnegative()
  })
  .strict();

export const HistoricalFrameFillSchema = z
  .object({
    id: z.string(),
    fillPriceRaw: z.string(),
    quantityRaw: z.string(),
    quoteQuantityRaw: z.string(),
    kind: z.string().nullable(),
    makerOrderId: z.string().nullable(),
    makerRemainingQuantityRaw: z.string().nullable(),
    makerSide: z.string().nullable(),
    takerOrderId: z.string().nullable(),
    takerRemainingQuantityRaw: z.string().nullable(),
    takerSide: z.string().nullable(),
    takerIsBid: z.boolean().nullable(),
    blockNumber: z.string().regex(/^[0-9]+$/),
    logIndex: z.string().regex(/^[0-9]+$/),
    timestampSeconds: z.number().int().nonnegative()
  })
  .strict();

export const HistoricalOpeningPriceSchema = z
  .object({
    priceRaw: z.string(),
    availableAtBlock: z.string().regex(/^[0-9]+$/)
  })
  .strict();

export const HistoricalDecisionFrameSchema = z
  .object({
    schemaVersion: z.literal(REPLAY_FRAME_SCHEMA_VERSION),
    market: HistoricalFrameMarketSchema,
    clock: HistoricalFrameClockSchema,
    openingPrice: HistoricalOpeningPriceSchema.nullable(),
    candles: z.array(HistoricalFrameCandleSchema),
    orders: z.array(HistoricalFrameOrderSchema),
    fills: z.array(HistoricalFrameFillSchema),
    exclusions: z.array(z.string())
  })
  .strict();

export const HistoricalOutcomeSchema = z
  .object({
    marketId: z.string().regex(/^0x[a-f0-9]{64}$/),
    loadedAfterDecisionFrameHash: z.string().regex(/^[a-f0-9]{64}$/),
    winningOutcome: z.string().nullable(),
    closingPriceRaw: z.string().nullable(),
    resolutionLoadedAt: z.iso.datetime(),
    source: z.literal("OUTCOME_PHASE_ONLY")
  })
  .strict();

export type HistoricalDecisionFrame = z.infer<typeof HistoricalDecisionFrameSchema>;
export type HistoricalOutcome = z.infer<typeof HistoricalOutcomeSchema>;

export interface HistoricalDecisionFrameInput {
  readonly market: HistoricalMarketEvidence;
  readonly decisionAt: string;
  readonly cutoffBlock: string;
  readonly candles: readonly HistoricalCandleEvidence[];
  readonly orders: readonly HistoricalOrderEvidence[];
  readonly fills: readonly HistoricalFillEvidence[];
  readonly openingPrice?: {
    readonly priceRaw: string;
    readonly availableAtBlock: string;
  } | null;
}

export interface HistoricalDecisionFrameBuildResult {
  readonly frame: HistoricalDecisionFrame;
  readonly frameHash: string;
}

function canonicalJson(input: unknown): string {
  if (Array.isArray(input)) {
    return `[${input.map(canonicalJson).join(",")}]`;
  }
  if (input !== null && typeof input === "object") {
    return `{${Object.entries(input as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${JSON.stringify(key)}:${canonicalJson(value)}`)
      .join(",")}}`;
  }
  return JSON.stringify(input);
}

function hashCanonical(input: unknown): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

function parseBlock(value: string): bigint {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`Invalid historical block number ${value}`);
  }
  return BigInt(value);
}

function decisionSeconds(decisionAt: string): number {
  const millis = Date.parse(decisionAt);
  if (!Number.isFinite(millis)) {
    throw new Error("Decision timestamp is invalid");
  }
  return Math.floor(millis / 1000);
}

function isAtOrBeforeCutoff(blockNumber: string, cutoffBlock: bigint): boolean {
  return parseBlock(blockNumber) <= cutoffBlock;
}

export function hashHistoricalDecisionFrame(frame: HistoricalDecisionFrame): string {
  return hashCanonical(HistoricalDecisionFrameSchema.parse(frame));
}

export function buildHistoricalDecisionFrame(
  input: HistoricalDecisionFrameInput
): HistoricalDecisionFrameBuildResult {
  const cutoffBlock = parseBlock(input.cutoffBlock);
  const decisionAtSeconds = decisionSeconds(input.decisionAt);
  const exclusions = new Set<string>();
  const openingPrice =
    input.openingPrice !== undefined &&
    input.openingPrice !== null &&
    isAtOrBeforeCutoff(input.openingPrice.availableAtBlock, cutoffBlock)
      ? input.openingPrice
      : null;
  if (input.openingPrice !== undefined && input.openingPrice !== null && openingPrice === null) {
    exclusions.add("OPENING_PRICE_AFTER_CUTOFF");
  }
  const candles = input.candles
    .filter((candle) => {
      const complete = candle.bucketStartSeconds + candle.intervalSeconds <= decisionAtSeconds;
      if (!complete) {
        exclusions.add("INCOMPLETE_OR_FUTURE_CANDLE");
      }
      return complete;
    })
    .map((candle) => ({
      bucketStartSeconds: candle.bucketStartSeconds,
      intervalSeconds: candle.intervalSeconds,
      openPriceRaw: candle.openPriceRaw,
      highPriceRaw: candle.highPriceRaw,
      lowPriceRaw: candle.lowPriceRaw,
      closePriceRaw: candle.closePriceRaw,
      baseVolumeRaw: candle.baseVolumeRaw,
      quoteVolumeRaw: candle.quoteVolumeRaw,
      tradeCount: candle.tradeCount
    }))
    .sort((left, right) => left.bucketStartSeconds - right.bucketStartSeconds || left.intervalSeconds - right.intervalSeconds);
  const orders = input.orders
    .filter((order) => {
      const included =
        isAtOrBeforeCutoff(order.placedAtBlock, cutoffBlock) &&
        isAtOrBeforeCutoff(order.lastUpdatedAtBlock, cutoffBlock) &&
        order.placedAtTimestampSeconds < decisionAtSeconds &&
        order.lastUpdatedAtTimestampSeconds < decisionAtSeconds;
      if (!included) {
        exclusions.add("ORDER_AFTER_CUTOFF");
      }
      return included;
    })
    .map((order) => ({
      id: order.id,
      orderId: order.orderId,
      side: order.side,
      isBid: order.isBid,
      priceRaw: order.priceRaw,
      fullQuantityRaw: order.fullQuantityRaw,
      filledQuantityRaw: order.filledQuantityRaw,
      remainingQuantityRaw: order.remainingQuantityRaw,
      status: order.status,
      rested: order.rested,
      placedAtBlock: order.placedAtBlock,
      placedAtTimestampSeconds: order.placedAtTimestampSeconds,
      lastUpdatedAtBlock: order.lastUpdatedAtBlock,
      lastUpdatedAtTimestampSeconds: order.lastUpdatedAtTimestampSeconds
    }))
    .sort((left, right) => {
      const blockDelta = Number(parseBlock(left.placedAtBlock) - parseBlock(right.placedAtBlock));
      return blockDelta === 0 ? left.id.localeCompare(right.id) : blockDelta;
    });
  const fills = input.fills
    .filter((fill) => {
      const included = isAtOrBeforeCutoff(fill.blockNumber, cutoffBlock) && fill.timestampSeconds < decisionAtSeconds;
      if (!included) {
        exclusions.add("FILL_AFTER_CUTOFF");
      }
      return included;
    })
    .map((fill) => ({
      id: fill.id,
      fillPriceRaw: fill.fillPriceRaw,
      quantityRaw: fill.quantityRaw,
      quoteQuantityRaw: fill.quoteQuantityRaw,
      kind: fill.kind,
      makerOrderId: fill.makerOrderId,
      makerRemainingQuantityRaw: fill.makerRemainingQuantityRaw,
      makerSide: fill.makerSide,
      takerOrderId: fill.takerOrderId,
      takerRemainingQuantityRaw: fill.takerRemainingQuantityRaw,
      takerSide: fill.takerSide,
      takerIsBid: fill.takerIsBid,
      blockNumber: fill.blockNumber,
      logIndex: fill.logIndex,
      timestampSeconds: fill.timestampSeconds
    }))
    .sort((left, right) => {
      const blockDelta = Number(parseBlock(left.blockNumber) - parseBlock(right.blockNumber));
      const logDelta = Number(parseBlock(left.logIndex) - parseBlock(right.logIndex));
      return blockDelta === 0 ? (logDelta === 0 ? left.id.localeCompare(right.id) : logDelta) : blockDelta;
    });
  const frame = HistoricalDecisionFrameSchema.parse({
    schemaVersion: REPLAY_FRAME_SCHEMA_VERSION,
    market: {
      stableMarketId: input.market.stableMarketId,
      asset: input.market.asset,
      intervalSeconds: input.market.intervalSeconds,
      tradingStartSeconds: input.market.tradingStartSeconds,
      expirySeconds: input.market.expirySeconds,
      question: input.market.question
    },
    clock: {
      decisionAt: input.decisionAt,
      decisionAtSeconds,
      cutoffBlock: input.cutoffBlock,
      cutoffRule: "STRICTLY_BEFORE_DECISION_AT"
    },
    openingPrice,
    candles,
    orders,
    fills,
    exclusions: [...exclusions].sort()
  });
  return {
    frame,
    frameHash: hashHistoricalDecisionFrame(frame)
  };
}
