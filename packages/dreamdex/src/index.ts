import {
  SOMNIA_MAINNET_ADDRESSES,
  SOMNIA_TESTNET_ADDRESSES,
  SomniaMarkets,
  type BinaryMarket,
  type BinaryOrderBook,
  type Candle,
  type FillRow,
  type MarketStatusUpdate,
  type PastBinaryMarketsOptions
} from "@somnia-chain/markets-sdk";
import {
  DREAMDEX_MARKETS_SDK_VERSION,
  type EvidencePlane,
  SOMNIA_MAINNET_CHAIN_ID,
  SOMNIA_SHANNON_CHAIN_ID,
  type EvidenceClass
} from "@edgelab/domain";
import { defineChain } from "viem";
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
  init: { readonly method: "POST"; readonly headers: Record<string, string>; readonly body: string }
) => Promise<{ readonly ok: boolean; readonly status: number; json(): Promise<unknown> }>;

const GraphQlErrorSchema = z.object({
  message: z.string().min(1)
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
    const count = await client.countBinaryMarkets(countFilters);
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

  try {
    const queryLimit = page.value.limit + 1;
    const query: PastBinaryMarketsOptions = {
      limit: queryLimit,
      offset: page.value.offset,
      ...(filters.asset === undefined ? {} : { asset: filters.asset }),
      ...(filters.intervalSec === undefined ? {} : { intervalSec: filters.intervalSec }),
      ...(filters.status === undefined ? {} : { status: filters.status })
    };
    const rows = await client.listPastBinaryMarkets(query);
    const pageRows = rows.slice(0, page.value.limit);
    const openingPrices =
      pageRows.length > 0
        ? await client.getOpeningPrices(pageRows.map((row) => row.marketId.toLowerCase()))
        : {};
    const retrievedAt = new Date().toISOString();
    const normalized = pageRows.map((row) =>
      normalizeHistoricalBinaryMarket(row, validated.value, retrievedAt, openingPrices[row.marketId.toLowerCase()] ?? null)
    );
    const validRows = normalized
      .filter((result): result is { readonly ok: true; readonly value: HistoricalMarketEvidence } => result.ok)
      .map((result) => result.value);
    return {
      ok: true,
      value: {
        rows: validRows,
        page: page.value,
        hasMore: rows.length > page.value.limit,
        excludedMalformedRows: normalized.length - validRows.length,
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
    const row = await client.getBinaryMarket(marketId);
    if (row === null) {
      return { ok: true, value: null };
    }
    const openingPrices = await client.getOpeningPrices([row.marketId.toLowerCase()]);
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
    const resolution = await client.getMarketResolution(marketId);
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
    const rows = await client.getMarketStatusHistory(marketId);
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
    const rows = await client.getCandles(poolAddress, intervalSeconds, candleOptions);
    return {
      ok: true,
      value: rows.map((row) => ({
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
      }))
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
    const response = await fetchImpl(config.indexerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables })
    });
    if (!response.ok) {
      return {
        ok: false,
        reasonCode: "DREAMDEX_HISTORICAL_READ_FAILED",
        message: `DreamDEX historical indexer returned HTTP ${String(response.status)}`
      };
    }
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
    const rows = await client.listLiveBinaryMarkets({ status: "Trading" });
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
      message: error instanceof Error ? error.message : "DreamDEX read failed"
    };
  }
}

export async function captureMarketSnapshot(
  client: DreamDexSdkClient,
  config: DreamDexReadConfig,
  marketId: string,
  depth = 10
): Promise<DreamDexReadResult<DreamDexSnapshotEvidence>> {
  try {
    validateDreamDexReadConfig(config);
    const market = await client.getBinaryMarket(marketId);
    if (market === null) {
      return {
        ok: false,
        reasonCode: "DREAMDEX_NO_ELIGIBLE_MARKET",
        message: `Market ${marketId} was not found`
      };
    }
    const retrievedAt = new Date().toISOString();
    const normalized = normalizeBinaryMarket(market, config, retrievedAt, "LIVE");
    if (!normalized.ok) {
      return normalized;
    }
    await client.getBinaryBookParams(market.poolAddress);
    const book = client.getLiveBinaryOrderBookByMarket(market.marketId, { depth });
    return {
      ok: true,
      value: {
        market: normalized.value,
        book: {
          yesBids: toBookLevels(book.yesBids),
          yesAsks: toBookLevels(book.yesAsks),
          noBids: toBookLevels(book.noBids),
          noAsks: toBookLevels(book.noAsks)
        }
      }
    };
  } catch (error) {
    return {
      ok: false,
      reasonCode: "DREAMDEX_READ_FAILED",
      message: error instanceof Error ? error.message : "DreamDEX snapshot read failed"
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
