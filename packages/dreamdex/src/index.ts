import {
  SOMNIA_MAINNET_ADDRESSES,
  SOMNIA_TESTNET_ADDRESSES,
  SomniaMarkets,
  type BinaryMarket,
  type BinaryOrderBook,
  outcomeId,
  type BinarySide,
  type Candle,
  type FillRow,
  type MarketStatusUpdate,
  type PastBinaryMarketsOptions,
  type Trader,
  type TraderConfig,
  type UnsignedOrder
} from "@somnia-chain/markets-sdk";
import {
  DREAMDEX_MARKETS_SDK_VERSION,
  type EvidencePlane,
  SOMNIA_MAINNET_CHAIN_ID,
  SOMNIA_SHANNON_CHAIN_ID,
  type EvidenceClass
} from "@edgelab/domain";
import { createPublicClient, defineChain, encodeFunctionData, http, parseAbi, type Address } from "viem";
import { z } from "zod";

export interface DreamDexReadConfig {
  readonly rpcUrl: string;
  readonly wsRpcUrl: string;
  readonly indexerUrl: string;
  readonly chainId: number;
  readonly sdkVersion: string;
}

export interface MainnetHistoricalDreamDexConfig {
  readonly rpcUrl: string;
  readonly indexerUrl: string;
  readonly chainId: number;
  readonly sdkVersion: string;
}

export interface DreamDexBookLevel {
  readonly priceRaw: string;
  readonly quantityRaw: string;
}

export type HistoricalBookReconstructionCapability =
  | "UNVERIFIED"
  | "BLOCK_LEVEL"
  | "EVENT_LEVEL"
  | "UNSUPPORTED"
  | "SOURCE_INCOMPLETE";
export type HistoricalMarketStatus = "Resolved" | "Finalized";
export type HistoricalAsset = "BTC" | "ETH";

export interface HistoricalPageOptions {
  readonly limit?: number;
  readonly offset?: number;
}

export interface HistoricalMarketFilters extends HistoricalPageOptions {
  readonly asset?: HistoricalAsset;
  readonly intervalSec?: number;
  readonly status?: HistoricalMarketStatus;
  readonly fromSec?: number;
  readonly toSec?: number;
  readonly frozenAtSec?: number;
}

export interface HistoricalTimeWindowPageOptions extends HistoricalPageOptions {
  readonly fromSec?: number;
  readonly toSec?: number;
}

export interface NormalizedHistoricalPage {
  readonly limit: number;
  readonly offset: number;
}

export interface HistoricalDreamDexSourceMeta {
  readonly plane: EvidencePlane;
  readonly chainId: typeof SOMNIA_MAINNET_CHAIN_ID;
  readonly rpcUrl: string;
  readonly indexerUrl: string;
  readonly sdkVersion: typeof DREAMDEX_MARKETS_SDK_VERSION;
  readonly evidenceClass: Extract<EvidenceClass, "LIVE">;
  readonly retrievedAt: string;
  readonly writePolicy: "read-only-no-mainnet-signer";
}

export interface HistoricalMarketEvidence {
  readonly stableMarketId: string;
  readonly marketAddress: string;
  readonly poolAddress: string;
  readonly nonce: string | null;
  readonly asset: HistoricalAsset;
  readonly question: string;
  readonly status: string;
  readonly finalized: boolean;
  readonly winningOutcome: string | null;
  readonly intervalSeconds: number | null;
  readonly tradingStartSeconds: number;
  readonly expirySeconds: number;
  readonly collateral: string;
  readonly quoteDecimals: number;
  readonly tradeCount: number;
  readonly openingPriceRaw: string | null;
  readonly source: HistoricalDreamDexSourceMeta;
}

export interface HistoricalMarketPage {
  readonly rows: readonly HistoricalMarketEvidence[];
  readonly page: NormalizedHistoricalPage;
  readonly hasMore: boolean;
  readonly excludedMalformedRows: number;
  readonly frozenAtSeconds: number;
  readonly source: HistoricalDreamDexSourceMeta;
}

export interface HistoricalCandleEvidence {
  readonly bucketStartSeconds: number;
  readonly intervalSeconds: number;
  readonly openPriceRaw: string;
  readonly highPriceRaw: string;
  readonly lowPriceRaw: string;
  readonly closePriceRaw: string;
  readonly baseVolumeRaw: string;
  readonly quoteVolumeRaw: string;
  readonly tradeCount: number;
  readonly source: HistoricalDreamDexSourceMeta;
}

export interface HistoricalMarketStatusEvidence {
  readonly oldStatus: string;
  readonly newStatus: string;
  readonly blockNumber: string;
  readonly timestampSeconds: number;
  readonly txHash: string;
  readonly source: HistoricalDreamDexSourceMeta;
}

export interface HistoricalResolutionEvidence {
  readonly marketId: string;
  readonly openingAnswer: unknown;
  readonly closingAnswer: unknown;
  readonly reference: unknown;
  readonly events: readonly unknown[];
  readonly source: HistoricalDreamDexSourceMeta;
}

export interface HistoricalOrderEvidence {
  readonly id: string;
  readonly orderId: string;
  readonly marketId: string;
  readonly side: string;
  readonly isBid: boolean | null;
  readonly priceRaw: string;
  readonly fullQuantityRaw: string;
  readonly filledQuantityRaw: string;
  readonly remainingQuantityRaw: string;
  readonly status: string;
  readonly rested: boolean;
  readonly expireTimestampNs: string;
  readonly placedAtBlock: string;
  readonly placedAtTimestampSeconds: number;
  readonly lastUpdatedAtBlock: string;
  readonly lastUpdatedAtTimestampSeconds: number;
  readonly placedTxHash: string;
  readonly source: HistoricalDreamDexSourceMeta;
}

export interface HistoricalFillEvidence {
  readonly id: string;
  readonly marketId: string;
  readonly poolAddress: string;
  readonly fillPriceRaw: string;
  readonly quantityRaw: string;
  readonly quoteQuantityRaw: string;
  readonly kind: string | null;
  readonly makerOrderId: string | null;
  readonly makerRemainingQuantityRaw: string | null;
  readonly makerSide: string | null;
  readonly takerOrderId: string | null;
  readonly takerRemainingQuantityRaw: string | null;
  readonly takerSide: string | null;
  readonly takerIsBid: boolean | null;
  readonly timestampSeconds: number;
  readonly blockNumber: string;
  readonly transactionIndex?: string | null;
  readonly logIndex: string;
  readonly txHash: string;
  readonly source: HistoricalDreamDexSourceMeta;
}

export interface HistoricalRowsPage<T> {
  readonly rows: readonly T[];
  readonly page: NormalizedHistoricalPage;
  readonly hasMore: boolean;
  readonly source: HistoricalDreamDexSourceMeta;
}

export const DREAMDEX_MAINNET_INDEXER_URL = "https://prd.smk.somnia.host/v1/graphql" as const;
export const SOMNIA_MAINNET_RPC_URL = "https://api.infra.mainnet.somnia.network" as const;
export const HISTORICAL_GRAPHQL_QUERY_VERSION = "edgelab-mainnet-history-v1" as const;
export const HISTORICAL_BOOK_RECONSTRUCTION_CAPABILITY =
  "SOURCE_INCOMPLETE" satisfies HistoricalBookReconstructionCapability;
export const HISTORICAL_CANDLE_INTERVAL_SECONDS = [
  60,
  300,
  900,
  3600,
  14400,
  86400
] as const;

export const HISTORICAL_MAX_PAGE_LIMIT = 100 as const;
export const HISTORICAL_DEFAULT_PAGE_LIMIT = 25 as const;
export const HISTORICAL_MAX_OFFSET = 10_000 as const;

export const HISTORICAL_MARKET_ORDERS_QUERY = `query EdgeLabHistoricalOrders($marketId: String!, $limit: Int!, $offset: Int!) {
  Order(
    where: { market_id: { _eq: $marketId } }
    order_by: [{ placedAtBlock: asc }, { lastUpdatedAtBlock: asc }, { id: asc }]
    limit: $limit
    offset: $offset
  ) {
    id
    orderId
    market_id
    side
    isBid
    price
    fullQuantity
    filledQuantity
    quantityRemaining
    status
    rested
    expireTimestampNs
    placedAtBlock
    placedAtTimestamp
    lastUpdatedAtBlock
    lastUpdatedAtTimestamp
    placedTxHash
  }
}`;

export const HISTORICAL_MARKET_FILLS_QUERY = `query EdgeLabHistoricalFills($marketId: String!, $limit: Int!, $offset: Int!) {
  Fill(
    where: { market_id: { _eq: $marketId } }
    order_by: [{ blockNumber: asc }, { logIndex: asc }, { id: asc }]
    limit: $limit
    offset: $offset
  ) {
    id
    market_id
    pool
    fillPrice
    quantity
    quoteQuantity
    kind
    makerOrderId
    makerRemainingQuantity
    makerSide
    takerOrderId
    takerRemainingQuantity
    takerSide
    takerIsBid
    timestamp
    blockNumber
    logIndex
    txHash
  }
}`;

export const SHANNON_LIVE_OPEN_ORDERS_QUERY = `query EdgeLabShannonLiveOpenOrders($marketId: String!, $limit: Int!) {
  Order(
    where: {
      market_id: { _eq: $marketId }
      status: { _eq: "Open" }
      rested: { _eq: true }
    }
    order_by: [{ price: asc }, { placedAtBlock: asc }, { id: asc }]
    limit: $limit
  ) {
    side
    isBid
    price
    quantityRemaining
    status
    rested
  }
}`;

