import type { PolicyDecision, Verdict } from "@edgelab/domain";

export interface ScoredDecision {
  readonly decision: PolicyDecision;
  readonly outcomeUp: boolean;
}

export interface MetricSummary {
  readonly sampleSize: number;
  readonly brierScore: number | null;
  readonly neutralBaselineDelta: number | null;
  readonly pnlStatus: "NOT_AVAILABLE" | "AVAILABLE";
}

export interface EvidenceAssessment {
  readonly verdict: Verdict;
  readonly reasonCodes: readonly string[];
  readonly metrics: MetricSummary;
}

export function calculateBrierScore(scored: readonly ScoredDecision[]): number | null {
  if (scored.length === 0) {
    return null;
  }
  const total = scored.reduce((sum, item) => {
    const actual = item.outcomeUp ? 1 : 0;
    return sum + (item.decision.forecastPUp - actual) ** 2;
  }, 0);
  return total / scored.length;
}

export function assessEvidence(scored: readonly ScoredDecision[]): EvidenceAssessment {
  const brierScore = calculateBrierScore(scored);
  const metrics: MetricSummary = {
    sampleSize: scored.length,
    brierScore,
    neutralBaselineDelta: brierScore === null ? null : 0.25 - brierScore,
    pnlStatus: "NOT_AVAILABLE"
  };

  if (scored.length < 30) {
    return {
      verdict: "INSUFFICIENT_EVIDENCE",
      reasonCodes: ["MIN_SAMPLE_NOT_MET", "PNL_SEPARATE_FROM_FORECAST"],
      metrics
    };
  }

  return {
    verdict: "HOLD",
    reasonCodes: ["FOUNDATION_RULES_PENDING_FULL_THRESHOLD_TABLE"],
    metrics
  };
}
