import { createHash } from "node:crypto";
import { PolicyDecisionSchema, type MarketSnapshot, type PolicyDecision } from "@edgelab/domain";

export interface PolicyManifest {
  readonly policyId: string;
  readonly version: string;
  readonly label: string;
  readonly sourceHash: string;
  readonly adapterName: string;
}

export interface PolicyEvaluationInput {
  readonly snapshot: MarketSnapshot;
  readonly decidedAt: string;
  readonly snapshotHash: string;
}

export interface PolicyAdapter {
  readonly policyId: string;
  readonly version: string;
  readonly label: string;
  readonly adapterName: string;
  evaluate(input: PolicyEvaluationInput): Omit<
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

function canonicalJson(input: unknown): string {
  return JSON.stringify(input, Object.keys(input as Record<string, unknown>).sort());
}

export function hashManifest(adapter: Pick<PolicyAdapter, "policyId" | "version" | "label" | "adapterName">): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        adapterName: adapter.adapterName,
        label: adapter.label,
        policyId: adapter.policyId,
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
    sourceHash: hashManifest(adapter)
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

export const referencePolicies: readonly PolicyAdapter[] = [
  {
    policyId: "reference-neutral",
    version: "1.0.0",
    label: "Educational neutral baseline",
    adapterName: "referenceNeutralPolicy",
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
