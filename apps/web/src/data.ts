export interface EvidenceSummary {
  readonly ok: true;
  readonly counts: {
    readonly experiments: number;
    readonly episodes: number;
    readonly snapshots: number;
    readonly decisions: number;
    readonly settlements: number;
    readonly metricRuns: number;
    readonly assessments: number;
  };
  readonly chain: {
    readonly submittedOrderCount: number;
    readonly fillCount: number;
    readonly terminalOrderCount: number;
    readonly openOrderCount: number;
    readonly latestTerminalState: string | null;
    readonly tradeabilityStatus: "NOT_EVALUATED" | "EVALUATED";
  };
}

export interface ProofRow {
  readonly label: string;
  readonly value: string;
  readonly href: string | null;
}

export interface V2Envelope<TData, TMeta = Record<string, unknown>> {
  readonly data: TData;
  readonly meta: TMeta & { readonly apiVersion: "v2" };
}

export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly correlationId: string;
    readonly details?: unknown;
  };
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly body: ApiErrorBody | null
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface SourceMeta {
  readonly plane: "MAINNET_HISTORICAL" | "SHANNON_FORWARD" | "SHANNON_EXECUTION";
  readonly chainId: number;
  readonly rpcUrl?: string;
  readonly indexerUrl?: string;
  readonly sdkVersion?: string;
  readonly evidenceClass?: string;
  readonly retrievedAt?: string;
  readonly writePolicy?: string;
}

export interface MarketEvidence {
  readonly stableMarketId: string;
  readonly marketAddress: string;
  readonly poolAddress: string;
  readonly asset: "BTC" | "ETH";
  readonly question: string;
  readonly status: string;
  readonly finalized?: boolean;
  readonly winningOutcome?: string | null;
  readonly intervalSeconds: number | null;
  readonly tradingStartSeconds: number;
  readonly expirySeconds: number;
  readonly tradeCount: number;
  readonly openingPriceRaw?: string | null;
  readonly source: SourceMeta;
}

export interface MarketsResponse {
  readonly markets: readonly MarketEvidence[];
}

export interface MarketsMeta {
  readonly apiVersion: "v2";
  readonly page?: {
    readonly limit: number;
    readonly offset: number;
  };
  readonly hasMore?: boolean;
  readonly countRelation?: string;
  readonly source?: SourceMeta;
  readonly plane?: string;
  readonly chainId?: number;
}

export interface HistoricalCountResponse {
  readonly count: number;
  readonly countRelation: "EXACT" | "AT_LEAST";
}

export interface HistoricalDetailResponse {
  readonly market: MarketEvidence;
}

export interface HistoricalResolutionResponse {
  readonly resolution: {
    readonly marketId: string;
    readonly openingAnswer: unknown;
    readonly closingAnswer: unknown;
    readonly reference: unknown;
    readonly events: readonly unknown[];
    readonly source: SourceMeta;
  };
}

export interface HistoricalStatusHistoryResponse {
  readonly statusHistory: readonly {
    readonly oldStatus: string;
    readonly newStatus: string;
    readonly blockNumber: string;
    readonly timestampSeconds: number;
    readonly txHash: string;
    readonly source: SourceMeta;
  }[];
}

export interface HistoricalCandlesResponse {
  readonly candles: readonly {
    readonly bucketStartSeconds: number;
    readonly intervalSeconds: number;
    readonly openPriceRaw: string;
    readonly highPriceRaw: string;
    readonly lowPriceRaw: string;
    readonly closePriceRaw: string;
    readonly baseVolumeRaw: string;
    readonly quoteVolumeRaw: string;
    readonly tradeCount: number;
    readonly source: SourceMeta;
  }[];
}

export interface HistoricalOrdersResponse {
  readonly orders: readonly {
    readonly orderId: string;
    readonly side: string;
    readonly priceRaw: string;
    readonly fullQuantityRaw: string;
    readonly filledQuantityRaw: string;
    readonly remainingQuantityRaw: string;
    readonly status: string;
    readonly rested: boolean;
    readonly placedAtBlock: string;
    readonly lastUpdatedAtBlock: string;
    readonly source: SourceMeta;
  }[];
}

export interface HistoricalFillsResponse {
  readonly fills: readonly {
    readonly fillPriceRaw: string;
    readonly quantityRaw: string;
    readonly kind: string | null;
    readonly makerOrderId: string | null;
    readonly takerOrderId: string | null;
    readonly blockNumber: string;
    readonly logIndex: string;
    readonly source: SourceMeta;
  }[];
}

