import { describe, expect, it } from "vitest";
import { assessEvidence, calculateBrierScore, calculateCalibrationBias } from "@edgelab/metrics";
import type { PolicyDecision } from "@edgelab/domain";

function decision(forecastPUp: number): PolicyDecision {
  return {
    policyId: "golden",
    policyVersion: "1.0.0",
    forecastPUp,
    action: "WATCH_ONLY",
    reasonCodes: ["TEST"],
    decidedAt: "2026-08-24T16:00:00.000Z",
    snapshotHash: "1".repeat(64),
    policyHash: "2".repeat(64)
  };
}

describe("METRIC-001 deterministic metric math", () => {
  it("calculates Brier score and calibration bias against golden values", () => {
    const scored = [
      { decision: decision(0.8), outcomeUp: true },
      { decision: decision(0.2), outcomeUp: false },
      { decision: decision(0.6), outcomeUp: true },
      { decision: decision(0.4), outcomeUp: false }
    ];

    expect(calculateBrierScore(scored)).toBeCloseTo(0.1, 12);
    expect(calculateCalibrationBias(scored)).toBeCloseTo(0, 12);
  });

  it("runs sufficiency first and keeps PnL unavailable without fills", () => {
    const assessment = assessEvidence([{ decision: decision(0.99), outcomeUp: true }]);

    expect(assessment.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(assessment.reasonCodes).toContain("SUFFICIENCY_RUN_FIRST");
    expect(assessment.metrics.pnlStatus).toBe("NOT_AVAILABLE");
    expect(assessment.metrics.executionMetrics.tradeabilityStatus).toBe("NOT_EVALUATED");
  });

  it("returns deterministic scoped promote, hold, and reject verdicts from thresholds", () => {
    const thresholds = {
      minSampleSize: 2,
      promoteMaxBrierScore: 0.2,
      promoteMaxAbsCalibrationBias: 0.1,
      rejectWorseThanNeutralBy: 0.02
    };

    expect(
      assessEvidence(
        [
          { decision: decision(0.8), outcomeUp: true },
          { decision: decision(0.2), outcomeUp: false }
        ],
        { thresholds }
      ).verdict
    ).toBe("PROMOTE_TO_FORWARD_OBSERVATION");

    expect(
      assessEvidence(
        [
          { decision: decision(0.55), outcomeUp: true },
          { decision: decision(0.55), outcomeUp: false }
        ],
        { thresholds }
      ).verdict
    ).toBe("HOLD");

    expect(
      assessEvidence(
        [
          { decision: decision(0.9), outcomeUp: false },
          { decision: decision(0.9), outcomeUp: false }
        ],
        { thresholds }
      ).verdict
    ).toBe("REJECT");
  });
});