export const historicalDreamDexSourceContract = {
  version: HISTORICAL_GRAPHQL_QUERY_VERSION,
  network: {
    label: "Somnia Mainnet historical research",
    chainId: SOMNIA_MAINNET_CHAIN_ID,
    rpcUrl: SOMNIA_MAINNET_RPC_URL,
    indexerUrl: DREAMDEX_MAINNET_INDEXER_URL,
    writePolicy: "read-only-no-mainnet-signer"
  },
  sdk: {
    packageName: "@somnia-chain/markets-sdk",
    requiredVersion: DREAMDEX_MARKETS_SDK_VERSION,
    requiredMethods: [
      "countBinaryMarkets",
      "listPastBinaryMarkets",
      "getMarketResolution",
      "getMarketStatusHistory",
      "getOpeningPrices",
      "getCandles",
      "getFills",
      "getOrders",
      "getBinaryPositionPnL"
    ]
  },
  indexerFields: {
    order: [
      "side",
      "price",
      "fullQuantity",
      "filledQuantity",
      "quantityRemaining",
      "placedAtBlock",
      "lastUpdatedAtBlock"
    ],
    fill: [
      "fillPrice",
      "quantity",
      "kind",
      "txHash",
      "blockNumber",
      "logIndex",
      "makerOrderId",
      "takerOrderId",
      "makerRemainingQuantity",
      "takerRemainingQuantity"
    ],
    candle: [
      "openPrice",
      "high",
      "low",
      "closePrice",
      "baseVolume",
      "quoteVolume",
      "tradeCount"
    ]
  },
  candleIntervals: HISTORICAL_CANDLE_INTERVAL_SECONDS,
  bookReconstructionCapability: HISTORICAL_BOOK_RECONSTRUCTION_CAPABILITY
} as const;

export interface DreamDexMarketEvidence {
  readonly stableMarketId: string;
  readonly marketAddress: string;
  readonly poolAddress: string;
  readonly nonce: string | null;
  readonly asset: "BTC" | "ETH";
  readonly question: string;
  readonly status: string;
  readonly intervalSeconds: number | null;
  readonly tradingStartSeconds: number;
  readonly expirySeconds: number;
  readonly collateral: string;
  readonly quoteDecimals: number;
  readonly lastPriceRaw: string | null;
  readonly lastTradeAtSeconds: number | null;
  readonly source: {
    readonly sdkVersion: typeof DREAMDEX_MARKETS_SDK_VERSION;
    readonly chainId: typeof SOMNIA_SHANNON_CHAIN_ID;
    readonly rpcUrl: string;
    readonly indexerUrl: string;
    readonly evidenceClass: EvidenceClass;
    readonly retrievedAt: string;
  };
}

export interface DreamDexSnapshotEvidence {
  readonly market: DreamDexMarketEvidence;
  readonly book: {
    readonly yesBids: readonly DreamDexBookLevel[];
    readonly yesAsks: readonly DreamDexBookLevel[];
    readonly noBids: readonly DreamDexBookLevel[];
    readonly noAsks: readonly DreamDexBookLevel[];
  };
}

export interface DreamDexUnsignedCallEvidence {
  readonly to: string;
  readonly data: string;
  readonly valueRaw: string;
  readonly description: string;
}

export interface DreamDexUnsignedOrderEvidence {
  readonly order: DreamDexUnsignedCallEvidence;
  readonly approval: DreamDexUnsignedCallEvidence | null;
}

export interface DreamDexControlledLiquidityEvidence {
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
  readonly calls: readonly DreamDexUnsignedCallEvidence[];
  readonly disclosures: readonly string[];
}

export interface DreamDexExecutionReadinessEvidence {
  readonly observedBlockNumber: string;
  readonly marketCollateral: string;
  readonly poolCollateral: string;
  readonly collateralBindingMatches: boolean;
  readonly walletBalanceRaw: string;
  readonly walletAllowanceRaw: string;
  readonly walletNativeBalanceRaw: string;
}

export type DreamDexReadResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly reasonCode:
        | "DREAMDEX_CONFIG_INVALID"
        | "DREAMDEX_READ_FAILED"
        | "DREAMDEX_NO_ELIGIBLE_MARKET"
        | "DREAMDEX_MALFORMED_MARKET";
      readonly message: string;
    };

export type HistoricalDreamDexReadResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly reasonCode:
        | "DREAMDEX_HISTORICAL_CONFIG_INVALID"
        | "DREAMDEX_HISTORICAL_BOUNDS_INVALID"
        | "DREAMDEX_HISTORICAL_READ_FAILED"
        | "DREAMDEX_HISTORICAL_MALFORMED_MARKET"
        | "DREAMDEX_HISTORICAL_CAPABILITY_UNVERIFIED";
      readonly message: string;
    };

export interface DreamDexSdkClient {
  listLiveBinaryMarkets(filter?: {
    readonly asset?: string;
    readonly intervalSec?: number;
    readonly status?: string;
  }): Promise<BinaryMarket[]>;
  getBinaryBookParams(pool: string): Promise<{
    readonly tickSize: bigint;
    readonly lotSize: bigint;
    readonly minQuantity: bigint;
  }>;
  getLiveBinaryOrderBookByMarket(marketId: string, opts?: { readonly depth?: number }): BinaryOrderBook;
  getBinaryMarket(id: string): Promise<BinaryMarket | null>;
  getOrders?(owner: string, opts?: { readonly pool?: string; readonly limit?: number }): Promise<readonly {
    readonly orderId: string;
    readonly market: string;
    readonly pool: string;
    readonly status: "Open" | "Closed" | "Filled" | "Cancelled" | "Expired";
    readonly fullQuantity: string;
    readonly filledQuantity: string;
    readonly quantityRemaining: string;
    readonly placedTxHash: string;
  }[]>;
  getOrderOnchain?(pool: string, orderId: bigint): Promise<{
    readonly orderId: bigint;
    readonly fullQuantity: bigint;
    readonly quantityRemaining: bigint;
  } | null>;
  getClaimable?(account: string): Promise<readonly {
    readonly marketId: string;
    readonly pool: string;
    readonly outcomeIdx: 0 | 1;
    readonly amount: bigint;
    readonly estPayout: bigint;
    readonly status: string;
  }[]>;
  getRouterActions?(account: string, opts?: {
    readonly market?: string;
    readonly kind?: "Redeem" | "MintCompleteSet" | "MergeCompleteSet";
    readonly limit?: number;
    readonly offset?: number;
  }): Promise<readonly {
    readonly id: string;
    readonly kind: "Redeem" | "MintCompleteSet" | "MergeCompleteSet";
    readonly account: string;
    readonly market: string | null;
    readonly amount: string;
    readonly payout: string | null;
    readonly routedVia: string | null;
    readonly timestamp: string;
    readonly txHash: string;
  }[]>;
  createTrader?(config: TraderConfig): Trader;
}

export interface HistoricalDreamDexSdkClient {
  countBinaryMarkets(opts: PastBinaryMarketsOptions & { readonly phase: "past" }): Promise<number>;
  listPastBinaryMarkets(opts?: PastBinaryMarketsOptions): Promise<BinaryMarket[]>;
  getBinaryMarket(id: string): Promise<BinaryMarket | null>;
  getMarketResolution(marketId: string): Promise<{
    readonly events: readonly unknown[];
    readonly reference: unknown;
    readonly closingAnswer: unknown;
    readonly openingAnswer: unknown;
  }>;
  getMarketStatusHistory(marketId: string): Promise<MarketStatusUpdate[]>;
  getOpeningPrices(marketIds: string[]): Promise<Record<string, string | null>>;
  getCandles(
    poolAddress: string,
    intervalSeconds: number,
    opts?: { readonly limit?: number; readonly from?: number; readonly to?: number }
  ): Promise<Candle[]>;
  getFills(pool: string, opts?: HistoricalTimeWindowPageOptions): Promise<FillRow[]>;
}

export type HistoricalIndexerFetch = (
  input: string,
  init: {
    readonly method: "POST";
    readonly headers: Record<string, string>;
    readonly body: string;
    readonly signal: AbortSignal;
  }
) => Promise<{ readonly ok: boolean; readonly status: number; json(): Promise<unknown> }>;

export type HistoricalRpcFetch = (
  input: string,
  init: {
    readonly method: "POST";
    readonly headers: Record<string, string>;
    readonly body: string;
    readonly signal: AbortSignal;
  }
) => Promise<{ readonly ok: boolean; readonly status: number; json(): Promise<unknown> }>;

export interface HistoricalCutoffBlock {
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly timestampSeconds: number;
  readonly decisionAtSeconds: number;
  readonly finalityTag: "finalized";
  readonly rule: "GREATEST_FINALIZED_BLOCK_STRICTLY_BEFORE_DECISION_AT";
}

export const HISTORICAL_READ_DEADLINE_MS = 10_000 as const;
const HistoricalRetryDelaysMs = [500, 1_500] as const;
const ShannonRetryDelaysMs = [250, 750, 1_500] as const;
const erc20ApproveAbi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
const erc20ReadAbi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)"
]);
const binaryMarketCollateralAbi = parseAbi(["function collateral() view returns (address)"]);
const binaryPoolSetupAbi = parseAbi([
  "function getOrderBookParameters() view returns ((uint256 tickSize, uint256 minQuantity, uint256 lotSize))",
  "function outcomeToken() view returns (address)",
  "function collateralToken() view returns (address)",
  "function marketNonce() view returns (uint64)",
  "function mintSet(address yesTo, address noTo, uint256 amount)",
  "function placeBinaryOrder(uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k, uint64 userData) payable returns (bool success, uint128 id)"
]);
const erc6909OperatorAbi = parseAbi(["function setOperator(address spender, bool approved) returns (bool)"]);

class HistoricalReadFailure extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "HistoricalReadFailure";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function dreamDexErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "DreamDEX read failed";
}

async function withShannonReadRetries<T>(label: string, operation: () => T | Promise<T>): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= ShannonRetryDelaysMs.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const delay = ShannonRetryDelaysMs[attempt];
      if (delay === undefined) {
        break;
      }
      await sleep(delay);
    }
  }
  throw new Error(`${label} failed after ${String(ShannonRetryDelaysMs.length + 1)} attempts: ${dreamDexErrorMessage(lastError)}`);
}

