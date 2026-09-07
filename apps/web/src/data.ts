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

export interface ExecutionProofLifecycleStep {
  readonly state: string;
  readonly title: string;
  readonly detail: string;
  readonly txHash: string | null;
  readonly href: string | null;
}

export interface ExecutionProofResponse {
  readonly proof: {
    readonly evidenceId: "EXG-003";
    readonly status: "VERIFIED";
    readonly network: {
      readonly name: string;
      readonly chainId: 50312;
      readonly explorerUrl: string;
    };
    readonly lifecycle: readonly ExecutionProofLifecycleStep[];
    readonly order: {
      readonly orderId: string;
      readonly marketId: string;
      readonly side: string;
      readonly priceRaw: string;
      readonly quantityRaw: string;
      readonly filledQuantityRaw: string;
      readonly fillStatus: string;
      readonly terminalEvent: "OrderExpired";
      readonly cancelFunction: string;
    };
    readonly reconciliation: {
      readonly fillObserved: boolean;
      readonly fillRequired: boolean;
      readonly collateralReconciled: boolean;
      readonly unexpectedOpenOrder: boolean;
      readonly selfTrade: boolean;
      readonly fakeVolume: boolean;
      readonly pnlStatus: "NOT_AVAILABLE";
    };
    readonly technical: readonly ProofRow[];
    readonly sourceArtifacts: readonly string[];
  };
}

export interface ObservationProofResponse {
  readonly observationProof: {
    readonly proofId: "OBSERVE-001";
    readonly status: string;
    readonly capturedAt: string;
    readonly evidenceClass: string;
    readonly scope: string;
    readonly sourcePlane: "SHANNON_FORWARD";
    readonly chainId: 50312;
    readonly sdkVersion: string;
    readonly transactionSubmitted: false;
    readonly walletRequired: false;
    readonly experimentId: string;
    readonly captureMethod: string;
    readonly observedMarketCount: number;
    readonly totalShadowDecisions: number;
    readonly implementedControls: readonly string[];
    readonly observedMarkets: readonly {
      readonly stableMarketId: string;
      readonly asset: string;
      readonly intervalSeconds: number;
      readonly poolAddress: string;
      readonly marketNonce: string;
      readonly expiresAt: string;
      readonly snapshotId: string;
      readonly snapshotHash: string;
      readonly decisionCount: number;
    }[];
    readonly validation: {
      readonly integrationTest: string;
      readonly lint: string;
      readonly typecheck: string;
      readonly test: string;
      readonly build: string;
      readonly fullVerification: string;
    };
    readonly judgeSummary: {
      readonly oneLine: string;
      readonly strongestEvidence: readonly string[];
      readonly nextMilestone: string;
      readonly blockedClaims: readonly string[];
    };
  };
}