export interface ResearchSessionResponse {
  readonly session: {
    readonly id: string;
    readonly expiresAt: string;
    readonly csrfVersion: number;
  };
  readonly csrfToken: string;
}

export interface ExperimentRecord {
  readonly experimentId: string;
  readonly name: string;
  readonly status: string;
  readonly visibility: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly configuration: {
    readonly id: string;
    readonly version: number;
    readonly mode: "HISTORICAL_REPLAY" | "LIVE_SHADOW";
    readonly assets: readonly string[];
    readonly intervals: readonly number[];
    readonly windowFrom: string | null;
    readonly windowTo: string | null;
    readonly decisionOffsetSec: number;
    readonly riskEnvelopeId: string | null;
    readonly ruleVersion: string;
    readonly config: {
      readonly sourcePlane?: string;
      readonly selectedMarketId?: string | null;
      readonly riskEnvelopeId?: string;
      readonly historicalBookReconstruction?: string;
      readonly pnlStatus?: string;
      readonly [key: string]: unknown;
    };
    readonly configHash: string;
  };
  readonly policies: readonly {
    readonly role: string;
    readonly policyVersionId: string;
    readonly policyId: string;
    readonly version: string;
    readonly label: string;
    readonly adapterName: string;
    readonly sourceHash: string;
  }[];
}

export interface ExperimentsResponse {
  readonly experiments: readonly ExperimentRecord[];
  readonly session: ResearchSessionResponse["session"];
  readonly csrfToken: string;
}

export interface ExperimentDetailResponse {
  readonly experiment: ExperimentRecord;
  readonly csrfToken?: string;
  readonly idempotentReplay?: boolean;
}

export interface ReplayDecisionRecord {
  readonly id: string;
  readonly marketId: string;
  readonly decisionAt: string;
  readonly cutoffBlock: string;
  readonly frameHash: string;
  readonly forecastPUp: number | null;
  readonly action: string;
  readonly reasonCodes: readonly string[];
  readonly outcomeLoadedAt: string | null;
  readonly outcomeResult: string | null;
  readonly exclusionReason: string | null;
}

export interface ReplayRunRecord {
  readonly id: string;
  readonly experimentId: string;
  readonly configurationId: string;
  readonly plane: "MAINNET_HISTORICAL";
  readonly status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  readonly frozenNow: string;
  readonly selectedCount: number;
  readonly processedCount: number;
  readonly scoredCount: number;
  readonly excludedCount: number;
  readonly capability: string;
  readonly sourceVersion: string;
  readonly queryVersion: string;
  readonly inputHash: string;
  readonly outputHash: string | null;
  readonly errorCode: string | null;
  readonly checkpoints: Record<string, unknown>;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly decisions?: readonly ReplayDecisionRecord[];
}

export interface ReplayResponse {
  readonly replay: ReplayRunRecord | null;
  readonly csrfToken?: string;
  readonly idempotentReplay?: boolean;
}

export interface EvaluationAssessmentRecord {
  readonly assessmentId: string;
  readonly metricRunId: string;
  readonly verdict: "PROMOTE" | "HOLD" | "REJECT" | "INSUFFICIENT_EVIDENCE";
  readonly reasonCodes: readonly string[];
  readonly sampleSize: number;
  readonly exclusionCount: number;
  readonly brierScore: number | null;
  readonly calibrationBias: number | null;
  readonly neutralBaselineDelta: number | null;
  readonly pnlStatus: "NOT_AVAILABLE" | "AVAILABLE";
  readonly evidencePlane: string;
  readonly replayRunId: string | null;
  readonly promotionScope: string;
  readonly createdAt: string;
}

export interface EvaluationResponse {
  readonly assessment: EvaluationAssessmentRecord | null;
  readonly csrfToken?: string;
}

export interface LiveShadowState {
  readonly episodeCount: number;
  readonly snapshotCount: number;
  readonly decisionCount: number;
  readonly latestDecidedAt: string | null;
  readonly latestMarketId: string | null;
  readonly sourcePlane: "SHANNON_FORWARD";
  readonly blockchainWrite: false;
}

export interface LiveShadowResponse {
  readonly liveShadow: LiveShadowState;
  readonly csrfToken?: string;
}

export interface LiveShadowObserveResponse {
  readonly observation: {
    readonly leaseAcquired: boolean;
    readonly holderId: string;
    readonly discoveredMarketCount: number;
    readonly observed: readonly {
      readonly marketId: string;
      readonly snapshotId: string | null;
      readonly insertedDecisionCount: number;
      readonly reusedDecisionCount: number;
      readonly skipped: boolean;
      readonly reasonCode?: string;
    }[];
  };
  readonly liveShadow: LiveShadowState;
}