const GraphQlErrorSchema = z.object({
  message: z.string().min(1)
});

const JsonRpcBlockSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.number(),
  result: z
    .object({
      number: z.string().regex(/^0x[0-9a-fA-F]+$/),
      hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      timestamp: z.string().regex(/^0x[0-9a-fA-F]+$/)
    })
    .nullable(),
  error: z
    .object({
      code: z.number(),
      message: z.string()
    })
    .optional()
});

const HistoricalOrderRowSchema = z.object({
  id: z.string().min(1),
  orderId: z.string().min(1),
  market_id: z.string().min(1),
  side: z.string().min(1),
  isBid: z.boolean().nullable(),
  price: z.string().min(1),
  fullQuantity: z.string().min(1),
  filledQuantity: z.string().min(1),
  quantityRemaining: z.string().min(1),
  status: z.string().min(1),
  rested: z.boolean(),
  expireTimestampNs: z.string().min(1),
  placedAtBlock: z.string().min(1),
  placedAtTimestamp: z.string().min(1),
  lastUpdatedAtBlock: z.string().min(1),
  lastUpdatedAtTimestamp: z.string().min(1),
  placedTxHash: z.string().min(1)
});

const LiveOpenOrderRowSchema = z.object({
  side: z.string().min(1),
  isBid: z.boolean().nullable(),
  price: z.string().min(1),
  quantityRemaining: z.string().min(1),
  status: z.string().min(1),
  rested: z.boolean()
});

const LiveOpenOrdersPayloadSchema = z.object({
  data: z.object({
    Order: z.array(LiveOpenOrderRowSchema)
  })
});

const HistoricalFillRowSchema = z.object({
  id: z.string().min(1),
  market_id: z.string().min(1),
  pool: z.string().min(1),
  fillPrice: z.string().min(1),
  quantity: z.string().min(1),
  quoteQuantity: z.string().min(1),
  kind: z.string().nullable(),
  makerOrderId: z.string().nullable(),
  makerRemainingQuantity: z.string().nullable(),
  makerSide: z.string().nullable(),
  takerOrderId: z.string().nullable(),
  takerRemainingQuantity: z.string().nullable(),
  takerSide: z.string().nullable(),
  takerIsBid: z.boolean().nullable(),
  timestamp: z.string().min(1),
  blockNumber: z.string().min(1),
  logIndex: z.union([z.string().min(1), z.number().int().nonnegative()]).transform((value) => String(value)),
  txHash: z.string().min(1)
});

export const somniaShannonTestnet = defineChain({
  id: SOMNIA_SHANNON_CHAIN_ID,
  name: "Somnia Shannon Testnet",
  nativeCurrency: {
    name: "Somnia Test Token",
    symbol: "STT",
    decimals: 18
  },
  rpcUrls: {
    default: {
      http: ["https://api.infra.testnet.somnia.network/"],
      webSocket: ["wss://api.infra.testnet.somnia.network/ws"]
    }
  },
  blockExplorers: {
    default: {
      name: "Somnia Shannon Explorer",
      url: "https://shannon-explorer.somnia.network/"
    }
  },
  testnet: true
});

export const somniaMainnetReadOnly = defineChain({
  id: SOMNIA_MAINNET_CHAIN_ID,
  name: "Somnia Mainnet",
  nativeCurrency: {
    name: "Somnia",
    symbol: "SOMI",
    decimals: 18
  },
  rpcUrls: {
    default: {
      http: [SOMNIA_MAINNET_RPC_URL]
    }
  },
  testnet: false
});

export function validateDreamDexReadConfig(config: DreamDexReadConfig): DreamDexReadConfig {
  if (config.chainId !== SOMNIA_SHANNON_CHAIN_ID) {
    throw new Error(`DreamDEX reads must target Somnia Shannon chain ${String(SOMNIA_SHANNON_CHAIN_ID)}`);
  }
  if (config.sdkVersion !== DREAMDEX_MARKETS_SDK_VERSION) {
    throw new Error(`DreamDEX SDK must be pinned to ${DREAMDEX_MARKETS_SDK_VERSION}`);
  }
  return config;
}

export function validateMainnetHistoricalDreamDexConfig(
  config: MainnetHistoricalDreamDexConfig
): MainnetHistoricalDreamDexConfig {
  if (config.chainId !== SOMNIA_MAINNET_CHAIN_ID) {
    throw new Error(`DreamDEX historical reads must target Somnia mainnet chain ${String(SOMNIA_MAINNET_CHAIN_ID)}`);
  }
  if (config.sdkVersion !== DREAMDEX_MARKETS_SDK_VERSION) {
    throw new Error(`DreamDEX SDK must be pinned to ${DREAMDEX_MARKETS_SDK_VERSION}`);
  }
  return config;
}

export function createDreamDexSdkClient(config: DreamDexReadConfig): DreamDexSdkClient {
  const validated = validateDreamDexReadConfig(config);
  return new SomniaMarkets({
    chain: {
      ...somniaShannonTestnet,
      rpcUrls: {
        default: {
          http: [validated.rpcUrl],
          webSocket: [validated.wsRpcUrl]
        }
      }
    },
    wsRpcUrl: validated.wsRpcUrl,
    indexerUrl: validated.indexerUrl,
    addresses: SOMNIA_TESTNET_ADDRESSES
  }).client;
}

export function createMainnetHistoricalDreamDexSdkClient(
  config: MainnetHistoricalDreamDexConfig
): HistoricalDreamDexSdkClient {
  const validated = validateMainnetHistoricalDreamDexConfig(config);
  return new SomniaMarkets({
    chain: {
      ...somniaMainnetReadOnly,
      rpcUrls: {
        default: {
          http: [validated.rpcUrl]
        }
      }
    },
    indexerUrl: validated.indexerUrl,
    addresses: SOMNIA_MAINNET_ADDRESSES
  }).client;
}

function parsePositiveInteger(value: string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function ensureHistoricalConfig(
  config: MainnetHistoricalDreamDexConfig
): HistoricalDreamDexReadResult<MainnetHistoricalDreamDexConfig> {
  try {
    return { ok: true, value: validateMainnetHistoricalDreamDexConfig(config) };
  } catch (error) {
    return {
      ok: false,
      reasonCode: "DREAMDEX_HISTORICAL_CONFIG_INVALID",
      message: error instanceof Error ? error.message : "DreamDEX historical configuration is invalid"
    };
  }
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export async function executeBoundedHistoricalRead<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: {
    readonly deadlineMs?: number;
    readonly retryDelaysMs?: readonly number[];
  } = {}
): Promise<T> {
  const deadlineMs = options.deadlineMs ?? HISTORICAL_READ_DEADLINE_MS;
  const retryDelaysMs = options.retryDelaysMs ?? HistoricalRetryDelaysMs;
  const deadlineAt = Date.now() + deadlineMs;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error("DreamDEX historical read deadline exceeded"));
    }, remainingMs);
    try {
      return await Promise.race([
        operation(controller.signal),
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => {
              reject(new HistoricalReadFailure("DreamDEX historical read deadline exceeded", false));
            },
            { once: true }
          );
        })
      ]);
    } catch (error) {
      lastError = error;
      const retryable = !(error instanceof HistoricalReadFailure) || error.retryable;
      const delayMs = retryDelaysMs[attempt];
      if (!retryable || delayMs === undefined || Date.now() + delayMs >= deadlineAt) {
        break;
      }
      await wait(delayMs);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new HistoricalReadFailure("DreamDEX historical read deadline exceeded", false);
}

function historicalSourceMeta(
  config: MainnetHistoricalDreamDexConfig,
  retrievedAt: string
): HistoricalDreamDexSourceMeta {
  return {
    plane: "MAINNET_HISTORICAL",
    chainId: SOMNIA_MAINNET_CHAIN_ID,
    rpcUrl: config.rpcUrl,
    indexerUrl: config.indexerUrl,
    sdkVersion: DREAMDEX_MARKETS_SDK_VERSION,
    evidenceClass: "LIVE",
    retrievedAt,
    writePolicy: "read-only-no-mainnet-signer"
  };
}

async function readHistoricalRpcBlock(
  config: MainnetHistoricalDreamDexConfig,
  blockTag: string,
  requestId: number,
  fetchImpl: HistoricalRpcFetch
): Promise<HistoricalDreamDexReadResult<{ readonly number: bigint; readonly hash: string; readonly timestampSeconds: number }>> {
  try {
    const response = await fetchImpl(config.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method: "eth_getBlockByNumber",
        params: [blockTag, false]
      }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) {
      return {
        ok: false,
        reasonCode: "DREAMDEX_HISTORICAL_READ_FAILED",
        message: `Somnia mainnet RPC returned HTTP ${String(response.status)}`
      };
    }
    const parsed = JsonRpcBlockSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.error !== undefined || parsed.data.result === null) {
      return {
        ok: false,
        reasonCode: "DREAMDEX_HISTORICAL_READ_FAILED",
        message: parsed.success && parsed.data.error !== undefined
          ? `Somnia mainnet RPC error: ${parsed.data.error.message}`
          : "Somnia mainnet RPC block response was invalid"
      };
    }
    const timestampSeconds = Number(BigInt(parsed.data.result.timestamp));
    if (!Number.isSafeInteger(timestampSeconds)) {
      return {
        ok: false,
        reasonCode: "DREAMDEX_HISTORICAL_READ_FAILED",
        message: "Somnia mainnet RPC block timestamp exceeded the safe integer range"
      };
    }
    return {
      ok: true,
      value: {
        number: BigInt(parsed.data.result.number),
        hash: parsed.data.result.hash.toLowerCase(),
        timestampSeconds
      }
    };
  } catch (error) {
    return {
      ok: false,
      reasonCode: "DREAMDEX_HISTORICAL_READ_FAILED",
      message: error instanceof Error ? error.message : "Somnia mainnet RPC block read failed"
    };
  }
}

