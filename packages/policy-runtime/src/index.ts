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

function implementationHash(adapter: Pick<PolicyIdentityInput, "evaluate" | "identitySource">): string {
  const source = adapter.identitySource ?? adapter.evaluate.toString();
  return createHash("sha256").update(source.replace(/\s+/g, " ").trim()).digest("hex");
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
  const numerator = Number(priceRaw);
  const denominator = 10 ** quoteDecimals;
  if (!Number.isFinite(numerator) || numerator < 0 || !Number.isFinite(denominator) || denominator <= 0) {
    throw new PolicyRuntimeError("Historical fill price is not a finite non-negative number", "INVALID_PRICE");
  }
  return Math.min(0.95, Math.max(0.05, numerator / denominator));
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
    canonicalDreamDexYesProbability: canonicalDreamDexYesProbability.toString(),
    compareHistoricalFills: compareHistoricalFills.toString(),
    eligibleDreamDexBinaryFill: eligibleDreamDexBinaryFill.toString(),
    isPositiveRawQuantity: isPositiveRawQuantity.toString(),
    isSupportedDreamDexBinaryFillKind: isSupportedDreamDexBinaryFillKind.toString(),
    scaledPriceToProbability: scaledPriceToProbability.toString()
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
          "NO_TAG_NOT_INVERTED",
          "MINT_PAIR_ELIGIBLE"
        ].filter((code) => code !== "MINT_PAIR_ELIGIBLE" || latestFill.kind?.toUpperCase() === "MINT_A_PAIR")
      };
    }
  }
];
