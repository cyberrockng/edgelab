import { createHash } from "node:crypto";
import { PolicyDecisionSchema, type MarketSnapshot, type PolicyDecision } from "@edgelab/domain";
import {
  HistoricalDecisionFrameSchema,
  type HistoricalDecisionFrame
} from "@edgelab/replay";

export interface PolicyManifest {
  readonly policyId: string;
  readonly version: string;
  readonly label: string;
  readonly sourceHash: string;
  readonly adapterName: string;
  readonly implementationHash: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly supportedPlanes: readonly ("MAINNET_HISTORICAL" | "SHANNON_FORWARD")[];
}

export interface PolicyEvaluationInput {
  readonly snapshot: MarketSnapshot;
  readonly decidedAt: string;
  readonly snapshotHash: string;
}

export interface HistoricalPolicyEvaluationInput {
  readonly frame: HistoricalDecisionFrame;
  readonly frameHash: string;
}

export interface PolicyAdapter {
  readonly policyId: string;
  readonly version: string;
  readonly label: string;
  readonly adapterName: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly supportedPlanes?: readonly ("MAINNET_HISTORICAL" | "SHANNON_FORWARD")[];
  readonly identitySource?: string;
  evaluate(input: PolicyEvaluationInput): Omit<
    PolicyDecision,
    "policyId" | "policyVersion" | "decidedAt" | "snapshotHash" | "policyHash"
  >;
}

export interface HistoricalPolicyAdapter {
  readonly policyId: string;
  readonly version: string;
  readonly label: string;
  readonly adapterName: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly supportedPlanes?: readonly ("MAINNET_HISTORICAL" | "SHANNON_FORWARD")[];
  readonly identitySource?: string;
  evaluate(input: HistoricalPolicyEvaluationInput): Omit<
    PolicyDecision,
    "policyId" | "policyVersion" | "decidedAt" | "snapshotHash" | "policyHash"
  >;
}

export class PolicyRuntimeError extends Error {
  constructor(
    message: string,
    readonly reasonCode: string
  ) {
    super(message);
    this.name = "PolicyRuntimeError";
  }
}

function canonicalize(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map(canonicalize);
  }
  if (input !== null && typeof input === "object") {
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, canonicalize(value)])
    );
  }
  return input;
}

function canonicalJson(input: unknown): string {
  return JSON.stringify(canonicalize(input));
}

interface PolicyIdentityInput {
  readonly policyId: string;
  readonly version: string;
  readonly label: string;
  readonly adapterName: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly supportedPlanes?: readonly ("MAINNET_HISTORICAL" | "SHANNON_FORWARD")[];
  readonly identitySource?: string;
  readonly evaluate: { toString(): string };
}

function canonicalMarketSnapshot(book: MarketSnapshot["book"]): MarketSnapshot {
  return {
    marketId: "0xbehavior-fingerprint",
    chainId: 50312,
    asset: "BTC",
    intervalSeconds: 900,
    capturedAt: "2026-08-27T00:00:00.000Z",
    source: {
      sdkVersion: "0.28.1",
      rpcUrl: "https://api.infra.testnet.somnia.network",
      indexerUrl: "https://dev.smk.somnia.host/v1/graphql",
      evidenceClass: "CAPTURED"
    },
    book
  };
}

function canonicalHistoricalFrame(fills: HistoricalDecisionFrame["fills"]): HistoricalDecisionFrame {
  return {
    schemaVersion: "historical-decision-frame-v1",
    market: {
      stableMarketId: ["0x", "0".repeat(60), "00aa"].join(""),
      asset: "BTC",
      intervalSeconds: 900,
      quoteDecimals: 18,
      tradingStartSeconds: 1_787_858_100,
      expirySeconds: 1_787_859_000,
      question: "BTC closes at or above its opening price"
    },
    clock: {
      decisionAt: "2026-08-27T19:29:00.000Z",
      decisionAtSeconds: 1_787_858_940,
      cutoffBlock: "397067729",
      cutoffRule: "STRICTLY_BEFORE_DECISION_AT"
    },
    openingPrice: {
      priceRaw: "8016762",
      availableAtBlock: "397000000"
    },
    candles: [],
    orders: [],
    fills,
    exclusions: []
  };
}