export async function resolveHistoricalCutoffBlock(
  config: MainnetHistoricalDreamDexConfig,
  decisionAtSeconds: number,
  fetchImpl: HistoricalRpcFetch = fetch
): Promise<HistoricalDreamDexReadResult<HistoricalCutoffBlock>> {
  const validated = ensureHistoricalConfig(config);
  if (!validated.ok) {
    return validated;
  }
  if (!Number.isSafeInteger(decisionAtSeconds) || decisionAtSeconds <= 0) {
    return {
      ok: false,
      reasonCode: "DREAMDEX_HISTORICAL_BOUNDS_INVALID",
      message: "Historical decision time must be a positive integer epoch second"
    };
  }
  let requestId = 1;
  const finalized = await readHistoricalRpcBlock(validated.value, "finalized", requestId, fetchImpl);
  requestId += 1;
  if (!finalized.ok) {
    return finalized;
  }
  let selected = finalized.value.timestampSeconds < decisionAtSeconds ? finalized.value : null;
  let low = 0n;
  let high = selected === null ? finalized.value.number - 1n : -1n;
  while (low <= high) {
    const midpoint = low + (high - low) / 2n;
    const candidate = await readHistoricalRpcBlock(
      validated.value,
      `0x${midpoint.toString(16)}`,
      requestId,
      fetchImpl
    );
    requestId += 1;
    if (!candidate.ok) {
      return candidate;
    }
    if (candidate.value.timestampSeconds < decisionAtSeconds) {
      selected = candidate.value;
      low = midpoint + 1n;
    } else {
      high = midpoint - 1n;
    }
  }
  if (selected === null) {
    return {
      ok: false,
      reasonCode: "DREAMDEX_HISTORICAL_READ_FAILED",
      message: "No finalized Somnia mainnet block exists strictly before the decision time"
    };
  }
  return {
    ok: true,
    value: {
      blockNumber: selected.number.toString(),
      blockHash: selected.hash,
      timestampSeconds: selected.timestampSeconds,
      decisionAtSeconds,
      finalityTag: "finalized",
      rule: "GREATEST_FINALIZED_BLOCK_STRICTLY_BEFORE_DECISION_AT"
    }
  };
}

export async function resolveHistoricalCutoffBlockAfter(
  config: MainnetHistoricalDreamDexConfig,
  decisionAtSeconds: number,
  lowerBound: HistoricalCutoffBlock,
  fetchImpl: HistoricalRpcFetch = fetch
): Promise<HistoricalDreamDexReadResult<HistoricalCutoffBlock>> {
  const validated = ensureHistoricalConfig(config);
  if (!validated.ok) {
    return validated;
  }
  if (!Number.isSafeInteger(decisionAtSeconds) || decisionAtSeconds <= 0) {
    return {
      ok: false,
      reasonCode: "DREAMDEX_HISTORICAL_BOUNDS_INVALID",
      message: "Historical decision time must be a positive integer epoch second"
    };
  }
  if (lowerBound.timestampSeconds >= decisionAtSeconds) {
    return resolveHistoricalCutoffBlock(validated.value, decisionAtSeconds, fetchImpl);
  }
  const lowerNumber = BigInt(lowerBound.blockNumber);
  let requestId = 1;
  const finalized = await readHistoricalRpcBlock(validated.value, "finalized", requestId, fetchImpl);
  requestId += 1;
  if (!finalized.ok) {
    return finalized;
  }
  let selected = {
    number: lowerNumber,
    hash: lowerBound.blockHash,
    timestampSeconds: lowerBound.timestampSeconds
  };
  if (finalized.value.timestampSeconds < decisionAtSeconds) {
    selected = finalized.value;
  } else {
    let step = 1n;
    let upper = finalized.value.number - 1n;
    let firstAtOrAfter: bigint | null = null;
    while (selected.number + step <= upper) {
      const candidateNumber = selected.number + step;
      const candidate = await readHistoricalRpcBlock(
        validated.value,
        `0x${candidateNumber.toString(16)}`,
        requestId,
        fetchImpl
      );
      requestId += 1;
      if (!candidate.ok) {
        return candidate;
      }
      if (candidate.value.timestampSeconds < decisionAtSeconds) {
        selected = candidate.value;
        step *= 2n;
        continue;
      }
      firstAtOrAfter = candidate.value.number;
      upper = candidate.value.number - 1n;
      break;
    }
    if (firstAtOrAfter === null && selected.number < upper) {
      firstAtOrAfter = upper + 1n;
    }
    let low = selected.number + 1n;
    let high = firstAtOrAfter === null ? upper : firstAtOrAfter - 1n;
    while (low <= high) {
      const midpoint = low + (high - low) / 2n;
      const candidate = await readHistoricalRpcBlock(
        validated.value,
        `0x${midpoint.toString(16)}`,
        requestId,
        fetchImpl
      );
      requestId += 1;
      if (!candidate.ok) {
        return candidate;
      }
      if (candidate.value.timestampSeconds < decisionAtSeconds) {
        selected = candidate.value;
        low = midpoint + 1n;
      } else {
        high = midpoint - 1n;
      }
    }
  }
  return {
    ok: true,
    value: {
      blockNumber: selected.number.toString(),
      blockHash: selected.hash,
      timestampSeconds: selected.timestampSeconds,
      decisionAtSeconds,
      finalityTag: "finalized",
      rule: "GREATEST_FINALIZED_BLOCK_STRICTLY_BEFORE_DECISION_AT"
    }
  };
}

export function normalizeHistoricalPagination(
  options: HistoricalPageOptions = {}
): NormalizedHistoricalPage {
  const limit = options.limit ?? HISTORICAL_DEFAULT_PAGE_LIMIT;
  const offset = options.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > HISTORICAL_MAX_PAGE_LIMIT) {
    throw new Error(`Historical query limit must be between 1 and ${String(HISTORICAL_MAX_PAGE_LIMIT)}`);
  }
  if (!Number.isInteger(offset) || offset < 0 || offset > HISTORICAL_MAX_OFFSET) {
    throw new Error(`Historical query offset must be between 0 and ${String(HISTORICAL_MAX_OFFSET)}`);
  }
  return { limit, offset };
}

function safeHistoricalPagination(
  options: HistoricalPageOptions
): HistoricalDreamDexReadResult<NormalizedHistoricalPage> {
  try {
    return { ok: true, value: normalizeHistoricalPagination(options) };
  } catch (error) {
    return {
      ok: false,
      reasonCode: "DREAMDEX_HISTORICAL_BOUNDS_INVALID",
      message: error instanceof Error ? error.message : "Historical query bounds are invalid"
    };
  }
}

function normalizeHistoricalTimeWindow(
  options: HistoricalTimeWindowPageOptions
): HistoricalDreamDexReadResult<HistoricalTimeWindowPageOptions & NormalizedHistoricalPage> {
  const page = safeHistoricalPagination(options);
  if (!page.ok) {
    return page;
  }
  if (
    options.fromSec !== undefined &&
    (!Number.isInteger(options.fromSec) || options.fromSec < 0)
  ) {
    return {
      ok: false,
      reasonCode: "DREAMDEX_HISTORICAL_BOUNDS_INVALID",
      message: "Historical fromSec must be a non-negative integer"
    };
  }
  if (options.toSec !== undefined && (!Number.isInteger(options.toSec) || options.toSec < 0)) {
    return {
      ok: false,
      reasonCode: "DREAMDEX_HISTORICAL_BOUNDS_INVALID",
      message: "Historical toSec must be a non-negative integer"
    };
  }
  if (
    options.fromSec !== undefined &&
    options.toSec !== undefined &&
    options.toSec < options.fromSec
  ) {
    return {
      ok: false,
      reasonCode: "DREAMDEX_HISTORICAL_BOUNDS_INVALID",
      message: "Historical toSec must be greater than or equal to fromSec"
    };
  }
  return {
    ok: true,
    value: {
      ...page.value,
      ...(options.fromSec === undefined ? {} : { fromSec: options.fromSec }),
      ...(options.toSec === undefined ? {} : { toSec: options.toSec })
    }
  };
}

function toBookLevels(levels: readonly { readonly price: bigint; readonly quantity: bigint }[]): DreamDexBookLevel[] {
  return levels.map((level) => ({
    priceRaw: level.price.toString(),
    quantityRaw: level.quantity.toString()
  }));
}

function bookHasAnyLevel(book: DreamDexSnapshotEvidence["book"]): boolean {
  return book.yesBids.length + book.yesAsks.length + book.noBids.length + book.noAsks.length > 0;
}

function addAggregatedBookLevel(levels: Map<string, bigint>, priceRaw: string, quantityRaw: string): void {
  if (!/^\d+$/.test(priceRaw) || !/^\d+$/.test(quantityRaw)) {
    return;
  }
  const quantity = BigInt(quantityRaw);
  if (quantity <= 0n) {
    return;
  }
  levels.set(priceRaw, (levels.get(priceRaw) ?? 0n) + quantity);
}

function toAggregatedBookLevels(levels: Map<string, bigint>, sort: "bid" | "ask"): DreamDexBookLevel[] {
  return [...levels.entries()]
    .map(([priceRaw, quantity]) => ({ priceRaw, quantityRaw: quantity.toString() }))
    .sort((left, right) => {
      const leftPrice = BigInt(left.priceRaw);
      const rightPrice = BigInt(right.priceRaw);
      if (leftPrice === rightPrice) {
        return 0;
      }
      if (sort === "bid") {
        return leftPrice > rightPrice ? -1 : 1;
      }
      return leftPrice < rightPrice ? -1 : 1;
    });
}

