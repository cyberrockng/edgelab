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

export async function fetchV2<TData, TMeta = Record<string, unknown>>(
  path: string
): Promise<V2Envelope<TData, TMeta>> {
  const response = await fetch(path, {
    headers: { accept: "application/json" }
  });
  const payload = (await response.json()) as unknown;
  if (!response.ok) {
    const body = payload as ApiErrorBody;
    throw new ApiError(body.error.message, response.status, body);
  }
  return payload as V2Envelope<TData, TMeta>;
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