function canonicalHistoricalFill(input: {
  readonly id: string;
  readonly fillPriceRaw: string;
  readonly kind: string | null;
  readonly makerSide: string | null;
  readonly takerSide: string | null;
  readonly timestampSeconds: number;
  readonly blockNumber: string;
  readonly logIndex: string;
}): HistoricalDecisionFrame["fills"][number] {
  return {
    id: input.id,
    fillPriceRaw: input.fillPriceRaw,
    quantityRaw: "1000000000000000000",
    quoteQuantityRaw: input.fillPriceRaw,
    kind: input.kind,
    makerOrderId: "1",
    makerRemainingQuantityRaw: "0",
    makerSide: input.makerSide,
    takerOrderId: "2",
    takerRemainingQuantityRaw: "0",
    takerSide: input.takerSide,
    takerIsBid: false,
    blockNumber: input.blockNumber,
    transactionIndex: null,
    logIndex: input.logIndex,
    timestampSeconds: input.timestampSeconds
  };
}

function behaviorFingerprint(adapter: PolicyIdentityInput): unknown {
  const supportedPlanes = adapter.supportedPlanes ?? [];
  if (supportedPlanes.includes("MAINNET_HISTORICAL")) {
    const evaluate = adapter.evaluate as HistoricalPolicyAdapter["evaluate"];
    const cases = [
      {
        name: "no-fill-abstain",
        frame: canonicalHistoricalFrame([])
      },
      {
        name: "yes-fill",
        frame: canonicalHistoricalFrame([
          canonicalHistoricalFill({
            id: "yes-fill",
            fillPriceRaw: "700000000000000000",
            kind: "DIRECT_YES",
            makerSide: "BUY_YES",
            takerSide: "SELL_YES",
            timestampSeconds: 1_787_858_800,
            blockNumber: "397066310",
            logIndex: "1"
          })
        ])
      },
      {
        name: "no-tag-canonical-price",
        frame: canonicalHistoricalFrame([
          canonicalHistoricalFill({
            id: "no-tag",
            fillPriceRaw: "700000000000000000",
            kind: "DIRECT_NO",
            makerSide: "BUY_NO",
            takerSide: "SELL_NO",
            timestampSeconds: 1_787_858_801,
            blockNumber: "397066311",
            logIndex: "2"
          })
        ])
      },
      {
        name: "mint-pair",
        frame: canonicalHistoricalFrame([
          canonicalHistoricalFill({
            id: "mint-pair",
            fillPriceRaw: "232000000000000000",
            kind: "MINT_A_PAIR",
            makerSide: "BUY_YES",
            takerSide: "BUY_NO",
            timestampSeconds: 1_787_858_798,
            blockNumber: "397066316",
            logIndex: "6"
          })
        ])
      }
    ];
    return cases.map((testCase) => ({
      name: testCase.name,
      output: evaluate({ frame: testCase.frame, frameHash: `behavior-${testCase.name}` })
    }));
  }
  const evaluate = adapter.evaluate as PolicyAdapter["evaluate"];
  return [
    {
      name: "empty-book",
      output: evaluate({
        snapshot: canonicalMarketSnapshot({ bids: [], asks: [] }),
        decidedAt: "2026-08-27T00:00:00.000Z",
        snapshotHash: "behavior-empty-book"
      })
    },
    {
      name: "bid-heavy-book",
      output: evaluate({
        snapshot: canonicalMarketSnapshot({
          bids: [{ priceRaw: "510000", quantityRaw: "1000000" }],
          asks: []
        }),
        decidedAt: "2026-08-27T00:00:00.000Z",
        snapshotHash: "behavior-bid-heavy-book"
      })
    }
  ];
}

function implementationHash(adapter: PolicyIdentityInput): string {
  const source = canonicalJson({
    declaredIdentity: adapter.identitySource ?? null,
    executableBehavior: behaviorFingerprint(adapter)
  });
  return createHash("sha256").update(source).digest("hex");
}