async function readLiveOpenBookFromIndexer(
  config: DreamDexReadConfig,
  marketId: string,
  limit: number,
  fetchImpl: HistoricalIndexerFetch = fetch
): Promise<DreamDexSnapshotEvidence["book"] | null> {
  const response = await executeBoundedHistoricalRead(async (signal) => {
    const current = await fetchImpl(config.indexerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: SHANNON_LIVE_OPEN_ORDERS_QUERY,
        variables: {
          marketId: marketId.toLowerCase(),
          limit
        }
      }),
      signal
    });
    if (!current.ok) {
      throw new HistoricalReadFailure(
        `DreamDEX Shannon indexer returned HTTP ${String(current.status)}`,
        current.status === 429 || current.status >= 500
      );
    }
    return current;
  });
  const payload = await response.json();
  const errorPayload = z.object({ errors: z.array(GraphQlErrorSchema).optional() }).passthrough().safeParse(payload);
  if (errorPayload.success && errorPayload.data.errors !== undefined && errorPayload.data.errors.length > 0) {
    throw new HistoricalReadFailure(errorPayload.data.errors.map((error) => error.message).join("; "), false);
  }
  const parsed = LiveOpenOrdersPayloadSchema.parse(payload);
  const yesBids = new Map<string, bigint>();
  const yesAsks = new Map<string, bigint>();
  const noBids = new Map<string, bigint>();
  const noAsks = new Map<string, bigint>();
  for (const row of parsed.data.Order) {
    if (row.status !== "Open" || !row.rested) {
      continue;
    }
    if (row.side === "BUY_YES" && row.isBid === true) {
      addAggregatedBookLevel(yesBids, row.price, row.quantityRemaining);
    } else if (row.side === "SELL_YES" && row.isBid === false) {
      addAggregatedBookLevel(yesAsks, row.price, row.quantityRemaining);
    } else if (row.side === "BUY_NO" && row.isBid === true) {
      addAggregatedBookLevel(noBids, row.price, row.quantityRemaining);
    } else if (row.side === "SELL_NO" && row.isBid === false) {
      addAggregatedBookLevel(noAsks, row.price, row.quantityRemaining);
    }
  }
  const book = {
    yesBids: toAggregatedBookLevels(yesBids, "bid"),
    yesAsks: toAggregatedBookLevels(yesAsks, "ask"),
    noBids: toAggregatedBookLevels(noBids, "bid"),
    noAsks: toAggregatedBookLevels(noAsks, "ask")
  };
  return bookHasAnyLevel(book) ? book : null;
}

async function readBinaryBookParamsFromRpc(config: DreamDexReadConfig, poolAddress: string): Promise<{
  readonly tickSize: bigint;
  readonly lotSize: bigint;
  readonly minQuantity: bigint;
}> {
  const publicClient = createPublicClient({
    chain: {
      ...somniaShannonTestnet,
      rpcUrls: {
        default: {
          http: [config.rpcUrl],
          webSocket: [config.wsRpcUrl]
        }
      }
    },
    transport: http(config.rpcUrl)
  });
  const params = await withShannonReadRetries(
    "getOrderBookParameters",
    async () =>
      await publicClient.readContract({
        address: poolAddress as Address,
        abi: binaryPoolSetupAbi,
        functionName: "getOrderBookParameters"
      })
  );
  return {
    tickSize: params.tickSize,
    minQuantity: params.minQuantity,
    lotSize: params.lotSize
  };
}

export function normalizeBinaryMarket(
  market: BinaryMarket,
  config: DreamDexReadConfig,
  retrievedAt: string,
  evidenceClass: EvidenceClass
): DreamDexReadResult<DreamDexMarketEvidence> {
  const tradingStartSeconds = parsePositiveInteger(market.tradingStart);
  const expirySeconds = parsePositiveInteger(market.expiry);
  const intervalSeconds =
    parsePositiveInteger(market.intervalSec ?? null) ??
    (tradingStartSeconds !== null && expirySeconds !== null
      ? expirySeconds - tradingStartSeconds
      : null);
  if (
    !["BTC", "ETH"].includes(market.asset) ||
    tradingStartSeconds === null ||
    expirySeconds === null ||
    expirySeconds <= tradingStartSeconds
  ) {
    return {
      ok: false,
      reasonCode: "DREAMDEX_MALFORMED_MARKET",
      message: "Binary market row failed EdgeLab validation"
    };
  }
  const asset = market.asset as "BTC" | "ETH";
  const lastTradeAtSeconds = parsePositiveInteger(market.lastTradeAt);
  const lastPriceRaw =
    lastTradeAtSeconds !== null && market.lastPrice !== null && /^\d+$/.test(market.lastPrice)
      ? market.lastPrice
      : null;

  return {
    ok: true,
    value: {
      stableMarketId: market.marketId.toLowerCase(),
      marketAddress: market.marketAddress.toLowerCase(),
      poolAddress: market.poolAddress.toLowerCase(),
      nonce: market.nonce ?? null,
      asset,
      question: market.question,
      status: market.status,
      intervalSeconds,
      tradingStartSeconds,
      expirySeconds,
      collateral: market.collateral.toLowerCase(),
      quoteDecimals: market.quoteDecimals,
      lastPriceRaw,
      lastTradeAtSeconds: lastPriceRaw === null ? null : lastTradeAtSeconds,
      source: {
        sdkVersion: DREAMDEX_MARKETS_SDK_VERSION,
        chainId: SOMNIA_SHANNON_CHAIN_ID,
        rpcUrl: config.rpcUrl,
        indexerUrl: config.indexerUrl,
        evidenceClass,
        retrievedAt
      }
    }
  };
}

export function normalizeHistoricalBinaryMarket(
  market: BinaryMarket,
  config: MainnetHistoricalDreamDexConfig,
  retrievedAt: string,
  openingPriceRaw: string | null = null
): HistoricalDreamDexReadResult<HistoricalMarketEvidence> {
  const tradingStartSeconds = parsePositiveInteger(market.tradingStart);
  const expirySeconds = parsePositiveInteger(market.expiry);
  const intervalSeconds =
    parsePositiveInteger(market.intervalSec ?? null) ??
    (tradingStartSeconds !== null && expirySeconds !== null
      ? expirySeconds - tradingStartSeconds
      : null);
  const tradeCount = parsePositiveInteger(market.tradeCount) ?? 0;
  if (
    !["BTC", "ETH"].includes(market.asset) ||
    tradingStartSeconds === null ||
    expirySeconds === null ||
    expirySeconds <= tradingStartSeconds
  ) {
    return {
      ok: false,
      reasonCode: "DREAMDEX_HISTORICAL_MALFORMED_MARKET",
      message: "Historical binary market row failed EdgeLab validation"
    };
  }

  return {
    ok: true,
    value: {
      stableMarketId: market.marketId.toLowerCase(),
      marketAddress: market.marketAddress.toLowerCase(),
      poolAddress: market.poolAddress.toLowerCase(),
      nonce: market.nonce ?? null,
      asset: market.asset as HistoricalAsset,
      question: market.question,
      status: market.status,
      finalized: market.finalized === true,
      winningOutcome: market.winningOutcome === null ? null : String(market.winningOutcome),
      intervalSeconds,
      tradingStartSeconds,
      expirySeconds,
      collateral: market.collateral.toLowerCase(),
      quoteDecimals: market.quoteDecimals,
      tradeCount,
      openingPriceRaw,
      source: historicalSourceMeta(config, retrievedAt)
    }
  };
}

export async function countHistoricalBinaryMarkets(
  client: HistoricalDreamDexSdkClient,
  config: MainnetHistoricalDreamDexConfig,
  filters: Omit<HistoricalMarketFilters, "limit" | "offset"> = {}
): Promise<HistoricalDreamDexReadResult<{ readonly count: number; readonly source: HistoricalDreamDexSourceMeta }>> {
  const validated = ensureHistoricalConfig(config);
  if (!validated.ok) {
    return validated;
  }
  try {
    const countFilters: PastBinaryMarketsOptions & { readonly phase: "past" } = {
      phase: "past",
      ...(filters.asset === undefined ? {} : { asset: filters.asset }),
      ...(filters.intervalSec === undefined ? {} : { intervalSec: filters.intervalSec }),
      ...(filters.status === undefined ? {} : { status: filters.status })
    };
    const count = await executeBoundedHistoricalRead(() => client.countBinaryMarkets(countFilters));
    if (!Number.isInteger(count) || count < 0) {
      return {
        ok: false,
        reasonCode: "DREAMDEX_HISTORICAL_READ_FAILED",
        message: "DreamDEX historical market count was not a non-negative integer"
      };
    }
    const retrievedAt = new Date().toISOString();
    return { ok: true, value: { count, source: historicalSourceMeta(validated.value, retrievedAt) } };
  } catch (error) {
    return {
      ok: false,
      reasonCode: "DREAMDEX_HISTORICAL_READ_FAILED",
      message: error instanceof Error ? error.message : "DreamDEX historical market count failed"
    };
  }
}

