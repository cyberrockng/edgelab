import type { EconomicsStatus, ForecastStatus, PolicyDecision, Verdict } from "@edgelab/domain";

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
    readonly qualificationTarget?: "FORWARD_OBSERVATION" | "EXECUTION_EXPOSURE";
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
    const strategyQualified = options.qualificationTarget === "EXECUTION_EXPOSURE";
    return {
      verdict: strategyQualified ? "STRATEGY_QUALIFIED" : "PROMOTE_TO_FORWARD_OBSERVATION",
      reasonCodes: [
        "FORECAST_THRESHOLD_MET",
        strategyQualified ? "STRATEGY_QUALIFIED" : "PROMOTE_TO_FORWARD_OBSERVATION",
        "ORDER_EXECUTABILITY_STILL_SEPARATE"
      ],
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

export interface PairedForecastObservation {
  readonly observationKey: string;
  readonly candidateProbability: number;
  readonly marketProbability: number | null;
  readonly outcomeUp: boolean;
  readonly observedAt: string;
}

export interface ReliabilityBin {
  readonly lower: number;
  readonly upper: number;
  readonly count: number;
  readonly meanPrediction: number;
  readonly outcomeRate: number;
  readonly wilson95: readonly [number, number];
}

export interface PairedMetricSummary {
  readonly pairedSampleSize: number;
  readonly duplicateCount: number;
  readonly missingBaselineCount: number;
  readonly candidateBrier: number | null;
  readonly marketBrier: number | null;
  readonly deltaBrier: number | null;
  readonly brierSkill: number | null;
  readonly candidateEce: number | null;
  readonly marketEce: number | null;
  readonly excessEce: number | null;
  readonly candidateReliability: readonly ReliabilityBin[];
  readonly marketReliability: readonly ReliabilityBin[];
}

function validProbability(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function wilson95(successes: number, count: number): readonly [number, number] {
  if (count === 0) return [0, 0];
  const z = 1.959963984540054;
  const rate = successes / count;
  const denominator = 1 + (z * z) / count;
  const center = (rate + (z * z) / (2 * count)) / denominator;
  const spread = (z / denominator) * Math.sqrt((rate * (1 - rate)) / count + (z * z) / (4 * count * count));
  return [Math.max(0, center - spread), Math.min(1, center + spread)];
}

export function reliabilityBins(predictions: readonly number[], outcomes: readonly boolean[]): readonly ReliabilityBin[] {
  if (predictions.length !== outcomes.length) throw new Error("Prediction and outcome counts must match");
  const bins = Array.from({ length: 10 }, () => ({ count: 0, predictionSum: 0, successes: 0 }));
  predictions.forEach((prediction, index) => {
    if (!validProbability(prediction)) throw new Error("Probabilities must be finite values from zero to one");
    const binIndex = Math.min(9, Math.floor(prediction * 10));
    const bin = bins[binIndex];
    if (bin === undefined) return;
    bin.count += 1;
    bin.predictionSum += prediction;
    if (outcomes[index] === true) bin.successes += 1;
  });
  return bins.flatMap((bin, index) => bin.count === 0 ? [] : [{
    lower: index / 10,
    upper: (index + 1) / 10,
    count: bin.count,
    meanPrediction: bin.predictionSum / bin.count,
    outcomeRate: bin.successes / bin.count,
    wilson95: wilson95(bin.successes, bin.count)
  }]);
}

function ece(bins: readonly ReliabilityBin[], sampleSize: number): number | null {
  if (sampleSize === 0) return null;
  return bins.reduce((sum, bin) => sum + (bin.count / sampleSize) * Math.abs(bin.meanPrediction - bin.outcomeRate), 0);
}

export function calculatePairedMetrics(observations: readonly PairedForecastObservation[]): PairedMetricSummary {
  const seen = new Set<string>();
  const paired: PairedForecastObservation[] = [];
  let duplicateCount = 0;
  let missingBaselineCount = 0;
  for (const observation of observations) {
    if (seen.has(observation.observationKey)) { duplicateCount += 1; continue; }
    seen.add(observation.observationKey);
    if (!validProbability(observation.candidateProbability)) throw new Error("Candidate probability is invalid");
    if (observation.marketProbability === null) { missingBaselineCount += 1; continue; }
    if (!validProbability(observation.marketProbability)) throw new Error("Market probability is invalid");
    paired.push(observation);
  }
  if (paired.length === 0) return {
    pairedSampleSize: 0, duplicateCount, missingBaselineCount, candidateBrier: null, marketBrier: null,
    deltaBrier: null, brierSkill: null, candidateEce: null, marketEce: null, excessEce: null,
    candidateReliability: [], marketReliability: []
  };
  const outcomes = paired.map((item) => item.outcomeUp);
  const candidate = paired.map((item) => item.candidateProbability);
  const market = paired.map((item) => item.marketProbability as number);
  const score = (values: readonly number[]) => values.reduce((sum, value, index) => sum + (value - (outcomes[index] ? 1 : 0)) ** 2, 0) / values.length;
  const candidateBrier = score(candidate);
  const marketBrier = score(market);
  const candidateReliability = reliabilityBins(candidate, outcomes);
  const marketReliability = reliabilityBins(market, outcomes);
  const candidateEce = ece(candidateReliability, paired.length);
  const marketEce = ece(marketReliability, paired.length);
  return {
    pairedSampleSize: paired.length, duplicateCount, missingBaselineCount, candidateBrier, marketBrier,
    deltaBrier: marketBrier - candidateBrier,
    brierSkill: marketBrier === 0 ? null : 1 - candidateBrier / marketBrier,
    candidateEce, marketEce,
    excessEce: candidateEce === null || marketEce === null ? null : candidateEce - marketEce,
    candidateReliability, marketReliability
  };
}

export interface MovingBlockInterval {
  readonly lower: number;
  readonly upper: number;
  readonly replicates: number;
  readonly blockLengthDays: number;
  readonly distinctDayBlocks: number;
  readonly seed: string;
  readonly familySize: number;
}

function seededRandom(seed: string): () => number {
  if (!/^[a-f0-9]{64}$/.test(seed)) throw new Error("Bootstrap seed must be a SHA-256 hex digest");
  let state = Number.parseInt(seed.slice(0, 8), 16) ^ Number.parseInt(seed.slice(56), 16);
  if (state === 0) state = 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function percentile(sorted: readonly number[], probability: number): number {
  const position = Math.min(sorted.length - 1, Math.max(0, Math.floor(probability * sorted.length)));
  return sorted[position] ?? Number.NaN;
}

export function pairedMovingBlockDeltaInterval(
  observations: readonly PairedForecastObservation[],
  options: { readonly seed: string; readonly replicates?: number; readonly blockLengthDays?: number; readonly familySize?: number; readonly alpha?: number }
): MovingBlockInterval | null {
  const unique = new Map<string, PairedForecastObservation>();
  for (const row of observations) {
    if (row.marketProbability !== null && !unique.has(row.observationKey)) unique.set(row.observationKey, row);
  }
  const days = new Map<string, PairedForecastObservation[]>();
  for (const row of unique.values()) {
    const timestamp = new Date(row.observedAt);
    if (Number.isNaN(timestamp.getTime())) throw new Error("Observation time must be ISO-compatible");
    const day = timestamp.toISOString().slice(0, 10);
    const group = days.get(day) ?? [];
    group.push(row);
    days.set(day, group);
  }
  const orderedDays = [...days].sort(([left], [right]) => left.localeCompare(right)).map(([, rows]) => rows);
  if (orderedDays.length === 0) return null;
  const replicates = options.replicates ?? 10_000;
  const blockLengthDays = options.blockLengthDays ?? 2;
  const familySize = options.familySize ?? 1;
  const alpha = options.alpha ?? .05;
  if (!Number.isInteger(replicates) || replicates < 1 || !Number.isInteger(blockLengthDays) || blockLengthDays < 1 || !Number.isInteger(familySize) || familySize < 1) throw new Error("Bootstrap controls must be positive integers");
  const random = seededRandom(options.seed);
  const estimates: number[] = [];
  for (let replicate = 0; replicate < replicates; replicate += 1) {
    const sampled: PairedForecastObservation[] = [];
    let sampledDays = 0;
    while (sampledDays < orderedDays.length) {
      const start = Math.floor(random() * orderedDays.length);
      for (let offset = 0; offset < blockLengthDays && sampledDays < orderedDays.length; offset += 1) {
        sampled.push(...(orderedDays[(start + offset) % orderedDays.length] ?? []));
        sampledDays += 1;
      }
    }
    const delta = calculatePairedMetrics(sampled).deltaBrier;
    if (delta !== null) estimates.push(delta);
  }
  estimates.sort((left, right) => left - right);
  const tail = alpha / (2 * familySize);
  return {
    lower: percentile(estimates, tail), upper: percentile(estimates, 1 - tail), replicates,
    blockLengthDays, distinctDayBlocks: orderedDays.length, seed: options.seed, familySize
  };
}

export interface V4ForecastGateInput {
  readonly sourcePlane: "MAINNET_HISTORICAL" | "SHANNON_FORWARD";
  readonly pairedMetrics: PairedMetricSummary;
  readonly deltaInterval: MovingBlockInterval | null;
  readonly eligibleScheduledCount: number;
  readonly studyEnded: boolean;
  readonly integrityComplete: boolean;
  readonly formalFloor?: number;
  readonly minimumDayBlocks?: number;
  readonly minimumCoverage?: number;
}

export interface ScenarioReturnObservation {
  readonly observationKey: string;
  readonly observedAt: string;
  readonly primaryNetReturn: number;
  readonly stressNetReturn: number;
  readonly deployedCollateralReturn: number | null;
  readonly action: "TRADE" | "NO_TRADE";
}

export interface EconomicScenarioSummary {
  readonly status: EconomicsStatus;
  readonly reasonCodes: readonly string[];
  readonly sampleSize: number;
  readonly eligibleScheduledCount: number;
  readonly coverage: number;
  readonly tradeCount: number;
  readonly noTradeCount: number;
  readonly primaryMeanPerWindowReturn: number | null;
  readonly stressMeanPerWindowReturn: number | null;
  readonly stressInterval: MovingBlockInterval | null;
  readonly coveredWeekCount: number;
  readonly meanAfterBestWeekRemoval: number | null;
  readonly gasTreatment: "DISCLOSED_NOT_CONVERTED_TO_PAYOUT_UNITS";
  readonly allCostValidation: false;
}

function utcWeekKey(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Scenario observation time must be ISO-compatible");
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${String(date.getUTCFullYear())}-W${String(week).padStart(2, "0")}`;
}

export function movingBlockMeanInterval(
  observations: readonly { readonly observationKey: string; readonly observedAt: string; readonly value: number }[],
  options: { readonly seed: string; readonly replicates?: number; readonly blockLengthDays?: number; readonly familySize?: number; readonly alpha?: number }
): MovingBlockInterval | null {
  const unique = new Map<string, (typeof observations)[number]>();
  for (const row of observations) {
    if (!Number.isFinite(row.value)) throw new Error("Scenario return must be finite");
    if (!unique.has(row.observationKey)) unique.set(row.observationKey, row);
  }
  const days = new Map<string, (typeof observations)[number][]>();
  for (const row of unique.values()) {
    const timestamp = new Date(row.observedAt);
    if (Number.isNaN(timestamp.getTime())) throw new Error("Scenario observation time must be ISO-compatible");
    const key = timestamp.toISOString().slice(0, 10);
    days.set(key, [...(days.get(key) ?? []), row]);
  }
  const orderedDays = [...days].sort(([left], [right]) => left.localeCompare(right)).map(([, rows]) => rows);
  if (orderedDays.length === 0) return null;
  const replicates = options.replicates ?? 10_000;
  const blockLengthDays = options.blockLengthDays ?? 2;
  const familySize = options.familySize ?? 1;
  const alpha = options.alpha ?? .05;
  if (!Number.isInteger(replicates) || replicates < 1 || !Number.isInteger(blockLengthDays) || blockLengthDays < 1 || !Number.isInteger(familySize) || familySize < 1) throw new Error("Bootstrap controls must be positive integers");
  const random = seededRandom(options.seed);
  const estimates: number[] = [];
  for (let replicate = 0; replicate < replicates; replicate += 1) {
    let sampledDays = 0;
    let sum = 0;
    let count = 0;
    while (sampledDays < orderedDays.length) {
      const start = Math.floor(random() * orderedDays.length);
      for (let offset = 0; offset < blockLengthDays && sampledDays < orderedDays.length; offset += 1) {
        for (const row of orderedDays[(start + offset) % orderedDays.length] ?? []) {
          sum += row.value;
          count += 1;
        }
        sampledDays += 1;
      }
    }
    if (count > 0) estimates.push(sum / count);
  }
  estimates.sort((left, right) => left - right);
  const tail = alpha / (2 * familySize);
  return {
    lower: percentile(estimates, tail), upper: percentile(estimates, 1 - tail), replicates,
    blockLengthDays, distinctDayBlocks: orderedDays.length, seed: options.seed, familySize
  };
}

export function assessEconomicScenario(input: {
  readonly observations: readonly ScenarioReturnObservation[];
  readonly eligibleScheduledCount: number;
  readonly studyEnded: boolean;
  readonly forecastStatus: ForecastStatus;
  readonly seed: string;
  readonly formalFloor?: number;
  readonly minimumDayBlocks?: number;
  readonly minimumCoverage?: number;
  readonly minimumWeekGroups?: number;
}): EconomicScenarioSummary {
  const unique = new Map(input.observations.map((row) => [row.observationKey, row]));
  const rows = [...unique.values()];
  const sampleSize = rows.length;
  const coverage = input.eligibleScheduledCount === 0 ? 0 : sampleSize / input.eligibleScheduledCount;
  const mean = (values: readonly number[]) => values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
  const stressInterval = movingBlockMeanInterval(rows.map((row) => ({ observationKey: row.observationKey, observedAt: row.observedAt, value: row.stressNetReturn })), { seed: input.seed });
  const weeks = new Map<string, ScenarioReturnObservation[]>();
  for (const row of rows) weeks.set(utcWeekKey(row.observedAt), [...(weeks.get(utcWeekKey(row.observedAt)) ?? []), row]);
  const bestWeek = [...weeks].sort(([, left], [, right]) =>
    right.reduce((sum, row) => sum + row.stressNetReturn, 0) - left.reduce((sum, row) => sum + row.stressNetReturn, 0)
  )[0]?.[0];
  const remaining = bestWeek === undefined ? [] : rows.filter((row) => utcWeekKey(row.observedAt) !== bestWeek);
  const meanAfterBestWeekRemoval = mean(remaining.map((row) => row.stressNetReturn));
  const reasons: string[] = [];
  if (input.forecastStatus !== "FORWARD_CRITERIA_MET") reasons.push("FORECAST_CRITERIA_NOT_MET");
  if (!input.studyEnded) reasons.push("FIXED_STUDY_END_NOT_REACHED");
  if (sampleSize < (input.formalFloor ?? 200)) reasons.push("SCENARIO_SAMPLE_FLOOR_NOT_MET");
  if ((stressInterval?.distinctDayBlocks ?? 0) < (input.minimumDayBlocks ?? 20)) reasons.push("SCENARIO_DAY_FLOOR_NOT_MET");
  if (coverage < (input.minimumCoverage ?? .8)) reasons.push("SCENARIO_COVERAGE_NOT_MET");
  if (weeks.size < (input.minimumWeekGroups ?? 4)) reasons.push("SCENARIO_WEEK_GROUP_FLOOR_NOT_MET");
  if (stressInterval === null) reasons.push("STRESS_INTERVAL_UNAVAILABLE");
  const prerequisites = reasons.length > 0;
  const status: EconomicsStatus = prerequisites
    ? "INSUFFICIENT"
    : (stressInterval?.lower ?? 0) > 0 && (meanAfterBestWeekRemoval ?? 0) > 0
      ? "SCENARIO_CRITERIA_MET"
      : "SCENARIO_REJECTED";
  if (!prerequisites && (stressInterval?.lower ?? 0) <= 0) reasons.push("STRESS_RETURN_LOWER_BOUND_NOT_POSITIVE");
  if (!prerequisites && (meanAfterBestWeekRemoval ?? 0) <= 0) reasons.push("BEST_WEEK_REMOVAL_NOT_POSITIVE");
  if (status === "SCENARIO_CRITERIA_MET") reasons.push("STRESS_SCENARIO_CRITERIA_MET", "GAS_COST_NOT_CONVERTED");
  return {
    status, reasonCodes: reasons, sampleSize, eligibleScheduledCount: input.eligibleScheduledCount, coverage,
    tradeCount: rows.filter((row) => row.action === "TRADE").length,
    noTradeCount: rows.filter((row) => row.action === "NO_TRADE").length,
    primaryMeanPerWindowReturn: mean(rows.map((row) => row.primaryNetReturn)),
    stressMeanPerWindowReturn: mean(rows.map((row) => row.stressNetReturn)),
    stressInterval, coveredWeekCount: weeks.size, meanAfterBestWeekRemoval,
    gasTreatment: "DISCLOSED_NOT_CONVERTED_TO_PAYOUT_UNITS", allCostValidation: false
  };
}

export function assessV4Forecast(input: V4ForecastGateInput): { readonly status: ForecastStatus; readonly reasonCodes: readonly string[] } {
  if (input.sourcePlane === "MAINNET_HISTORICAL") {
    return input.pairedMetrics.pairedSampleSize === 0
      ? { status: "INSUFFICIENT", reasonCodes: ["HISTORICAL_MARKET_COMPARISON_UNAVAILABLE"] }
      : { status: "HISTORICAL_SCREEN_PASSED", reasonCodes: ["HISTORICAL_DESCRIPTIVE_ONLY", "FORWARD_EVIDENCE_REQUIRED"] };
  }
  const floor = input.formalFloor ?? 200;
  const days = input.minimumDayBlocks ?? 20;
  const coverageFloor = input.minimumCoverage ?? .8;
  const coverage = input.eligibleScheduledCount === 0 ? 0 : input.pairedMetrics.pairedSampleSize / input.eligibleScheduledCount;
  const prerequisites: string[] = [];
  if (!input.studyEnded) prerequisites.push("FIXED_STUDY_END_NOT_REACHED");
  if (input.pairedMetrics.pairedSampleSize < floor) prerequisites.push("FORMAL_SAMPLE_FLOOR_NOT_MET");
  if ((input.deltaInterval?.distinctDayBlocks ?? 0) < days) prerequisites.push("DISTINCT_DAY_FLOOR_NOT_MET");
  if (coverage < coverageFloor) prerequisites.push("PAIRED_COVERAGE_NOT_MET");
  if (!input.integrityComplete) prerequisites.push("INTEGRITY_PREREQUISITE_NOT_MET");
  if (input.deltaInterval === null || input.pairedMetrics.marketBrier === 0) prerequisites.push("PAIRED_INTERVAL_UNAVAILABLE");
  if (prerequisites.length > 0) return { status: "INSUFFICIENT", reasonCodes: prerequisites };
  if ((input.deltaInterval?.upper ?? 0) < 0) return { status: "UNDERPERFORMS_MARKET", reasonCodes: ["DELTA_BRIER_INTERVAL_BELOW_ZERO"] };
  if ((input.deltaInterval?.lower ?? 0) <= 0) return { status: "NO_DEMONSTRATED_IMPROVEMENT", reasonCodes: ["DELTA_BRIER_INTERVAL_INCLUDES_ZERO"] };
  if ((input.pairedMetrics.candidateEce ?? Number.POSITIVE_INFINITY) > .05) return { status: "NO_DEMONSTRATED_IMPROVEMENT", reasonCodes: ["CANDIDATE_ECE_LIMIT_EXCEEDED"] };
  if ((input.pairedMetrics.excessEce ?? Number.POSITIVE_INFINITY) > .02) return { status: "NO_DEMONSTRATED_IMPROVEMENT", reasonCodes: ["EXCESS_ECE_LIMIT_EXCEEDED"] };
  return { status: "FORWARD_CRITERIA_MET", reasonCodes: ["PAIRED_DELTA_LOWER_BOUND_POSITIVE", "CALIBRATION_CRITERIA_MET"] };
}