export function hashManifest(
  adapter: PolicyIdentityInput
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        adapterName: adapter.adapterName,
        implementationHash: implementationHash(adapter),
        label: adapter.label,
        parameters: adapter.parameters ?? {},
        policyId: adapter.policyId,
        supportedPlanes: adapter.supportedPlanes ?? [],
        version: adapter.version
      })
    )
    .digest("hex");
}

export function createPolicyManifest(adapter: PolicyAdapter): PolicyManifest {
  return {
    policyId: adapter.policyId,
    version: adapter.version,
    label: adapter.label,
    adapterName: adapter.adapterName,
    sourceHash: hashManifest(adapter),
    implementationHash: implementationHash(adapter),
    parameters: adapter.parameters ?? {},
    supportedPlanes: adapter.supportedPlanes ?? []
  };
}

export function createHistoricalPolicyManifest(adapter: HistoricalPolicyAdapter): PolicyManifest {
  return {
    policyId: adapter.policyId,
    version: adapter.version,
    label: adapter.label,
    adapterName: adapter.adapterName,
    sourceHash: hashManifest(adapter),
    implementationHash: implementationHash(adapter),
    parameters: adapter.parameters ?? {},
    supportedPlanes: adapter.supportedPlanes ?? []
  };
}

export function evaluatePolicy(adapter: PolicyAdapter, input: PolicyEvaluationInput): PolicyDecision {
  let decision: ReturnType<PolicyAdapter["evaluate"]>;
  try {
    decision = adapter.evaluate(input);
  } catch (error) {
    throw new PolicyRuntimeError(
      error instanceof Error ? error.message : "Policy evaluation failed",
      "POLICY_EXCEPTION"
    );
  }
  const parsed = PolicyDecisionSchema.safeParse({
    ...decision,
    policyId: adapter.policyId,
    policyVersion: adapter.version,
    decidedAt: input.decidedAt,
    snapshotHash: input.snapshotHash,
    policyHash: hashManifest(adapter)
  });
  if (!parsed.success) {
    throw new PolicyRuntimeError(parsed.error.message, "INVALID_POLICY_OUTPUT");
  }
  return parsed.data;
}

export function evaluateHistoricalPolicy(
  adapter: HistoricalPolicyAdapter,
  input: HistoricalPolicyEvaluationInput
): PolicyDecision {
  const frame = HistoricalDecisionFrameSchema.parse(input.frame);
  let decision: ReturnType<HistoricalPolicyAdapter["evaluate"]>;
  try {
    decision = adapter.evaluate({ frame, frameHash: input.frameHash });
  } catch (error) {
    throw new PolicyRuntimeError(
      error instanceof Error ? error.message : "Historical policy evaluation failed",
      "POLICY_EXCEPTION"
    );
  }
  const parsed = PolicyDecisionSchema.safeParse({
    ...decision,
    policyId: adapter.policyId,
    policyVersion: adapter.version,
    decidedAt: frame.clock.decisionAt,
    snapshotHash: input.frameHash,
    policyHash: hashManifest(adapter)
  });
  if (!parsed.success) {
    throw new PolicyRuntimeError(parsed.error.message, "INVALID_POLICY_OUTPUT");
  }
  return parsed.data;
}

export function createPolicyRegistry(adapters: readonly PolicyAdapter[]): Map<string, PolicyManifest> {
  const registry = new Map<string, PolicyManifest>();
  for (const adapter of adapters) {
    const key = `${adapter.policyId}@${adapter.version}`;
    if (registry.has(key)) {
      throw new PolicyRuntimeError(`Duplicate policy version ${key}`, "DUPLICATE_POLICY_VERSION");
    }
    registry.set(key, createPolicyManifest(adapter));
  }
  return registry;
}

export function createHistoricalPolicyRegistry(
  adapters: readonly HistoricalPolicyAdapter[]
): Map<string, PolicyManifest> {
  const registry = new Map<string, PolicyManifest>();
  for (const adapter of adapters) {
    const key = `${adapter.policyId}@${adapter.version}`;
    if (registry.has(key)) {
      throw new PolicyRuntimeError(`Duplicate historical policy version ${key}`, "DUPLICATE_POLICY_VERSION");
    }
    registry.set(key, createHistoricalPolicyManifest(adapter));
  }
  return registry;
}