export async function listHistoricalBinaryMarkets(
  client: HistoricalDreamDexSdkClient,
  config: MainnetHistoricalDreamDexConfig,
  filters: HistoricalMarketFilters = {}
): Promise<HistoricalDreamDexReadResult<HistoricalMarketPage>> {
  const validated = ensureHistoricalConfig(config);
  if (!validated.ok) {
    return validated;
  }
  const page = safeHistoricalPagination(filters);
  if (!page.ok) {
    return page;
  }
  const frozenAtSeconds = filters.frozenAtSec ?? Math.floor(Date.now() / 1000);
  if (
    !Number.isSafeInteger(frozenAtSeconds) ||
    frozenAtSeconds <= 0 ||
    (filters.fromSec !== undefined && (!Number.isSafeInteger(filters.fromSec) || filters.fromSec < 0)) ||
    (filters.toSec !== undefined && (!Number.isSafeInteger(filters.toSec) || filters.toSec < 0)) ||
    (filters.fromSec !== undefined && filters.toSec !== undefined && filters.fromSec > filters.toSec)
  ) {
    return {
      ok: false,
      reasonCode: "DREAMDEX_HISTORICAL_BOUNDS_INVALID",
      message: "Historical market date/frozen-page bounds are invalid"
    };
  }

  try {
    const queryLimit = page.value.limit + 1;
    const query: PastBinaryMarketsOptions = {
      limit: queryLimit,
      offset: page.value.offset,
      ...(filters.asset === undefined ? {} : { asset: filters.asset }),
      ...(filters.intervalSec === undefined ? {} : { intervalSec: filters.intervalSec }),
      ...(filters.status === undefined ? {} : { status: filters.status })
    };
    const rows = await executeBoundedHistoricalRead(() => client.listPastBinaryMarkets(query));
    const pageRows = rows.slice(0, queryLimit);
    const openingPrices =
      pageRows.length > 0
        ? await executeBoundedHistoricalRead(() =>
            client.getOpeningPrices(pageRows.map((row) => row.marketId.toLowerCase()))
          )
        : {};
    const retrievedAt = new Date().toISOString();
    const normalized = pageRows.map((row) =>
      normalizeHistoricalBinaryMarket(row, validated.value, retrievedAt, openingPrices[row.marketId.toLowerCase()] ?? null)
    );
    const normalizedRows = normalized
      .filter((result): result is { readonly ok: true; readonly value: HistoricalMarketEvidence } => result.ok)
      .map((result) => result.value);
    const validRows = normalizedRows
      .filter(
        (market) =>
          market.expirySeconds <= frozenAtSeconds &&
          (filters.fromSec === undefined || market.expirySeconds >= filters.fromSec) &&
          (filters.toSec === undefined || market.tradingStartSeconds <= filters.toSec)
      )
      .slice(0, page.value.limit);
    return {
      ok: true,
      value: {
        rows: validRows,
        page: page.value,
        hasMore: rows.length > page.value.limit,
        excludedMalformedRows: normalized.length - normalizedRows.length,
        frozenAtSeconds,
        source: historicalSourceMeta(validated.value, retrievedAt)
      }
    };
  } catch (error) {
    return {
      ok: false,
      reasonCode: "DREAMDEX_HISTORICAL_READ_FAILED",
      message: error instanceof Error ? error.message : "DreamDEX historical markets read failed"
    };
  }
}

export async function getHistoricalBinaryMarket(
  client: HistoricalDreamDexSdkClient,
  config: MainnetHistoricalDreamDexConfig,
  marketId: string
): Promise<HistoricalDreamDexReadResult<HistoricalMarketEvidence | null>> {
  const validated = ensureHistoricalConfig(config);
  if (!validated.ok) {
    return validated;
  }
  try {
    const row = await executeBoundedHistoricalRead(() => client.getBinaryMarket(marketId));
    if (row === null) {
      return { ok: true, value: null };
    }
    const openingPrices = await executeBoundedHistoricalRead(() =>
      client.getOpeningPrices([row.marketId.toLowerCase()])
    );
    return normalizeHistoricalBinaryMarket(
      row,
      validated.value,
      new Date().toISOString(),
      openingPrices[row.marketId.toLowerCase()] ?? null
    );
  } catch (error) {
    return {
      ok: false,
      reasonCode: "DREAMDEX_HISTORICAL_READ_FAILED",
      message: error instanceof Error ? error.message : "DreamDEX historical market detail read failed"
    };
  }
}

export async function getHistoricalMarketResolution(
  client: HistoricalDreamDexSdkClient,
  config: MainnetHistoricalDreamDexConfig,
  marketId: string
): Promise<HistoricalDreamDexReadResult<HistoricalResolutionEvidence>> {
  const validated = ensureHistoricalConfig(config);
  if (!validated.ok) {
    return validated;
  }
  try {
    const retrievedAt = new Date().toISOString();
    const resolution = await executeBoundedHistoricalRead(() => client.getMarketResolution(marketId));
    return {
      ok: true,
      value: {
        marketId: marketId.toLowerCase(),
        openingAnswer: resolution.openingAnswer,
        closingAnswer: resolution.closingAnswer,
        reference: resolution.reference,
        events: resolution.events,
        source: historicalSourceMeta(validated.value, retrievedAt)
      }
    };
  } catch (error) {
    return {
      ok: false,
      reasonCode: "DREAMDEX_HISTORICAL_READ_FAILED",
      message: error instanceof Error ? error.message : "DreamDEX historical resolution read failed"
    };
  }
}

export async function getHistoricalMarketStatusHistory(
  client: HistoricalDreamDexSdkClient,
  config: MainnetHistoricalDreamDexConfig,
  marketId: string
): Promise<HistoricalDreamDexReadResult<readonly HistoricalMarketStatusEvidence[]>> {
  const validated = ensureHistoricalConfig(config);
  if (!validated.ok) {
    return validated;
  }
  try {
    const retrievedAt = new Date().toISOString();
    const rows = await executeBoundedHistoricalRead(() => client.getMarketStatusHistory(marketId));
    return {
      ok: true,
      value: rows.map((row) => ({
        oldStatus: row.oldStatus,
        newStatus: row.newStatus,
        blockNumber: row.blockNumber,
        timestampSeconds: Number(row.timestamp),
        txHash: row.txHash,
        source: historicalSourceMeta(validated.value, retrievedAt)
      }))
    };
  } catch (error) {
    return {
      ok: false,
      reasonCode: "DREAMDEX_HISTORICAL_READ_FAILED",
      message: error instanceof Error ? error.message : "DreamDEX historical lifecycle read failed"
    };
  }
}

export async function listHistoricalCandles(
  client: HistoricalDreamDexSdkClient,
  config: MainnetHistoricalDreamDexConfig,
  poolAddress: string,
  intervalSeconds: number,
  options: Omit<HistoricalTimeWindowPageOptions, "offset"> = {}
): Promise<HistoricalDreamDexReadResult<readonly HistoricalCandleEvidence[]>> {
  const validated = ensureHistoricalConfig(config);
  if (!validated.ok) {
    return validated;
  }
  const bounded = normalizeHistoricalTimeWindow(options);
  if (!bounded.ok) {
    return bounded;
  }
  if (!HISTORICAL_CANDLE_INTERVAL_SECONDS.includes(intervalSeconds as (typeof HISTORICAL_CANDLE_INTERVAL_SECONDS)[number])) {
    return {
      ok: false,
      reasonCode: "DREAMDEX_HISTORICAL_BOUNDS_INVALID",
      message: "Historical candle interval is not supported by the DreamDEX indexer"
    };
  }

  try {
    const retrievedAt = new Date().toISOString();
    const candleOptions: { readonly limit?: number; readonly from?: number; readonly to?: number } = {
      limit: bounded.value.limit,
      ...(bounded.value.fromSec === undefined ? {} : { from: bounded.value.fromSec }),
      ...(bounded.value.toSec === undefined ? {} : { to: bounded.value.toSec })
    };
    const rows = await executeBoundedHistoricalRead(() =>
      client.getCandles(poolAddress, intervalSeconds, candleOptions)
    );
    const normalizedRows = rows.map((row) => ({
        bucketStartSeconds: Number(row.bucketStart),
        intervalSeconds,
        openPriceRaw: row.openPrice,
        highPriceRaw: row.high,
        lowPriceRaw: row.low,
        closePriceRaw: row.closePrice,
        baseVolumeRaw: row.baseVolume,
        quoteVolumeRaw: row.quoteVolume,
        tradeCount: row.tradeCount,
        source: historicalSourceMeta(validated.value, retrievedAt)
      }));
    return {
      ok: true,
      value: normalizedRows.filter(
        (row) =>
          (bounded.value.fromSec === undefined || row.bucketStartSeconds >= bounded.value.fromSec) &&
          (bounded.value.toSec === undefined || row.bucketStartSeconds < bounded.value.toSec)
      )
    };
  } catch (error) {
    return {
      ok: false,
      reasonCode: "DREAMDEX_HISTORICAL_READ_FAILED",
      message: error instanceof Error ? error.message : "DreamDEX historical candles read failed"
    };
  }
}

async function executeHistoricalGraphQl<Schema extends z.ZodType>(
  config: MainnetHistoricalDreamDexConfig,
  fetchImpl: HistoricalIndexerFetch,
  query: string,
  variables: Record<string, string | number>,
  schema: Schema
): Promise<HistoricalDreamDexReadResult<z.infer<Schema>>> {
  try {
    const response = await executeBoundedHistoricalRead(async (signal) => {
      const current = await fetchImpl(config.indexerUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
        signal
      });
      if (!current.ok) {
        throw new HistoricalReadFailure(
          `DreamDEX historical indexer returned HTTP ${String(current.status)}`,
          current.status === 429 || current.status >= 500
        );
      }
      return current;
    });
    const payload = await response.json();
    const errorPayload = z.object({ errors: z.array(GraphQlErrorSchema).optional() }).passthrough().safeParse(payload);
    if (errorPayload.success && errorPayload.data.errors !== undefined && errorPayload.data.errors.length > 0) {
      return {
        ok: false,
        reasonCode: "DREAMDEX_HISTORICAL_READ_FAILED",
        message: errorPayload.data.errors.map((error) => error.message).join("; ")
      };
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      return {
        ok: false,
        reasonCode: "DREAMDEX_HISTORICAL_READ_FAILED",
        message: "DreamDEX historical indexer payload did not match the verified schema"
      };
    }
    return { ok: true, value: parsed.data };
  } catch (error) {
    return {
      ok: false,
      reasonCode: "DREAMDEX_HISTORICAL_READ_FAILED",
      message: error instanceof Error ? error.message : "DreamDEX historical indexer read failed"
    };
  }
}

const OrdersPayloadSchema = z.object({
  data: z.object({
    Order: z.array(HistoricalOrderRowSchema)
  })
});

const FillsPayloadSchema = z.object({
  data: z.object({
    Fill: z.array(HistoricalFillRowSchema)
  })
});