export interface ExperimentCreateInput {
  readonly name: string;
  readonly mode: "HISTORICAL_REPLAY" | "LIVE_SHADOW";
  readonly asset: "BTC" | "ETH";
  readonly intervalSec: 900 | 3600 | 14400 | 86400;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly marketId?: string;
  readonly riskEnvelopeId: "WATCH_ONLY_BOUNDED";
}

const csrfStorageKey = "edgelab.research.csrf";

function getStoredCsrfToken(): string | null {
  if (typeof globalThis.localStorage === "undefined") {
    return null;
  }
  return globalThis.localStorage.getItem(csrfStorageKey);
}

function storeCsrfToken(token: string): void {
  if (typeof globalThis.localStorage !== "undefined") {
    globalThis.localStorage.setItem(csrfStorageKey, token);
  }
}

export async function fetchV2<TData, TMeta = Record<string, unknown>>(
  path: string
): Promise<V2Envelope<TData, TMeta>> {
  return await fetchV2Request<TData, TMeta>(path);
}

export async function fetchV2Request<TData, TMeta = Record<string, unknown>>(
  path: string,
  init: RequestInit = {}
): Promise<V2Envelope<TData, TMeta>> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers
  });
  const payload = (await response.json()) as unknown;
  if (!response.ok) {
    const body = payload as ApiErrorBody;
    throw new ApiError(body.error.message, response.status, body);
  }
  return payload as V2Envelope<TData, TMeta>;
}

export async function ensureResearchSession(): Promise<V2Envelope<ResearchSessionResponse>> {
  const response = await fetchV2Request<ResearchSessionResponse>("/api/v2/research-session", {
    method: "POST"
  });
  storeCsrfToken(response.data.csrfToken);
  return response;
}

export async function createExperiment(input: ExperimentCreateInput): Promise<V2Envelope<ExperimentDetailResponse>> {
  let csrfToken = getStoredCsrfToken();
  if (csrfToken === null) {
    csrfToken = (await ensureResearchSession()).data.csrfToken;
  }
  const response = await fetchV2Request<ExperimentDetailResponse>("/api/v2/experiments", {
    method: "POST",
    headers: {
      "x-csrf-token": csrfToken,
      "idempotency-key": `lab-${globalThis.crypto.randomUUID()}`
    },
    body: JSON.stringify(input)
  });
  if (response.data.csrfToken !== undefined) {
    storeCsrfToken(response.data.csrfToken);
  }
  return response;
}

export async function listExperiments(): Promise<V2Envelope<ExperimentsResponse>> {
  const response = await fetchV2Request<ExperimentsResponse>("/api/v2/experiments");
  storeCsrfToken(response.data.csrfToken);
  return response;
}

export async function fetchExperimentDetail(experimentId: string): Promise<V2Envelope<ExperimentDetailResponse>> {
  const response = await fetchV2Request<ExperimentDetailResponse>(`/api/v2/experiments/${experimentId}`);
  if (response.data.csrfToken !== undefined) {
    storeCsrfToken(response.data.csrfToken);
  }
  return response;
}

export async function fetchReplayRun(experimentId: string): Promise<V2Envelope<ReplayResponse>> {
  const response = await fetchV2Request<ReplayResponse>(`/api/v2/experiments/${experimentId}/replay`);
  if (response.data.csrfToken !== undefined) {
    storeCsrfToken(response.data.csrfToken);
  }
  return response;
}

export async function runHistoricalReplay(experimentId: string): Promise<V2Envelope<ReplayResponse>> {
  let csrfToken = getStoredCsrfToken();
  if (csrfToken === null) {
    csrfToken = (await ensureResearchSession()).data.csrfToken;
  }
  const response = await fetchV2Request<ReplayResponse>(`/api/v2/experiments/${experimentId}/replay`, {
    method: "POST",
    headers: {
      "x-csrf-token": csrfToken,
      "idempotency-key": `replay-${globalThis.crypto.randomUUID()}`
    }
  });
  if (response.data.csrfToken !== undefined) {
    storeCsrfToken(response.data.csrfToken);
  }
  return response;
}

export async function fetchLatestEvaluation(experimentId: string): Promise<V2Envelope<EvaluationResponse>> {
  const response = await fetchV2Request<EvaluationResponse>(`/api/v2/experiments/${experimentId}/evaluation/latest`);
  if (response.data.csrfToken !== undefined) {
    storeCsrfToken(response.data.csrfToken);
  }
  return response;
}