function compareHistoricalFills(
  left: HistoricalDecisionFrame["fills"][number],
  right: HistoricalDecisionFrame["fills"][number]
): number {
  const timestampDelta = left.timestampSeconds - right.timestampSeconds;
  if (timestampDelta !== 0) {
    return timestampDelta;
  }
  const blockDelta = BigInt(left.blockNumber) - BigInt(right.blockNumber);
  if (blockDelta !== 0n) {
    return blockDelta > 0n ? 1 : -1;
  }
  if (left.transactionIndex !== null && right.transactionIndex !== null) {
    const transactionDelta = BigInt(left.transactionIndex) - BigInt(right.transactionIndex);
    if (transactionDelta !== 0n) {
      return transactionDelta > 0n ? 1 : -1;
    }
  }
  const logDelta = BigInt(left.logIndex) - BigInt(right.logIndex);
  if (logDelta !== 0n) {
    return logDelta > 0n ? 1 : -1;
  }
  return left.id.localeCompare(right.id);
}

function scaledPriceToProbability(priceRaw: string, quoteDecimals: number): number {
  if (!/^[0-9]+$/.test(priceRaw) || !Number.isInteger(quoteDecimals) || quoteDecimals < 0 || quoteDecimals > 36) {
    throw new PolicyRuntimeError("Historical fill price scale is invalid", "INVALID_PRICE");
  }
  const numerator = BigInt(priceRaw);
  const denominator = 10n ** BigInt(quoteDecimals);
  if (denominator <= 0n) {
    throw new PolicyRuntimeError("Historical fill price denominator is invalid", "INVALID_PRICE");
  }
  const precision = 1_000_000_000_000n;
  const scaled = (numerator * precision) / denominator;
  const probability = Number(scaled) / Number(precision);
  if (!Number.isFinite(probability)) {
    throw new PolicyRuntimeError("Historical fill probability is not finite", "INVALID_PRICE");
  }
  return Math.min(0.95, Math.max(0.05, probability));
}

function normalizeHistoricalFillOutcome(fill: HistoricalDecisionFrame["fills"][number]): "YES" | "NO" | null {
  const tags = [fill.kind, fill.makerSide, fill.takerSide]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toUpperCase());
  const yesTagged = tags.some((value) => value.includes("YES"));
  const noTagged = tags.some((value) => value.includes("NO"));
  if (yesTagged === noTagged) {
    return null;
  }
  return yesTagged ? "YES" : "NO";
}

const supportedDreamDexBinaryFillKinds = new Set([
  "DIRECT_YES",
  "DIRECT_NO",
  "MINT_A_PAIR",
  "BURN_A_PAIR"
]);

function isSupportedDreamDexBinaryFillKind(fill: HistoricalDecisionFrame["fills"][number]): boolean {
  return typeof fill.kind === "string" && supportedDreamDexBinaryFillKinds.has(fill.kind.toUpperCase());
}

function isPositiveRawQuantity(quantityRaw: string): boolean {
  try {
    return BigInt(quantityRaw) > 0n;
  } catch {
    return false;
  }
}

function fillHasNoTag(fill: HistoricalDecisionFrame["fills"][number]): boolean {
  return [fill.kind, fill.makerSide, fill.takerSide]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toUpperCase().includes("NO"));
}

function canonicalDreamDexYesProbability(priceRaw: string, quoteDecimals: number): number {
  if (!/^[0-9]+$/.test(priceRaw)) {
    throw new PolicyRuntimeError("Historical fill price is not an unsigned integer string", "INVALID_PRICE");
  }
  return scaledPriceToProbability(priceRaw, quoteDecimals);
}