export async function listHistoricalOrdersByMarket(
  config: MainnetHistoricalDreamDexConfig,
  marketId: string,
  options: HistoricalPageOptions = {},
  fetchImpl: HistoricalIndexerFetch = fetch
): Promise<HistoricalDreamDexReadResult<HistoricalRowsPage<HistoricalOrderEvidence>>> {
  const validated = ensureHistoricalConfig(config);
  if (!validated.ok) {
    return validated;
  }
  const page = safeHistoricalPagination(options);
  if (!page.ok) {
    return page;
  }
  const queryLimit = page.value.limit + 1;
  const payload = await executeHistoricalGraphQl(
    validated.value,
    fetchImpl,
    HISTORICAL_MARKET_ORDERS_QUERY,
    { marketId: marketId.toLowerCase(), limit: queryLimit, offset: page.value.offset },
    OrdersPayloadSchema
  );
  if (!payload.ok) {
    return payload;
  }
  const retrievedAt = new Date().toISOString();
  const rows = payload.value.data.Order.slice(0, page.value.limit).map((row) => ({
    id: row.id,
    orderId: row.orderId,
    marketId: row.market_id.toLowerCase(),
    side: row.side,
    isBid: row.isBid,
    priceRaw: row.price,
    fullQuantityRaw: row.fullQuantity,
    filledQuantityRaw: row.filledQuantity,
    remainingQuantityRaw: row.quantityRemaining,
    status: row.status,
    rested: row.rested,
    expireTimestampNs: row.expireTimestampNs,
    placedAtBlock: row.placedAtBlock,
    placedAtTimestampSeconds: Number(row.placedAtTimestamp),
    lastUpdatedAtBlock: row.lastUpdatedAtBlock,
    lastUpdatedAtTimestampSeconds: Number(row.lastUpdatedAtTimestamp),
    placedTxHash: row.placedTxHash,
    source: historicalSourceMeta(validated.value, retrievedAt)
  }));
  return {
    ok: true,
    value: {
      rows,
      page: page.value,
      hasMore: payload.value.data.Order.length > page.value.limit,
      source: historicalSourceMeta(validated.value, retrievedAt)
    }
  };
}

export async function listHistoricalFillsByMarket(
  config: MainnetHistoricalDreamDexConfig,
  marketId: string,
  options: HistoricalPageOptions = {},
  fetchImpl: HistoricalIndexerFetch = fetch
): Promise<HistoricalDreamDexReadResult<HistoricalRowsPage<HistoricalFillEvidence>>> {
  const validated = ensureHistoricalConfig(config);
  if (!validated.ok) {
    return validated;
  }
  const page = safeHistoricalPagination(options);
  if (!page.ok) {
    return page;
  }
  const queryLimit = page.value.limit + 1;
  const payload = await executeHistoricalGraphQl(
    validated.value,
    fetchImpl,
    HISTORICAL_MARKET_FILLS_QUERY,
    { marketId: marketId.toLowerCase(), limit: queryLimit, offset: page.value.offset },
    FillsPayloadSchema
  );
  if (!payload.ok) {
    return payload;
  }
  const retrievedAt = new Date().toISOString();
  const rows = payload.value.data.Fill.slice(0, page.value.limit).map((row) => ({
    id: row.id,
    marketId: row.market_id.toLowerCase(),
    poolAddress: row.pool.toLowerCase(),
    fillPriceRaw: row.fillPrice,
    quantityRaw: row.quantity,
    quoteQuantityRaw: row.quoteQuantity,
    kind: row.kind,
    makerOrderId: row.makerOrderId,
    makerRemainingQuantityRaw: row.makerRemainingQuantity,
    makerSide: row.makerSide,
    takerOrderId: row.takerOrderId,
    takerRemainingQuantityRaw: row.takerRemainingQuantity,
    takerSide: row.takerSide,
    takerIsBid: row.takerIsBid,
    timestampSeconds: Number(row.timestamp),
    blockNumber: row.blockNumber,
    transactionIndex: null,
    logIndex: row.logIndex,
    txHash: row.txHash,
    source: historicalSourceMeta(validated.value, retrievedAt)
  }));
  return {
    ok: true,
    value: {
      rows,
      page: page.value,
      hasMore: payload.value.data.Fill.length > page.value.limit,
      source: historicalSourceMeta(validated.value, retrievedAt)
    }
  };
}

export function getHistoricalReconstructedBookCapability(): HistoricalDreamDexReadResult<{
  readonly capability: HistoricalBookReconstructionCapability;
  readonly reason: string;
}> {
  return {
    ok: false,
    reasonCode: "DREAMDEX_HISTORICAL_CAPABILITY_UNVERIFIED",
    message:
      "Historical resting-book reconstruction is unavailable because BOOK-001 could not prove complete order/fill coverage, linked lifecycle semantics, pool-reuse behavior, and archive-state comparison"
  };
}

export async function discoverSuccessorMarkets(
  client: DreamDexSdkClient,
  config: DreamDexReadConfig,
  options: { readonly assets?: readonly ("BTC" | "ETH")[]; readonly intervals?: readonly number[] } = {}
): Promise<DreamDexReadResult<DreamDexMarketEvidence[]>> {
  try {
    validateDreamDexReadConfig(config);
    const rows = await withShannonReadRetries("listLiveBinaryMarkets", async () => await client.listLiveBinaryMarkets({ status: "Trading" }));
    const assets = new Set(options.assets ?? ["BTC", "ETH"]);
    const intervals = new Set(options.intervals ?? [900, 3600]);
    const retrievedAt = new Date().toISOString();
    const normalized = rows
      .map((row) => normalizeBinaryMarket(row, config, retrievedAt, "LIVE"))
      .filter((result): result is { readonly ok: true; readonly value: DreamDexMarketEvidence } => result.ok)
      .map((result) => result.value)
      .filter(
        (market) =>
          assets.has(market.asset) &&
          (market.intervalSeconds === null || intervals.has(market.intervalSeconds))
      )
      .sort((a, b) => a.expirySeconds - b.expirySeconds);

    if (normalized.length === 0) {
      return {
        ok: false,
        reasonCode: "DREAMDEX_NO_ELIGIBLE_MARKET",
        message: "No BTC/ETH Trading successor market matched the requested intervals"
      };
    }
    return { ok: true, value: normalized };
  } catch (error) {
    return {
      ok: false,
      reasonCode: "DREAMDEX_READ_FAILED",
      message: dreamDexErrorMessage(error)
    };
  }
}

export async function captureMarketSnapshot(
  client: DreamDexSdkClient,
  config: DreamDexReadConfig,
  marketId: string,
  depth = 10,
  capturedAt?: string
): Promise<DreamDexReadResult<DreamDexSnapshotEvidence>> {
  try {
    validateDreamDexReadConfig(config);
    const market = await withShannonReadRetries("getBinaryMarket", async () => await client.getBinaryMarket(marketId));
    if (market === null) {
      return {
        ok: false,
        reasonCode: "DREAMDEX_NO_ELIGIBLE_MARKET",
        message: `Market ${marketId} was not found`
      };
    }
    const book = await withShannonReadRetries(
      "getLiveBinaryOrderBookByMarket",
      () => client.getLiveBinaryOrderBookByMarket(market.marketId, { depth })
    );
    const sdkBook = {
      yesBids: toBookLevels(book.yesBids),
      yesAsks: toBookLevels(book.yesAsks),
      noBids: toBookLevels(book.noBids),
      noAsks: toBookLevels(book.noAsks)
    };
    const fallbackBook = bookHasAnyLevel(sdkBook)
      ? null
      : await readLiveOpenBookFromIndexer(config, market.marketId, Math.max(depth * 20, 100)).catch(() => null);
    const retrievedAt = capturedAt ?? new Date().toISOString();
    const normalized = normalizeBinaryMarket(market, config, retrievedAt, "LIVE");
    if (!normalized.ok) {
      return normalized;
    }
    return {
      ok: true,
      value: {
        market: normalized.value,
        book: fallbackBook ?? sdkBook
      }
    };
  } catch (error) {
    return {
      ok: false,
      reasonCode: "DREAMDEX_READ_FAILED",
      message: dreamDexErrorMessage(error)
    };
  }
}

export async function readBinaryBookParams(
  client: DreamDexSdkClient,
  config: DreamDexReadConfig,
  poolAddress: string
): Promise<DreamDexReadResult<{
  readonly tickSize: bigint;
  readonly lotSize: bigint;
  readonly minQuantity: bigint;
}>> {
  try {
    validateDreamDexReadConfig(config);
    let params: {
      readonly tickSize: bigint;
      readonly lotSize: bigint;
      readonly minQuantity: bigint;
    };
    try {
      params = await withShannonReadRetries(
        "getBinaryBookParams",
        async () => await client.getBinaryBookParams(poolAddress)
      );
    } catch {
      params = await readBinaryBookParamsFromRpc(config, poolAddress);
    }
    return { ok: true, value: params };
  } catch (error) {
    return {
      ok: false,
      reasonCode: "DREAMDEX_READ_FAILED",
      message: dreamDexErrorMessage(error)
    };
  }
}

