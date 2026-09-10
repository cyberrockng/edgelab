import { describe, expect, it } from "vitest";
import { assessEconomicScenario, assessEvidence, assessV4Forecast, calculateBrierScore, calculateCalibrationBias, calculatePairedMetrics, movingBlockMeanInterval, pairedMovingBlockDeltaInterval, reliabilityBins } from "@edgelab/metrics";
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

describe("METRIC-004 paired market evaluation", () => {
  it("keeps equal forecasts at zero improvement and deduplicates observation keys", () => {
    const rows = [
      { observationKey: "a", candidateProbability: .8, marketProbability: .8, outcomeUp: true, observedAt: "2026-09-01T00:00:00Z" },
      { observationKey: "b", candidateProbability: .2, marketProbability: .2, outcomeUp: false, observedAt: "2026-09-01T01:00:00Z" },
      { observationKey: "a", candidateProbability: .1, marketProbability: .9, outcomeUp: false, observedAt: "2026-09-01T02:00:00Z" }
    ];
    const result = calculatePairedMetrics(rows);
    expect(result.pairedSampleSize).toBe(2);
    expect(result.duplicateCount).toBe(1);
    expect(result.deltaBrier).toBe(0);
    expect(result.brierSkill).toBe(0);
  });

  it("reproduces the bias-cancellation diagnostic without granting market skill", () => {
    const outcomes = [...Array<boolean>(12).fill(true), ...Array<boolean>(3).fill(false), ...Array<boolean>(3).fill(true), ...Array<boolean>(12).fill(false)];
    const rows = outcomes.map((outcomeUp, index) => ({
      observationKey: String(index),
      candidateProbability: index < 15 ? .9 : .1,
      marketProbability: index < 15 ? .8 : .2,
      outcomeUp,
      observedAt: `2026-09-${String((index % 20) + 1).padStart(2, "0")}T00:00:00Z`
    }));
    const result = calculatePairedMetrics(rows);
    expect(result.candidateBrier).toBeCloseTo(.17, 12);
    expect(result.marketBrier).toBeCloseTo(.16, 12);
    expect(result.brierSkill).toBeLessThan(0);
    expect(result.candidateEce).toBeCloseTo(.1, 12);
  });

  it("reports missing baselines and a zero market denominator explicitly", () => {
    const missing = calculatePairedMetrics([{ observationKey: "missing", candidateProbability: .6, marketProbability: null, outcomeUp: true, observedAt: "2026-09-01T00:00:00Z" }]);
    expect(missing.pairedSampleSize).toBe(0);
    expect(missing.missingBaselineCount).toBe(1);
    expect(missing.brierSkill).toBeNull();
    const zero = calculatePairedMetrics([{ observationKey: "zero", candidateProbability: .9, marketProbability: 1, outcomeUp: true, observedAt: "2026-09-01T00:00:00Z" }]);
    expect(zero.marketBrier).toBe(0);
    expect(zero.brierSkill).toBeNull();
  });

  it("uses fixed bins with an inclusive probability-one endpoint and Wilson bounds", () => {
    const bins = reliabilityBins([0, .099, .1, .999, 1], [false, true, false, true, true]);
    expect(bins.map((bin) => [bin.lower, bin.upper, bin.count])).toEqual([
      [0, .1, 2], [.1, .2, 1], [.9, 1, 2]
    ]);
    expect(bins.every((bin) => bin.wilson95[0] >= 0 && bin.wilson95[1] <= 1)).toBe(true);
  });
});