function eligibleDreamDexBinaryFill(
  fill: HistoricalDecisionFrame["fills"][number]
): { readonly eligible: true } | { readonly eligible: false; readonly reasonCode: string } {
  if (!isSupportedDreamDexBinaryFillKind(fill)) {
    return { eligible: false, reasonCode: "FILL_KIND_UNSUPPORTED_BY_SOURCE" };
  }
  if (!isPositiveRawQuantity(fill.quantityRaw)) {
    return { eligible: false, reasonCode: "FILL_SOURCE_INCOMPLETE" };
  }
  if (!/^[0-9]+$/.test(fill.fillPriceRaw)) {
    return { eligible: false, reasonCode: "INVALID_PRICE" };
  }
  if (!/^[0-9]+$/.test(fill.blockNumber) || !/^[0-9]+$/.test(fill.logIndex) || fill.id.trim() === "") {
    return { eligible: false, reasonCode: "FILL_ORDERING_INCOMPLETE" };
  }
  return { eligible: true };
}

const historicalLastTradeV11IdentitySource = canonicalJson({
  policyId: "historical-last-trade",
  version: "1.1.0",
  dataSemantics: {
    dreamDexBinaryFillPrice: "YES_TERM_PROBABILITY",
    canonicalFormula: "forecastPUp = clamp(fillPriceRaw / 10^quoteDecimals, 0.05, 0.95)",
    noTagHandling: "NO tags are display/account context only; do not invert market-level YES/UP forecasts",
    supportedFillKinds: [...supportedDreamDexBinaryFillKinds].sort()
  },
  helpers: {
    canonicalDreamDexYesProbability: "scaled fillPriceRaw / 10^quoteDecimals, clamped to [0.05, 0.95]",
    compareHistoricalFills: "timestampSeconds, blockNumber, transactionIndex, logIndex, id",
    eligibleDreamDexBinaryFill: "supported kind, positive quantity, valid price, deterministic ordering fields",
    supportedFillKinds: [...supportedDreamDexBinaryFillKinds].sort()
  },
  parameters: {
    fillOrder: ["timestampSeconds", "blockNumber", "transactionIndex", "logIndex", "id"],
    lookbackSeconds: 900,
    probabilityClamp: [0.05, 0.95],
    targetOutcome: "YES_UP"
  }
});

export const referencePolicies: readonly PolicyAdapter[] = [
  {
    policyId: "reference-neutral",
    version: "1.0.0",
    label: "Educational neutral baseline",
    adapterName: "referenceNeutralPolicy",
    parameters: { forecastPUp: 0.5, action: "WATCH_ONLY" },
    supportedPlanes: ["MAINNET_HISTORICAL", "SHANNON_FORWARD"],
    evaluate() {
      return {
        forecastPUp: 0.5,
        action: "WATCH_ONLY",
        reasonCodes: ["REFERENCE_POLICY", "NEUTRAL_BASELINE"]
      };
    }
  },
  {
    policyId: "reference-book-tilt",
    version: "1.0.0",
    label: "Educational captured-book tilt",
    adapterName: "referenceBookTiltPolicy",
    parameters: { neutralForecastPUp: 0.5, tilt: 0.04 },
    supportedPlanes: ["SHANNON_FORWARD"],
    evaluate(input) {
      const bidDepth = input.snapshot.book.bids.length;
      const askDepth = input.snapshot.book.asks.length;
      const tilt = bidDepth === askDepth ? 0 : bidDepth > askDepth ? 0.04 : -0.04;
      return {
        forecastPUp: 0.5 + tilt,
        action: "WATCH_ONLY",
        reasonCodes: ["REFERENCE_POLICY", "CAPTURED_BOOK_ONLY"]
      };
    }
  }
];