export async function readExecutionReadiness(
  config: DreamDexReadConfig,
  input: {
    readonly account: string;
    readonly marketAddress: string;
    readonly poolAddress: string;
  }
): Promise<DreamDexReadResult<DreamDexExecutionReadinessEvidence>> {
  try {
    validateDreamDexReadConfig(config);
    const publicClient = createPublicClient({
      chain: {
        ...somniaShannonTestnet,
        rpcUrls: {
          default: {
            http: [config.rpcUrl],
            webSocket: [config.wsRpcUrl]
          }
        }
      },
      transport: http(config.rpcUrl)
    });
    const account = input.account as Address;
    const marketAddress = input.marketAddress as Address;
    const poolAddress = input.poolAddress as Address;
    const [observedBlockNumber, marketCollateral, poolCollateral, walletNativeBalanceRaw] =
      await withShannonReadRetries("executionReadinessBindings", async () =>
        await Promise.all([
          publicClient.getBlockNumber(),
          publicClient.readContract({
            address: marketAddress,
            abi: binaryMarketCollateralAbi,
            functionName: "collateral"
          }),
          publicClient.readContract({
            address: poolAddress,
            abi: binaryPoolSetupAbi,
            functionName: "collateralToken"
          }),
          publicClient.getBalance({ address: account })
        ])
      );
    const [walletBalanceRaw, walletAllowanceRaw] = await withShannonReadRetries(
      "executionReadinessWallet",
      async () =>
        await Promise.all([
          publicClient.readContract({
            address: marketCollateral,
            abi: erc20ReadAbi,
            functionName: "balanceOf",
            args: [account]
          }),
          publicClient.readContract({
            address: marketCollateral,
            abi: erc20ReadAbi,
            functionName: "allowance",
            args: [account, poolAddress]
          })
        ])
    );
    return {
      ok: true,
      value: {
        observedBlockNumber: observedBlockNumber.toString(),
        marketCollateral,
        poolCollateral,
        collateralBindingMatches: marketCollateral.toLowerCase() === poolCollateral.toLowerCase(),
        walletBalanceRaw: walletBalanceRaw.toString(),
        walletAllowanceRaw: walletAllowanceRaw.toString(),
        walletNativeBalanceRaw: walletNativeBalanceRaw.toString()
      }
    };
  } catch (error) {
    return {
      ok: false,
      reasonCode: "DREAMDEX_READ_FAILED",
      message: dreamDexErrorMessage(error)
    };
  }
}

export async function buildControlledLiquidityEvidence(
  config: DreamDexReadConfig,
  input: {
    readonly makerAddress: string;
    readonly poolAddress: string;
    readonly side: "SELL_YES" | "SELL_NO";
    readonly priceRaw: string;
    readonly quantityRaw: string;
    readonly expireTimestampNs: string;
  }
): Promise<DreamDexReadResult<DreamDexControlledLiquidityEvidence>> {
  try {
    validateDreamDexReadConfig(config);
    const publicClient = createPublicClient({
      chain: {
        ...somniaShannonTestnet,
        rpcUrls: {
          default: {
            http: [config.rpcUrl],
            webSocket: [config.wsRpcUrl]
          }
        }
      },
      transport: http(config.rpcUrl)
    });
    const poolAddress = input.poolAddress as Address;
    const [outcomeToken, collateral, marketNonce] = await withShannonReadRetries(
      "controlledLiquidityPoolTokens",
      async () =>
        await Promise.all([
          publicClient.readContract({ address: poolAddress, abi: binaryPoolSetupAbi, functionName: "outcomeToken" }),
          publicClient.readContract({ address: poolAddress, abi: binaryPoolSetupAbi, functionName: "collateralToken" }),
          publicClient.readContract({ address: poolAddress, abi: binaryPoolSetupAbi, functionName: "marketNonce" })
        ])
    );
    const makerAddress = input.makerAddress as Address;
    const quantity = BigInt(input.quantityRaw);
    const selectedOutcomeId = outcomeId(input.poolAddress, marketNonce, input.side === "SELL_YES" ? 0 : 1);
    const orderKind = input.side === "SELL_YES" ? 1 : 3;
    const calls: DreamDexUnsignedCallEvidence[] = [
      {
        to: collateral,
        data: encodeFunctionData({
          abi: erc20ApproveAbi,
          functionName: "approve",
          args: [poolAddress, quantity]
        }),
        valueRaw: "0",
        description: "Approve exact tUSDC amount for controlled liquidity mint"
      },
      {
        to: poolAddress,
        data: encodeFunctionData({
          abi: binaryPoolSetupAbi,
          functionName: "mintSet",
          args: [makerAddress, makerAddress, quantity]
        }),
        valueRaw: "0",
        description: "Mint equal YES and NO outcome tokens for controlled testnet liquidity"
      },
      {
        to: outcomeToken,
        data: encodeFunctionData({
          abi: erc6909OperatorAbi,
          functionName: "setOperator",
          args: [poolAddress, true]
        }),
        valueRaw: "0",
        description: "Allow the pool to escrow the selected outcome token for the maker sell order"
      },
      {
        to: poolAddress,
        data: encodeFunctionData({
          abi: binaryPoolSetupAbi,
          functionName: "placeBinaryOrder",
          args: [orderKind, BigInt(input.priceRaw), quantity, BigInt(input.expireTimestampNs), 3, 0, "0x0000000000000000000000000000000000000000", 0n, 0n]
        }),
        valueRaw: "0",
        description: `Place controlled post-only ${input.side} liquidity`
      }
    ];
    return {
      ok: true,
      value: {
        setupKind: "CONTROLLED_TESTNET_LIQUIDITY",
        makerAddress: input.makerAddress,
        poolAddress: input.poolAddress,
        side: input.side,
        priceRaw: input.priceRaw,
        quantityRaw: input.quantityRaw,
        expireTimestampNs: input.expireTimestampNs,
        outcomeToken,
        collateral,
        outcomeId: selectedOutcomeId.toString(),
        calls,
        disclosures: [
          "controlled testnet liquidity, not organic market demand",
          "browser wallet must approve every setup transaction",
          "server prepares unsigned calldata only and never signs",
          "post-only sell order is intended to create a takable ask for a separate proof wallet"
        ]
      }
    };
  } catch (error) {
    return {
      ok: false,
      reasonCode: "DREAMDEX_READ_FAILED",
      message: dreamDexErrorMessage(error)
    };
  }
}

function serializeUnsignedCall(call: UnsignedOrder["order"]): DreamDexUnsignedCallEvidence {
  return {
    to: call.to,
    data: call.data,
    valueRaw: call.value.toString(),
    description: call.description
  };
}

async function buildUnsignedBinaryOrderEvidenceFromCalldata(
  config: DreamDexReadConfig,
  input: {
    readonly poolAddress: string;
    readonly side: BinarySide;
    readonly priceRaw: string;
    readonly quantityRaw: string;
    readonly expireTimestampNs: string;
    readonly orderType: 2;
    readonly quoteDecimals: number;
    readonly collateralAddress?: string;
  }
): Promise<DreamDexUnsignedOrderEvidence> {
  const publicClient = createPublicClient({
    chain: {
      ...somniaShannonTestnet,
      rpcUrls: {
        default: {
          http: [config.rpcUrl],
          webSocket: [config.wsRpcUrl]
        }
      }
    },
    transport: http(config.rpcUrl)
  });
  const poolAddress = input.poolAddress as Address;
  const collateral = input.collateralAddress === undefined
    ? await withShannonReadRetries(
        "executionCandidateCollateralToken",
        async () => await publicClient.readContract({ address: poolAddress, abi: binaryPoolSetupAbi, functionName: "collateralToken" })
      )
    : input.collateralAddress as Address;
  const priceRaw = BigInt(input.priceRaw);
  const quantityRaw = BigInt(input.quantityRaw);
  const quoteUnit = 10n ** BigInt(input.quoteDecimals);
  const escrowPriceRaw = input.side === "BUY_YES" ? priceRaw : quoteUnit - priceRaw;
  const escrowRaw = (escrowPriceRaw * quantityRaw + quoteUnit - 1n) / quoteUnit;
  const orderKind = input.side === "BUY_YES" ? 0 : 2;
  return {
    approval: {
      to: collateral,
      data: encodeFunctionData({
        abi: erc20ApproveAbi,
        functionName: "approve",
        args: [poolAddress, escrowRaw]
      }),
      valueRaw: "0",
      description: "Approve exact tUSDC escrow for strategy-linked IOC order"
    },
    order: {
      to: poolAddress,
      data: encodeFunctionData({
        abi: binaryPoolSetupAbi,
        functionName: "placeBinaryOrder",
        args: [
          orderKind,
          priceRaw,
          quantityRaw,
          BigInt(input.expireTimestampNs),
          input.orderType,
          0,
          "0x0000000000000000000000000000000000000000",
          0n,
          0n
        ]
      }),
      valueRaw: "0",
      description: `Place bounded strategy-linked ${input.side} IOC order`
    }
  };
}

export async function buildUnsignedBinaryOrderEvidence(
  client: DreamDexSdkClient,
  config: DreamDexReadConfig,
  input: {
    readonly ownerAddress: string;
    readonly poolAddress: string;
    readonly side: BinarySide;
    readonly priceRaw: string;
    readonly quantityRaw: string;
    readonly expireTimestampNs: string;
    readonly orderType: 2;
    readonly quoteDecimals: number;
    readonly collateralAddress?: string;
  }
): Promise<DreamDexReadResult<DreamDexUnsignedOrderEvidence>> {
  try {
    validateDreamDexReadConfig(config);
    const deterministic = await buildUnsignedBinaryOrderEvidenceFromCalldata(config, input);
    if (client.createTrader === undefined) {
      return {
        ok: true,
        value: deterministic
      };
    }
    let unsigned: UnsignedOrder;
    try {
      const trader = client.createTrader({
        account: input.ownerAddress as Address,
        decimals: input.quoteDecimals
      });
      unsigned = await trader.buildPlaceOrder({
        pool: input.poolAddress as Address,
        side: input.side,
        price: BigInt(input.priceRaw),
        quantity: BigInt(input.quantityRaw),
        expireTimestampNs: BigInt(input.expireTimestampNs),
        orderType: input.orderType
      });
    } catch {
      return {
        ok: true,
        value: deterministic
      };
    }
    return {
      ok: true,
      value: {
        order: serializeUnsignedCall(unsigned.order),
        approval: deterministic.approval
      }
    };
  } catch (error) {
    return {
      ok: false,
      reasonCode: "DREAMDEX_READ_FAILED",
      message: error instanceof Error ? error.message : "DreamDEX unsigned order build failed"
    };
  }
}

export const dreamDexBoundaries = {
  writes: "browser-wallet-human-gated-only",
  mainnetHistoricalWrites: "forbidden",
  historicalReplay: "allowed-only-from-authentic-provenance-labeled-history",
  fabricatedFills: "forbidden",
  bookReconstruction: HISTORICAL_BOOK_RECONSTRUCTION_CAPABILITY
} as const;
