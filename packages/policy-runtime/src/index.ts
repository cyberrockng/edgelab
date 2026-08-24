import { createHash } from "node:crypto";
import type { MarketSnapshot, PolicyDecision } from "@edgelab/domain";

export interface PolicyEvaluationInput {
  readonly snapshot: MarketSnapshot;
  readonly decidedAt: string;
  readonly snapshotHash: string;
}

export interface PolicyAdapter {
  readonly policyId: string;
  readonly version: string;
  readonly label: string;
  evaluate(input: PolicyEvaluationInput): Omit<
    PolicyDecision,
    "policyId" | "policyVersion" | "decidedAt" | "snapshotHash" | "policyHash"
  >;
}

function hashManifest(adapter: Pick<PolicyAdapter, "policyId" | "version" | "label">): string {
  return createHash("sha256").update(JSON.stringify(adapter)).digest("hex");
}

export function evaluatePolicy(adapter: PolicyAdapter, input: PolicyEvaluationInput): PolicyDecision {
  const decision = adapter.evaluate(input);
  return {
    ...decision,
    policyId: adapter.policyId,
    policyVersion: adapter.version,
    decidedAt: input.decidedAt,
    snapshotHash: input.snapshotHash,
    policyHash: hashManifest(adapter)
  };
}

export const referencePolicies: readonly PolicyAdapter[] = [
  {
    policyId: "reference-neutral",
    version: "1.0.0",
    label: "Educational neutral baseline",
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