export interface ExecutionCandidateResponse {
  readonly executionCandidate: {
    readonly status: "READY" | "BLOCKED";
    readonly intentHash: string;
    readonly account: string;
    readonly validatedAt: string;
    readonly sourcePlane: "SHANNON_EXECUTION";
    readonly network: {
      readonly name: string;
      readonly chainId: 50312;
    };
    readonly market: {
      readonly stableMarketId: string;
      readonly marketAddress: string;
      readonly poolAddress: string;
      readonly asset: string;
      readonly intervalSeconds: number | null;
      readonly expirySeconds: number;
      readonly quoteDecimals: number;
      readonly collateral: string;
    };
    readonly strategyLink: {
      readonly experimentId: string;
      readonly configurationId: string;
      readonly assessmentId: string;
      readonly assessmentHash: string;
      readonly qualificationVerdict: "STRATEGY_QUALIFIED";
      readonly qualificationRuleVersion: string;
      readonly eligibleForwardObservationCount: number;
      readonly qualifiedAt: string;
      readonly sourceObservationPolicy: string;
      readonly linkedHistoricalPolicy: string;
      readonly snapshotHash: string;
      readonly decision: {
        readonly policyId: string;
        readonly policyVersion: string;
        readonly forecastPUp: number;
        readonly action: string;
        readonly reasonCodes: readonly string[];
        readonly decidedAt: string;
        readonly snapshotHash: string;
        readonly policyHash: string;
      };
    };
    readonly risk: {
      readonly maxEscrowRaw: string;
      readonly maxEscrowDisplay: string;
      readonly orderCount: 1;
      readonly orderType: "ImmediateOrCancel";
      readonly serverSigner: false;
      readonly mainnetWrite: false;
      readonly expiryHeadroomSeconds: number;
      readonly minExpiryHeadroomSec: number;
      readonly minimumPoolEscrowRaw: string | null;
      readonly minimumPoolEscrowDisplay: string | null;
      readonly capAdequateForPoolMinimum: boolean;
      readonly priceAcceptable: boolean;
      readonly requiredEscrowRaw: string;
      readonly observedBlockNumber: string;
      readonly collateralResolvedFromMarket: string;
      readonly poolCollateral: string;
      readonly collateralBindingMatches: boolean;
      readonly walletBalanceRaw: string;
      readonly walletAllowanceRaw: string;
      readonly walletNativeBalanceRaw: string;
      readonly walletHasRequiredCollateral: boolean;
      readonly walletHasGas: boolean;
    };
    readonly sizing: {
      readonly side: string;
      readonly priceRaw: string | null;
      readonly availableQuantityRaw: string | null;
      readonly quantityRaw: string;
      readonly minQuantityRaw: string;
      readonly lotSizeRaw: string;
      readonly tickSizeRaw: string;
      readonly expireTimestampNs: string;
    };
    readonly unsignedTransactions: {
      readonly order: {
        readonly to: string;
        readonly data: string;
        readonly valueRaw: string;
        readonly description: string;
      };
      readonly approval: {
        readonly to: string;
        readonly data: string;
        readonly valueRaw: string;
        readonly description: string;
      } | null;
    } | null;
    readonly blockedReasons: readonly string[];
    readonly controls: readonly string[];
    readonly blockedClaims: readonly string[];
  };
}

export interface ControlledLiquidityCandidateResponse {
  readonly controlledLiquidityCandidate: {
    readonly status: "READY" | "BLOCKED";
    readonly maker: string;
    readonly sourcePlane: "SHANNON_EXECUTION";
    readonly network: {
      readonly name: string;
      readonly chainId: 50312;
    };
    readonly market: {
      readonly stableMarketId: string;
      readonly marketAddress: string;
      readonly poolAddress: string;
      readonly asset: string;
      readonly intervalSeconds: number | null;
      readonly expirySeconds: number;
      readonly quoteDecimals: number;
      readonly collateral: string;
    };
    readonly setup: {
      readonly setupKind: "CONTROLLED_TESTNET_LIQUIDITY";
      readonly makerAddress: string;
      readonly poolAddress: string;
      readonly side: "SELL_YES" | "SELL_NO";
      readonly priceRaw: string;
      readonly quantityRaw: string;
      readonly expireTimestampNs: string;
      readonly outcomeToken: string;
      readonly collateral: string;
      readonly outcomeId: string;
      readonly calls: readonly {
        readonly to: string;
        readonly data: string;
        readonly valueRaw: string;
        readonly description: string;
      }[];
      readonly disclosures: readonly string[];
    } | null;
    readonly sizing: {
      readonly side: "SELL_YES" | "SELL_NO";
      readonly priceRaw: string;
      readonly quantityRaw: string;
      readonly minQuantityRaw: string;
      readonly lotSizeRaw: string;
      readonly expireTimestampNs: string;
    };
    readonly risk: {
      readonly controlledLiquidity: true;
      readonly organicLiquidityClaim: false;
      readonly serverSigner: false;
      readonly mainnetWrite: false;
      readonly approvalScope: string;
      readonly maxSetupCollateralRaw: string;
      readonly maxSetupCollateralDisplay: string;
      readonly expiryHeadroomSeconds: number;
      readonly minExpiryHeadroomSec: number;
    };
    readonly blockedReasons: readonly string[];
    readonly nextStep: string;
  };
}

export interface ExecutionReceiptImportResponse {
  readonly executionReceipt: {
    readonly status: "TX_PENDING" | "TX_REVERTED" | "APPROVED" | "UNFILLED" | "PARTIALLY_FILLED" | "FILLED" | "CANCELLED" | "EXPIRED" | "UNVERIFIED" | "FAILED";
    readonly intentId: string;
    readonly intentHash: string;
    readonly txHash: string;
    readonly txRole: "approval" | "order";
    readonly account: string;
    readonly receiptStatus: boolean | null;
    readonly blockNumber: string | null;
    readonly logHash: string | null;
    readonly lifecycleDecoded: boolean;
    readonly order: {
      readonly orderId: string;
      readonly state: string;
      readonly requestedQuantityRaw: string;
      readonly filledQuantityRaw: string;
      readonly remainingQuantityRaw: string;
      readonly fillState: "NO_FILL" | "PARTIAL_FILL" | "FULL_FILL";
      readonly terminal: boolean;
      readonly fillCount: number;
    } | null;
    readonly nextMissingProof: string;
  };
}