describe("METRIC-005 frozen v4 inference", () => {
  const seed = "a".repeat(64);
  const rows = Array.from({ length: 40 }, (_, index) => ({
    observationKey: `row-${String(index)}`,
    candidateProbability: index % 2 === 0 ? .96 : .04,
    marketProbability: index % 2 === 0 ? .9 : .1,
    outcomeUp: index % 2 === 0,
    observedAt: `2026-08-${String((index % 20) + 1).padStart(2, "0")}T${String(index % 24).padStart(2, "0")}:00:00Z`
  }));

  it("repeats moving-day bootstrap output exactly from the frozen seed", () => {
    const first = pairedMovingBlockDeltaInterval(rows, { seed, replicates: 250 });
    const second = pairedMovingBlockDeltaInterval(rows, { seed, replicates: 250 });
    expect(first).toEqual(second);
    expect(first?.distinctDayBlocks).toBe(20);
    expect(first?.lower).toBeGreaterThan(0);
  });

  it("runs coverage and fixed-end prerequisites before success", () => {
    const pairedMetrics = calculatePairedMetrics(rows);
    const deltaInterval = pairedMovingBlockDeltaInterval(rows, { seed, replicates: 100 });
    expect(assessV4Forecast({ sourcePlane: "SHANNON_FORWARD", pairedMetrics, deltaInterval, eligibleScheduledCount: 100, studyEnded: false, integrityComplete: true, formalFloor: 30 }).status).toBe("INSUFFICIENT");
    const accepted = assessV4Forecast({ sourcePlane: "SHANNON_FORWARD", pairedMetrics, deltaInterval, eligibleScheduledCount: 40, studyEnded: true, integrityComplete: true, formalFloor: 30 });
    expect(accepted.status).toBe("FORWARD_CRITERIA_MET");
  });

  it("does not let a copy-market control earn incremental success", () => {
    const copyRows = rows.map((row) => ({ ...row, candidateProbability: row.marketProbability }));
    const pairedMetrics = calculatePairedMetrics(copyRows);
    const deltaInterval = pairedMovingBlockDeltaInterval(copyRows, { seed, replicates: 100 });
    expect(pairedMetrics.deltaBrier).toBe(0);
    expect(assessV4Forecast({
      sourcePlane: "SHANNON_FORWARD", pairedMetrics, deltaInterval,
      eligibleScheduledCount: copyRows.length, studyEnded: true, integrityComplete: true, formalFloor: 30
    }).status).toBe("NO_DEMONSTRATED_IMPROVEMENT");
  });
});

describe("METRIC-006 captured-book economic scenarios", () => {
  const economicSeed = "b".repeat(64);
  const positiveRows = Array.from({ length: 40 }, (_, index) => ({
    observationKey: `economic-${String(index)}`,
    observedAt: new Date(Date.UTC(2026, 7, 1 + (index % 28), index % 24)).toISOString(),
    primaryNetReturn: .003,
    stressNetReturn: .002,
    deployedCollateralReturn: .2,
    action: index % 5 === 0 ? "NO_TRADE" as const : "TRADE" as const
  })).map((row) => row.action === "NO_TRADE" ? { ...row, primaryNetReturn: 0, stressNetReturn: 0, deployedCollateralReturn: null } : row);

  it("reproduces the mean bootstrap and accepts positive stress economics after all floors", () => {
    const vector = positiveRows.map((row) => ({ observationKey: row.observationKey, observedAt: row.observedAt, value: row.stressNetReturn }));
    expect(movingBlockMeanInterval(vector, { seed: economicSeed, replicates: 250 }))
      .toEqual(movingBlockMeanInterval(vector, { seed: economicSeed, replicates: 250 }));
    const result = assessEconomicScenario({
      observations: positiveRows, eligibleScheduledCount: 40, studyEnded: true,
      forecastStatus: "FORWARD_CRITERIA_MET", seed: economicSeed, formalFloor: 30
    });
    expect(result.status).toBe("SCENARIO_CRITERIA_MET");
    expect(result.stressInterval?.lower).toBeGreaterThan(0);
    expect(result.coveredWeekCount).toBeGreaterThanOrEqual(4);
    expect(result.noTradeCount).toBe(8);
    expect(result.allCostValidation).toBe(false);
  });

  it("keeps no-trades in the denominator and requires positive economics without the best week", () => {
    const concentrated = positiveRows.map((row, index) => ({
      ...row,
      action: "TRADE" as const,
      primaryNetReturn: index % 28 < 2 ? .2 : -.001,
      stressNetReturn: index % 28 < 2 ? .15 : -.002,
      deployedCollateralReturn: index % 28 < 2 ? .5 : -.1
    }));
    const result = assessEconomicScenario({
      observations: concentrated, eligibleScheduledCount: 40, studyEnded: true,
      forecastStatus: "FORWARD_CRITERIA_MET", seed: "c".repeat(64), formalFloor: 30
    });
    expect(result.status).toBe("SCENARIO_REJECTED");
    expect(result.reasonCodes).toContain("BEST_WEEK_REMOVAL_NOT_POSITIVE");
  });
});