export const historicalPolicies: readonly HistoricalPolicyAdapter[] = [
  {
    policyId: "historical-last-trade",
    version: "1.0.0",
    label: "Last-Trade Probability",
    adapterName: "historicalLastTradeProbabilityPolicy",
    parameters: {
      lookbackSeconds: 900,
      targetOutcome: "YES_UP",
      priceScale: "fillPriceRaw / 10^quoteDecimals",
      probabilityClamp: [0.05, 0.95],
      fillOrder: ["timestampSeconds", "blockNumber", "transactionIndex", "logIndex", "id"]
    },
    supportedPlanes: ["MAINNET_HISTORICAL"],
    evaluate(input) {
      const windowStartSeconds = Math.max(
        input.frame.market.tradingStartSeconds,
        input.frame.clock.decisionAtSeconds - 900
      );
      const latestFill = [...input.frame.fills]
        .filter((fill) => fill.timestampSeconds >= windowStartSeconds)
        .sort(compareHistoricalFills)
        .at(-1);
      if (latestFill === undefined) {
        return {
          forecastPUp: 0.5,
          action: "ABSTAIN",
          reasonCodes: ["HISTORICAL_LAST_TRADE", "NO_PRE_CUTOFF_FILL"]
        };
      }
      const fillOutcome = normalizeHistoricalFillOutcome(latestFill);
      if (fillOutcome === null) {
        return {
          forecastPUp: 0.5,
          action: "ABSTAIN",
          reasonCodes: ["HISTORICAL_LAST_TRADE", "FILL_OUTCOME_SIDE_UNSUPPORTED"]
        };
      }
      const rawProbability = scaledPriceToProbability(latestFill.fillPriceRaw, input.frame.market.quoteDecimals);
      return {
        forecastPUp: fillOutcome === "YES" ? rawProbability : 1 - rawProbability,
        action: "WATCH_ONLY",
        reasonCodes: [
          "HISTORICAL_LAST_TRADE",
          "PRE_CUTOFF_FILL",
          fillOutcome === "YES" ? "YES_FILL_PRICE" : "NO_FILL_PRICE_INVERTED"
        ]
      };
    }
  },
  {
    policyId: "historical-last-trade",
    version: "1.1.0",
    label: "Last-Trade Probability",
    adapterName: "historicalLastTradeProbabilityPolicy",
    identitySource: historicalLastTradeV11IdentitySource,
    parameters: {
      lookbackSeconds: 900,
      targetOutcome: "YES_UP",
      priceScale: "DreamDEX YES-term fillPriceRaw / 10^quoteDecimals",
      probabilityClamp: [0.05, 0.95],
      fillOrder: ["timestampSeconds", "blockNumber", "transactionIndex", "logIndex", "id"],
      dataSemantics: "DreamDEX binary fill prices are canonical market-level YES/UP probabilities",
      supersedes: "historical-last-trade@1.0.0"
    },
    supportedPlanes: ["MAINNET_HISTORICAL"],
    evaluate(input) {
      const windowStartSeconds = Math.max(
        input.frame.market.tradingStartSeconds,
        input.frame.clock.decisionAtSeconds - 900
      );
      const candidates: HistoricalDecisionFrame["fills"] = [];
      const exclusionReasons = new Set<string>();
      for (const fill of input.frame.fills) {
        if (fill.timestampSeconds < windowStartSeconds) {
          continue;
        }
        const eligible = eligibleDreamDexBinaryFill(fill);
        if (eligible.eligible) {
          candidates.push(fill);
        } else {
          exclusionReasons.add(eligible.reasonCode);
        }
      }
      const latestFill = candidates.sort(compareHistoricalFills).at(-1);
      if (latestFill === undefined) {
        return {
          forecastPUp: 0.5,
          action: "ABSTAIN",
          reasonCodes: [
            "HISTORICAL_LAST_TRADE",
            input.frame.fills.length === 0 ? "NO_PRE_CUTOFF_FILL" : "NO_QUALIFYING_PRE_CUTOFF_FILL",
            ...[...exclusionReasons].sort()
          ]
        };
      }
      const rawProbability = canonicalDreamDexYesProbability(
        latestFill.fillPriceRaw,
        input.frame.market.quoteDecimals
      );
      return {
        forecastPUp: rawProbability,
        action: "WATCH_ONLY",
        reasonCodes: [
          "HISTORICAL_LAST_TRADE",
          "PRE_CUTOFF_FILL",
          "DREAMDEX_YES_TERM_PRICE",
          fillHasNoTag(latestFill) ? "NO_TAG_NOT_INVERTED" : null,
          "MINT_PAIR_ELIGIBLE"
        ].filter((code): code is string => code !== null && (code !== "MINT_PAIR_ELIGIBLE" || latestFill.kind?.toUpperCase() === "MINT_A_PAIR"))
      };
    }
  }
];
