import type { PolicyDecision, Verdict } from "@edgelab/domain";

export interface ScoredDecision {
  readonly decision: PolicyDecision;
  readonly outcomeUp: boolean;
}

export interface MetricSummary {
  readonly sampleSize: number;
  readonly exclusionCount: number;
  readonly brierScore: number | null;
  readonly calibrationBias: number | null;
  readonly neutralBaselineDelta: number | null;
  readonly executionMetrics: {
    readonly submittedOrderCount: number;
    readonly fillCount: number;
    readonly terminalOrderCount: number;
    readonly tradeabilityStatus: "NOT_EVALUATED" | "EVALUATED";
  };
  readonly pnlStatus: "NOT_AVAILABLE" | "AVAILABLE";
}

export interface EvidenceThresholds {
  readonly minSampleSize: number;
  readonly promoteMaxBrierScore: number;
  readonly promoteMaxAbsCalibrationBias: number;
  readonly rejectWorseThanNeutralBy: number;
}

export interface EvidenceAssessment {
  readonly verdict: Verdict;
  readonly reasonCodes: readonly string[];
  readonly thresholds: EvidenceThresholds;
  readonly metrics: MetricSummary;
}

export const defaultEvidenceThresholds: EvidenceThresholds = {
  minSampleSize: 30,
  promoteMaxBrierScore: 0.2,
  promoteMaxAbsCalibrationBias: 0.05,
  rejectWorseThanNeutralBy: 0.02
};

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

export function calculateCalibrationBias(scored: readonly ScoredDecision[]): number | null {
  if (scored.length === 0) {
    return null;
  }
  const total = scored.reduce((sum, item) => {
    const actual = item.outcomeUp ? 1 : 0;
    return sum + (item.decision.forecastPUp - actual);
  }, 0);
  return total / scored.length;
}

export function assessEvidence(
  scored: readonly ScoredDecision[],
  options: {
    readonly exclusionCount?: number;
    readonly thresholds?: EvidenceThresholds;
    readonly executionMetrics?: Partial<MetricSummary["executionMetrics"]>;
  } = {}
): EvidenceAssessment {
  const thresholds = options.thresholds ?? defaultEvidenceThresholds;
  const brierScore = calculateBrierScore(scored);
  const calibrationBias = calculateCalibrationBias(scored);
  const metrics: MetricSummary = {
    sampleSize: scored.length,
    exclusionCount: options.exclusionCount ?? 0,
    brierScore,
    calibrationBias,
    neutralBaselineDelta: brierScore === null ? null : 0.25 - brierScore,
    executionMetrics: {
      submittedOrderCount: options.executionMetrics?.submittedOrderCount ?? 0,
      fillCount: options.executionMetrics?.fillCount ?? 0,
      terminalOrderCount: options.executionMetrics?.terminalOrderCount ?? 0,
      tradeabilityStatus: options.executionMetrics?.tradeabilityStatus ?? "NOT_EVALUATED"
    },
    pnlStatus: "NOT_AVAILABLE"
  };

  if (scored.length < thresholds.minSampleSize) {
    return {
      verdict: "INSUFFICIENT_EVIDENCE",
      reasonCodes: ["MIN_SAMPLE_NOT_MET", "SUFFICIENCY_RUN_FIRST", "PNL_SEPARATE_FROM_FORECAST"],
      thresholds,
      metrics
    };
  }

  if (brierScore !== null && brierScore > 0.25 + thresholds.rejectWorseThanNeutralBy) {
    return {
      verdict: "REJECT",
      reasonCodes: ["UNDERPERFORMS_NEUTRAL_BASELINE", "PNL_SEPARATE_FROM_FORECAST"],
      thresholds,
      metrics
    };
  }

  if (
    brierScore !== null &&
    calibrationBias !== null &&
    brierScore <= thresholds.promoteMaxBrierScore &&
    Math.abs(calibrationBias) <= thresholds.promoteMaxAbsCalibrationBias
  ) {
    return {
      verdict: "PROMOTE",
      reasonCodes: ["FORECAST_THRESHOLD_MET", "TRADEABILITY_STILL_SEPARATE"],
      thresholds,
      metrics
    };
  }

  return {
    verdict: "HOLD",
    reasonCodes: ["FORECAST_SIGNAL_NOT_PROMOTABLE", "PNL_SEPARATE_FROM_FORECAST"],
    thresholds,
    metrics
  };
}