export async function evaluateExperiment(experimentId: string): Promise<V2Envelope<{ readonly assessment: EvaluationAssessmentRecord }>> {
  let csrfToken = getStoredCsrfToken();
  if (csrfToken === null) {
    csrfToken = (await ensureResearchSession()).data.csrfToken;
  }
  const response = await fetchV2Request<{ readonly assessment: EvaluationAssessmentRecord }>(
    `/api/v2/experiments/${experimentId}/evaluate`,
    {
      method: "POST",
      headers: {
        "x-csrf-token": csrfToken,
        "idempotency-key": `evaluate-${globalThis.crypto.randomUUID()}`
      }
    }
  );
  return response;
}

export async function fetchLiveShadowState(experimentId: string): Promise<V2Envelope<LiveShadowResponse>> {
  const response = await fetchV2Request<LiveShadowResponse>(`/api/v2/experiments/${experimentId}/live-shadow`);
  if (response.data.csrfToken !== undefined) {
    storeCsrfToken(response.data.csrfToken);
  }
  return response;
}

export async function observeLiveShadow(experimentId: string): Promise<V2Envelope<LiveShadowObserveResponse>> {
  let csrfToken = getStoredCsrfToken();
  if (csrfToken === null) {
    csrfToken = (await ensureResearchSession()).data.csrfToken;
  }
  return await fetchV2Request<LiveShadowObserveResponse>(`/api/v2/experiments/${experimentId}/live-shadow/observe`, {
    method: "POST",
    headers: {
      "x-csrf-token": csrfToken,
      "idempotency-key": `live-${globalThis.crypto.randomUUID()}`
    }
  });
}

export function apiErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.body?.error.message ?? error.message;
  }
  return error instanceof Error ? error.message : "Request failed";
}

export function formatEpoch(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}

export function compactId(value: string): string {
  if (value.length <= 18) {
    return value;
  }
  return `${value.slice(0, 10)}...${value.slice(-8)}`;
}

export const capturedSummary: EvidenceSummary = {
  ok: true,
  counts: {
    experiments: 0,
    episodes: 0,
    snapshots: 0,
    decisions: 0,
    settlements: 0,
    metricRuns: 0,
    assessments: 0
  },
  chain: {
    submittedOrderCount: 1,
    fillCount: 0,
    terminalOrderCount: 1,
    openOrderCount: 0,
    latestTerminalState: "EXPIRED",
    tradeabilityStatus: "EVALUATED"
  }
};

export const minimumSample = 30;
export const explorerBase = "https://shannon-explorer.somnia.network";
export const proofWalletAddress = ["0x6b3a87a4bbf7", "d7d324df227d", "640fc42ebf987971"].join("");

export const proofRows: readonly ProofRow[] = [
  {
    label: "Wallet",
    value: "0x6b3a...7971",
    href: `${explorerBase}/address/${proofWalletAddress}`
  },
  {
    label: "Approval",
    value: "0xeb2c...5312",
    href: `${explorerBase}/tx/${[
      "0xeb2ce83146e757b",
      "8bb5b204e01b711d2",
      "e9dd479a35fc336d",
      "ef101c722e905312"
    ].join("")}`
  },
  {
    label: "Order",
    value: "0x666d...4196",
    href: `${explorerBase}/tx/${[
      "0x666d5d5a5dc95914",
      "ef6ae14684d96405",
      "5f936bf52c199658",
      "50ed1c773b954196"
    ].join("")}`
  },
  {
    label: "Terminal",
    value: "0x9405...02fd",
    href: `${explorerBase}/tx/${[
      "0x94057033d8cd59cd",
      "1c58a6efa21d25cc",
      "7dc00c4eb0a0a0ea",
      "a2cfefb860ab02fd"
    ].join("")}`
  },
  {
    label: "Order ID",
    value: "110680464442257591736",
    href: null
  }
];

export const policyRows = [
  {
    name: "Watch-only calibration",
    version: "reference-a/1.0.0",
    action: "WATCH_ONLY",
    observations: 0,
    calibration: "NOT AVAILABLE",
    tradeability: "shared Shannon probe verified",
    risk: "bounded",
    pnl: "NOT AVAILABLE",
    promotion: "not evaluated"
  },
  {
    name: "Neutral abstain baseline",
    version: "reference-b/1.0.0",
    action: "ABSTAIN",
    observations: 0,
    calibration: "NOT AVAILABLE",
    tradeability: "shared Shannon probe verified",
    risk: "bounded",
    pnl: "NOT AVAILABLE",
    promotion: "not evaluated"
  }
] as const;

export const capturedSummarySource = "CAPTURED" as const;