export interface ExecutionLifecycleResponse {
  readonly executionLifecycle: {
    readonly intentId: string;
    readonly intentHash: string;
    readonly experimentId: string;
    readonly state: string;
    readonly qualification: {
      readonly verdict: string;
      readonly assessmentId: string;
      readonly assessmentHash: string;
      readonly policyVersionId: string;
      readonly policyId: string;
      readonly policyVersion: string;
      readonly policyHash: string;
    };
    readonly candidate: {
      readonly marketId: string;
      readonly poolAddress: string;
      readonly side: string;
      readonly priceRaw: string;
      readonly requestedQuantityRaw: string;
      readonly escrowRaw: string;
      readonly validatedAt: string;
    };
    readonly transactions: Record<"approval" | "order" | "redeem", {
      readonly txHash: string;
      readonly state: "NOT_SUBMITTED" | "PENDING" | "CONFIRMED" | "REVERTED";
      readonly blockNumber: string | null;
      readonly verifiedAt: string | null;
    } | null>;
    readonly order: {
      readonly orderId: string;
      readonly state: string;
      readonly requestedQuantityRaw: string;
      readonly filledQuantityRaw: string;
      readonly remainingQuantityRaw: string;
      readonly fillState: "UNKNOWN" | "NO_FILL" | "PARTIAL_FILL" | "FULL_FILL";
      readonly fillCount: number;
      readonly evidenceSource: string;
      readonly observedAt: string;
    } | null;
    readonly settlement: {
      readonly state: "NOT_APPLICABLE" | "SETTLED" | "PENDING_OR_UNKNOWN";
      readonly marketStatus: string | null;
      readonly resolved: boolean | null;
      readonly voided: boolean | null;
      readonly winner: string | null;
      readonly observedAt: string | null;
    };
    readonly redemption: {
      readonly state:
        | "NOT_APPLICABLE"
        | "NOT_APPLICABLE_LOSS"
        | "REDEEMED"
        | "REDEEMABLE"
        | "REDEMPTION_PENDING"
        | "REDEMPTION_REVERTED"
        | "UNKNOWN"
        | "NOT_YET_REDEEMABLE";
      readonly claimableAmountRaw: string;
      readonly estimatedPayoutRaw: string;
      readonly redeemedQuantityRaw: string | null;
      readonly actualPayoutRaw: string | null;
      readonly evidenceSource: string | null;
    };
    readonly lastReconciledAt: string | null;
    readonly createdAt: string;
    readonly publicClaim: string;
  } | null;
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
  readonly quoteDecimals?: number;
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
  readonly status: "QUEUED" | "RUNNING" | "COMPLETED" | "SOURCE_BLOCKED" | "SUCCEEDED" | "FAILED" | "CANCELLED";
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
  readonly verdict: "PROMOTE_TO_FORWARD_OBSERVATION" | "STRATEGY_QUALIFIED" | "HOLD" | "REJECT" | "INSUFFICIENT_EVIDENCE";
  readonly reasonCodes: readonly string[];
  readonly sampleSize: number;
  readonly exclusionCount: number;
  readonly brierScore: number | null;
  readonly calibrationBias: number | null;
  readonly neutralBaselineDelta: number | null;
  readonly tradeabilityStatus: string;
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

export interface EvidenceGateRow {
  readonly dimension: string;
  readonly status: "PASS" | "BLOCKED" | "PENDING" | "NOT_AVAILABLE" | "VERIFIED";
  readonly value: string;
  readonly detail: string;
}

export interface EvidenceGateRecord {
  readonly experimentId: string;
  readonly assessment: AssessmentSummaryRecord;
  readonly decision: {
    readonly verdict: EvaluationAssessmentRecord["verdict"];
    readonly reason: string;
    readonly supportingEvidence: readonly string[];
    readonly missingEvidence: readonly string[];
    readonly nextPermittedAction: string;
    readonly doesNotAuthorize: readonly string[];
    readonly sourcePlane: string;
    readonly promotionScope: string;
    readonly decidedAt: string;
  };
  readonly progression: {
    readonly candidateId: string;
    readonly currentStage: string;
    readonly stages: readonly {
      readonly stage: string;
      readonly plane: string;
      readonly status: string;
      readonly detail: string;
    }[];
  };
  readonly gateRows: readonly EvidenceGateRow[];
  readonly missingEvidence: readonly string[];
  readonly verdictReasons: readonly string[];
  readonly nextPermittedAction: string;
  readonly serverAuthored: true;
}

export interface EvidenceGateResponse {
  readonly evidence: EvidenceGateRecord | null;
  readonly state: "READY" | "EVALUATION_REQUIRED";
  readonly message: string;
  readonly csrfToken?: string;
}

export interface ProvenExperimentSummary {
  readonly slug: "proven-experiment";
  readonly title: string;
  readonly verdict: EvaluationAssessmentRecord["verdict"];
  readonly sampleSize: number;
  readonly sourcePlane: string;
  readonly policy: string;
  readonly route: string;
  readonly evidenceRoute: string;
  readonly exportPath: string;
}

export interface ProvenExperimentRecord extends ProvenExperimentSummary {
  readonly status: "PUBLIC_PROVEN";
  readonly selectionDisclosure: string;
  readonly source: {
    readonly plane: "MAINNET_HISTORICAL";
    readonly chainId: 5031;
    readonly sdkVersion: string;
    readonly writePolicy: string;
  };
  readonly market: {
    readonly stableMarketId: string;
    readonly asset: string;
    readonly intervalSeconds: number;
    readonly status: string;
    readonly normalizedOutcome: string;
  };
  readonly experiment: {
    readonly experimentId: string;
    readonly mode: "HISTORICAL_REPLAY";
    readonly policy: string;
    readonly riskEnvelope: string;
  };
  readonly replay: {
    readonly status: "COMPLETED" | "SUCCEEDED";
    readonly selectedCount: number;
    readonly processedCount: number;
    readonly scoredCount: number;
    readonly excludedCount: number;
    readonly outputHash: string;
    readonly bookReconstruction: string;
    readonly blockchainWrite: false;
  };
  readonly decision: {
    readonly marketId: string;
    readonly action: string;
    readonly forecastPUp: number | null;
    readonly outcomeResult: string | null;
    readonly frameHash: string;
    readonly reasonCodes: readonly string[];
  };
  readonly antiLookahead: {
    readonly decisionFrames: string;
    readonly outcomeEmbargo: string;
    readonly futureCandlesExcluded: boolean;
    readonly futureFillsExcluded: boolean;
    readonly resolutionEmbargoedFromPolicy: boolean;
  };
  readonly assessment: AssessmentSummaryRecord;
  readonly evidenceGate: EvidenceGateRecord;
  readonly reproducibility: {
    readonly sourceArtifacts: readonly string[];
    readonly replayOutputHash: string;
    readonly inputHash: string;
    readonly assessmentHash: string;
    readonly exportPath: string;
  };
}

export interface ProvenExperimentsResponse {
  readonly provenExperiments: readonly ProvenExperimentSummary[];
}

export interface ProvenExperimentResponse {
  readonly provenExperiment: ProvenExperimentRecord;
}

export interface LiveShadowState {
  readonly episodeCount: number;
  readonly snapshotCount: number;
  readonly decisionCount: number;
  readonly eligibleDecisionCount: number;
  readonly abstentionCount: number;
  readonly pendingOutcomeCount: number;
  readonly timingExcludedDecisionCount: number;
  readonly excludedEpisodeCount: number;
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
    readonly discoveryIssue?: {
      readonly reasonCode: string;
      readonly message: string;
    };
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

export interface AssessmentSummaryRecord extends EvaluationAssessmentRecord {
  readonly experimentId: string;
  readonly experimentName: string;
}

export interface AssessmentListResponse {
  readonly assessments: readonly AssessmentSummaryRecord[];
  readonly csrfToken?: string;
}

export interface ComparisonRecord {
  readonly comparisonId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly items: readonly (AssessmentSummaryRecord & { readonly displayOrder: number })[];
}

export interface ComparisonSummaryRecord {
  readonly comparisonId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly itemCount: number;
}

export interface ComparisonListResponse {
  readonly comparisons: readonly ComparisonSummaryRecord[];
  readonly csrfToken?: string;
}

export interface ComparisonResponse {
  readonly comparison: ComparisonRecord | null;
  readonly csrfToken?: string;
}

export interface ExperimentCreateInput {
  readonly name: string;
  readonly mode: "HISTORICAL_REPLAY" | "LIVE_SHADOW";
  readonly asset: "BTC" | "ETH";
  readonly intervalSec: 900 | 3600;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly marketId?: string;
  readonly windowFrom?: string;
  readonly windowTo?: string;
  readonly decisionOffsetSec?: number;
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

export async function fetchEvidenceGate(experimentId: string): Promise<V2Envelope<EvidenceGateResponse>> {
  const response = await fetchV2Request<EvidenceGateResponse>(`/api/v2/experiments/${experimentId}/evidence`);
  if (response.data.csrfToken !== undefined) {
    storeCsrfToken(response.data.csrfToken);
  }
  return response;
}

export async function fetchProvenExperiments(): Promise<V2Envelope<ProvenExperimentsResponse>> {
  return await fetchV2Request<ProvenExperimentsResponse>("/api/v2/proven-experiments");
}

export async function fetchProvenExperiment(slug = "proven-experiment"): Promise<V2Envelope<ProvenExperimentResponse>> {
  return await fetchV2Request<ProvenExperimentResponse>(`/api/v2/proven-experiments/${slug}`);
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

export async function fetchAssessments(): Promise<V2Envelope<AssessmentListResponse>> {
  const response = await fetchV2Request<AssessmentListResponse>("/api/v2/assessments");
  if (response.data.csrfToken !== undefined) {
    storeCsrfToken(response.data.csrfToken);
  }
  return response;
}

export async function fetchExecutionProof(): Promise<V2Envelope<ExecutionProofResponse>> {
  return await fetchV2Request<ExecutionProofResponse>("/api/v2/proof/exg-003");
}

export async function fetchObservationProof(): Promise<V2Envelope<ObservationProofResponse>> {
  return await fetchV2Request<ObservationProofResponse>("/api/v2/observation-proof");
}

export async function fetchExecutionCandidate(input: {
  readonly experimentId: string;
  readonly account: string;
  readonly asset: "BTC" | "ETH";
  readonly intervalSec: 900 | 3600;
}): Promise<V2Envelope<ExecutionCandidateResponse>> {
  const params = new URLSearchParams({
    experimentId: input.experimentId,
    account: input.account,
    asset: input.asset,
    intervalSec: String(input.intervalSec)
  });
  return await fetchV2Request<ExecutionCandidateResponse>(`/api/v2/shannon/execution-candidate?${params.toString()}`);
}

export async function revalidateExecutionCandidate(input: {
  readonly experimentId: string;
  readonly account: string;
  readonly asset: "BTC" | "ETH";
  readonly intervalSec: 900 | 3600;
}): Promise<V2Envelope<ExecutionCandidateResponse & { readonly intentId: string }>> {
  let csrfToken = getStoredCsrfToken();
  if (csrfToken === null) {
    csrfToken = (await ensureResearchSession()).data.csrfToken;
  }
  return await fetchV2Request<ExecutionCandidateResponse & { readonly intentId: string }>(
    "/api/v2/shannon/execution-candidates/revalidate",
    {
      method: "POST",
      headers: {
        "x-csrf-token": csrfToken,
        "idempotency-key": `execution-revalidate-${globalThis.crypto.randomUUID()}`
      },
      body: JSON.stringify(input)
    }
  );
}

export async function revalidateExecutionOrder(
  intentId: string
): Promise<V2Envelope<ExecutionCandidateResponse & {
  readonly intentId: string;
  readonly signingValidation: {
    readonly status: "READY";
    readonly validatedAt: string;
    readonly observedBlockNumber: string;
    readonly exactOrderCallUnchanged: true;
  };
}>> {
  let csrfToken = getStoredCsrfToken();
  if (csrfToken === null) {
    csrfToken = (await ensureResearchSession()).data.csrfToken;
  }
  return await fetchV2Request(`/api/v2/execution-intents/${encodeURIComponent(intentId)}/revalidate-order`, {
    method: "POST",
    headers: {
      "x-csrf-token": csrfToken,
      "idempotency-key": `execution-order-revalidate-${globalThis.crypto.randomUUID()}`
    },
    body: "{}"
  });
}

export async function fetchControlledLiquidityCandidate(input: {
  readonly maker: string;
  readonly asset: "BTC" | "ETH";
  readonly intervalSec: 900 | 3600;
  readonly side: "SELL_YES" | "SELL_NO";
  readonly priceRaw: string;
  readonly quantityRaw: string;
}): Promise<V2Envelope<ControlledLiquidityCandidateResponse>> {
  const params = new URLSearchParams({
    maker: input.maker,
    asset: input.asset,
    intervalSec: String(input.intervalSec),
    side: input.side,
    priceRaw: input.priceRaw,
    quantityRaw: input.quantityRaw
  });
  return await fetchV2Request<ControlledLiquidityCandidateResponse>(`/api/v2/shannon/controlled-liquidity-candidate?${params.toString()}`);
}

export async function importExecutionReceipt(input: {
  readonly intentHash: string;
  readonly txHash: string;
  readonly txRole: "approval" | "order";
}): Promise<V2Envelope<ExecutionReceiptImportResponse>> {
  let csrfToken = getStoredCsrfToken();
  if (csrfToken === null) {
    csrfToken = (await ensureResearchSession()).data.csrfToken;
  }
  return await fetchV2Request<ExecutionReceiptImportResponse>("/api/v2/shannon/execution-receipts", {
    method: "POST",
    headers: {
      "x-csrf-token": csrfToken,
      "idempotency-key": `execution-${input.txRole}-${input.intentHash}-${input.txHash.slice(2, 18)}`
    },
    body: JSON.stringify(input)
  });
}

export async function fetchExperimentExecution(experimentId: string): Promise<V2Envelope<ExecutionLifecycleResponse>> {
  return await fetchV2Request<ExecutionLifecycleResponse>(`/api/v2/experiments/${encodeURIComponent(experimentId)}/execution`);
}

export async function reconcileExecutionIntent(intentId: string): Promise<V2Envelope<ExecutionLifecycleResponse>> {
  let csrfToken = getStoredCsrfToken();
  if (csrfToken === null) {
    csrfToken = (await ensureResearchSession()).data.csrfToken;
  }
  return await fetchV2Request<ExecutionLifecycleResponse>(`/api/v2/execution-intents/${encodeURIComponent(intentId)}/reconcile`, {
    method: "POST",
    headers: {
      "x-csrf-token": csrfToken,
      "idempotency-key": `execution-reconcile-${intentId}-${String(Date.now())}`
    },
    body: "{}"
  });
}

export async function createComparison(input: {
  readonly name: string;
  readonly assessmentIds: readonly string[];
}): Promise<V2Envelope<ComparisonResponse>> {
  let csrfToken = getStoredCsrfToken();
  if (csrfToken === null) {
    csrfToken = (await ensureResearchSession()).data.csrfToken;
  }
  return await fetchV2Request<ComparisonResponse>("/api/v2/comparisons", {
    method: "POST",
    headers: {
      "x-csrf-token": csrfToken,
      "idempotency-key": `compare-${globalThis.crypto.randomUUID()}`
    },
    body: JSON.stringify(input)
  });
}

export async function fetchComparisons(): Promise<V2Envelope<ComparisonListResponse>> {
  const response = await fetchV2Request<ComparisonListResponse>("/api/v2/comparisons");
  if (response.data.csrfToken !== undefined) {
    storeCsrfToken(response.data.csrfToken);
  }
  return response;
}

export async function fetchComparison(comparisonId: string): Promise<V2Envelope<ComparisonResponse>> {
  const response = await fetchV2Request<ComparisonResponse>(`/api/v2/comparisons/${comparisonId}`);
  if (response.data.csrfToken !== undefined) {
    storeCsrfToken(response.data.csrfToken);
  }
  return response;
}

export async function revokeResearchSession(): Promise<V2Envelope<{ readonly revoked: boolean }>> {
  let csrfToken = getStoredCsrfToken();
  if (csrfToken === null) {
    csrfToken = (await ensureResearchSession()).data.csrfToken;
  }
  const response = await fetchV2Request<{ readonly revoked: boolean }>("/api/v2/research-session/revoke", {
    method: "POST",
    headers: {
      "x-csrf-token": csrfToken,
      "idempotency-key": `session-revoke-${globalThis.crypto.randomUUID()}`
    }
  });
  if (typeof globalThis.localStorage !== "undefined") {
    globalThis.localStorage.removeItem(csrfStorageKey);
  }
  return response;
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
